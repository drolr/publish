import type { BrowserHealthView } from '../../src/contracts/browser-health';
import {
  ManualStateSchema,
  type ManualState,
  type ManualDraft,
} from '../../src/contracts/manual-article';
import type { DocumentCommand } from '../../src/contracts/manual-edit';
import { installCoverBridge } from './cover-renderer-fixture';
import { test, expect, type Page } from '@playwright/test';
import webpack from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.beforeAll(async () => {
  await new Promise<void>((done, reject) => {
    webpack(
      {
        mode: 'development',
        entry: resolve('tests/e2e/draft-renderer-entry.tsx'),
        output: { path: resolve('.tmp/draft-renderer'), filename: 'app.js' },
        module: {
          rules: [
            {
              test: /\.tsx?$/,
              loader: 'ts-loader',
              options: {
                transpileOnly: true,
                compilerOptions: { noEmit: false },
              },
            },
            {
              test: /\.css$/,
              use: [MiniCssExtractPlugin.loader, 'css-loader'],
            },
          ],
        },
        plugins: [new MiniCssExtractPlugin({ filename: 'app.css' })],
        resolve: { extensions: ['.tsx', '.ts', '.js'] },
        devtool: false,
      },
      (error, stats) =>
        error || stats?.hasErrors()
          ? reject(error ?? new Error(stats?.toString()))
          : done(),
    );
  });
});

