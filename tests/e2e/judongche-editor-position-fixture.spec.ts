import {
  test,
  expect,
  type Page,
  type Locator,
  type ElementHandle,
} from '@playwright/test';
import {
  createPlaywrightEditorDom,
  createRichTextDomPort,
} from '../../src/infrastructure/platforms/judongche/production-rich-text-dom';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';

test.beforeEach(async ({ context, page }) => {
  await denyExternalNetwork(context);
  await page.setViewportSize({ width: 1442, height: 825 });
});

async function editor(page: Page, html: string, style = '') {
  await page.setContent(`<style>
    body { margin:0; font:16px/24px Arial }
    .publish-editor { width:748px; margin:50px }
    p,li,h1 { margin:0; min-height:24px } ul,blockquote { margin:0 }
    .ProseMirror { outline:none; white-space:pre-wrap } ${style}
    </style><button id="outside">outside</button><div class="publish-editor"><div class="ProseMirror" contenteditable="true">${html}</div></div>`);
}

async function richNativeActions(page: Page) {
  const calls = { keys: [] as string[], text: [] as string[] };
  let dropText = false;
  const wrapped = new Proxy(page, {
    get(target, key) {
      if (key === 'keyboard')
        return new Proxy(target.keyboard, {
          get(keyboard, key) {
            if (key === 'press')
              return async (...args: Parameters<typeof keyboard.press>) => {
                calls.keys.push(args[0]);
                await keyboard.press(...args);
              };
            if (key === 'insertText')
              return async (text: string) => {
                calls.text.push(text);
                if (!dropText) await keyboard.insertText(text);
              };
            const value = Reflect.get(keyboard, key);
            return typeof value === 'function' ? value.bind(keyboard) : value;
          },
        });
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await editor(page, '<p></p>');
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.ProseMirror')!;
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(root.querySelector('p')!);
    range.collapse(true);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const actions = { clicks: 0, keys: 0, input: 0, externalChanges: 0 };
    Object.assign(window, { richNativeActions: actions });
    document.addEventListener('click', () => actions.clicks++);
    document.addEventListener('keydown', () => actions.keys++);
    document.addEventListener('input', () => actions.input++);
    const external = document.createElement('input');
    external.id = 'external-checkbox';
    external.type = 'checkbox';
    external.addEventListener('change', () => actions.externalChanges++);
    document.body.append(external);
  });
  const dom = createPlaywrightEditorDom(wrapped);
  const port = createRichTextDomPort(dom, {
    settleAttempts: 3,
    settleDelayMs: 0,
    sleep: async () => {},
  });
  await port.typeText('Alpha');
  calls.keys.length = 0;
  calls.text.length = 0;
  await page.evaluate(() => {
    Object.assign(Reflect.get(window, 'richNativeActions'), {
      clicks: 0,
      keys: 0,
      input: 0,
    });
  });
  return { dom, port, calls, dropText: () => (dropText = true) };
}

async function wrapRichTextAndMoveCaret(
  page: Page,
  tag: string,
  attributes: Record<string, string> = {},
) {
  await page.evaluate(
    ({ tag, attributes }) => {
      const root = document.querySelector<HTMLElement>('.ProseMirror')!;
      const p = root.querySelector('p')!;
      const wrapper = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes))
        wrapper.setAttribute(key, value);
      wrapper.style.cssText = 'display:block;width:100%;min-height:24px';
      while (p.firstChild) wrapper.append(p.firstChild);
      p.append(wrapper);
      root.focus();
      const text = document
        .createTreeWalker(wrapper, NodeFilter.SHOW_TEXT)
        .nextNode()!;
      const range = document.createRange();
      range.setStart(text, 1);
      range.collapse(true);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { tag, attributes },
  );
}

