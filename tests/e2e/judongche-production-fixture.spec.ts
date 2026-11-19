import { verifyAcknowledgedTitleEdit } from '../../src/infrastructure/platforms/judongche/content-evidence';
import { makeDraftTask } from '../fixtures/draft-task';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { reduceTask } from '../../src/domain/draft-task';
import type { BrowserSession } from '../../src/infrastructure/automation/browser-session';
import {
  createJudongcheAdapter,
  createAdapterWithPages,
} from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import { draftHarness } from '../fixtures/draft-adapter';
import { denyExternalNetwork } from './network-policy';
import { installProductionFixture } from '../fixtures/judongche-production';
import { confirmMenuStore } from '../../src/infrastructure/platforms/judongche/production-state';

test.beforeEach(async ({ context }) => denyExternalNetwork(context));

for (const review of [
  'unique',
  'duplicate',
  'incomplete',
  'wrong-record',
  'missing-title',
  'missing-type',
] as const) {
  test(`manual saved-draft acceptance is read-only and conservative: ${review}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, {
      fullDraftReview:
        review === 'wrong-record' ||
        review === 'missing-title' ||
        review === 'missing-type'
          ? 'unique'
          : review,
    });
    await page.goto(fixture.home);
    const h = draftHarness();
    const session = {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture-generation',
      close: async () => {},
    };
    const options = {
      manualReview: true,
      ownerConfirmedPilot: {
        dealerId: '123456',
        storeName: '合成门店',
      },
    };
    const adapter = createJudongcheAdapter(session, undefined, options);
    const probe = await adapter.checkSession();
    if (probe.status !== 'ready') throw Error('not ready');
    h.task.store = probe.store;
    // Keep the real persisted store in the fixture's durable reducer as well.
    h.durable().store = probe.store;
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason: 'MANUAL_REVIEW_REQUIRED',
    });
    const task = reduceTask(
      h.durable(),
      {
        type: 'settle',
        state: 'needs_human',
        reason: 'MANUAL_REVIEW_REQUIRED',
      },
      h.task.updatedAt,
    );
    const reviewOptions = {
      ...options,
      reviewedSavedTask: {
        taskId: task.taskId,
        title: task.snapshot.article.title,
        recordKey: review === 'wrong-record' ? '999' : '501',
      },
    };
    if (review === 'missing-title' || review === 'missing-type') {
      await context.addInitScript((fault) => {
        document.addEventListener('DOMContentLoaded', () => {
          const results = document.getElementById('results');
          if (!results) return;
          new MutationObserver(() => {
            for (const card of Array.from(
              results.querySelectorAll('[class*="articleBox-"]'),
            )) {
              if (fault === 'missing-title') {
                const title = card.querySelector('p');
                if (title) title.textContent = 'unrelated draft';
              } else {
                for (const tag of Array.from(card.querySelectorAll('span'))) {
                  if (tag.textContent === '文章资讯') tag.remove();
                }
              }
            }
          }).observe(results, { childList: true });
        });
      }, review);
    }
    const diagnostics: unknown[] = [];
    const reader = createJudongcheAdapter(
      session,
      (event) => diagnostics.push(event),
      reviewOptions,
    );
    const outcome = await reader.reconcile(task);
    if (review === 'unique') {
      expect(outcome.status).toBe('verified');
      if (outcome.status === 'verified') {
        expect(outcome.evidence.remote?.recordKey).toBe('501');
        expect(outcome.evidence.images).toEqual(task.evidence.images);
      }
    } else
      expect(outcome).toEqual({
        status: 'blocked',
        reason: 'RESULT_AMBIGUOUS',
      });
    if (review === 'missing-title') {
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          check: 'draft-list-incomplete',
          reason: 'RESULT_AMBIGUOUS',
        }),
      );
    }
    if (review === 'duplicate' || review === 'missing-type') {
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          operation: 'reviewSavedDraft',
          phase: 'manual-draft-list-title',
          check: 'draft-title-observed',
          draftListObservation: {
            cardCount: review === 'duplicate' ? 2 : 1,
            exactTitleCount: review === 'duplicate' ? 2 : 1,
            articleTypeVisible: review === 'missing-type' ? false : null,
          },
        }),
      );
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          failure: true,
          draftListObservation: {
            cardCount: review === 'duplicate' ? 2 : 1,
            exactTitleCount: review === 'duplicate' ? 2 : 1,
            articleTypeVisible: review === 'missing-type' ? false : null,
          },
          check:
            review === 'duplicate'
              ? 'draft-title-multiple'
              : 'draft-article-type-missing',
        }),
      );
    }
    expect(fixture.saves()).toBe(1);
    expect(fixture.uploads()).toBe(2);
    expect(fixture.coverActions()).toBe(0);
    expect(context.pages()).toHaveLength(1);
  });
}

for (const ownerConfirmed of [
  true,
  false,
  'delayed',
  'no-banner',
  'no-workbench',
  'two-images',
  'one-image',
  'cps2-list',
  'observed-tail',
  'reopened-tail',
] as const) {
  test(`owner-confirmed single article does not depend on the store menu: ${ownerConfirmed}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, {
      observedTrailingParagraphs: ['observed-tail', 'reopened-tail'].includes(
        String(ownerConfirmed),
      ),
      observedReopenTail: ownerConfirmed === 'reopened-tail',
      delayedEditor: ownerConfirmed === 'delayed',
      listAlias: ownerConfirmed === 'cps2-list',
      ...(ownerConfirmed === 'no-banner' || ownerConfirmed === 'no-workbench'
        ? { headerShape: ownerConfirmed }
        : {}),
    });
    let menuHovers = 0;
    await context.exposeBinding('fixtureMenuHovered', () => menuHovers++);
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const account = document.getElementById('account');
        if (!account) return;
        account.onmouseenter = () => {
          void (
            window as unknown as { fixtureMenuHovered(): Promise<void> }
          ).fixtureMenuHovered();
        };
        account.onclick = null;
      });
    });
    await page.goto(
      ownerConfirmed === 'cps2-list'
        ? 'https://www.autoengine.com/jdc/dealer/info/contentPublish/content/index-cps2?pageTab=0'
        : fixture.home,
    );
    const h = draftHarness();
    h.task.snapshot.article.body = [
      { type: 'paragraph', text: 'first' },
      { type: 'image', image_id: 'X' },
      { type: 'paragraph', text: 'second' },
      { type: 'paragraph', text: 'third' },
      { type: 'image', image_id: 'X' },
      { type: 'paragraph', text: 'fourth' },
      { type: 'paragraph', text: 'fifth' },
      { type: 'image', image_id: 'X' },
      { type: 'paragraph', text: 'last' },
    ];
    h.task.snapshot.article.title = 'Selected normal single article';
    h.durable().snapshot.article.title = h.task.snapshot.article.title;
    if (ownerConfirmed === 'one-image')
      h.task.snapshot.article.body = h.task.snapshot.article.body.filter(
        (_block, index) => index !== 4 && index !== 7,
      );
    if (ownerConfirmed === 'two-images')
      h.task.snapshot.article.body = h.task.snapshot.article.body.filter(
        (_block, index) => index !== 7,
      );
    h.durable().snapshot.article.body = structuredClone(
      h.task.snapshot.article.body,
    );
    const adapter = createJudongcheAdapter(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture-generation',
        close: async () => {},
      },
      undefined,
      {
        manualReview: true,
        ...(ownerConfirmed
          ? {
              ownerConfirmedPilot: {
                dealerId: '123456',
                storeName: '合成门店',
              },
            }
          : {}),
      },
    );
    const probe = await adapter.checkSession();
    if (!ownerConfirmed) {
      expect(probe.status).toBe('blocked');
      expect(menuHovers).toBeGreaterThan(0);
      expect(fixture.uploads()).toBe(0);
      expect(fixture.saves()).toBe(0);
      return;
    }
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;
    expect(probe.store.identity.value).toBe('123456');
    h.task.store = probe.store;
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason: 'MANUAL_REVIEW_REQUIRED',
    });
    expect(fixture.uploads()).toBe(
      ownerConfirmed === 'one-image'
        ? 1
        : ownerConfirmed === 'two-images'
          ? 2
          : 3,
    );
    expect(fixture.saves()).toBe(1);
    expect(await page.locator('textarea').inputValue()).toBe(
      h.task.snapshot.article.title,
    );
    expect(fixture.coverActions()).toBe(0);
    expect(menuHovers).toBe(0);
    await expect(page.locator('#body [ignoreel]')).toHaveCount(0);
    expect(context.pages()).toHaveLength(1);
    expect(
      await page
        .locator('#body > *')
        .evaluateAll((nodes) =>
          nodes
            .map((node) =>
              node.tagName === 'P'
                ? node.textContent?.trim()
                : node.querySelector('.pgc-image img')?.getAttribute('web_uri'),
            )
            .filter(Boolean),
        ),
    ).toEqual(
      [
        'first',
        'body-1',
        'second',
        'third',
        'body-2',
        'fourth',
        'fifth',
        'body-3',
        'last',
      ].filter((value) =>
        ownerConfirmed === 'one-image'
          ? value !== 'body-2' && value !== 'body-3'
          : ownerConfirmed !== 'two-images' || value !== 'body-3',
      ),
    );
    expect(h.durable().evidence.images.map((image) => image.bodyIndex)).toEqual(
      ownerConfirmed === 'one-image'
        ? [1]
        : ownerConfirmed === 'two-images'
          ? [1, 4]
          : [1, 4, 7],
    );
    if (
      ownerConfirmed === 'observed-tail' ||
      ownerConfirmed === 'reopened-tail'
    ) {
      await page.goto(
        'https://www.autoengine.com/jdc/dealer/info/Article?pgc_id=501&pgc_status=3',
      );
      await expect(page.locator('textarea')).toHaveValue(
        'Selected normal single article',
      );
      const savedStructure = await page
        .locator('#body > *')
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            node.tagName === 'P'
              ? node.textContent
              : node.querySelector('.pgc-image img')?.getAttribute('web_uri'),
          ),
        );
      expect(savedStructure).toEqual([
        'first',
        'body-1',
        'second',
        'third',
        'body-2',
        'fourth',
        'fifth',
        'body-3',
        'last',
        '',
      ]);
      expect(fixture.saves()).toBe(1);
    }
    await adapter.execute(h.task, h.hooks);
    expect(fixture.saves()).toBe(1);
    expect(fixture.uploads()).toBe(
      ownerConfirmed === 'one-image'
        ? 1
        : ownerConfirmed === 'two-images'
          ? 2
          : 3,
    );
  });
}