import {
  DraftViewSchema,
  type DraftView,
} from '../../src/contracts/draft-task';
const key = '11111111-1111-4111-8111-111111111111';
const initial: DraftView = DraftViewSchema.parse({
  session: {
    status: 'ready',
    bindingToken: key,
    storeName: '测试门店',
    reason: null,
  },
  preparation: null,
  task: {
    taskId: key,
    articleKey: key,
    title: '测试文章',
    storeName: '测试门店',
    state: 'needs_human',
    stage: 'settled',
    revision: 3,
    possibleRemoteEffect: true,
    stopRequested: false,
    platformPaused: true,
    reason: 'RESULT_AMBIGUOUS',
    canOpenDraft: false,
  },
});
async function mount(
  page: Page,
  view = initial,
  secondArticle = false,
  browserHealth?: BrowserHealthView,
) {
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://draft.test') return route.abort();
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      });
    if (!['/app.js', '/app.css'].includes(url.pathname)) return route.abort();
    return route.fulfill({
      contentType: url.pathname.endsWith('js') ? 'text/javascript' : 'text/css',
      body: readFileSync(resolve('.tmp/draft-renderer', url.pathname.slice(1))),
    });
  });
  await page.addInitScript(
    ({ view, key, secondArticle }) => {
      let current = JSON.parse(
        sessionStorage.getItem('draft') ?? JSON.stringify(view),
      );
      const commands: string[] = JSON.parse(
        sessionStorage.getItem('commands') ?? '[]',
      );
      const record = (name: string) => {
        commands.push(name);
        sessionStorage.setItem('commands', JSON.stringify(commands));
      };
      const reply = () => {
        sessionStorage.setItem('draft', JSON.stringify(current));
        return { status: 'ok', view: structuredClone(current) };
      };
      let preparationSequence = 0;
      const summary = {
        articleKey: key,
        externalId: 'one',
        title: '测试文章',
        contentDeclaration: 'original',
        imageCount: 1,
        articleRevision: 1,
        createdAt: '2026-09-23T00:00:00.000Z',
      };
      Object.assign(window, {
        testDraft: {
          commands,
          set: (value: unknown) => {
            current = value;
            reply();
          },
          get: () => structuredClone(current),
        },
      });
      Object.assign(window, {
        desktopApi: {
          onManualCloseRequest: () => () => undefined,
          getAppStatus: async () => ({
            state: 'ready',
            schemaVersion: 15,
            appVersion: '1',
          }),
          getManualArticleState: async () => ({ state: 'idle', revision: 0 }),
          // Keep these independent readonly library/platform cases out of admitted editor fixtures.
          openManualArticle: async () => ({
            status: 'busy',
            snapshot: { state: 'idle', revision: 0 },
          }),
          getImportStatus: async () => ({ state: 'idle', revision: 0 }),
          listArticles: async () => ({
            status: 'ok',
            page: {
              totalCount: secondArticle ? 2 : 1,
              membershipRevision: 0,
              pageNumber: 1,
              totalPages: 1,
              items: secondArticle
                ? [
                    summary,
                    {
                      ...summary,
                      articleKey: '22222222-2222-4222-8222-222222222222',
                      title: '第二篇文章',
                      externalId: 'two',
                    },
                  ]
                : [summary],
            },
          }),
          getArticlePreview: async () => ({
            status: 'ok',
            article: {
              ...summary,
              editorBody: {
                version: 2,
                blocks: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '第一段正文', marks: [] }],
                  },
                  { type: 'image', imageId: 'one' },
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: '图片后的正文', marks: [] },
                    ],
                  },
                  { type: 'image', imageId: 'one' },
                ],
              },
              body: [
                { type: 'paragraph', text: '第一段正文' },
                { type: 'image', image_id: 'one' },
                { type: 'paragraph', text: '图片后的正文' },
                { type: 'image', image_id: 'one' },
              ],
              assets: [
                {
                  assetKey: key,
                  imageId: 'one',
                  mime: 'image/png',
                  width: 1,
                  height: 1,
                },
              ],
            },
          }),
          getArticleImage: async () => ({
            status: 'ok',
            mime: 'image/png',
            bytes: Uint8Array.from(
              atob(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
              ),
              (c) => c.charCodeAt(0),
            ),
          }),
          getArticleDeclarations: async () => ({
            status: 'ok',
            items: [summary],
          }),
          getDraftState: async () => structuredClone(current),
          prepareTaskClosure: async () => {
            record('prepareTaskClosure');
            return {
              ...reply(),
              closure: {
                ...(current.task.emptyEditorReviewed
                  ? { basis: 'owner-reviewed-empty-editor' }
                  : current.task.unsavedBodyReviewed
                    ? { basis: 'owner-reviewed-unsaved-body' }
                    : {}),
                token: key,
                taskId: current.task.taskId,
                revision: current.task.revision,
                title: current.task.title,
                storeName: current.task.storeName,
                expiresAt: new Date(Date.now() + 120000).toISOString(),
              },
            };
          },
          confirmTaskClosure: async () => {
            record('confirmTaskClosure');
            current.task = {
              ...current.task,
              state: 'closed_without_save',
              revision: current.task.revision + 1,
              platformPaused: false,
              canCloseTask: false,
            };
            return reply();
          },
          openDraftSession: async () => {
            record('openDraftSession');
            return reply();
          },
          checkDraftSession: async () => {
            record('checkDraftSession');
            return reply();
          },
          closeDraftSession: async () => {
            record('closeDraftSession');
            return reply();
          },
          prepareDraft: async (articleKey: string, bindingToken: string) => {
            record('prepareDraft');
            if (articleKey !== key || bindingToken !== key)
              throw Error('bad binding');
            current.preparation = {
              preparationId:
                '00000000-0000-4000-8000-' +
                String(++preparationSequence).padStart(12, '0'),
              articleKey: key,
              title: summary.title,
              storeName: '测试门店',
              bodyImageCount: 2,
              contentDeclaration: 'original',
              mode: 'draft',
              coverPolicy: 'manual-after-draft',
            };
            reply();
            return { status: 'ready', preparation: current.preparation };
          },
          startDraft: async () => {
            record('startDraft');
            current.preparation = null;
            current.task = {
              taskId: key,
              articleKey: key,
              title: summary.title,
              storeName: '测试门店',
              state: 'running',
              stage: 'body',
              revision: 1,
              possibleRemoteEffect: true,
              stopRequested: false,
              platformPaused: false,
              reason: null,
              canOpenDraft: false,
            };
            return reply();
          },
          stopDraft: async () => {
            record('stopDraft');
            current.task = {
              ...current.task,
              state: 'needs_human',
              stage: 'settled',
              revision: 5,
              stopRequested: true,
              platformPaused: true,
              reason: 'STOP_REQUESTED',
            };
            return reply();
          },
          reconcileDraft: async () => {
            record('reconcileDraft');
            return reply();
          },
          openSavedDraft: async () => {
            record('openSavedDraft');
            return reply();
          },
        },
      });
    },
    { view: DraftViewSchema.parse(view), key, secondArticle },
  );
  await installCoverBridge(page, { browserHealth });
  await page.goto('http://draft.test');
}
const panel = (page: Page) => page.getByRole('region', { name: '巨懂车草稿' });
test('ambiguous remote effect blocks start and retains read-only reconciliation', async ({
  page,
}) => {
  await mount(page);
  await expect(page.getByText('任务尚未核实，请先核对后台草稿')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '重新核对状态' }).click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['reconcileDraft']);
});
const ready = { ...initial, task: null };
async function olderExisting(page: Page, delayed = false) {
  const older = {
    ...initial.task!,
    state: 'draft_saved' as const,
    reason: null,
    platformPaused: false,
    canOpenDraft: true,
  };
  const newer = {
    ...older,
    taskId: '22222222-2222-4222-8222-222222222222',
    articleKey: '22222222-2222-4222-8222-222222222222',
    title: '第二篇文章',
  };
  await mount(page, { ...initial, task: newer }, true);
  await page.evaluate(
    ({ older, delayed }) => {
      Object.assign(window.desktopApi, {
        prepareDraft: async () => {
          if (delayed)
            await new Promise<void>((resolve) =>
              Reflect.set(window, 'releasePreparation', resolve),
            );
          return { status: 'existing', task: older };
        },
        openSavedDraft: async (id: string) => {
          Reflect.get(window, 'testDraft').commands.push(
            `openSavedDraft:${id}`,
          );
          return { status: 'ok', view: Reflect.get(window, 'testDraft').get() };
        },
      });
    },
    { older, delayed },
  );
  await page.getByRole('button', { name: /测试文章 文章编号/ }).click();
  await panel(page).getByRole('button', { name: '检查文章摘要' }).click();
}
test('historical saved result has no mandatory remote review action and permits the next article', async ({
  page,
}) => {
  await olderExisting(page);
  await expect(panel(page)).toContainText('上次任务：测试文章');
  await expect(
    panel(page).getByRole('button', { name: '打开已保存草稿核对' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual([]);
  await expect(panel(page)).toContainText('上次任务：测试文章');
  await page.getByRole('button', { name: /第二篇文章 文章编号/ }).click();
  await expect(panel(page)).toContainText('上次任务：第二篇文章');
});
test('older existing result cannot hide a newly occupied platform lane', async ({
  page,
}) => {
  await olderExisting(page);
  await expect(panel(page)).toContainText('上次任务：测试文章');
  await page.evaluate(() => {
    const state = Reflect.get(window, 'testDraft');
    const next = state.get();
    next.task = {
      ...next.task,
      state: 'running',
      stage: 'body',
      revision: 4,
      canOpenDraft: false,
    };
    state.set(next);
  });
  await page
    .getByRole('region', { name: '专用浏览器', exact: true })
    .getByRole('button', { name: '检查登录状态' })
    .click();
  await expect(panel(page)).toContainText('当前任务：第二篇文章');
  await expect(
    panel(page).getByRole('button', { name: '停止操作' }),
  ).toBeEnabled();
  await expect(
    panel(page).getByRole('button', { name: '打开已保存草稿核对' }),
  ).toHaveCount(0);
});
test('late existing preparation after selection changes cannot replace current projection', async ({
  page,
}) => {
  await olderExisting(page, true);
  await page.getByRole('button', { name: /第二篇文章 文章编号/ }).click();
  await page.getByRole('button', { name: /测试文章 文章编号/ }).click();
  await page.evaluate(() => Reflect.get(window, 'releasePreparation')());
  await expect(
    panel(page).getByRole('button', { name: '检查文章摘要' }),
  ).toBeEnabled();
  await expect(panel(page)).toContainText('上次任务：第二篇文章');
});
async function prepare(page: Page) {
  await page.getByRole('button', { name: /测试文章 文章编号/ }).click();
  await panel(page).getByRole('button', { name: '检查文章摘要' }).click();
  await expect(
    panel(page).getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeFocused();
}
test('single preview uses operator store reminder and full summary; double start and reload never replay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await mount(page, ready);
  await expect(panel(page)).toContainText('请先从文章列表打开一篇已保存文章');
  await page
    .getByRole('checkbox', { name: '选择 测试文章', exact: true })
    .check();
  await expect(
    panel(page).getByRole('button', { name: '检查文章摘要' }),
  ).toBeDisabled();
  await prepare(page);
  await expect(
    page.getByRole('region', { name: '专用浏览器', exact: true }),
  ).toContainText('助手不检查门店');
  await expect(
    panel(page).getByRole('button', { name: '检查登录与门店' }),
  ).toHaveCount(0);
  await expect(
    panel(page).getByRole('button', { name: '确认此门店，检查文章' }),
  ).toHaveCount(0);
  await expect(panel(page)).toContainText('正文图片出现 2 次');
  await expect(panel(page)).not.toContainText(/原创|转载|本地声明/);
  await expect(panel(page).getByText('第一段正文')).toBeVisible();
  await expect(panel(page).getByRole('img')).toBeVisible();
  const start = panel(page).getByRole('button', {
    name: '存到巨懂车草稿',
    exact: true,
  });
  await expect(start).toBeDisabled();
  const confirm = panel(page).getByRole('checkbox', {
    name: '我已核对门店和图文内容，仅存草稿',
  });
  await confirm.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(start).toBeFocused();
  await panel(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve('.tmp/draft-summary-800.png'),
    fullPage: true,
  });
  await start.dblclick({ force: true });
  await expect(panel(page)).toContainText('正在处理草稿');
  await page.reload();
  await expect(panel(page)).toContainText('正在处理草稿');
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['prepareDraft', 'startDraft']);
  await expect(panel(page).locator('[aria-live="polite"]')).toContainText(
    '正在处理草稿',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('stale poll and late stop cannot roll newer task revisions backward', async ({
  page,
}) => {
  await mount(page, ready);
  await prepare(page);
  await panel(page)
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await panel(page)
    .getByRole('button', { name: '存到巨懂车草稿', exact: true })
    .click();
  await page.evaluate(() => {
    const state = Reflect.get(window, 'testDraft');
    const old = state.get();
    let reads = 0;
    Object.assign(window.desktopApi, {
      getDraftState: async () => {
        if (++reads === 1)
          return new Promise((resolve) =>
            Object.assign(window, { releaseOld: () => resolve(old) }),
          );
        return state.get();
      },
      stopDraft: async () => {
        state.commands.push('stopDraft');
        const next = state.get();
        next.task = {
          ...next.task,
          state: 'draft_saved',
          revision: 9,
          canOpenDraft: true,
          platformPaused: false,
        };
        state.set(next);
        return new Promise((resolve) =>
          Object.assign(window, {
            releaseStop: () =>
              resolve({
                status: 'blocked',
                reason: 'BROWSER_UNAVAILABLE',
                view: old,
              }),
          }),
        );
      },
    });
  });
  await expect
    .poll(() => page.evaluate(() => Object.hasOwn(window, 'releaseOld')))
    .toBe(true);
  await panel(page).getByRole('button', { name: '停止操作' }).click();
  await page.evaluate(() => Reflect.get(window, 'releaseOld')());
  await expect(panel(page)).toContainText('草稿已保存并核对');
  await page.evaluate(() => Reflect.get(window, 'releaseStop')());
  await expect(panel(page)).toContainText('草稿已保存并核对');
  await expect(panel(page)).not.toContainText('专用浏览器暂时不可用');
  await expect(
    panel(page).getByRole('button', { name: '停止操作' }),
  ).toHaveCount(0);
});
test('command timeout keeps read-only polling without resubmitting', async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, ready);
  await prepare(page);
  await panel(page)
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await page.evaluate(() => {
    Object.assign(window.desktopApi, {
      startDraft: async () => {
        Reflect.get(window, 'testDraft').commands.push('startDraft');
        return new Promise(() => {});
      },
    });
  });
  await panel(page)
    .getByRole('button', { name: '存到巨懂车草稿', exact: true })
    .click();
  await page.clock.fastForward(11000);
  await expect(panel(page)).toContainText('状态待核对');
  await expect(
    panel(page).getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  await page.clock.fastForward(5000);
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['prepareDraft', 'startDraft']);
});

for (const outcome of [
  'ready',
  'LOGIN_REQUIRED',
  'VERIFICATION_REQUIRED',
  'PAGE_CHANGED',
  'rejected',
  'unmounted',
] as const) {
  test(`first open late ${outcome} refreshes after an overlapping stale state read without a second click`, async ({
    page,
  }) => {
    await page.clock.install();
    await mount(page, {
      ...ready,
      session: {
        status: 'closed',
        bindingToken: null,
        storeName: null,
        reason: null,
      },
    });
    const browser = page.getByRole('region', {
      name: '专用浏览器',
      exact: true,
    });
    await expect(
      browser.getByRole('button', { name: '打开专用浏览器' }),
    ).toBeEnabled();
    await page.evaluate((outcome) => {
      const state = Reflect.get(window, 'testDraft');
      let staleRead = true;
      Reflect.set(window, 'openRefreshReads', 0);
      window.desktopApi.getDraftState = async () => {
        Reflect.set(
          window,
          'openRefreshReads',
          Reflect.get(window, 'openRefreshReads') + 1,
        );
        if (staleRead) {
          staleRead = false;
          const old = state.get();
          return new Promise((resolve) =>
            Reflect.set(window, 'releaseClosedRead', () => resolve(old)),
          );
        }
        return state.get();
      };
      window.desktopApi.openDraftSession = async () => {
        state.commands.push('openDraftSession');
        return new Promise((resolve, reject) =>
          Reflect.set(window, 'releaseFirstOpen', () => {
            const next = state.get();
            next.session =
              outcome === 'ready' || outcome === 'unmounted'
                ? {
                    status: 'ready',
                    bindingToken: '11111111-1111-4111-8111-111111111111',
                    storeName: '首次连接门店',
                    reason: null,
                  }
                : {
                    status: 'blocked',
                    bindingToken: null,
                    storeName: null,
                    reason:
                      outcome === 'rejected' ? 'BROWSER_UNAVAILABLE' : outcome,
                  };
            state.set(next);
            if (outcome === 'rejected') reject(new Error('open reply lost'));
            else
              resolve(
                outcome === 'ready' || outcome === 'unmounted'
                  ? { status: 'ok', view: next }
                  : { status: 'blocked', reason: outcome, view: next },
              );
          }),
        );
      };
    }, outcome);
    await browser.getByRole('button', { name: '打开专用浏览器' }).click();
    await page.clock.fastForward(11000);
    await page.clock.fastForward(1000);
    await expect
      .poll(() =>
        page.evaluate(() => Object.hasOwn(window, 'releaseClosedRead')),
      )
      .toBe(true);
    await page.evaluate(() => Reflect.get(window, 'releaseFirstOpen')());
    if (outcome === 'unmounted')
      await page.evaluate(() =>
        Reflect.get(window, 'draftRendererHarness').unmount(),
      );
    await page.evaluate(() => Reflect.get(window, 'releaseClosedRead')());
    if (outcome === 'unmounted') {
      await page.clock.fastForward(2000);
      expect(
        await page.evaluate(() => Reflect.get(window, 'openRefreshReads')),
      ).toBe(1);
    } else if (outcome === 'ready')
      await expect(browser).toContainText('首次连接门店');
    else {
      await expect(
        browser.getByRole('button', { name: '检查登录状态' }),
      ).toBeEnabled();
      await expect(
        browser.getByRole('button', { name: '关闭专用浏览器' }),
      ).toBeVisible();
      await expect(browser).not.toContainText('首次连接门店');
    }
    expect(
      await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
    ).toEqual(['openDraftSession']);
  });
}
test('stop and reset retire an outstanding open reply and its overlapping read', async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, {
    ...ready,
    session: {
      status: 'closed',
      bindingToken: null,
      storeName: null,
      reason: null,
    },
  });
  const browser = page.getByRole('region', { name: '专用浏览器', exact: true });
  await expect(
    browser.getByRole('button', { name: '打开专用浏览器' }),
  ).toBeEnabled();
  await page.evaluate(() => {
    const state = Reflect.get(window, 'testDraft');
    let holdRead = true;
    const obsolete = state.get();
    obsolete.session = {
      status: 'ready',
      bindingToken: '11111111-1111-4111-8111-111111111111',
      storeName: '过期连接门店',
      reason: null,
    };
    window.desktopApi.getDraftState = async () => {
      if (holdRead) {
        holdRead = false;
        return new Promise((resolve) =>
          Reflect.set(window, 'releaseRetiredRead', () => resolve(obsolete)),
        );
      }
      return state.get();
    };
    window.desktopApi.openDraftSession = async () =>
      new Promise((resolve) =>
        Reflect.set(window, 'releaseRetiredOpen', () =>
          resolve({ status: 'ok', view: obsolete }),
        ),
      );
    window.desktopApi.requestStopAll = async () => ({
      revision: 1,
      phase: 'stopped',
      owners: [],
    });
  });
  await browser.getByRole('button', { name: '打开专用浏览器' }).click();
  await page.clock.fastForward(11000);
  await page.clock.fastForward(1000);
  await expect
    .poll(() =>
      page.evaluate(() => Object.hasOwn(window, 'releaseRetiredRead')),
    )
    .toBe(true);
  await page
    .getByRole('region', { name: '全局操作状态' })
    .getByRole('button', { name: '停止并初始化', exact: true })
    .click();
  await expect(
    browser.getByRole('button', { name: '打开专用浏览器' }),
  ).toBeEnabled();
  await page.evaluate(() => {
    Reflect.get(window, 'releaseRetiredOpen')();
    Reflect.get(window, 'releaseRetiredRead')();
  });
  await page.clock.fastForward(2000);
  await expect(browser).not.toContainText('过期连接门店');
  await expect(
    browser.getByRole('button', { name: '检查登录状态' }),
  ).toBeDisabled();
});

