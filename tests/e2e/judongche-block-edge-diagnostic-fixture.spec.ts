import { test, expect, type Page, type ElementHandle } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlaywrightEditorDom,
  createRichTextDomPort,
} from '../../src/infrastructure/platforms/judongche/production-rich-text-dom';
import {
  JudongchePageError,
  type BlockEdgeAttempt,
} from '../../src/infrastructure/platforms/judongche/production-state';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import type { ProbeDiagnostic } from '../../src/infrastructure/platforms/judongche/production-pages';
import { writeProbeLog } from '../../src/desktop/main/probe-log';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { clickEditorLeafEnd } from '../../src/infrastructure/platforms/judongche/production-editor-position';

test.beforeEach(async ({ context }) => denyExternalNetwork(context));

test('T1 actual click emits start and completion without relabeling the pre-click sample', async ({
  page,
}) => {
  await fixture(page);
  const observations: unknown[] = [];
  await clickEditorLeafEnd(page, '.ProseMirror', 0, 0, {
    callsite: 'unspecified',
    diagnostic: (value) => observations.push(structuredClone(value)),
  });
  expect(observations).toMatchObject([
    {
      attempts: [
        {
          sample: 'sampled-before-click',
          clickStage: 'not-started',
          clickCompleted: false,
          documentVisibility: 'visible',
          documentHasFocus: expect.any(Boolean),
        },
      ],
    },
    { attempts: [{ clickStage: 'started', clickCompleted: false }] },
    {
      attempts: [
        {
          clickStage: 'completed',
          clickCompleted: true,
          clickElapsedMs: expect.any(Number),
        },
      ],
    },
    { attempts: [{ positionStage: 'settle', clickCompleted: true }] },
    {
      attempts: [
        { positionStage: 'post-identity', settleElapsedMs: expect.any(Number) },
      ],
    },
    {
      attempts: [
        {
          positionStage: 'completed',
          postIdentityElapsedMs: expect.any(Number),
        },
      ],
    },
  ]);
});

test('T1 real actionability timeouts record an incomplete click and sanitized category on both existing attempts', async ({
  page,
}) => {
  await fixture(
    page,
    '@keyframes move { from { transform:translateX(0) } to { transform:translateX(20px) } } p { animation:move .2s infinite alternate linear }',
  );
  const error = await clickEditorLeafEnd(page, '.ProseMirror', 0, 0).catch(
    (error: unknown) => error,
  );
  expect(error).toMatchObject({
    check: 'block-edge-blocked',
    blockEdge: {
      attempts: [
        {
          sample: 'sampled-before-click',
          clickStage: 'exception',
          clickCompleted: false,
          clickExceptionCategory: 'timeout',
          clickElapsedMs: expect.any(Number),
        },
        {
          sample: 'sampled-before-click',
          clickStage: 'exception',
          clickCompleted: false,
          clickExceptionCategory: 'timeout',
          clickElapsedMs: expect.any(Number),
        },
      ],
    },
  });
  expect(JSON.stringify(error)).not.toMatch(
    /TimeoutError|waiting for|https:|ARTICLE_SENTINEL/,
  );
});

test('T1 a target replacement after a completed click retains clickCompleted', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const target = document.querySelector('p')!;
    target.onclick = () => target.replaceWith(target.cloneNode(true));
  });
  await expect(
    clickEditorLeafEnd(page, '.ProseMirror', 0, 0),
  ).rejects.toMatchObject({
    check: 'block-edge-target-changed',
    blockEdge: {
      attempts: [
        {
          sample: 'sampled-before-click',
          clickStage: 'completed',
          clickCompleted: true,
          clickElapsedMs: expect.any(Number),
        },
      ],
    },
  });
});