for (const scenario of [
  'empty',
  'body-drift',
  'title-drift',
  'populated',
  'unknown',
] as const) {
  test(`single article ignores manual cover and permits body normalization: ${scenario}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, {
      headerShape: 'no-workbench',
    });
    await page.goto(fixture.home);
    const h = draftHarness();
    h.task.snapshot.article.body = [
      { type: 'paragraph', text: 'first' },
      { type: 'image', image_id: 'X' },
      { type: 'paragraph', text: 'second' },
      { type: 'paragraph', text: 'third' },
      { type: 'image', image_id: 'X' },
      { type: 'paragraph', text: 'fourth' },
      { type: 'paragraph', text: 'fifth' },
      { type: 'image', image_id: 'X' },
      { type: 'paragraph', text: 'last' },
    ];
    h.durable().snapshot.article.body = structuredClone(
      h.task.snapshot.article.body,
    );
    let fullReads = 0;
    const evaluate = page.evaluate.bind(page);
    page.evaluate = (async (...args: Parameters<Page['evaluate']>) => {
      const arg = args[1];
      if (
        arg &&
        typeof arg === 'object' &&
        'title' in arg &&
        'body' in arg &&
        'emptyPlaceholder' in arg &&
        !('imageOnly' in arg && arg.imageOnly)
      )
        fullReads++;
      return evaluate(...args);
    }) as Page['evaluate'];
    const adapter = createJudongcheAdapter(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture-generation',
        close: async () => {},
      },
      undefined,
      {
        manualReview: true,
        ownerConfirmedPilot: {
          dealerId: '123456',
          storeName: '合成门店',
        },
      },
    );
    const probe = await adapter.checkSession();
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;
    h.task.store = probe.store;
    {
      const evidence = h.hooks.evidence;
      h.hooks.evidence = async (value) => {
        await evidence(value);
        if (value.images.length === 1) fullReads = 0;
        if (value.images.length === 3) {
          if (scenario === 'body-drift')
            await page
              .locator('#body > p')
              .first()
              .evaluate((e) => (e.textContent = 'changed'));
          else if (scenario === 'title-drift')
            await page.locator('textarea').fill('Unexpected editor title');
          else if (scenario !== 'empty')
            await page.locator('.article-cover-images').evaluate((e, state) => {
              if (state === 'unknown') e.remove();
              else {
                const selected = document.createElement('div');
                for (let i = 0; i < 3; i++) {
                  const image = document.createElement('img');
                  image.src = '/fixture/image';
                  selected.append(image);
                }
                e.append(selected);
              }
            }, scenario);
        }
      };
    }
    fullReads = 0;
    const checkContext = adapter.checkSession as (
      contextOnly?: boolean,
    ) => ReturnType<typeof adapter.checkSession>;
    expect((await checkContext(true)).status).toBe('ready');
    expect((await checkContext(true)).status).toBe('ready');
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason:
        scenario === 'title-drift'
          ? 'CONTENT_MISMATCH'
          : 'MANUAL_REVIEW_REQUIRED',
    });
    // Entry stays strict. Once writing starts, operation reads never require
    // the complete text projection, including final/save reads.
    expect(fullReads).toBe(0);
    expect(fixture.uploads()).toBe(3);
    expect(fixture.saves()).toBe(scenario === 'title-drift' ? 0 : 1);
    expect(h.durable().saveAttempted).toBe(scenario !== 'title-drift');
    expect(fixture.coverActions()).toBe(0);
    expect((await page.locator('#body > p').last().innerText()).trim()).toBe(
      '',
    );
    expect(
      (await page.locator('#body > p').allTextContents())
        .map((text) => text.trim())
        .filter(Boolean)
        .at(-1),
    ).toBe('last');
    expect(await page.locator('textarea').inputValue()).toBe(
      scenario === 'title-drift'
        ? 'Unexpected editor title'
        : h.task.snapshot.article.title,
    );
    await adapter.execute(h.task, h.hooks);
    expect(fixture.saves()).toBe(scenario === 'title-drift' ? 0 : 1);
    expect(fixture.uploads()).toBe(3);
  });
}

for (const unsafe of [
  'login',
  'verification',
  'dialog',
  'editor-verification',
] as const) {
  test(`owner-confirmed single article still stops on ${unsafe}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, {
      editorSafety: unsafe === 'editor-verification',
    });
    await page.goto(fixture.home);
    const h = draftHarness();
    const adapter = createJudongcheAdapter(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture-generation',
        close: async () => {},
      },
      undefined,
      {
        manualReview: true,
        ownerConfirmedPilot: {
          dealerId: '123456',
          storeName: '合成门店',
        },
      },
    );
    const probe = await adapter.checkSession();
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;
    h.task.store = probe.store;
    if (unsafe !== 'editor-verification')
      await page.evaluate((value) => {
        const node = document.createElement('div');
        if (value === 'dialog') node.setAttribute('role', 'dialog');
        node.textContent =
          value === 'login'
            ? '巨懂车欢迎您'
            : value === 'verification'
              ? '安全验证'
              : '未知确认';
        document.body.append(node);
      }, unsafe);
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason:
        unsafe === 'login'
          ? 'LOGIN_REQUIRED'
          : unsafe === 'verification' || unsafe === 'editor-verification'
            ? 'VERIFICATION_REQUIRED'
            : 'PAGE_CHANGED',
    });
    expect(fixture.uploads()).toBe(0);
    expect(fixture.saves()).toBe(0);
  });
}