test('timed-out start keeps known task visible and permits safe stop without a second start', async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, ready);
  await prepare(page);
  await panel(page)
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await page.evaluate(() => {
    const start = window.desktopApi.startDraft;
    Object.assign(window.desktopApi, {
      startDraft: async (id: string) => {
        await start(id);
        return new Promise(() => {});
      },
    });
  });
  await panel(page)
    .getByRole('button', { name: '存到巨懂车草稿', exact: true })
    .click();
  await page.clock.fastForward(11000);
  await expect(panel(page)).toContainText('状态待核对');
  await expect(panel(page)).toContainText('当前任务：测试文章');
  await panel(page).getByRole('button', { name: '停止操作' }).click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['prepareDraft', 'startDraft', 'stopDraft']);
});
test('manual-review submission stays locked and offers no automatic reconciliation or replay', async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    task: {
      ...initial.task!,
      state: 'needs_human',
      reason: 'MANUAL_REVIEW_REQUIRED',
      manualReview: true,
      possibleRemoteEffect: true,
      platformPaused: true,
      canOpenDraft: false,
      canCloseTask: false,
    },
  });
  await expect(panel(page)).toContainText('待人工核对草稿');
  await expect(
    panel(page).getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  await expect(
    panel(page).getByRole('button', { name: '重新核对状态' }),
  ).toHaveCount(0);
  await expect(
    panel(page).getByRole('button', { name: '核对已保存草稿并完成任务' }),
  ).toBeEnabled();
  await panel(page)
    .getByRole('button', { name: '核对已保存草稿并完成任务' })
    .click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['reconcileDraft']);
});
test('nonempty or unknown cover pauses without requesting material-library selection', async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    task: { ...initial.task!, reason: 'COVER_UNAVAILABLE' },
  });
  await expect(panel(page)).toContainText(
    '展示封面未确认为空，尚未点击存草稿。请保留页面并联系维护人员。',
  );
  await expect(
    panel(page).getByRole('button', { name: '存到巨懂车草稿' }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual([]);
});