test('T3 stop during settling never replays a completed positioning click', async ({
  page,
}) => {
  await fixture(page);
  let stopped = false;
  const observations: BlockEdgeAttempt[] = [];
  await page.evaluate(() => {
    const counts = { clicks: 0, keys: 0 };
    Object.assign(window, { positionCounts: counts });
    document.addEventListener('click', () => counts.clicks++);
    document.addEventListener('keydown', () => counts.keys++);
  });
  await expect(
    clickEditorLeafEnd(page, '.ProseMirror', 0, 0, {
      callsite: 'unspecified',
      stop: () => {
        if (stopped) throw new JudongchePageError('STOP_REQUESTED');
      },
      diagnostic: (value) => {
        observations.push(structuredClone(value.attempts.at(-1)!));
        if (value.attempts.at(-1)?.positionStage === 'settle') stopped = true;
      },
    }),
  ).rejects.toMatchObject({ reason: 'STOP_REQUESTED' });
  expect(
    await page.evaluate(() => Reflect.get(window, 'positionCounts')),
  ).toEqual({ clicks: 1, keys: 0 });
  expect(observations.at(-1)).toMatchObject({
    positionStage: 'settle',
    clickCompleted: true,
    settleElapsedMs: expect.any(Number),
  });
});

test('R1 actual rich tool action checks stop after its hit observation', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const tool = document.createElement('div');
    tool.className = 'syl-toolbar-tool bold';
    tool.innerHTML = '<button class="syl-toolbar-button">bold</button>';
    Object.assign(window, { richToolClicks: 0 });
    tool.querySelector('button')!.onclick = () =>
      Reflect.set(
        window,
        'richToolClicks',
        Reflect.get(window, 'richToolClicks') + 1,
      );
    document.body.append(tool);
  });
  let stopped = false;
  const evaluate = page.evaluate.bind(page);
  page.evaluate = new Proxy(evaluate, {
    apply(target, receiver, args) {
      return (Reflect.apply(target, receiver, args) as Promise<unknown>).then(
        (value) => {
          if (
            args[1] === 'bold' &&
            value &&
            typeof value === 'object' &&
            'inside' in value
          )
            stopped = true;
          return value;
        },
      );
    },
  });
  const dom = createPlaywrightEditorDom(page, undefined, () => stopped);
  try {
    await expect(dom.clickTool('bold')).rejects.toMatchObject({
      reason: 'STOP_REQUESTED',
    });
    expect(await evaluate(() => Reflect.get(window, 'richToolClicks'))).toBe(0);
  } finally {
    page.evaluate = evaluate;
    await dom.dispose?.();
  }
});