for (const saveFailure of [false, true]) {
  test(`controlled submission writes once without searches: saveFailure=${saveFailure}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, { saveFailure });
    let searches = 0;
    context.on('request', (request) => {
      if (
        request.url().includes('/fixture/list') ||
        request.url().includes('/content/index')
      )
        searches++;
    });
    await page.goto(fixture.home);
    const adapter = createJudongcheAdapter(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture-generation',
        close: async () => {},
      },
      undefined,
      { manualReview: true },
    );
    const probe = await adapter.checkSession();
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;
    const h = draftHarness();
    h.task.store = probe.store;
    const result = await adapter.execute(h.task, h.hooks);
    expect(result).toEqual({
      status: 'blocked',
      reason: saveFailure ? 'RESULT_AMBIGUOUS' : 'MANUAL_REVIEW_REQUIRED',
    });
    expect(searches).toBe(0);
    expect(fixture.saves()).toBe(1);
    expect(fixture.uploads()).toBe(2);
    expect(fixture.coverActions()).toBe(0);
    expect(h.durable().evidence.images.map((image) => image.bodyIndex)).toEqual(
      [1, 2],
    );
    expect(await adapter.execute(h.task, h.hooks)).toMatchObject({
      status: 'blocked',
    });
    expect(fixture.saves()).toBe(1);
  });
}
for (const imageClose of [
  'delayed',
  'file-detached',
  'unknown-dialog',
] as const) {
  test(`image dialog teardown keeps content order and other dialogs blocked: ${imageClose}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, { imageClose });
    await page.goto(fixture.home);
    const events: import('../../src/infrastructure/platforms/judongche/production-pages').ProbeDiagnostic[] =
      [];
    const adapter = createJudongcheAdapter(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture-generation',
        close: async () => {},
      },
      (event) => events.push(event),
      { manualReview: true },
    );
    const probe = await adapter.checkSession();
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;
    const h = draftHarness();
    h.task.store = probe.store;
    h.task.snapshot.article.body = [
      { type: 'paragraph', text: 'first' },
      { type: 'image', image_id: 'X' },
      { type: 'paragraph', text: 'middle' },
      { type: 'image', image_id: 'X' },
      { type: 'paragraph', text: 'last' },
      { type: 'image', image_id: 'X' },
      { type: 'paragraph', text: 'end' },
    ];
    h.durable().snapshot.article.body = structuredClone(
      h.task.snapshot.article.body,
    );
    const result = await adapter.execute(h.task, h.hooks);
    expect(result).toEqual({
      status: 'blocked',
      reason:
        imageClose !== 'unknown-dialog'
          ? 'MANUAL_REVIEW_REQUIRED'
          : 'PAGE_CHANGED',
    });
    expect(fixture.coverActions()).toBe(0);
    if (imageClose !== 'unknown-dialog') {
      expect(fixture.uploads()).toBe(3);
      expect(fixture.saves()).toBe(1);
      expect(
        h.durable().evidence.images.map((image) => image.bodyIndex),
      ).toEqual([1, 3, 5]);
      expect(events.some((event) => event.failure)).toBe(false);
      expect(
        await page
          .locator('#body > *')
          .evaluateAll((nodes) =>
            nodes
              .map((node) =>
                node.tagName === 'P'
                  ? node.textContent?.trim()
                  : node
                      .querySelector('.pgc-image img')
                      ?.getAttribute('web_uri'),
              )
              .filter(Boolean),
          ),
      ).toEqual([
        'first',
        'body-1',
        'middle',
        'body-2',
        'last',
        'body-3',
        'end',
      ]);
    } else {
      expect(fixture.uploads()).toBe(1);
      expect(fixture.saves()).toBe(0);
      expect(h.durable().saveAttempted).toBe(false);
      expect(events.find((event) => event.failure)).toMatchObject({
        operation: 'appendImage',
        phase: 'guard-safety',
        check: 'unknown-dialog',
      });
    }
    await adapter.execute(h.task, h.hooks);
    expect(fixture.saves()).toBe(imageClose !== 'unknown-dialog' ? 1 : 0);
    expect(fixture.uploads()).toBe(imageClose !== 'unknown-dialog' ? 3 : 1);
  });
}

test('read-only probe records bounded editor entry structure without opening editor', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context);
  await page.goto(fixture.home);
  const events: unknown[] = [];
  const pages = createJudongchePages(
    {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture-generation',
      close: async () => {},
    },
    (event) => events.push(event),
  );
  expect((await pages.probe()).status).toBe('ready');
  expect(events.at(-1)).toMatchObject({
    entryStructure: {
      labelCount: 1,
      directParentButtonCount: 0,
      labels: [
        {
          visible: true,
          ancestors: expect.arrayContaining([
            expect.objectContaining({
              depth: 1,
              tag: 'div',
              publishCount: 0,
            }),
            expect.objectContaining({ depth: 2, tag: 'div', publishCount: 1 }),
          ]),
        },
      ],
    },
  });
  expect(JSON.stringify(events)).not.toMatch(/合成账号|合成门店|https:/);
  expect(page.url()).toBe(fixture.home);
  expect(context.pages()).toHaveLength(1);
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
});

test('a dismissed menu under the stationary pointer requires one fresh entry before store validation', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context);
  await page.goto(fixture.home);
  await page.locator('#account').hover();
  await page.locator('#menu').evaluate((node) => {
    (node as HTMLElement).hidden = true;
  });
  await expect(confirmMenuStore(page, '合成门店')).resolves.toBeUndefined();
  expect(await page.locator('#menu').isVisible()).toBe(false);
  expect(
    await page.evaluate(
      () => (window as unknown as { menuClicks: number }).menuClicks,
    ),
  ).toBe(0);
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
});

test('manual-review builds close unsaved tasks through the exact-title query', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    inputSearch: true,
  });
  await page.goto(fixture.home);
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture-generation',
    close: async () => {},
  };
  const adapter = createJudongcheAdapter(session, undefined, {
    manualReview: true,
    ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
  });
  const probe = await adapter.checkSession();
  if (probe.status !== 'ready') throw Error('not ready');
  const task = makeDraftTask({
    state: 'needs_human',
    stage: 'settled',
    possibleRemoteEffect: true,
    reason: 'PAGE_CHANGED',
    store: probe.store,
  });
  const result = await adapter.checkAbsence(task);
  expect(result.status).toBe('absent');
  if (result.status !== 'absent') return;
  expect(result.proof).toMatchObject({
    taskId: task.taskId,
    revision: task.revision,
    snapshotDigest: task.snapshot.digest,
    storeKey: probe.store.storeKey,
    generation: probe.generation,
  });
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
});

test('hover account menu supports read-only draft query without toggling it by click', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    inputSearch: true,
  });
  await page.goto(fixture.home);
  const observations: unknown[] = [];
  const pages = createJudongchePages(
    {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture-generation',
      close: async () => {},
    },
    (event) => observations.push(event.menuObservations),
  );
  expect((await pages.probe()).status).toBe('ready');
  expect(await pages.inspectDraftAbsence!('unique-readonly-title')).toBe(true);
  expect(await page.locator('#menu').isVisible()).toBe(false);
  expect(
    await page.evaluate(
      () => (window as unknown as { menuClicks: number }).menuClicks,
    ),
  ).toBe(0);
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
  expect(observations.flat()).toContainEqual(
    expect.objectContaining({
      point: 'after-hover',
      entryCount: 1,
      entryVisible: true,
      entryHovered: true,
      entryCenterHit: true,
      documentChanged: false,
    }),
  );
  expect(JSON.stringify(observations)).not.toMatch(
    /合成账号|合成门店|unique-readonly-title|https:/,
  );
});

test('first menu failure keeps its step before cleanup and later successful probes', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context);
  await page.goto(fixture.home);
  const events: import('../../src/infrastructure/platforms/judongche/production-pages').ProbeDiagnostic[] =
    [];
  const pages = createJudongchePages(
    {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture-generation',
      close: async () => {},
    },
    (event) => events.push(event),
  );
  expect((await pages.probe()).status).toBe('ready');
  await page.locator('#menu strong').evaluate((node) => {
    node.textContent = 'private-wrong-store';
  });
  await expect(
    pages.enterNewEditor('private-title', () => false, randomUUID()),
  ).rejects.toMatchObject({ reason: 'STORE_CHANGED' });
  const failure = events.find((event) => event.failure);
  expect(failure).toMatchObject({
    operation: 'enterNewEditor',
    phase: 'guard-store-menu/menu-store-card',
    exceptionCategory: 'platform-guard',
    pageState: 'home',
    reason: 'STORE_CHANGED',
  });
  expect((await pages.probe()).status).toBe('blocked');
  expect(events.at(-1)?.firstFailure).toMatchObject({
    operation: 'probe',
    phase: 'primary-store-menu/menu-store-card',
    reason: 'STORE_CHANGED',
    exceptionCategory: 'platform-guard',
  });
  const failuresBeforeRefresh = events.filter((event) => event.failure);
  await page.goto(fixture.home);
  expect((await pages.probe()).status).toBe('ready');
  expect(events.at(-1)?.firstFailure).toBeUndefined();
  expect(events.filter((event) => event.failure)).toEqual(
    failuresBeforeRefresh,
  );
  expect(JSON.stringify(events)).not.toMatch(
    /private-title|private-wrong-store/,
  );
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
});

test('explicit read-only absence after a previous execution stop does not revive its write capabilities', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    inputSearch: true,
  });
  await page.goto(fixture.home);
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture-generation',
    close: async () => {},
  };
  const pages = createJudongchePages(session);
  const adapter = createAdapterWithPages(session, pages);
  const probe = await adapter.checkSession();
  if (probe.status !== 'ready') throw new Error('fixture not ready');
  const h = draftHarness();
  let stopped = false;
  await pages.enterNewEditor(
    h.task.snapshot.article.title,
    () => stopped,
    h.task.taskId,
  );
  stopped = true;
  const task = {
    ...h.task,
    store: probe.store,
    state: 'needs_human' as const,
    stage: 'settled' as const,
    saveAttempted: false,
    possibleRemoteEffect: true,
    stopRequested: true,
    holdsPlatform: true,
    evidence: { remote: null, images: [], cover: null },
  };
  expect((await adapter.checkAbsence(task)).status).toBe('absent');
  await expect(
    pages.fillTitle(task.snapshot.article.title),
  ).rejects.toMatchObject({ reason: 'STOP_REQUESTED' });
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
  expect(fixture.coverActions()).toBe(0);
});