for (const [state, message, reason] of [
  ['failed', '文章检查失败，未生成草稿', 'IMAGE_FORMAT_UNSUPPORTED'],
  ['stopped', '已停止，未生成草稿', 'STOP_REQUESTED'],
  ['interrupted', '上次操作中断，请先核对状态', 'INTERRUPTED'],
  ['draft_saved', '草稿已保存并核对', null],
] as const) {
  test(`renders authoritative ${state} without replay`, async ({ page }) => {
    const task = {
      ...initial.task!,
      state,
      reason,
      possibleRemoteEffect: state === 'draft_saved',
      platformPaused: state === 'interrupted',
      canOpenDraft: state === 'draft_saved',
    };
    await mount(page, { ...initial, task });
    await expect(panel(page)).toContainText(message);
    await expect(
      panel(page).getByRole('button', { name: '存到巨懂车草稿', exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
    ).toEqual([]);
    await expect(
      panel(page).getByRole('button', { name: '打开已保存草稿核对' }),
    ).toHaveCount(0);
  });
}
test('closed login and unverified store stay blocked; no fallback binding is invented', async ({
  page,
}) => {
  await mount(page, {
    ...ready,
    session: {
      status: 'closed',
      bindingToken: null,
      storeName: null,
      reason: null,
    },
  });
  await page.getByRole('button', { name: /测试文章 文章编号/ }).click();
  await expect(panel(page)).toContainText('人工登录后台');
  await page
    .getByRole('region', { name: '专用浏览器', exact: true })
    .getByRole('button', { name: '打开专用浏览器' })
    .click();
  await page.evaluate(() => {
    const state = Reflect.get(window, 'testDraft');
    const next = state.get();
    next.session = {
      status: 'blocked',
      bindingToken: null,
      storeName: null,
      reason: 'STORE_UNCONFIRMED',
    };
    state.set(next);
  });
  await page.reload();
  await page.getByRole('button', { name: /测试文章 文章编号/ }).click();
  await expect(panel(page)).toContainText('当前无法可靠确认门店');
  await expect(
    panel(page).getByRole('button', { name: '检查文章摘要' }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['openDraftSession']);
});
test('task remains visible during manual editor mount and after discard; selection is independent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mount(page, initial, true);
  const selected = page.getByRole('checkbox', {
    name: '选择 测试文章',
    exact: true,
  });
  await selected.check();
  const fixture = ManualStateSchema.parse({
    state: 'editing',
    revision: 1,
    sessionId: key,
    nextPasteCommandId: key,
    nextEditCommandId: key,
    nextClientSequence: 1,
    nextSaveOperationId: key,
    target: { kind: 'new' },
    documentRevision: 0,
    acknowledgedEdit: null,
    candidates: [],
    externalId: 'manual-' + key,
    dirty: false,
    draft: {
      bodyVersion: 2,
      title: '',
      contentDeclaration: 'repost',
      blocks: [{ blockKey: key, type: 'paragraph', content: [] }],
    },
    images: [],
  });
  await page.evaluate((fixture) => {
    let state: ManualState = { state: 'idle', revision: 0 };
    const calls: string[] = [];
    const reply = () => ({ status: 'ok', snapshot: structuredClone(state) });
    Object.assign(window, { manualMountProbe: { calls } });
    Object.assign(window.desktopApi, {
      getManualArticleState: async () => structuredClone(state),
      beginManualArticle: async () => {
        calls.push('begin');
        state = structuredClone(fixture);
        return reply();
      },
      applyManualEdit: async (command: DocumentCommand, draft: ManualDraft) => {
        if (
          state.state !== 'editing' ||
          command.sessionId !== state.sessionId ||
          command.expectedDocumentRevision !== state.documentRevision ||
          command.clientSequence !== state.nextClientSequence ||
          command.commandId !== state.nextEditCommandId
        )
          throw Error('Unexpected edit ticket');
        calls.push('edit');
        state = {
          ...state,
          draft: structuredClone(draft),
          dirty: true,
          revision: state.revision + 1,
          documentRevision: state.documentRevision + 1,
          nextClientSequence: state.nextClientSequence + 1,
          nextEditCommandId:
            '00000000-0000-4000-8000-' +
            String(state.nextClientSequence + 1).padStart(12, '0'),
          acknowledgedEdit: {
            commandId: command.commandId,
            clientSequence: command.clientSequence,
          },
        };
        return reply();
      },
      closeManualEditor: async (command: DocumentCommand, choice: string) => {
        if (
          choice !== 'discard' ||
          state.state !== 'editing' ||
          command.sessionId !== state.sessionId ||
          command.expectedDocumentRevision !== state.documentRevision ||
          command.clientSequence !== state.nextClientSequence ||
          command.commandId !== state.nextEditCommandId
        )
          throw Error('Unexpected discard ticket');
        calls.push('discard');
        state = { state: 'idle', revision: state.revision + 1 };
        return reply();
      },
    });
  }, fixture);
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  const title = page.getByRole('textbox', { name: '文章标题', exact: true });
  await expect(title).toBeVisible();
  const global = page.getByRole('region', {
    name: '全局操作状态',
    exact: true,
  });
  await expect(global).toContainText('平台已暂停');
  await expect(
    global.getByRole('button', { name: '返回工作区处理', exact: true }),
  ).toBeVisible();
  await expect(panel(page)).toBeHidden();
  // A hidden mounted panel still retains its submission lock; it is never clicked here.
  await expect(
    page
      .getByRole('region', { name: '巨懂车草稿', includeHidden: true })
      .getByRole('button', {
        name: '存到巨懂车草稿',
        exact: true,
        includeHidden: true,
      }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.desktopApi.getDraftState())).toEqual(
    initial,
  );
  await title.fill('未保存的本机标题');
  await page
    .getByRole('textbox', { name: '文章正文', exact: true })
    .fill('未保存的本机正文');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.desktopApi
          .getManualArticleState()
          .then(
            (s) =>
              s.state === 'editing' &&
              s.dirty &&
              s.draft.title === '未保存的本机标题' &&
              s.draft.blocks.length === 1 &&
              s.draft.blocks[0].type === 'paragraph' &&
              s.draft.blocks[0].content.map((run) => run.text).join('') ===
                '未保存的本机正文',
          ),
      ),
    )
    .toBe(true);
  const dirty = ManualStateSchema.parse(
    await page.evaluate(() => window.desktopApi.getManualArticleState()),
  );
  expect(dirty).toMatchObject({
    state: 'editing',
    dirty: true,
    draft: {
      bodyVersion: 2,
      title: '未保存的本机标题',
      blocks: [{ content: [{ text: '未保存的本机正文' }] }],
    },
  });
  await page.getByRole('button', { name: '返回文章池', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: '离开当前编辑？',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(global).toContainText('平台已暂停');
  await dialog.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(panel(page)).toContainText('任务尚未核实，请先核对后台草稿');
  await expect(
    panel(page).getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  await expect(title).toBeHidden();
  expect(
    ManualStateSchema.parse(
      await page.evaluate(() => window.desktopApi.getManualArticleState()),
    ),
  ).toMatchObject({ state: 'idle' });
  await expect(selected).toBeChecked();
  const other = page.getByRole('button', { name: /第二篇文章 文章编号/ });
  await other.click();
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await expect(selected).toBeChecked();
  await expect(panel(page)).toContainText('当前任务：测试文章');
  await expect(panel(page)).toContainText('任务尚未核实，请先核对后台草稿');
  await expect(
    panel(page).getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.desktopApi.getDraftState())).toEqual(
    initial,
  );
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual([]);
  const calls: string[] = await page.evaluate(
    () => Reflect.get(window, 'manualMountProbe').calls,
  );
  expect(calls[0]).toBe('begin');
  expect(calls.filter((c) => c === 'edit').length).toBeGreaterThan(0);
  expect(calls.filter((c) => c === 'discard')).toHaveLength(1);
  expect(calls.at(-1)).toBe('discard');
  expect(errors).toEqual([]);
});

test('slow polls never overlap and lower revision command cannot replace current state', async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, {
    ...initial,
    task: {
      ...initial.task!,
      state: 'running',
      revision: 8,
      platformPaused: false,
    },
  });
  await expect(panel(page)).toContainText('正在处理草稿');
  await page.evaluate(() => {
    const state = Reflect.get(window, 'testDraft');
    Object.assign(window, { reads: 0 });
    Object.assign(window.desktopApi, {
      getDraftState: async () => {
        Reflect.set(window, 'reads', Reflect.get(window, 'reads') + 1);
        return new Promise((resolve) =>
          Object.assign(window, { releaseRead: () => resolve(state.get()) }),
        );
      },
      stopDraft: async () => {
        const old = state.get();
        old.task = {
          ...old.task,
          state: 'queued',
          revision: 1,
          title: '不应显示的旧任务',
        };
        return { status: 'ok', view: old };
      },
    });
  });
  await page.clock.fastForward(1000);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'reads')))
    .toBe(1);
  await page.clock.fastForward(5000);
  expect(await page.evaluate(() => Reflect.get(window, 'reads'))).toBe(1);
  await panel(page).getByRole('button', { name: '停止操作' }).click();
  await expect(panel(page)).toContainText('当前任务：测试文章');
  await expect(panel(page)).not.toContainText('不应显示的旧任务');
  await page.evaluate(() => Reflect.get(window, 'releaseRead')());
  await expect(panel(page)).toContainText('正在处理草稿');
});
test('long task title wraps and controls remain keyboard reachable at 800 by 600', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await mount(page, {
    ...initial,
    task: { ...initial.task!, title: '汽车评测与门店服务'.repeat(15) },
  });
  const reconcile = panel(page).getByRole('button', { name: '重新核对状态' });
  await reconcile.focus();
  await expect(reconcile).toBeFocused();
  await page.screenshot({ path: resolve('.tmp/draft-paused-800.png') });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press('Enter');
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['reconcileDraft']);
});