const richInteractiveWrappers: {
  name: string;
  tag: string;
  attributes: Record<string, string>;
}[] = [
  {
    name: 'external label',
    tag: 'label',
    attributes: { for: 'external-checkbox' },
  },
  { name: 'tabindex wrapper', tag: 'font', attributes: { tabindex: '0' } },
  {
    name: 'editable wrapper',
    tag: 'font',
    attributes: { contenteditable: 'true' },
  },
  { name: 'tabindex span', tag: 'span', attributes: { tabindex: '0' } },
  {
    name: 'editable mark',
    tag: 'strong',
    attributes: { contenteditable: 'true' },
  },
  { name: 'role mark', tag: 'em', attributes: { role: 'button' } },
];
for (const wrapper of richInteractiveWrappers)
  for (const operation of ['typeText', 'softBreak'] as const)
    test(`rich native ownership rejects ${wrapper.name} before ${operation} reseating`, async ({
      page,
    }) => {
      const h = await richNativeActions(page);
      try {
        await wrapRichTextAndMoveCaret(page, wrapper.tag, wrapper.attributes);
        expect(await h.dom.focusState()).toEqual({
          activeIsEditor: true,
          selectionInEditor: true,
        });
        expect((await h.dom.snapshot()).caret?.offset).toBe(1);
        const action =
          operation === 'typeText'
            ? h.port.typeText('MUST_NOT_INSERT')
            : h.port.softBreak();
        const outcome = await action.then(
          () => null,
          (error: unknown) => error,
        );
        expect.soft(outcome).toMatchObject({
          reason: 'PAGE_CHANGED',
          check: 'unsupported-inline-content',
        });
        expect.soft(h.calls).toEqual({ keys: [], text: [] });
        expect
          .soft(
            await page.evaluate(() => Reflect.get(window, 'richNativeActions')),
          )
          .toEqual({ clicks: 0, keys: 0, input: 0, externalChanges: 0 });
        await expect.soft(page.locator('#external-checkbox')).not.toBeChecked();
        await expect.soft(page.locator('.ProseMirror > p')).toHaveText('Alpha');
      } finally {
        await h.dom.dispose?.();
      }
    });

for (const operation of ['typeText', 'softBreak'] as const)
  test(`rich native ownership allows an ordinary wrapper before ${operation} reseating`, async ({
    page,
  }) => {
    const h = await richNativeActions(page);
    try {
      await wrapRichTextAndMoveCaret(page, 'font', {
        'data-normalized': 'true',
      });
      if (operation === 'typeText') {
        await h.port.typeText('Beta');
        expect(h.calls.text).toEqual(['Beta']);
      } else {
        await h.port.softBreak();
        expect(
          h.calls.keys.filter((key) => key === 'Shift+Enter'),
        ).toHaveLength(1);
      }
      const snapshot = await h.dom.snapshot();
      expect(snapshot.blocks[0].leaves[0].text).toBe(
        // Raw contenteditable adds an unclassified terminal caret BR as well.
        operation === 'typeText' ? 'AlphaBeta' : 'Alpha\n\n',
      );
      expect(snapshot.caret?.offset).toBe(operation === 'typeText' ? 9 : 6);
      await expect(page.locator('#external-checkbox')).not.toBeChecked();
    } finally {
      await h.dom.dispose?.();
    }
  });

for (const drop of [true, false])
  test(`rich native ownership uses the reseated offset when input is ${drop ? 'dropped' : 'applied'}`, async ({
    page,
  }) => {
    const h = await richNativeActions(page);
    try {
      await wrapRichTextAndMoveCaret(page, 'font');
      const before = await h.dom.snapshot();
      expect(before.caret?.offset).toBe(1);
      if (drop) h.dropText();
      let nextBlock = false;
      const action = async () => {
        await h.port.typeText('Beta');
        if (drop) {
          nextBlock = true;
          await h.port.exitBlock();
          await h.port.typeText('NEXT');
        }
      };
      if (drop)
        await expect(action()).rejects.toMatchObject({
          reason: 'PAGE_CHANGED',
          check: 'typed-text-not-applied',
        });
      else await action();
      expect(nextBlock).toBe(false);
      expect(h.calls.text).toEqual(['Beta']);
      const after = await h.dom.snapshot();
      expect(after.caret?.offset).toBe(drop ? 5 : 9);
      expect(after.blocks[0].leaves[0].text).toBe(drop ? 'Alpha' : 'AlphaBeta');
      if (drop) {
        expect(after.inputRevision).toBe(before.inputRevision);
        await expect(page.locator('.ProseMirror > p')).toHaveCount(1);
      } else expect(after.inputRevision).toBeGreaterThan(before.inputRevision!);
    } finally {
      await h.dom.dispose?.();
    }
  });