// Observe the real page boundary, including the actual evaluate result; do not
// recreate the hit algorithm in a test double.
function observedPage(page: Page) {
  const effects: string[] = [];
  const observations: unknown[] = [];
  const wrapped = new Proxy(page, {
    get(target, key) {
      if (key === 'evaluateHandle')
        return async (...args: Parameters<Page['evaluateHandle']>) => {
          const handle = await target.evaluateHandle(...args);
          return new Proxy(handle, {
            get(target, key) {
              if (key === 'asElement')
                return () => {
                  const element =
                    target.asElement() as ElementHandle<Element> | null;
                  return (
                    element &&
                    new Proxy(element, {
                      get(target, key) {
                        if (key === 'click')
                          return async (
                            ...args: Parameters<typeof target.click>
                          ) => {
                            await target.click(...args);
                            effects.push('click');
                          };
                        const value = Reflect.get(target, key);
                        return typeof value === 'function'
                          ? value.bind(target)
                          : value;
                      },
                    })
                  );
                };
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        };
      if (key === 'evaluate')
        return async (...args: Parameters<Page['evaluate']>) => {
          const value = await target.evaluate(...args);
          observations.push(value);
          return value;
        };
      if (key === 'mouse')
        return {
          click: async (x: number, y: number) => {
            effects.push('click');
            await target.mouse.click(x, y);
          },
        };
      if (key === 'keyboard')
        return {
          insertText: target.keyboard.insertText.bind(target.keyboard),
          press: async (key: string) => {
            effects.push(key);
            await target.keyboard.press(key);
          },
        };
      if (key === 'waitForTimeout')
        return async (ms: number) => {
          effects.push(`wait:${ms}`);
          await target.waitForTimeout(ms);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { dom: createPlaywrightEditorDom(wrapped), effects, observations };
}

async function fixture(page: Page, style = '', child = '<br>') {
  await page.setContent(`<style>
    body { margin: 0 } .publish-editor { margin: 50px; width: 300px }
    .ProseMirror { outline: none } p { margin: 0; height: 24px }
    p span { display: block; width: 100%; height: 100% } ${style}
    </style><div class="publish-editor"><div class="ProseMirror" contenteditable="true"><p>${child}</p></div></div>`);
}

function expectSettledClick(effects: string[], before: string[] = []) {
  expect(effects.slice(0, before.length + 1)).toEqual([...before, 'click']);
  const waits = effects.slice(before.length + 1);
  expect(waits.length).toBeGreaterThan(0);
  for (const wait of waits) expect(wait).toMatch(/^wait:[0-9.]+$/);
  expect(
    waits.reduce((total, wait) => total + Number(wait.slice(5)), 0),
  ).toBeLessThanOrEqual(160);
}

for (const child of ['<br>', '<span>ARTICLE_SENTINEL</span>']) {
  test(`real edge hit preserves successful click sequence: ${child}`, async ({
    page,
  }) => {
    await fixture(page, '', child);
    const h = observedPage(page);
    await h.dom.clickBlockEdge(0, 0);
    expectSettledClick(h.effects);
    expect(await h.dom.focusState()).toEqual({
      activeIsEditor: true,
      selectionInEditor: true,
    });
    expect(h.observations[0]).toMatchObject({
      diagnostic: {
        status: 'observed',
        inside: true,
        blocked: false,
        hitRelation: 'target-descendant',
        targetKind: 'paragraph',
      },
    });
    expect(JSON.stringify(h.observations)).not.toContain('ARTICLE_SENTINEL');
  });
}

for (const scenario of ['zero-height', 'popup', 'radio'] as const) {
  test(`real edge failure records bounded geometry: ${scenario}`, async ({
    page,
  }) => {
    await fixture(page, scenario === 'zero-height' ? 'p { height: 0 }' : '');
    if (scenario === 'popup' || scenario === 'radio')
      await page.evaluate((kind) => {
        const blocker = document.createElement(
          kind === 'popup' ? 'div' : 'label',
        );
        blocker.className = kind === 'popup' ? 'plugin-helper' : 'byte-radio';
        blocker.style.cssText =
          'position:absolute;left:0;top:0;width:600px;height:200px';
        blocker.textContent = 'CREDENTIAL_SENTINEL';
        document.body.append(blocker);
      }, scenario);
    const h = observedPage(page);
    const error = await h.dom
      .clickBlockEdge(0, 0)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(JudongchePageError);
    expect(error).toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'block-edge-blocked',
      blockEdge: {
        callsite: 'unspecified',
        blockIndex: 0,
        leafIndex: 0,
        attempts: [
          { attempt: 1, status: 'observed', inside: false },
          { attempt: 2, status: 'observed', inside: false },
        ],
      },
    });
    const detail = (
      error as JudongchePageError & {
        blockEdge: {
          attempts: {
            hitCategory: string;
            ancestors: unknown[];
            siblings: unknown[];
            beforeScroll: { height: number };
            point: { x: number };
          }[];
        };
      }
    ).blockEdge.attempts[0];
    expect(detail.ancestors.length).toBeLessThanOrEqual(6);
    expect(detail.siblings.length).toBeLessThanOrEqual(2);
    if (scenario === 'zero-height') expect(detail.beforeScroll.height).toBe(0);
    if (scenario === 'popup' || scenario === 'radio')
      expect(detail.hitCategory).toBe(scenario);
    expect(JSON.stringify(error)).not.toMatch(
      /ARTICLE_SENTINEL|CREDENTIAL_SENTINEL|className|cssText|https:/,
    );
    expect(h.effects).toEqual(['Escape', 'wait:120', 'Escape', 'wait:120']);
  });
}

for (const [scenario, style] of [
  ['narrow', 'p { width:4px }'],
  ['horizontal', '.publish-editor { margin-left:1400px }'],
  [
    'ancestor',
    '.publish-editor { width:100px; overflow:hidden } p { width:300px }',
  ],
]) {
  test(`final visual line remains actionable with bounded diagnostics: ${scenario}`, async ({
    page,
  }) => {
    await fixture(page, style);
    const h = observedPage(page);
    await h.dom.clickBlockEdge(0, 0);
    await h.dom.placeCaret('end');
    expect((await h.dom.snapshot()).caret).toEqual({
      blockIndex: 0,
      leafIndex: 0,
      offset: 0,
    });
    await h.dom.insertText('TAIL');
    await expect(page.locator('p')).toHaveText('TAIL');
    const attempts = h.observations.filter(
      (v) => !!(v as { diagnostic?: unknown })?.diagnostic,
    ) as { diagnostic: BlockEdgeAttempt }[];
    expect(attempts.length).toBeLessThanOrEqual(2);
    expect(attempts.at(-1)?.diagnostic).toMatchObject({
      status: 'observed',
      inside: true,
      blocked: false,
      hitRelation: 'target-descendant',
    });
    for (const { diagnostic } of attempts) {
      expect(diagnostic.ancestors!.length).toBeLessThanOrEqual(6);
      expect(diagnostic.siblings!.length).toBeLessThanOrEqual(2);
    }
    expect(JSON.stringify(attempts)).not.toMatch(
      /ARTICLE_SENTINEL|CREDENTIAL_SENTINEL|className|cssText|https:/,
    );
    expect(h.effects.filter((effect) => effect === 'click')).toHaveLength(1);
  });
}

test('missing block preserves immediate rejection and records requested indexes', async ({
  page,
}) => {
  await fixture(page);
  const h = observedPage(page);
  await expect(h.dom.clickBlockEdge(7, 3)).rejects.toMatchObject({
    check: 'block-missing',
    blockEdge: {
      blockIndex: 7,
      leafIndex: 3,
      attempts: [{ attempt: 1, status: 'block-missing' }],
    },
  });
  expect(h.effects).toEqual([]);
});

for (const blocked of [false, true]) {
  test(`diagnostic style exception preserves operation outcome: blocked=${blocked}`, async ({
    page,
  }) => {
    await fixture(page, blocked ? 'p { height: 0 }' : '');
    await page.evaluate(() => {
      window.getComputedStyle = () => {
        throw new Error('SECRET_STYLE_ERROR');
      };
    });
    const h = observedPage(page);
    if (blocked) {
      await expect(h.dom.clickBlockEdge(0, 0)).rejects.toMatchObject({
        check: 'block-edge-blocked',
        blockEdge: {
          attempts: [
            { attempt: 1, status: 'unavailable' },
            { attempt: 2, status: 'unavailable' },
          ],
        },
      });
      expect(h.effects).toEqual(['Escape', 'wait:120', 'Escape', 'wait:120']);
    } else {
      await h.dom.clickBlockEdge(0, 0);
      expectSettledClick(h.effects);
      expect(h.observations[0]).toMatchObject({
        diagnostic: { status: 'unavailable' },
      });
    }
  });
}

test('paragraph-tail failure reaches ProbeDiagnostic and the immutable first-failure file', async ({
  context,
  page,
}) => {
  const f = await installProductionFixture(context, {
    observedTrailingParagraphs: true,
  });
  await page.goto(f.home);
  const root = mkdtempSync(join(tmpdir(), 'block-edge-diagnostic-'));
  const task = { taskId: '91fb259b-ad99-4128-8138-916ebb5b9091' };
  const events: ProbeDiagnostic[] = [];
  try {
    const pages = createJudongchePages(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture-generation',
        close: async () => {},
      },
      (event) => {
        events.push(event);
        writeProbeLog(root, event, task);
      },
      {
        manualReview: true,
        ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
      },
    );
    expect((await pages.probe()).status).toBe('ready');
    await pages.enterNewEditor('TITLE_SENTINEL', () => false, task.taskId);
    await page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>('#body')!;
      const wrapper = document.createElement('div');
      wrapper.className = 'publish-editor';
      editor.before(wrapper);
      wrapper.append(editor);
      editor.classList.add('ProseMirror');
      for (const name of ['bold', 'italic', 'underline']) {
        const tool = document.createElement('div');
        tool.className = 'syl-toolbar-tool ' + name;
        const button = document.createElement('button');
        button.className = 'syl-toolbar-button';
        tool.append(button);
        document.querySelector('.syl-toolbar')!.append(tool);
      }
      const style = document.createElement('style');
      style.textContent =
        '#body p:not(:first-child) { width:4px!important; min-height:0!important; height:0!important; padding:0!important; margin:0!important }';
      document.head.append(style);
    });
    await expect(
      pages.appendTextBlock!(
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'ARTICLE_SENTINEL', marks: [] }],
        },
        () => false,
      ),
    ).rejects.toMatchObject({ check: 'block-edge-blocked' });
    const failure = events.find((event) => event.failure)!;
    expect(failure).toMatchObject({
      operation: 'appendTextBlock',
      check: 'block-edge-blocked',
      blockEdge: {
        callsite: 'paragraph-tail-reuse',
        blockIndex: 1,
        leafIndex: 0,
        attempts: [{ attempt: 1 }, { attempt: 2 }],
      },
    });
    const path = join(
      root,
      `judongche-first-failure-${task.taskId}-execution.json`,
    );
    const saved = readFileSync(path, 'utf8');
    expect(JSON.parse(saved).blockEdge).toEqual(
      (failure as ProbeDiagnostic & { blockEdge: unknown }).blockEdge,
    );
    writeProbeLog(root, { operation: 'appendTextBlock', failure: true }, task);
    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(saved).not.toMatch(
      /TITLE_SENTINEL|ARTICLE_SENTINEL|SECRET_STYLE_ERROR|CREDENTIAL_SENTINEL|https:|className|innerHTML/,
    );
    expect(f.saves()).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing vertical scroll is observed before and after with compact focus and bounded node names', async ({
  page,
}) => {
  await fixture(page, '.publish-editor { margin-top: 1800px }');
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.ProseMirror')!;
    const custom = document.createElement('secret-custom-element');
    custom.setAttribute('data-secret', 'CREDENTIAL_SENTINEL');
    editor.append(custom);
    editor.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(editor.firstElementChild!);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  const h = observedPage(page);
  await h.dom.clickBlockEdge(0, 0);
  const detail = (h.observations[0] as { diagnostic: BlockEdgeAttempt })
    .diagnostic;
  expect(detail.beforeScroll!.y).toBeGreaterThan(1500);
  expect(detail.afterScroll!.y).toBeLessThan(detail.viewport!.height);
  expect(detail.scrolled).toBe(true);
  expect(detail.focus).toMatchObject({
    active: 'editor',
    anchor: 'target-descendant',
    focus: 'target-descendant',
    collapsed: true,
    rangeCount: 1,
  });
  expect(detail.siblings).toEqual([
    expect.objectContaining({ side: 'next', tag: 'other' }),
  ]);
  expect(JSON.stringify(detail)).not.toMatch(
    /secret-custom|data-secret|CREDENTIAL_SENTINEL/,
  );
  expectSettledClick(h.effects);
});