test('unmount cancels future polls and remount reads persisted task without starting', async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, ready);
  await prepare(page);
  await panel(page)
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await panel(page)
    .getByRole('button', { name: '存到巨懂车草稿', exact: true })
    .click();
  await expect(panel(page)).toContainText('正在处理草稿');
  await page.evaluate(() => {
    const original = window.desktopApi.getDraftState;
    Reflect.set(window, 'reads', 0);
    Object.assign(window.desktopApi, {
      getDraftState: async () => {
        Reflect.set(window, 'reads', Reflect.get(window, 'reads') + 1);
        return original();
      },
    });
    Reflect.get(window, 'draftRendererHarness').unmount();
  });
  await page.clock.fastForward(5000);
  expect(await page.evaluate(() => Reflect.get(window, 'reads'))).toBe(0);
  await page.evaluate(() =>
    Reflect.get(window, 'draftRendererHarness').mount(),
  );
  await expect(panel(page)).toContainText('正在处理草稿');
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['prepareDraft', 'startDraft']);
});
test('verified terminal read resolves lost start response and enables opening without replay', async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, ready);
  await prepare(page);
  await panel(page)
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await page.evaluate(() => {
    const start = window.desktopApi.startDraft;
    Object.assign(window.desktopApi, {
      startDraft: async (id: string) => {
        await start(id);
        return new Promise(() => {});
      },
    });
  });
  await panel(page)
    .getByRole('button', { name: '存到巨懂车草稿', exact: true })
    .click();
  await page.clock.fastForward(11000);
  await expect(panel(page)).toContainText('状态待核对');
  await page.evaluate(() => {
    const state = Reflect.get(window, 'testDraft');
    const next = state.get();
    next.task = {
      ...next.task,
      state: 'draft_saved',
      revision: 10,
      canOpenDraft: true,
    };
    state.set(next);
  });
  await page.clock.fastForward(2000);
  await expect(panel(page)).toContainText('草稿已保存并核对');
  await expect(
    panel(page).getByRole('button', { name: '打开已保存草稿核对' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['prepareDraft', 'startDraft']);
});
test('rejected start reply preserves uncertainty across unchanged preparation reads', async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, ready);
  await prepare(page);
  await panel(page)
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await page.evaluate(() => {
    const state = Reflect.get(window, 'testDraft');
    Reflect.set(window, 'rejectionReads', 0);
    Object.assign(window.desktopApi, {
      startDraft: async () => {
        state.commands.push('startDraft');
        throw new Error('lost bridge reply');
      },
      getDraftState: async () => {
        Reflect.set(
          window,
          'rejectionReads',
          Reflect.get(window, 'rejectionReads') + 1,
        );
        return state.get();
      },
    });
  });
  await panel(page)
    .getByRole('button', { name: '存到巨懂车草稿', exact: true })
    .click();
  await expect(panel(page)).toContainText('状态待核对');
  await page.clock.fastForward(3000);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'rejectionReads')))
    .toBeGreaterThan(0);
  await expect(
    panel(page).getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  await expect(panel(page)).toContainText('状态待核对');
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['prepareDraft', 'startDraft']);
});
test('prepare rejection and transient state read failure recover safe controls from main', async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, ready);
  await page.getByRole('button', { name: /测试文章 文章编号/ }).click();
  await page.evaluate(() => {
    const state = Reflect.get(window, 'testDraft');
    let reads = 0;
    Reflect.set(window, 'controlReads', 0);
    Object.assign(window.desktopApi, {
      prepareDraft: async () => {
        state.commands.push('prepareDraft');
        throw new Error('control transport');
      },
      getDraftState: async () => {
        Reflect.set(window, 'controlReads', ++reads);
        if (reads === 1) throw new Error('read transport');
        return state.get();
      },
    });
  });
  await panel(page).getByRole('button', { name: '检查文章摘要' }).click();
  await expect(panel(page)).toContainText('状态待核对');
  await page.clock.fastForward(1000);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'controlReads')))
    .toBe(1);
  await expect(panel(page)).toContainText('状态待核对');
  await page.clock.fastForward(1000);
  await expect(
    panel(page).getByRole('button', { name: '检查文章摘要' }),
  ).toBeEnabled();
  await expect(panel(page)).not.toContainText('状态待核对');
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['prepareDraft']);
});
test('rejected start with main task evidence still permits safe stop and terminal recovery', async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, ready);
  await prepare(page);
  await panel(page)
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await page.evaluate(() => {
    const original = window.desktopApi.startDraft;
    Object.assign(window.desktopApi, {
      startDraft: async (id: string) => {
        await original(id);
        throw new Error('lost start response');
      },
    });
  });
  await panel(page)
    .getByRole('button', { name: '存到巨懂车草稿', exact: true })
    .click();
  await page.clock.fastForward(1000);
  await expect(panel(page)).toContainText('当前任务：测试文章');
  await expect(panel(page)).toContainText('状态待核对');
  await panel(page).getByRole('button', { name: '停止操作' }).click();
  await expect(panel(page)).toContainText('任务尚未核实，请先核对后台草稿');
  await expect(panel(page)).not.toContainText('状态待核对');
  await expect(
    panel(page).getByRole('button', { name: '重新核对状态' }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['prepareDraft', 'startDraft', 'stopDraft']);
});