test('input-triggered title search is observed before fill; read-only zero does not unlock or save', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    inputSearch: true,
  });
  await page.goto(fixture.home);
  const events: { check: string }[] = [];
  const adapter = createJudongcheAdapter(
    {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture-generation',
      close: async () => {},
    },
    (event) => events.push(event),
  );
  const probe = await adapter.checkSession();
  expect(probe.status).toBe('ready');
  if (probe.status !== 'ready') return;
  const h = draftHarness();
  h.task.store = probe.store;
  h.task.snapshot.article.title = '图文 搜索时序回归';
  h.task.evidence.remote = null;
  const before = structuredClone(h.task);
  expect(await adapter.reconcile(h.task)).toEqual({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(events.at(-1)?.check).toBe('exact-title-absent');
  expect(h.task).toEqual(before);
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
  expect(fixture.coverActions()).toBe(0);
  expect(context.pages()).toHaveLength(1);
});

for (const duplicate of [false, true]) {
  test(`missing remote ID reconciliation checks title absence without saving or releasing task: duplicate=${duplicate}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, { duplicate });
    await page.goto(fixture.home);
    const events: { check: string; phase: string }[] = [];
    const adapter = createJudongcheAdapter(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture-generation',
        close: async () => {},
      },
      (event) => events.push(event),
    );
    const probe = await adapter.checkSession();
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;
    const h = draftHarness();
    h.task.store = probe.store;
    h.task.evidence.remote = null;
    const before = structuredClone(h.task);
    expect(await adapter.reconcile(h.task)).toEqual({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(events.at(-1)?.check).toBe(
      duplicate ? 'absence-unconfirmed' : 'exact-title-absent',
    );
    expect(events.at(-1)).toMatchObject({
      searchDiagnostic: {
        requestTitleExact: true,
        inputTitleExact: true,
        visibleCards: duplicate ? 1 : 0,
        exactTitleMatches: duplicate ? 1 : 0,
        emptyVisible: !duplicate,
        endVisible: duplicate,
      },
    });
    const closeable = {
      ...h.task,
      state: 'needs_human' as const,
      stage: 'settled' as const,
      possibleRemoteEffect: true,
      saveAttempted: false,
      stopRequested: false,
      holdsPlatform: true,
      evidence: { remote: null, images: [], cover: null },
    };
    const absence = await adapter.checkAbsence(closeable);
    expect(absence.status).toBe('absent');
    if (absence.status === 'absent')
      expect(absence.proof).toMatchObject({
        taskId: closeable.taskId,
        revision: closeable.revision,
        snapshotDigest: closeable.snapshot.digest,
        storeKey: probe.store.storeKey,
        generation: probe.generation,
      });
    expect(h.task).toEqual(before);
    expect(fixture.saves()).toBe(0);
    expect(fixture.uploads()).toBe(0);
    expect(fixture.coverActions()).toBe(0);
    expect(context.pages()).toHaveLength(1);
  });
}

test('production probe distinguishes inert backgrounds and diagnoses unsafe pages without exposing page data', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context);
  const diagnostics: unknown[] = [];
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture-generation',
    close: async () => {},
  };
  const pages = createJudongchePages(session, (event) =>
    diagnostics.push(event),
  );
  await page.goto(fixture.home + '?private=do-not-log-this');
  expect(await pages.probe()).toMatchObject({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(diagnostics.at(-1)).toMatchObject({
    phase: 'primary-safety',
    check: 'url-not-allowed',
    reason: 'PAGE_CHANGED',
  });
  expect(JSON.stringify(diagnostics)).not.toContain('do-not-log-this');
  await page.goto(fixture.home);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
  });
  expect(await pages.probe()).toMatchObject({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(diagnostics.at(-1)).toMatchObject({ check: 'visible-iframe' });
  const throwing = createJudongchePages(session, () => {
    throw new Error('diagnostic unavailable');
  });
  expect(await throwing.probe()).toMatchObject({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  await page.goto(fixture.home);
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'private-account-do-not-log';
    overlay.textContent = 'private-content-do-not-log';
    overlay.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:9999;background-image:linear-gradient(transparent,transparent)';
    document.body.append(overlay);
  });
  expect(await pages.probe()).toMatchObject({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(diagnostics.at(-1)).toMatchObject({
    check: 'blocking-overlay',
    overlay: {
      tag: 'div',
      widthRatio: 1,
      heightRatio: 1,
      pointerEventsNone: true,
      interactiveDescendants: 0,
      childCount: 0,
      hasBackgroundImage: true,
      hasText: true,
      hasShadowRoot: false,
    },
  });
  expect(JSON.stringify(diagnostics)).not.toContain('private-account');
  expect(JSON.stringify(diagnostics)).not.toContain('private-content');
  await page.evaluate(() => {
    document.getElementById('private-account-do-not-log')!.textContent = '';
  });
  expect(await pages.probe()).toMatchObject({ status: 'ready' });
  await page.evaluate(() => {
    document.getElementById(
      'private-account-do-not-log',
    )!.style.backgroundColor = 'black';
  });
  expect(await pages.probe()).toMatchObject({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  await page.evaluate(() => {
    document.getElementById(
      'private-account-do-not-log',
    )!.style.backgroundColor = 'transparent';
    const button = document.createElement('button');
    button.style.pointerEvents = 'auto';
    document.getElementById('private-account-do-not-log')!.append(button);
  });
  expect(await pages.probe()).toMatchObject({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(diagnostics.at(-1)).toMatchObject({
    overlay: { interactiveDescendants: 1, childCount: 1 },
  });
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
});

for (const assembly of ['adapter-factory', 'pages-factory'] as const)
  test(`production factory writes ordered body images once and reopens one coverless draft: ${assembly}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context);
    await page.goto(fixture.home);
    const session: BrowserSession = {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture-generation',
      close: async () => {},
    };
    const diagnostics: unknown[] = [];
    const pages =
      assembly === 'pages-factory'
        ? createJudongchePages(session, (value) => diagnostics.push(value))
        : undefined;
    const adapter = pages
      ? createAdapterWithPages(
          session,
          pages,
          createJudongcheAdapter(session).contentCapabilities(),
        )
      : createJudongcheAdapter(session, (value) => diagnostics.push(value));
    const probe = await adapter.checkSession();
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;
    const h = draftHarness();
    h.task.store = probe.store;
    h.task.taskId = randomUUID();
    const result = await adapter.execute(h.task, h.hooks);
    if (result.status !== 'verified')
      throw Error(JSON.stringify({ result, diagnostic: diagnostics.at(-1) }));
    expect({ result, diagnostics }).toMatchObject({
      result: { status: 'verified' },
    });
    expect(fixture.saves()).toBe(1);
    expect(fixture.uploads()).toBe(2);
    expect(fixture.coverActions()).toBe(0);
    expect(h.durable().evidence.images.map((image) => image.bodyIndex)).toEqual(
      [1, 2],
    );
    if (pages) {
      const insert = page.keyboard.insertText.bind(page.keyboard),
        press = page.keyboard.press.bind(page.keyboard);
      let resumedActions = 0;
      page.keyboard.insertText = async (...args) => {
        resumedActions++;
        return insert(...args);
      };
      page.keyboard.press = async (...args) => {
        resumedActions++;
        return press(...args);
      };
      try {
        await expect(
          pages.appendParagraph('must remain read only'),
        ).rejects.toMatchObject({
          reason: 'PAGE_CHANGED',
          check: 'operation-root-changed',
        });
        expect(resumedActions).toBe(0);
      } finally {
        page.keyboard.insertText = insert;
        page.keyboard.press = press;
      }
    }
    expect(await adapter.execute(h.task, h.hooks)).toMatchObject({
      status: 'blocked',
    });
    expect(fixture.saves()).toBe(1);
    expect(fixture.uploads()).toBe(2);
  });

test('ambiguous buttons in the observed article card block before editor entry', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    ambiguousEntry: true,
  });
  await page.goto(fixture.home);
  const pages = createJudongchePages({
    open: async () => context,
    current: () => context,
    generation: () => 'fixture-generation',
    close: async () => {},
  });
  expect((await pages.probe()).status).toBe('ready');
  await expect(
    pages.enterNewEditor('unique-title', () => false, randomUUID()),
  ).rejects.toMatchObject({ reason: 'PAGE_CHANGED' });
  expect(page.url()).toContain('/sceneMarketing');
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
});