for (const tag of ['div', 'button']) {
  for (const permanent of [false, true]) {
    test(`in-viewport bottom ${tag} obstruction ${permanent ? 'stops' : 'scrolls and recovers'}`, async ({
      page,
    }) => {
      await editor(
        page,
        '<p><br></p>',
        '.publish-editor { margin-top:710px } body { min-height:2400px }',
      );
      await page.evaluate(
        ({ tag, permanent }) => {
          const p = document.querySelector('p')!;
          // Exactly the observed geometry: a 748×24 paragraph fully in the 825px viewport.
          p.style.position = 'relative';
          const delta = 758 - p.getBoundingClientRect().top;
          document.querySelector<HTMLElement>(
            '.publish-editor',
          )!.style.marginTop = `${710 + delta}px`;
          const blocker = document.createElement(tag);
          blocker.id = 'blocker';
          blocker.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${permanent ? '825px' : '80px'};z-index:10`;
          blocker.onclick = () => {
            blocker.dataset.clicked = 'yes';
          };
          document.body.append(blocker);
        },
        { tag, permanent },
      );
      const before = await page.locator('p').boundingBox();
      expect(before).toMatchObject({ y: 758, width: 748, height: 24 });
      const dom = createPlaywrightEditorDom(page);
      if (permanent) {
        await expect(dom.clickBlockEdge(0, 0)).rejects.toMatchObject({
          check: 'block-edge-blocked',
          blockEdge: {
            attempts: [
              { inside: false, hitTag: tag },
              { inside: false, hitTag: tag },
            ],
          },
        });
      } else {
        await dom.clickBlockEdge(0, 0);
        await dom.placeCaret('end');
        await dom.insertText('correct tail');
        expect((await dom.snapshot()).caret).toMatchObject({
          blockIndex: 0,
          leafIndex: 0,
          offset: 12,
        });
        await expect(page.locator('p')).toHaveText('correct tail');
        expect((await page.locator('p').boundingBox())!.y).toBeLessThan(700);
      }
      await expect(page.locator('#blocker')).not.toHaveAttribute(
        'data-clicked',
        'yes',
      );
    });
  }
}

for (const shape of [
  'wrapped',
  'hard-break',
  'empty',
  'list',
  'quote',
  'heading',
  'nested-scroll',
] as const) {
  test(`normal click and End seat at actual ${shape} leaf end`, async ({
    page,
  }) => {
    const text = 'long formatted sentence '.repeat(35) + 'LAST';
    const leaf = `<strong>${text}</strong>`;
    const html =
      shape === 'empty'
        ? '<p><br class="ProseMirror-trailingBreak"></p>'
        : shape === 'hard-break'
          ? '<p>first<br>last<br><br class="ProseMirror-trailingBreak"></p>'
          : shape === 'list'
            ? `<ul><li>previous</li><li>${leaf}</li></ul>`
            : shape === 'quote'
              ? `<blockquote><p>previous</p><p>${leaf}</p></blockquote>`
              : shape === 'heading'
                ? `<h1>${leaf}</h1>`
                : `<p>${leaf}</p>`;
    await editor(page, html, '.publish-editor { width:260px }');
    if (shape === 'nested-scroll')
      await page.evaluate(() => {
        const wrapper = document.querySelector<HTMLElement>('.publish-editor')!;
        wrapper.style.cssText = 'height:180px;overflow:auto;width:260px';
        document.querySelector<HTMLElement>('.ProseMirror')!.style.paddingTop =
          '700px';
      });
    const dom = createPlaywrightEditorDom(page);
    const leafIndex = shape === 'list' || shape === 'quote' ? 1 : 0;
    await dom.clickBlockEdge(0, leafIndex);
    await dom.placeCaret('end');
    const length =
      shape === 'empty' ? 0 : shape === 'hard-break' ? 11 : text.length;
    expect((await dom.snapshot()).caret).toEqual({
      blockIndex: 0,
      leafIndex,
      offset: length,
    });
    await dom.insertText('APPENDED');
    const snapshot = await dom.snapshot();
    expect(snapshot.blocks[0].leaves[leafIndex].text).toBe(
      (shape === 'empty'
        ? ''
        : shape === 'hard-break'
          ? 'first\nlast\n'
          : text) + 'APPENDED',
    );
  });
}

test('focus recovery uses the last visual line before typing', async ({
  page,
}) => {
  const text = 'focus recovery long text '.repeat(40);
  await editor(page, `<p>${text}</p>`, '.publish-editor { width:260px }');
  await page.locator('#outside').focus();
  const dom = createPlaywrightEditorDom(page);
  await createRichTextDomPort(dom).guard();
  expect((await dom.snapshot()).caret).toEqual({
    blockIndex: 0,
    leafIndex: 0,
    offset: text.length,
  });
  await dom.insertText('TAIL');
  await expect(page.locator('p')).toHaveText(text + 'TAIL');
});

test('missing container leaf rejects without clicking its sibling', async ({
  page,
}) => {
  await editor(page, '<ul><li>keep</li></ul>');
  await expect(
    createPlaywrightEditorDom(page).clickBlockEdge(0, 1),
  ).rejects.toMatchObject({ reason: 'PAGE_CHANGED' });
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    'BODY',
  );
});

for (const mutation of ['prepend', 'replace'] as const)
  test(`target identity change after geometry cannot click a different leaf: ${mutation}`, async ({
    page,
  }) => {
    await editor(page, '<p id="original"><br></p><p>untouched</p>');
    let changed = false;
    const wrapped = new Proxy(page, {
      get(target, key) {
        if (key === 'evaluate')
          return async (...args: Parameters<Page['evaluate']>) => {
            const result = await target.evaluate(...args);
            if (!changed && (result as { diagnostic?: unknown })?.diagnostic) {
              changed = true;
              await target.evaluate((mutation) => {
                const original = document.querySelector('#original')!;
                const foreign = document.createElement('p');
                foreign.id = 'foreign';
                foreign.innerHTML = '<br>';
                foreign.onclick = () => {
                  foreign.dataset.clicked = 'yes';
                };
                if (mutation === 'replace') original.replaceWith(foreign);
                else original.before(foreign);
              }, mutation);
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const dom = createPlaywrightEditorDom(wrapped);
    await expect(dom.clickBlockEdge(0, 0)).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
    });
    await expect(page.locator('#foreign')).not.toHaveAttribute(
      'data-clicked',
      'yes',
    );
    await expect(page.locator('.ProseMirror')).toHaveText('untouched');
  });

test('target index change during a normal click stops before text insertion', async ({
  page,
}) => {
  await editor(page, '<p id="original"><br></p><p>untouched</p>');
  await page.locator('#original').evaluate((node) => {
    node.addEventListener(
      'mousedown',
      () => {
        const foreign = document.createElement('p');
        foreign.id = 'foreign';
        foreign.innerHTML = '<br>';
        foreign.onclick = () => {
          foreign.dataset.clicked = 'yes';
        };
        node.before(foreign);
      },
      { once: true },
    );
  });
  await expect(
    createPlaywrightEditorDom(page).clickBlockEdge(0, 0),
  ).rejects.toMatchObject({
    reason: 'PAGE_CHANGED',
    check: 'block-edge-target-changed',
  });
  await expect(page.locator('#foreign')).not.toHaveAttribute(
    'data-clicked',
    'yes',
  );
  await expect(page.locator('.ProseMirror')).toHaveText('untouched');
});

for (const whiteSpace of ['pre-wrap', 'break-spaces'])
  for (const spaces of ['', ' ', '     ']) {
    test(`End preserves leaf boundary with ${spaces.length} terminal spaces: ${whiteSpace}`, async ({
      page,
    }) => {
      await editor(
        page,
        `<ul><li>first${spaces}</li><li>untouched</li></ul><p>next block</p>`,
        `.ProseMirror { white-space:${whiteSpace} }`,
      );
      const dom = createPlaywrightEditorDom(page);
      await dom.clickBlockEdge(0, 0);
      await dom.placeCaret('end');
      expect((await dom.snapshot()).caret).toEqual({
        blockIndex: 0,
        leafIndex: 0,
        offset: 5 + spaces.length,
      });
      await dom.insertText('TAIL');
      await expect(page.locator('li').first()).toHaveText(`first${spaces}TAIL`);
      await expect(page.locator('li').nth(1)).toHaveText('untouched');
      await expect(page.locator('p')).toHaveText('next block');
    });
  }

for (const whiteSpace of ['normal', 'pre-wrap', 'break-spaces']) {
  test(`native inserted terminal spaces retain the leaf boundary: ${whiteSpace}`, async ({
    page,
  }) => {
    await editor(
      page,
      '<ul><li><br></li><li>untouched</li></ul><p>next block</p>',
      `.ProseMirror { white-space:${whiteSpace} }`,
    );
    const dom = createPlaywrightEditorDom(page);
    await dom.clickBlockEdge(0, 0);
    await dom.insertText('first     ');
    const before = await dom.snapshot();
    expect(before.blocks[0].leaves[0].text.replaceAll('\u00a0', ' ')).toBe(
      'first     ',
    );
    await page.locator('#outside').focus();
    await dom.clickBlockEdge(0, 0);
    await dom.placeCaret('end');
    expect((await dom.snapshot()).caret).toEqual({
      blockIndex: 0,
      leafIndex: 0,
      offset: 10,
    });
    await dom.insertText('TAIL');
    expect(
      (await dom.snapshot()).blocks[0].leaves[0].text.replaceAll('\u00a0', ' '),
    ).toBe('first     TAIL');
    await expect(page.locator('li').nth(1)).toHaveText('untouched');
    await expect(page.locator('p')).toHaveText('next block');
  });
}

for (const spaces of [' ', '     '])
  test(`literal ${spaces.length} collapsed terminal spaces stop without crossing into the next leaf`, async ({
    page,
  }) => {
    await editor(
      page,
      `<ul><li>first${spaces}</li><li>untouched</li></ul>`,
      '.ProseMirror { white-space:normal }',
    );
    const dom = createPlaywrightEditorDom(page);
    await dom.clickBlockEdge(0, 0);
    await expect(dom.placeCaret('end')).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'caret-not-at-leaf-end',
    });
    expect((await dom.snapshot()).caret).toEqual({
      blockIndex: 0,
      leafIndex: 0,
      offset: 5,
    });
    expect((await dom.snapshot()).blocks[0].leaves[0].text).toBe(
      `first${spaces}`,
    );
    await expect(page.locator('li').nth(1)).toHaveText('untouched');
  });

test('plain appendParagraph recovers the same covered empty tail through its production entry', async ({
  context,
  page,
}) => {
  const f = await installProductionFixture(context, {
    observedTrailingParagraphs: true,
  });
  await page.goto(f.home);
  const pages = createJudongchePages(
    {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture-generation',
      close: async () => {},
    },
    undefined,
    {
      manualReview: true,
      ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
    },
  );
  expect((await pages.probe()).status).toBe('ready');
  await pages.enterNewEditor('合成正文定位', () => false, 'position-plain');
  await page.addStyleTag({
    content:
      'body { min-height:2400px } #body { margin-top:650px } #body p { min-height:24px } #bottom-cover { position:fixed;inset:650px 0 0;z-index:100 }',
  });
  await page.evaluate(() => {
    const blocker = document.createElement('button');
    blocker.id = 'bottom-cover';
    blocker.onclick = () => {
      blocker.dataset.clicked = 'yes';
    };
    document.body.append(blocker);
  });
  await pages.appendParagraph('plain tail content');
  await expect(page.locator('#body > p').first()).toHaveText(
    'plain tail content',
  );
  await expect(page.locator('#bottom-cover')).not.toHaveAttribute(
    'data-clicked',
    'yes',
  );
  expect(f.saves()).toBe(0);
});

for (const operation of ['appendParagraph', 'appendImage'] as const)
  for (const mutation of ['prepend', 'replace', 'remove'] as const)
    test(`production ${operation} rejects tail change after validation before helper binding: ${mutation}`, async ({
      context,
      page,
    }) => {
      const fixture = await installProductionFixture(context, {
        observedTrailingParagraphs: true,
      });
      await page.goto(fixture.home);
      let armed = false;
      let injected = false;
      let afterMutation = '';
      const injectAfterIndex = async (value: unknown) => {
        if (!armed || injected || typeof value !== 'number' || value < 0)
          return;
        injected = true;
        await page.evaluate((mutation) => {
          const body = document.querySelector('#body')!;
          const tail = body.querySelector(':scope > p:last-of-type')!;
          if (mutation === 'remove') {
            tail.remove();
            return;
          }
          const foreign = document.createElement('p');
          foreign.id = 'unverified-tail';
          foreign.textContent = 'UNVERIFIED';
          foreign.onclick = () => {
            foreign.dataset.clicked = 'yes';
          };
          if (mutation === 'replace') tail.replaceWith(foreign);
          else tail.before(foreign);
        }, mutation);
        afterMutation = await page.locator('#body').innerHTML();
      };
      const wrapHandle = (
        handle: ElementHandle<HTMLElement | SVGElement> | null,
      ) =>
        handle &&
        new Proxy(handle, {
          get(target, key) {
            if (key === 'evaluate')
              return async (...args: Parameters<typeof target.evaluate>) => {
                const value = await target.evaluate(...args);
                await injectAfterIndex(value);
                return value;
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const wrapLocator = (locator: Locator, tail = false): Locator =>
        new Proxy(locator, {
          get(target, key) {
            if (key === 'locator')
              return (...args: Parameters<Locator['locator']>) =>
                wrapLocator(target.locator(...args), args[0] === ':scope > p');
            if (key === 'last') return () => wrapLocator(target.last(), tail);
            if (tail && key === 'elementHandle')
              return async (...args: Parameters<Locator['elementHandle']>) =>
                wrapHandle(await target.elementHandle(...args));
            if (tail && key === 'evaluate')
              return async (...args: Parameters<Locator['evaluate']>) => {
                const value = await target.evaluate(...args);
                await injectAfterIndex(value);
                return value;
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const wrappedPage = new Proxy(page, {
        get(target, key) {
          if (key === 'locator')
            return (...args: Parameters<Page['locator']>) =>
              wrapLocator(target.locator(...args));
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const wrappedContext = new Proxy(context, {
        get(target, key) {
          if (key === 'pages')
            return () =>
              target
                .pages()
                .map((candidate) =>
                  candidate === page ? wrappedPage : candidate,
                );
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const pages = createJudongchePages(
        {
          open: async () => wrappedContext,
          current: () => wrappedContext,
          generation: () => 'fixture-generation',
          close: async () => {},
        },
        undefined,
        {
          manualReview: true,
          ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
        },
      );
      expect((await pages.probe()).status).toBe('ready');
      await pages.enterNewEditor(
        '合成尾段身份',
        () => false,
        `fix1-${operation}-${mutation}`,
      );
      await page.locator('#imageTool').evaluate((button) =>
        button.addEventListener('click', () => {
          (button as HTMLElement).dataset.clicked = 'yes';
        }),
      );
      armed = true;
      const action =
        operation === 'appendParagraph'
          ? pages.appendParagraph('MUST_NOT_INSERT')
          : pages.appendImage(
              Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
                'base64',
              ),
              'image/png',
            );
      await expect(action).rejects.toMatchObject({ reason: 'PAGE_CHANGED' });
      expect(injected).toBe(true);
      expect(await page.locator('#body').innerHTML()).toBe(afterMutation);
      if (mutation !== 'remove')
        await expect(page.locator('#unverified-tail')).not.toHaveAttribute(
          'data-clicked',
          'yes',
        );
      expect(fixture.uploads()).toBe(0);
      expect(fixture.saves()).toBe(0);
      await expect(page.locator('#imageTool')).not.toHaveAttribute(
        'data-clicked',
        'yes',
      );
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    });