for (const review of ['none', 'empty-editor', 'unsaved-body'] as const) {
  test(`manual closure displays bound confirmation and never starts another draft (${review})`, async ({
    page,
  }) => {
    const closeable = structuredClone(initial);
    closeable.task!.canCloseTask = true;
    closeable.task!.emptyEditorReviewed = review === 'empty-editor';
    closeable.task!.unsavedBodyReviewed = review === 'unsaved-body';
    await mount(page, closeable);
    await panel(page)
      .getByRole('button', { name: '核对并结束未保存任务' })
      .click();
    await expect(
      panel(page).getByRole('group', { name: '结束未保存任务确认' }),
    ).toContainText('测试文章');
    await expect(panel(page)).toContainText(
      review === 'empty-editor'
        ? '点击“确认结束本次任务”即确认已核对无同标题草稿'
        : review === 'unsaved-body'
          ? '本任务未请求存草稿，编辑页可能保留既有图文'
          : '仅结束本次未保存任务，不会重新保存',
    );
    expect(
      await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
    ).toEqual(['prepareTaskClosure']);
    await panel(page).getByRole('button', { name: '确认结束本次任务' }).click();
    await expect(panel(page)).toContainText(
      review === 'empty-editor'
        ? '已按人工核对及空白编辑器失败记录结束本次任务'
        : review === 'unsaved-body'
          ? '已按人工核对结束未保存任务，原始记录已保留'
          : '已核对未生成草稿，本次任务已结束',
    );
    await expect(panel(page)).not.toContainText('任务尚未核实');
    expect(
      await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
    ).toEqual(['prepareTaskClosure', 'confirmTaskClosure']);
    await expect(
      panel(page).getByRole('button', { name: '存到巨懂车草稿', exact: true }),
    ).toBeDisabled();
  });
}

test('manual ambiguous task retains existing read-only reconciliation', async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    task: {
      ...initial.task!,
      manualReview: true,
      reason: 'RESULT_AMBIGUOUS',
      state: 'needs_human',
      possibleRemoteEffect: true,
      platformPaused: true,
      canCloseTask: false,
      canOpenDraft: false,
    },
  });
  const read = panel(page).getByRole('button', {
    name: '重新核对状态',
    exact: true,
  });
  await expect(read).toBeEnabled();
  await expect(
    panel(page).getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  await read.click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual(['reconcileDraft']);
});
test('reviewed ambiguous closure is shown as ended with preserved save uncertainty', async ({
  page,
}) => {
  await mount(page, {
    ...initial,
    task: {
      ...initial.task!,
      state: 'closed_after_review',
      platformPaused: false,
      canCloseTask: false,
    },
  });
  await expect(
    page.getByText('本次任务已人工结束，保存尝试及可能影响记录已保留'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '重新核对状态' })).toHaveCount(
    0,
  );
  await expect(page.getByText('已核对未生成草稿，本次任务已结束')).toHaveCount(
    0,
  );
});