test('production factory does not enter or save when a same-title draft exists', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, { duplicate: true });
  await page.goto(fixture.home);
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture',
    close: async () => {},
  };
  const adapter = createJudongcheAdapter(session);
  const probe = await adapter.checkSession();
  expect(probe.status).toBe('ready');
  if (probe.status !== 'ready') return;
  const h = draftHarness();
  h.task.store = probe.store;
  expect(await adapter.execute(h.task, h.hooks)).toMatchObject({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
});

test('failed save is never retried and does not return draft evidence', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    saveFailure: true,
  });
  await page.goto(fixture.home);
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture',
    close: async () => {},
  };
  const adapter = createJudongcheAdapter(session);
  const probe = await adapter.checkSession();
  expect(probe.status).toBe('ready');
  if (probe.status !== 'ready') return;
  const h = draftHarness();
  h.task.store = probe.store;
  expect(await adapter.execute(h.task, h.hooks)).toEqual({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(fixture.saves()).toBe(1);
  expect(h.durable().evidence.remote).toBeNull();
  await expect(page.locator('#body [ignoreel]')).toHaveCount(0);
  expect(await adapter.execute(h.task, h.hooks)).toMatchObject({
    status: 'blocked',
  });
  expect(fixture.saves()).toBe(1);
  expect(fixture.coverActions()).toBe(0);
});

test('security challenge prevents all production writes', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, { safety: true });
  await page.goto(fixture.home);
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture',
    close: async () => {},
  };
  expect(await createJudongcheAdapter(session).checkSession()).toEqual({
    status: 'blocked',
    reason: 'VERIFICATION_REQUIRED',
  });
  expect(fixture.uploads()).toBe(0);
  expect(fixture.saves()).toBe(0);
});

test('stop at upload completion cannot confirm the image or save', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context);
  await page.goto(fixture.home);
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture',
    close: async () => {},
  };
  const adapter = createJudongcheAdapter(session);
  const probe = await adapter.checkSession();
  expect(probe.status).toBe('ready');
  if (probe.status !== 'ready') return;
  const h = draftHarness();
  h.task.store = probe.store;
  h.hooks.stopped = () => fixture.uploads() > 0;
  expect(await adapter.execute(h.task, h.hooks)).toEqual({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(fixture.uploads()).toBe(1);
  expect(fixture.saves()).toBe(0);
  expect(await page.locator('div[__syl_tag]').count()).toBe(0);
});

test('old empty results plus an unrelated request never prove zero same-title drafts', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    staleSearch: true,
  });
  await page.goto(fixture.home);
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture',
    close: async () => {},
  };
  const adapter = createJudongcheAdapter(session);
  const probe = await adapter.checkSession();
  expect(probe.status).toBe('ready');
  if (probe.status !== 'ready') return;
  const h = draftHarness();
  h.task.store = probe.store;
  expect(await adapter.execute(h.task, h.hooks)).toEqual({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(fixture.saves()).toBe(0);
  expect(fixture.uploads()).toBe(0);
});

test('explicit browser reopen reidentifies the store with the new generation', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context);
  await page.goto(fixture.home);
  let generation = 'first';
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => generation,
    close: async () => {},
  };
  const pages = createJudongchePages(session);
  expect(await pages.probe()).toMatchObject({
    status: 'ready',
    generation: 'first',
  });
  await page.close();
  generation = 'second';
  const next = await context.newPage();
  await next.goto(fixture.home);
  expect(await pages.probe()).toMatchObject({
    status: 'ready',
    generation: 'second',
  });
});

test('closing at initial login before binding can reopen and identify', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context);
  await context.route(
    fixture.home,
    (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<meta charset="utf-8"><div>巨懂车欢迎您</div>',
      }),
    { times: 1 },
  );
  await page.goto(fixture.home);
  let generation = 'first';
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => generation,
    close: async () => {},
  };
  const pages = createJudongchePages(session);
  expect(await pages.probe()).toEqual({
    status: 'blocked',
    reason: 'LOGIN_REQUIRED',
  });
  await page.close();
  generation = 'second';
  const next = await context.newPage();
  await next.goto(fixture.home);
  expect(await pages.probe()).toMatchObject({
    status: 'ready',
    generation: 'second',
  });
});

test('a search request with no response terminates without upload or save', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, { hungSearch: true });
  await page.goto(fixture.home);
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture',
    close: async () => {},
  };
  const adapter = createJudongcheAdapter(session);
  const probe = await adapter.checkSession();
  expect(probe.status).toBe('ready');
  if (probe.status !== 'ready') return;
  const h = draftHarness();
  h.task.store = probe.store;
  expect(await adapter.execute(h.task, h.hooks)).toEqual({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(fixture.uploads()).toBe(0);
  expect(fixture.saves()).toBe(0);
});

type Fault =
  | 'valid'
  | 'hidden'
  | 'wrong'
  | 'ambiguous'
  | 'separate-card'
  | 'verification'
  | 'dialog'
  | 'new-document'
  | 'other-error';