test('one existing Escape dismisses popup before the second hit and successful click', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const popup = document.createElement('div');
    popup.className = 'plugin-helper';
    popup.style.cssText = 'position:absolute;inset:0;height:200px';
    document.body.append(popup);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') popup.remove();
    });
  });
  const h = observedPage(page);
  await h.dom.clickBlockEdge(0, 0);
  expect(h.observations).toMatchObject([
    {
      diagnostic: {
        attempt: 1,
        inside: false,
        blocked: true,
        hitCategory: 'popup',
      },
    },
    { diagnostic: { attempt: 2, inside: true, blocked: false } },
  ]);
  expectSettledClick(h.effects, ['Escape', 'wait:120']);
});

test('an original geometry exception remains an operation failure without Escape or click', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    document.querySelector('p')!.getBoundingClientRect = () => {
      throw new Error('operation-geometry-failed');
    };
  });
  const h = observedPage(page);
  await expect(h.dom.clickBlockEdge(0, 0)).rejects.toThrow(
    'operation-geometry-failed',
  );
  expect(h.effects).toEqual([]);
});

test('focus-recovery wrapper retains the original guard check and causal hit observations', async ({
  page,
}) => {
  await fixture(page, 'p { height: 0 }');
  const h = observedPage(page);
  await expect(createRichTextDomPort(h.dom).guard()).rejects.toMatchObject({
    reason: 'PAGE_CHANGED',
    check: 'block-edge-blocked',
    blockEdge: {
      callsite: 'focus-recovery',
      attempts: [
        { attempt: 1, inside: false },
        { attempt: 2, inside: false },
      ],
    },
  });
  expect(h.effects).toEqual(['Escape', 'wait:120', 'Escape', 'wait:120']);
});