test('initialization keeps ambiguous submission history without carrying its error into the new workspace', async ({
  page,
}) => {
  const view: DraftView = {
    ...initial,
    task: {
      ...initial.task!,
      state: 'submission_recorded',
      platformPaused: false,
    },
  };
  await mount(page, view);
  await page.evaluate(() =>
    Object.assign(window.desktopApi, {
      requestStopAll: async () => ({
        revision: 1,
        phase: 'stopped',
        owners: [],
      }),
    }),
  );
  const footer = page.getByRole('region', { name: '全局操作状态' });
  await expect(footer).toContainText('草稿状态尚未确认');
  await footer
    .getByRole('button', { name: '停止并初始化', exact: true })
    .click();
  await expect(footer).toContainText('已停止并初始化');
  expect(
    (await page.evaluate(() => window.desktopApi.getDraftState())).task?.reason,
  ).toBe('RESULT_AMBIGUOUS');
});

test('single-entry human new attempt defaults off and changing it requires a fresh summary confirmation', async ({
  page,
}) => {
  await mount(page, ready);
  await prepare(page);
  const choice = panel(page).getByRole('checkbox', {
    name: '作为新尝试',
    exact: true,
  });
  await expect(choice).not.toBeChecked();
  await page.evaluate(() => {
    const original = window.desktopApi.prepareDraft;
    window.desktopApi.prepareDraft = async (...args) => {
      Reflect.set(window, 'singleAttemptArgs', args);
      return original(...args);
    };
  });
  await choice.check();
  await expect(
    panel(page).getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toHaveCount(0);
  await panel(page).getByRole('button', { name: '检查文章摘要' }).click();
  await expect(
    panel(page).getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'singleAttemptArgs')[2]),
  ).toBe('new_attempt');
  await expect(
    panel(page).getByRole('checkbox', {
      name: '我已核对门店和图文内容，仅存草稿',
    }),
  ).not.toBeChecked();
});

test('late READY for A with a retired new-attempt intent stays non-actionable after A to B to A selection', async ({
  page,
}) => {
  await mount(page, ready, true);
  await page.getByRole('button', { name: /测试文章 文章编号/ }).click();
  await panel(page)
    .getByRole('checkbox', { name: '作为新尝试', exact: true })
    .check();
  await page.evaluate(() => {
    const original = window.desktopApi.prepareDraft;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    Reflect.set(window, 'releaseReadyPreparation', resolve);
    let calls = 0;
    window.desktopApi.prepareDraft = async (...args) => {
      Reflect.set(window, 'lastReadyIntent', args[2]);
      if (++calls === 1) await pending;
      return original(...args);
    };
  });
  await panel(page).getByRole('button', { name: '检查文章摘要' }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'lastReadyIntent')))
    .toBe('new_attempt');
  await page.getByRole('button', { name: /第二篇文章 文章编号/ }).click();
  await page.getByRole('button', { name: /测试文章 文章编号/ }).click();
  await expect(
    panel(page).getByRole('checkbox', { name: '作为新尝试', exact: true }),
  ).not.toBeChecked();
  await page.evaluate(() => Reflect.get(window, 'releaseReadyPreparation')());
  await expect(
    panel(page).getByRole('button', { name: '检查文章摘要' }),
  ).toBeEnabled();
  // A later canonical read must not resurrect the stale READY projection either.
  await page
    .getByRole('region', { name: '专用浏览器', exact: true })
    .getByRole('button', { name: '检查登录状态' })
    .click();
  await expect(
    panel(page).getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toHaveCount(0);
  await expect(
    panel(page).getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  await panel(page).getByRole('button', { name: '检查文章摘要' }).click();
  await expect(
    panel(page).getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'lastReadyIntent')),
  ).toBe('default');
  await expect(
    panel(page).getByRole('checkbox', {
      name: '我已核对门店和图文内容，仅存草稿',
    }),
  ).not.toBeChecked();
});

const closedDraft = () => ({
  ...initial,
  session: {
    status: 'closed' as const,
    bindingToken: null,
    storeName: null,
    reason: null,
  },
  preparation: null,
  task: null,
});
const healthView = (
  status: BrowserHealthView['status'],
  reason: BrowserHealthView['reason'] = null,
  version: string | null = null,
): BrowserHealthView => ({ status, reason, version, stage: null });
test('browser health unchecked has no invented version and keyboard check stays separate from platform login', async ({
  page,
}) => {
  await mount(page, closedDraft());
  const card = page.getByRole('region', { name: '浏览器基础检查' });
  await expect(card.getByText('尚未检查浏览器')).toBeVisible();
  await expect(card.getByText(/Edge 版本/)).toHaveCount(0);
  const check = card.getByRole('button', { name: '检查浏览器', exact: true });
  await check.focus();
  await page.keyboard.press('Enter');
  await expect(
    card.getByText('浏览器基础检查通过', { exact: true }),
  ).toBeVisible();
  await expect(card.getByText('Edge 版本：156.0.0.0')).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual([]);
  await expect(
    page.getByRole('button', { name: '检查登录状态', exact: true }),
  ).toBeDisabled();
  await expect(card.getByText(/不代表已登录/)).toBeVisible();
  await card.screenshot({
    path: '.tmp/browser-health/task-2-health-passed.png',
  });
});
test('checking is accessible and duplicate requests stay disabled through promise settlement', async ({
  page,
}) => {
  await mount(page, closedDraft());
  await page.evaluate(() => Reflect.get(window, 'healthFixture').hold());
  const card = page.getByRole('region', { name: '浏览器基础检查' });
  await card.getByRole('button', { name: '检查浏览器', exact: true }).click();
  await expect(card).toHaveAttribute('aria-busy', 'true');
  await expect(
    card.getByRole('button', { name: '检查浏览器', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '打开专用浏览器', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => Reflect.get(window, 'healthFixture').release());
  await expect(
    card.getByText('浏览器基础检查通过', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'healthFixture').commands),
  ).toEqual(['check']);
});
for (const [status, reason, text] of [
  ['missing', null, '未找到 Microsoft Edge'],
  ['unknown_version', null, '无法识别 Edge 版本'],
  ['too_old', null, 'Edge 版本过旧'],
  ['check_failed', 'capability_failed', '请联系维护者发布新版助手'],
  ['busy', 'business_open', '请先手动关闭专用浏览器'],
  ['busy', 'task_busy', '请先处理当前任务'],
  ['busy', 'ownership_unconfirmed', '浏览器占用尚未确认'],
  [
    'unavailable',
    'update_unavailable',
    'Edge 菜单 → 帮助和反馈 → 关于 Microsoft Edge',
  ],
] as const)
  test(`browser recovery ${status}/${reason} gives a concrete next step`, async ({
    page,
  }) => {
    await mount(
      page,
      closedDraft(),
      false,
      healthView(
        status,
        reason,
        status === 'check_failed' ? '160.1.2.3' : null,
      ),
    );
    const card = page.getByRole('region', { name: '浏览器基础检查' });
    await expect(card.getByText(text, { exact: false })).toBeVisible();
    expect(
      await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
    ).toEqual([]);
  });
test('maintenance remains disabled after opening until close is observed and narrow card wraps', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await mount(page, closedDraft());
  const card = page.getByRole('region', { name: '浏览器基础检查' });
  await card
    .getByRole('button', { name: '打开 Edge 更新页', exact: true })
    .click();
  await expect(card.getByText(/已打开 Edge 更新页/)).toBeVisible();
  await expect(
    card.getByRole('button', { name: '检查浏览器', exact: true }),
  ).toBeDisabled();
  await expect(
    card.getByRole('button', { name: '打开 Edge 更新页', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '打开专用浏览器', exact: true }),
  ).toBeDisabled();
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await card.screenshot({
    path: '.tmp/browser-health/task-2-health-narrow-update.png',
  });
  await page.evaluate(() =>
    Reflect.get(window, 'healthFixture').set({
      status: 'unchecked',
      version: null,
      stage: null,
      reason: null,
    }),
  );
  await expect(
    card.getByRole('button', { name: '检查浏览器', exact: true }),
  ).toBeEnabled();
});