// Inject only the input acknowledgement failure. DOM recognition, safety,
// document identity, store matching and cleanup run against the real fixture.
function acknowledgementFault(page: Page, fault: Fault) {
  let attempts = 0;
  function wrap(locator: Locator, account = false): Locator {
    return new Proxy(locator, {
      get(target, property) {
        if (property === 'getByText')
          return (...args: Parameters<Locator['getByText']>) =>
            wrap(target.getByText(...args), args[0] === '合成账号');
        if (property === 'hover' && account)
          return async (...args: Parameters<Locator['hover']>) => {
            attempts++;
            await target.hover(...args);
            if (fault === 'new-document') {
              await page.reload();
              await page.locator('#menu').evaluate((node) => {
                (node as HTMLElement).hidden = false;
              });
            } else {
              await page.evaluate((kind) => {
                const menu = document.getElementById('menu')!;
                if (kind === 'hidden') menu.hidden = true;
                if (kind === 'wrong')
                  menu.querySelector('strong')!.textContent = '错误门店';
                if (kind === 'ambiguous')
                  menu.append(menu.lastElementChild!.cloneNode(true));
                if (kind === 'separate-card')
                  menu.append(menu.querySelector('strong')!);
                if (kind === 'verification' || kind === 'dialog') {
                  const warning = document.createElement('div');
                  if (kind === 'dialog') warning.setAttribute('role', 'dialog');
                  warning.textContent =
                    kind === 'verification' ? '安全验证' : '未知弹窗';
                  document.body.append(warning);
                }
              }, fault);
            }
            const error = new Error(
              'local acknowledgement fault; private detail must not leave diagnostics',
            );
            error.name = fault === 'other-error' ? 'TypeError' : 'TimeoutError';
            throw error;
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  const wrapped = new Proxy(page, {
    get(target, property) {
      if (property === 'getByRole')
        return (...args: Parameters<Page['getByRole']>) =>
          wrap(target.getByRole(...args));
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { page: wrapped, attempts: () => attempts };
}

for (const scenario of [
  'valid',
  'hidden',
  'wrong',
  'ambiguous',
  'separate-card',
  'verification',
  'dialog',
  'new-document',
  'other-error',
] as const) {
  test(`production menu verifies fresh store evidence after one timeout: ${scenario}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context);
    await page.goto(fixture.home);
    const fault = acknowledgementFault(page, scenario);
    const observations: unknown[] = [];
    const result = confirmMenuStore(fault.page, '合成门店', {
      step: (value) => observations.push({ step: value }),
      failure: (error) =>
        observations.push({
          category: error instanceof Error ? error.name : 'non-error',
        }),
      observation: (value) => observations.push(value),
    });
    if (scenario === 'valid') await expect(result).resolves.toBeUndefined();
    else if (scenario === 'verification')
      await expect(result).rejects.toMatchObject({
        reason: 'VERIFICATION_REQUIRED',
      });
    else if (scenario === 'dialog')
      await expect(result).rejects.toMatchObject({ reason: 'PAGE_CHANGED' });
    else await expect(result).rejects.toBeDefined();
    expect(fault.attempts()).toBe(1);
    expect(fixture.saves()).toBe(0);
    expect(fixture.uploads()).toBe(0);
    expect(fixture.coverActions()).toBe(0);
    expect(JSON.stringify(observations)).not.toMatch(
      /private detail|合成账号|合成门店|错误门店/,
    );
  });
}

test('manual read mismatch can be rechecked without upload or save replay', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    fullDraftReview: 'unique',
  });
  await page.goto(fixture.home);
  const h = draftHarness();
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture-generation',
    close: async () => {},
  };
  const options = {
    manualReview: true,
    ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
  };
  const writer = createJudongcheAdapter(session, undefined, options);
  const probe = await writer.checkSession();
  if (probe.status !== 'ready') throw Error('not ready');
  h.task.store = probe.store;
  h.durable().store = probe.store;
  expect(await writer.execute(h.task, h.hooks)).toEqual({
    status: 'blocked',
    reason: 'MANUAL_REVIEW_REQUIRED',
  });
  const original = reduceTask(
    h.durable(),
    { type: 'settle', state: 'needs_human', reason: 'MANUAL_REVIEW_REQUIRED' },
    h.task.updatedAt,
  );
  const pages = createJudongchePages(session, undefined, {
    ...options,
    reviewedSavedTask: {
      taskId: original.taskId,
      title: original.snapshot.article.title,
      recordKey: '501',
    },
  });
  const read = pages.reviewSavedDraft!.bind(pages);
  let changedTitle = true;
  pages.reviewSavedDraft = async (...args) => {
    const observed = await read(...args);
    return changedTitle
      ? { ...observed, title: 'operator changed this title' }
      : observed;
  };
  const reader = createAdapterWithPages(session, pages);
  expect(await reader.reconcile(original)).toEqual({
    status: 'blocked',
    reason: 'CONTENT_MISMATCH',
  });
  const held = {
    ...original,
    reason: 'CONTENT_MISMATCH' as const,
    stopRequested: true,
  };
  // An actual title mismatch must remain blocked, even on a repeated READ.
  expect(await reader.reconcile(held)).toEqual({
    status: 'blocked',
    reason: 'CONTENT_MISMATCH',
  });
  changedTitle = false;
  const outcome = await reader.reconcile(held);
  expect(outcome.status).toBe('verified');
  if (outcome.status === 'verified')
    expect(outcome.evidence.remote?.recordKey).toBe('501');
  expect(fixture.saves()).toBe(1);
  expect(fixture.uploads()).toBe(2);
  expect(fixture.coverActions()).toBe(0);
  expect(context.pages()).toHaveLength(1);
  // Saved-task recovery never grants a read path to an unsaved task.
  expect(await reader.reconcile({ ...held, saveAttempted: false })).toEqual({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
});

for (const review of [
  'unique',
  'duplicate',
  'incomplete',
  'renamed',
] as const) {
  test(
    'automatic saved-draft review preserves manual store mode: ' + review,
    async ({ context, page }) => {
      const fixture = await installProductionFixture(context, {
        fullDraftReview: review === 'renamed' ? 'unique' : review,
        headerShape: 'no-workbench',
      });
      await page.goto(fixture.home);
      const h = draftHarness();
      const session = {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture-generation',
        close: async () => {},
      };
      const options = {
        manualReview: true,
        automaticDraftReview: true,
        ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
      };
      const pages = createJudongchePages(session, undefined, options);
      if (review === 'renamed') {
        const read = pages.reviewSavedDraft!.bind(pages);
        pages.reviewSavedDraft = async (...args) => ({
          ...(await read(...args)),
          title: 'operator changed this title',
        });
      }
      const adapter = createAdapterWithPages(session, pages);
      const probe = await adapter.checkSession();
      if (probe.status !== 'ready') throw Error('not ready');
      h.task.store = probe.store;
      h.durable().store = probe.store;
      const outcome = await adapter.execute(h.task, h.hooks);
      if (review === 'unique') {
        expect(outcome.status).toBe('verified');
        if (outcome.status === 'verified') {
          expect(outcome.evidence.remote?.recordKey).toBe('501');
          expect(outcome.evidence.images).toHaveLength(2);
          const settled = reduceTask(
            h.durable(),
            { type: 'settle', state: 'draft_saved', reason: null },
            h.task.updatedAt,
          );
          expect(settled.holdsPlatform).toBe(false);
          expect(settled.saveAttempted).toBe(true);
        }
      } else
        expect(outcome).toEqual({
          status: 'blocked',
          reason:
            review === 'renamed' ? 'CONTENT_MISMATCH' : 'RESULT_AMBIGUOUS',
        });
      expect(pages.manualReview).toBe(true);
      expect(fixture.saves()).toBe(1);
      expect(fixture.uploads()).toBe(2);
      expect(fixture.coverActions()).toBe(0);
      expect(context.pages()).toHaveLength(1);
    },
  );
}

for (const afterSave of ['unknown', 'stop', 'generation-changed'] as const) {
  test(
    'automatic readback never converts a save uncertainty or stop into success: ' +
      afterSave,
    async ({ context, page }) => {
      const fixture = await installProductionFixture(context, {
        fullDraftReview: 'unique',
      });
      await page.goto(fixture.home);
      const h = draftHarness();
      let generation = 'fixture-generation';
      const session = {
        open: async () => context,
        current: () => context,
        generation: () => generation,
        close: async () => {},
      };
      const pages = createJudongchePages(session, undefined, {
        manualReview: true,
        automaticDraftReview: true,
        ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
      });
      const save = pages.saveOnce.bind(pages),
        read = pages.reviewSavedDraft!.bind(pages);
      let reads = 0;
      pages.saveOnce = async () => {
        await save();
        if (afterSave === 'unknown') {
          const { JudongchePageError } =
            await import('../../src/infrastructure/platforms/judongche/production-state');
          throw new JudongchePageError('RESULT_AMBIGUOUS');
        }
        if (afterSave === 'stop') h.stop();
      };
      pages.reviewSavedDraft = async (...args) => {
        reads++;
        const evidence = await read(...args);
        if (afterSave === 'generation-changed') generation = 'changed';
        return evidence;
      };
      const adapter = createAdapterWithPages(session, pages);
      const probe = await adapter.checkSession();
      if (probe.status !== 'ready') throw Error('not ready');
      h.task.store = probe.store;
      h.durable().store = probe.store;
      expect(await adapter.execute(h.task, h.hooks)).toEqual({
        status: 'blocked',
        reason:
          afterSave === 'unknown'
            ? 'RESULT_AMBIGUOUS'
            : afterSave === 'stop'
              ? 'STOP_REQUESTED'
              : 'PAGE_CHANGED',
      });
      expect(reads).toBe(afterSave === 'generation-changed' ? 1 : 0);
      expect(fixture.saves()).toBe(1);
      expect(fixture.uploads()).toBe(2);
      expect(h.durable().holdsPlatform).toBe(true);
      expect(h.durable().evidence.remote).toBeNull();
      await expect(page.locator('#body [ignoreel]')).toHaveCount(0);
    },
  );
}

test('before-save checkpoint without save request cannot adopt an old same-title draft', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    fullDraftReview: 'unique',
  });
  await page.goto(fixture.home);
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture-generation',
    close: async () => {},
  };
  const options = {
    manualReview: true,
    ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
  };
  const make = () => {
    const simple = makeDraftTask({ taskId: randomUUID() });
    return draftHarness(undefined, {
      snapshot: simple.snapshot,
      taskId: simple.taskId,
    });
  };
  const old = make();
  const writer = createJudongcheAdapter(session, undefined, options);
  const firstProbe = await writer.checkSession();
  if (firstProbe.status !== 'ready') throw Error('not ready');
  old.task.store = firstProbe.store;
  old.durable().store = firstProbe.store;
  expect(await writer.execute(old.task, old.hooks)).toEqual({
    status: 'blocked',
    reason: 'MANUAL_REVIEW_REQUIRED',
  });
  expect(fixture.saves()).toBe(1);
  const current = make();
  const pages = createJudongchePages(session, undefined, options);
  const checkpoint = pages.checkWritingContext!.bind(pages);
  pages.checkWritingContext = async (...args) => {
    await checkpoint(...args);
    if (current.durable().saveAttempted) {
      const { JudongchePageError } =
        await import('../../src/infrastructure/platforms/judongche/production-state');
      throw new JudongchePageError('CONTENT_MISMATCH');
    }
  };
  const adapter = createAdapterWithPages(session, pages);
  const probe = await adapter.checkSession();
  if (probe.status !== 'ready') throw Error('not ready');
  current.task.store = probe.store;
  current.durable().store = probe.store;
  expect(await adapter.execute(current.task, current.hooks)).toEqual({
    status: 'blocked',
    reason: 'CONTENT_MISMATCH',
  });
  expect(current.durable().saveAttempted).toBe(true);
  expect(fixture.saves()).toBe(1); // The second task sent ZERO save requests.
  const held = reduceTask(
    current.durable(),
    { type: 'settle', state: 'needs_human', reason: 'CONTENT_MISMATCH' },
    current.task.updatedAt,
  );
  expect(await adapter.reconcile(held)).toEqual({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(held.evidence.remote).toBeNull();
  expect(fixture.saves()).toBe(1);
});

test('save acknowledgement never binds an old response to a new generation', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    fullDraftReview: 'unique',
  });
  await page.goto(fixture.home);
  const h = draftHarness();
  let generation = 'fixture-generation';
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => generation,
    close: async () => {},
  };
  const pages = createJudongchePages(session, undefined, {
    manualReview: true,
    ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
  });
  page.on('request', (r) => {
    if (
      new URL(r.url()).pathname === '/motor/dealer_admin/go_api/article/create'
    )
      generation = 'new-generation';
  });
  const adapter = createAdapterWithPages(session, pages);
  const probe = await adapter.checkSession();
  if (probe.status !== 'ready') throw Error('not ready');
  h.task.store = probe.store;
  h.durable().store = probe.store;
  expect(await adapter.execute(h.task, h.hooks)).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(
    pages.confirmedDraftSave?.(h.task.taskId, h.task.snapshot.article.title),
  ).toBe(false);
  expect(fixture.saves()).toBe(1);
  expect(h.durable().evidence.remote).toBeNull();
  await expect(page.locator('#body [ignoreel]')).toHaveCount(0);
});

test('acknowledged post-save title edit settles only its exact saved task without replay', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    fullDraftReview: 'unique',
  });
  await page.goto(fixture.home);
  const h = draftHarness();
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture-generation',
    close: async () => {},
  };
  const options = {
    manualReview: true,
    ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
  };
  const writer = createJudongcheAdapter(session, undefined, options);
  const probe = await writer.checkSession();
  if (probe.status !== 'ready') throw Error('not ready');
  h.task.store = probe.store;
  h.durable().store = probe.store;
  expect((await writer.execute(h.task, h.hooks)).status).toBe('blocked');
  const task = reduceTask(
    h.durable(),
    { type: 'settle', state: 'needs_human', reason: 'CONTENT_MISMATCH' },
    h.task.updatedAt,
  );
  const snapshot = JSON.stringify(task.snapshot);
  const editedTitle = '运营人员保存后确认的新标题';
  fixture.renameSaved(editedTitle);
  const reviewedSavedTask = {
    taskId: task.taskId,
    title: task.snapshot.article.title,
    recordKey: '501',
  };
  const acknowledgedTitleEdit = {
    taskId: task.taskId,
    originalTitle: task.snapshot.article.title,
    editedTitle,
    snapshotDigest: task.snapshot.digest,
    storeKey: task.store.storeKey,
    recordKey: '501',
  };
  for (const change of [
    { taskId: randomUUID() },
    { snapshotDigest: '0'.repeat(64) },
    { storeKey: '0'.repeat(64) },
    { recordKey: '502' },
    { originalTitle: 'other' },
    { editedTitle: 'unapproved title' },
  ]) {
    const reader = createJudongcheAdapter(session, undefined, {
      ...options,
      reviewedSavedTask,
      acknowledgedTitleEdit: { ...acknowledgedTitleEdit, ...change },
    });
    expect((await reader.reconcile(task)).status).toBe('blocked');
  }
  const plainReader = createJudongcheAdapter(session, undefined, {
    ...options,
    reviewedSavedTask,
  });
  expect((await plainReader.reconcile(task)).status).toBe('blocked');
  const reader = createJudongcheAdapter(session, undefined, {
    ...options,
    reviewedSavedTask,
    acknowledgedTitleEdit,
  });
  const readPages = createJudongchePages(session, undefined, {
    ...options,
    reviewedSavedTask,
    acknowledgedTitleEdit,
  });
  await readPages.probe();
  const observed = await readPages.reviewSavedDraft!(
    task.taskId,
    task.snapshot.article.title,
    editedTitle,
  );
  expect(observed.title).toBe(editedTitle);
  const candidate = {
    ...task,
    evidence: { ...task.evidence, remote: observed.remote },
  };
  expect(
    verifyAcknowledgedTitleEdit(candidate, observed, acknowledgedTitleEdit),
  ).toBe(true);
  for (const altered of [
    { ...observed, blocks: [] },
    { ...observed, blocks: [...observed.blocks].reverse() },
    {
      ...observed,
      blocks: observed.blocks.map((b) =>
        b.type === 'image' ? { ...b, loaded: false } : b,
      ),
    },
    {
      ...observed,
      blocks: observed.blocks.map((b) =>
        b.type === 'paragraph' ? { ...b, text: 'changed body' } : b,
      ),
    },
    { ...observed, isDraft: false },
    { ...observed, known: false },
    { ...observed, pendingUploads: true },
  ])
    expect(
      verifyAcknowledgedTitleEdit(candidate, altered, acknowledgedTitleEdit),
    ).toBe(false);
  const outcome = await reader.reconcile(task);
  expect(outcome.status).toBe('verified');
  if (outcome.status !== 'verified') throw Error('not verified');
  expect(outcome.evidence.remote?.recordKey).toBe('501');
  const settled = reduceTask(
    reduceTask(
      task,
      { type: 'evidence', evidence: outcome.evidence },
      task.updatedAt,
    ),
    { type: 'settle', state: 'draft_saved', reason: null },
    task.updatedAt,
  );
  expect(settled.state).toBe('draft_saved');
  expect(settled.holdsPlatform).toBe(false);
  expect(JSON.stringify(task.snapshot)).toBe(snapshot);
  expect(JSON.stringify(settled.snapshot)).toBe(snapshot);
  expect(fixture.saves()).toBe(1);
  expect(fixture.uploads()).toBe(2);
  expect(fixture.coverActions()).toBe(0);
});

test('acknowledged save with a readback failure can be rechecked without replay', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    fullDraftReview: 'unique',
    headerShape: 'no-workbench',
  });
  await page.goto(fixture.home);
  const h = draftHarness();
  let generation = 'fixture-generation';
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => generation,
    close: async () => {},
  };
  const pages = createJudongchePages(session, undefined, {
    manualReview: true,
    automaticDraftReview: true,
    ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
  });
  const realRead = pages.reviewSavedDraft!.bind(pages);
  let reads = 0;
  pages.reviewSavedDraft = async (...args) => {
    reads++;
    if (reads === 1) {
      const { JudongchePageError } =
        await import('../../src/infrastructure/platforms/judongche/production-state');
      throw new JudongchePageError('RESULT_AMBIGUOUS');
    }
    return realRead(...args);
  };
  const adapter = createAdapterWithPages(session, pages);
  const probe = await adapter.checkSession();
  if (probe.status !== 'ready') throw Error('not ready');
  h.task.store = probe.store;
  h.durable().store = probe.store;
  expect(await adapter.execute(h.task, h.hooks)).toEqual({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  const held = reduceTask(
    h.durable(),
    { type: 'settle', state: 'needs_human', reason: 'RESULT_AMBIGUOUS' },
    h.task.updatedAt,
  );
  const result = await adapter.reconcile(held);
  expect(result.status).toBe('verified');
  expect(reads).toBe(2);
  expect(fixture.saves()).toBe(1);
  expect(fixture.uploads()).toBe(2);
  expect(fixture.coverActions()).toBe(0);
  expect(context.pages()).toHaveLength(1);
  // A successful observation cannot outlive the save acknowledgement.
  const saveProof = pages.confirmedDraftSave!;
  const acknowledgedRead = pages.reviewSavedDraft!.bind(pages);
  pages.reviewSavedDraft = async (...args) => {
    const value = await acknowledgedRead(...args);
    pages.confirmedDraftSave = () => false;
    return value;
  };
  expect(await adapter.reconcile(held)).toEqual({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  pages.confirmedDraftSave = saveProof;
  pages.reviewSavedDraft = realRead;
  // Production ownedRead validates before awaiting its temporary-page close.
  // Simulate native session invalidation in that final close, not a fake save.
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const reader = await newPage();
    const close = reader.close.bind(reader);
    reader.close = async (options) => {
      await close(options);
      generation = 'closed-session';
    };
    return reader;
  };
  expect(await adapter.reconcile(held)).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(fixture.saves()).toBe(1);
  expect(fixture.uploads()).toBe(2);
  expect(context.pages()).toHaveLength(1);
});

test('ambiguous task without save acknowledgement may be observed but never adopted', async ({
  context,
  page,
}) => {
  const fixture = await installProductionFixture(context, {
    fullDraftReview: 'unique',
  });
  await page.goto(fixture.home);
  const h = draftHarness();
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture-generation',
    close: async () => {},
  };
  const options = {
    manualReview: true,
    ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
  };
  const writer = createJudongcheAdapter(session, undefined, options);
  const probe = await writer.checkSession();
  if (probe.status !== 'ready') throw Error('not ready');
  h.task.store = probe.store;
  h.durable().store = probe.store;
  expect(await writer.execute(h.task, h.hooks)).toEqual({
    status: 'blocked',
    reason: 'MANUAL_REVIEW_REQUIRED',
  });
  const held = reduceTask(
    h.durable(),
    { type: 'settle', state: 'needs_human', reason: 'RESULT_AMBIGUOUS' },
    h.task.updatedAt,
  );
  const events: unknown[] = [];
  const pages = createJudongchePages(session, (e) => events.push(e), options);
  const realRead = pages.reviewSavedDraft!.bind(pages);
  let reads = 0;
  pages.reviewSavedDraft = async (...args) => {
    reads++;
    return realRead(...args);
  };
  const reader = createAdapterWithPages(session, pages);
  expect((await reader.checkSession()).status).toBe('ready');
  expect(await reader.reconcile(held)).toEqual({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(reads).toBe(1);
  expect(held.evidence.remote).toBeNull();
  expect(held.holdsPlatform).toBe(true);
  expect(fixture.saves()).toBe(1);
  expect(fixture.uploads()).toBe(2);
  expect(fixture.coverActions()).toBe(0);
  expect(events).toContainEqual(
    expect.objectContaining({
      check: 'draft-read-observed',
      draftObservation: expect.objectContaining({
        recordKey: '501',
        exactTitle: true,
        imageCount: 2,
      }),
    }),
  );
  expect(JSON.stringify(events)).not.toMatch(
    /https:\/\/|合成门店|合成账号|operator changed/,
  );
});

for (const safety of [false, true]) {
  test(`editor entry uses ready controls despite a pending ancillary resource: safety=${safety}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, {
      pendingEditorResource: true,
      editorSafety: safety,
    });
    await page.goto(fixture.home);
    page.setDefaultNavigationTimeout(1500);
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
    const entering = pages.enterNewEditor(
      'pending resource fixture',
      () => false,
      randomUUID(),
    );
    if (safety)
      await expect(entering).rejects.toMatchObject({
        reason: 'VERIFICATION_REQUIRED',
      });
    else await entering;
    expect(await page.evaluate(() => document.readyState)).toBe('interactive');
    await expect(page.locator('textarea')).toHaveValue('');
    expect(fixture.uploads()).toBe(0);
    expect(fixture.saves()).toBe(0);
    expect(fixture.coverActions()).toBe(0);
  });
}

for (const scenario of [
  'paragraphs',
  'image',
  'image-first',
  'adjacent-images',
  'line-breaks',
  'changed-caret',
] as const) {
  test(`observed automatic tail preserves body without extra blank paragraphs: ${scenario}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, {
      observedTrailingParagraphs: true,
      changedImageCaret: scenario === 'changed-caret',
    });
    await page.goto(fixture.home);
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
    await pages.enterNewEditor(
      'blank paragraph regression',
      () => false,
      randomUUID(),
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
      'base64',
    );
    if (scenario === 'paragraphs') {
      await pages.appendParagraph('first paragraph');
      await pages.appendParagraph('second paragraph');
    } else if (scenario === 'line-breaks') {
      await pages.appendParagraph('first\n\nlast\n');
      await pages.appendParagraph('second paragraph');
    } else {
      if (scenario !== 'image-first') {
        await page.locator('#body > p').click();
        await page.keyboard.insertText('first paragraph');
      }
      if (scenario === 'changed-caret') {
        await expect(pages.appendImage(png, 'image/png')).rejects.toMatchObject(
          { reason: 'PAGE_CHANGED' },
        );
        await expect(page.locator('#body')).toContainText('operator content');
        expect(await page.locator('#body .pgc-image').count()).toBe(1);
        expect(fixture.saves()).toBe(0);
        expect(fixture.uploads()).toBe(1);
        return;
      }
      await pages.appendImage(png, 'image/png');
      if (scenario === 'adjacent-images')
        await pages.appendImage(png, 'image/png');
      await pages.appendParagraph('second paragraph');
    }
    const structure = await page.locator('#body').evaluate((node) =>
      Array.from(node.children).map((child) =>
        child.tagName === 'P'
          ? Array.from(child.childNodes)
              .map((n) =>
                n instanceof HTMLBRElement
                  ? n.classList.contains('ProseMirror-trailingBreak')
                    ? ''
                    : '\n'
                  : n.textContent,
              )
              .join('')
          : '[image]',
      ),
    );
    const expected = {
      paragraphs: ['first paragraph', 'second paragraph', ''],
      image: ['first paragraph', '[image]', 'second paragraph', ''],
      'image-first': ['[image]', 'second paragraph', ''],
      'adjacent-images': [
        'first paragraph',
        '[image]',
        '[image]',
        'second paragraph',
        '',
      ],
      'line-breaks': ['first\n\nlast\n', 'second paragraph', ''],
    };
    expect(structure).toEqual(expected[scenario]);
    expect(fixture.saves()).toBe(0);
    expect(fixture.coverActions()).toBe(0);
    expect(fixture.uploads()).toBe(
      scenario === 'adjacent-images'
        ? 2
        : ['image', 'image-first'].includes(scenario)
          ? 1
          : 0,
    );
  });
}

for (const emptyCount of [2, 3]) {
  test(`${emptyCount} restored empty caret paragraphs enter without retaining a leading blank`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, {
      observedTrailingParagraphs: true,
    });
    await context.addInitScript(
      (count) =>
        document.addEventListener('DOMContentLoaded', () => {
          const body = document.querySelector('#body');
          if (body)
            body.innerHTML =
              '<p elementtiming="element-timing"><br class="ProseMirror-trailingBreak" elementtiming="element-timing"></p>'.repeat(
                count,
              );
        }),
      emptyCount,
    );
    await page.goto(fixture.home);
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
    await pages.enterNewEditor(
      'empty restored editor',
      () => false,
      randomUUID(),
    );
    await pages.appendParagraph('first paragraph');
    expect(await page.locator('#body > p').allTextContents()).toEqual([
      'first paragraph',
      '',
    ]);
    expect(fixture.uploads()).toBe(0);
    expect(fixture.saves()).toBe(0);
  });
}

for (const initial of [
  '<p>operator text</p><p><br class="ProseMirror-trailingBreak"></p>',
  '<p><span></span></p><p><br class="ProseMirror-trailingBreak"></p>',
]) {
  test(`restored editor cleanup refuses content or unknown structure: ${initial}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context);
    await context.addInitScript(
      (html) =>
        document.addEventListener('DOMContentLoaded', () => {
          const body = document.querySelector('#body');
          if (body) body.innerHTML = html;
        }),
      initial,
    );
    await page.goto(fixture.home);
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
    await expect(
      pages.enterNewEditor('empty restored editor', () => false, randomUUID()),
    ).rejects.toMatchObject({ reason: 'CONTENT_MISMATCH' });
    expect(await page.locator('#body').innerHTML()).toBe(initial);
    expect(fixture.uploads()).toBe(0);
    expect(fixture.saves()).toBe(0);
  });
}

for (const tailChange of ['text', 'existing-marker'] as const) {
  test(`save serialization never excludes a changed or owned tail: ${tailChange}`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, {
      observedTrailingParagraphs: true,
    });
    await page.goto(fixture.home);
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
    await pages.enterNewEditor('tail guard', () => false, randomUUID());
    await pages.fillTitle('tail guard');
    await pages.appendParagraph('original body');
    expect((await pages.inspectEditor()).known).toBe(true);
    await page
      .locator('#body > p')
      .last()
      .evaluate((tail, change) => {
        if (change === 'text') tail.textContent = 'operator addition';
        else tail.setAttribute('ignoreel', 'false');
      }, tailChange);
    await pages.saveOnce();
    expect(fixture.saves()).toBe(1);
    if (tailChange === 'text')
      await expect(page.locator('#body')).toContainText('operator addition');
    else
      await expect(page.locator('#body > p').last()).toHaveAttribute(
        'ignoreel',
        'false',
      );
  });
}

for (const safety of [false, true]) {
  test(
    'owner-confirmed operator batch uses the verified editor route: safety=' +
      safety,
    async ({ context, page }) => {
      const fixture = await installProductionFixture(context, {
        editorSafety: safety,
      });
      let marketingRequests = 0;
      context.on('request', (request) => {
        if (new URL(request.url()).pathname.endsWith('/sceneMarketing'))
          marketingRequests++;
      });
      // Live second-article failure: the legacy entry remained on marketing after
      // its click. This route must never be used by the owner-confirmed flow.
      await context.route('**/sceneMarketing', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<div><div><span>文章资讯</span></div><button>立即发布</button></div>',
        }),
      );
      await page.goto(fixture.home);
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
          batchSubmissionReview: 'operator',
          ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
        },
      );
      expect((await pages.probe()).status).toBe('ready');
      const entering = pages.enterNewEditor(
        'next operator batch article',
        () => false,
        randomUUID(),
        true,
      );
      if (safety)
        await expect(entering).rejects.toMatchObject({
          reason: 'VERIFICATION_REQUIRED',
        });
      else {
        await entering;
        await expect(page.locator('textarea')).toHaveValue('');
      }
      expect(marketingRequests).toBe(0);
      expect(fixture.uploads()).toBe(0);
      expect(fixture.saves()).toBe(0);
    },
  );
}