test('unconfirmed ownership disables health commands but confirmed close cleanup failure permits an explicit retry', async ({
  page,
}) => {
  await mount(
    page,
    closedDraft(),
    false,
    healthView('busy', 'ownership_unconfirmed'),
  );
  const card = page.getByRole('region', { name: '浏览器基础检查' });
  await expect(card.getByText(/浏览器占用尚未确认/)).toBeVisible();
  await expect(
    card.getByRole('button', { name: '检查浏览器', exact: true }),
  ).toBeDisabled();
  await expect(
    card.getByRole('button', { name: '打开 Edge 更新页', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() =>
    Reflect.get(window, 'healthFixture').set({
      status: 'check_failed',
      reason: 'cleanup_failed',
      version: null,
      stage: 'cleanup',
    }),
  );
  await expect(
    card.getByRole('button', { name: '检查浏览器', exact: true }),
  ).toBeEnabled();
  await expect(card.getByText(/已关闭.*清理/)).toBeVisible();
});

test('StrictMode keeps a single read-only health polling loop', async ({
  page,
}) => {
  await mount(page, closedDraft());
  const card = page.getByRole('region', { name: '浏览器基础检查' });
  await expect(card.getByText('尚未检查浏览器')).toBeVisible();
  await page.evaluate(() => {
    const original = window.desktopApi.getBrowserHealth;
    let reads = 0;
    window.desktopApi.getBrowserHealth = async () => {
      reads++;
      return original();
    };
    Object.assign(window, { healthPollCount: () => reads });
  });
  await page.waitForTimeout(2300);
  expect(
    await page.evaluate(() => Reflect.get(window, 'healthPollCount')()),
  ).toBeLessThanOrEqual(2);
  expect(
    await page.evaluate(() => Reflect.get(window, 'testDraft').commands),
  ).toEqual([]);
});

test('a business browser blocks health commands while preserving platform login checks', async ({
  page,
}) => {
  await mount(
    page,
    { ...initial, task: null },
    false,
    healthView('busy', 'business_open'),
  );
  const card = page.getByRole('region', { name: '浏览器基础检查' });
  await expect(card.getByText(/请先手动关闭专用浏览器/)).toBeVisible();
  await expect(
    card.getByRole('button', { name: '检查浏览器', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '检查登录状态', exact: true }),
  ).toBeEnabled();
});

test('stuck single article can finish by the normal typed command and preserves uncertainty', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const state = Reflect.get(window, 'testDraft');
    window.desktopApi.finishHandledTask = async (input) => {
      Reflect.set(window, 'finishHandledInput', input);
      await new Promise<void>((resolve) =>
        Reflect.set(window, 'releaseHandled', resolve),
      );
      const view = state.get();
      const next = {
        ...view,
        session: {
          status: 'closed',
          bindingToken: null,
          storeName: null,
          reason: null,
        },
        task: {
          ...view.task,
          revision: view.task.revision + 2,
          state: 'stopped_by_user',
          stage: 'settled',
          stopRequested: true,
          platformPaused: false,
        },
      };
      state.set(next);
      return { status: 'ok', view: next };
    };
  });
  await panel(page)
    .getByRole('button', { name: '人工处理完成，结束这篇' })
    .click();
  await expect(
    panel(page).getByRole('button', { name: '人工处理完成，结束这篇' }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => Reflect.get(window, 'finishHandledInput')),
  ).toEqual({ taskId: key, expectedRevision: 3 });
  await page.evaluate(() => Reflect.get(window, 'releaseHandled')());
  await expect(
    panel(page).getByRole('button', { name: '人工处理完成，结束这篇' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '打开专用浏览器' }),
  ).toBeEnabled();
});

test('ArticleWorkspace keeps bound recovery reachable while paused task and batch block normal entry', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate((key) => {
    const api = window.desktopApi.batch;
    const view = {
      id: key,
      revision: 12,
      state: 'paused' as const,
      storeName: '测试门店',
      stopRequested: false,
      reason: 'RESULT_AMBIGUOUS' as const,
      counts: {
        total: 1,
        saved: 0,
        attempted: 0,
        failed: 0,
        skipped: 0,
        pending: 0,
        needsHuman: 1,
        stopped: 0,
      },
      items: [
        {
          articleKey: key,
          title: '测试文章',
          contentDeclaration: 'original' as const,
          coverSummary: null,
          taskId: key,
          state: 'needs_human' as const,
          reason: 'RESULT_AMBIGUOUS' as const,
          saveAttempted: true,
        },
      ],
    };
    api.getCurrent = async () => view;
    api.skipCurrentAndContinue = async (input) => {
      Reflect.set(window, 'parentRecoveryInput', input);
      return { status: 'blocked', reason: 'LOGIN_REQUIRED', view };
    };
  }, key);
  await expect(
    page.getByText(
      '批次正在执行、等待处理或状态待核对，请先处理后再开始单篇任务。',
    ),
  ).toBeVisible();
  await expect(
    panel(page).getByRole('button', { name: '人工处理完成，结束这篇' }),
  ).toBeDisabled();
  await page.getByRole('tab', { name: '批量存草稿' }).click();
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '跳过这篇，继续上传' }).click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'parentRecoveryInput')),
  ).toEqual({ batchId: key, expectedRevision: 12, taskId: key });
  await expect(
    page.getByText('请在专用浏览器中登录，再检查登录状态。'),
  ).toBeVisible();
});
