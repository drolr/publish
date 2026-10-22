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
        entry: resolve('src/renderer/main.tsx'),
        output: { path: resolve('.tmp/library-renderer'), filename: 'app.js' },
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

async function mount(page: Page, scenario = 'normal') {
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://library.test') return route.abort();
    const name = url.pathname;
    if (name === '/app.js' || name === '/app.css')
      await route.fulfill({
        contentType: name.endsWith('js')
          ? 'text/javascript; charset=utf-8'
          : 'text/css; charset=utf-8',
        body: readFileSync(resolve('.tmp/library-renderer', name.slice(1))),
      });
    else if (name === '/')
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      });
    else await route.abort();
  });
  await page.addInitScript(
    ({ scenario }) => {
      const key = '11111111-1111-4111-8111-111111111111';
      const summary = {
        articleKey: key,
        externalId: 'story-1',
        title: '一篇汽车文章',
        contentDeclaration: 'original' as 'original' | 'repost',
        imageCount: 1,
        articleRevision: 1,
        createdAt: '2026-09-16T00:00:00.000Z',
      };
      let active = scenario === 'recover';
      let polls = 0;
      let imported = false;
      let starts = 0;
      const state = {
        starts: 0,
        images: 0,
        revoked: 0,
        cursors: [] as unknown[],
        maxQueries: 0,
        queries: 0,
      };
      Object.assign(window, { testState: state });
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => {
        state.revoked++;
        revoke(url);
      };
      Object.assign(window, {
        desktopApi: {
          onManualCloseRequest: () => () => undefined,
          getManualArticleState: async () => ({ state: 'idle', revision: 0 }),
          // Keep these independent readonly library/platform cases out of admitted editor fixtures.
          openManualArticle: async () => ({
            status: 'busy',
            snapshot: { state: 'idle', revision: 0 },
          }),
          beginManualArticle: async () => ({
            status: 'unavailable',
            snapshot: { state: 'idle', revision: 0 },
          }),
          updateManualDraft: async () => ({
            status: 'unavailable',
            snapshot: { state: 'idle', revision: 0 },
          }),
          pickManualImage: async () => ({
            status: 'unavailable',
            snapshot: { state: 'idle', revision: 0 },
          }),
          getManualImage: async () => ({ status: 'not_found' }),
          saveManualArticle: async () => ({
            status: 'unavailable',
            snapshot: { state: 'idle', revision: 0 },
          }),
          cancelManualOperation: async () => ({
            status: 'unavailable',
            snapshot: { state: 'idle', revision: 0 },
          }),
          discardManualArticle: async () => ({
            status: 'unavailable',
            snapshot: { state: 'idle', revision: 0 },
          }),
          getAppStatus: async () =>
            scenario === 'unavailable'
              ? { state: 'unavailable', code: 'INITIALIZATION_FAILED' }
              : {
                  state: 'ready',
                  schemaVersion: 14,
                  appVersion: '1',
                },
          startArticleImport: async () => {
            starts++;
            state.starts = starts;
            active = true;
            return { status: 'started', jobId: key };
          },
          getImportStatus: async () => {
            state.queries++;
            state.maxQueries = Math.max(state.maxQueries, state.queries);
            await new Promise((r) => setTimeout(r, 20));
            state.queries--;
            if (active) {
              polls++;
              if (scenario === 'recover' && polls === 1)
                throw new Error('private');
              if (polls < 3)
                return { state: 'importing', revision: polls, jobId: key };
              active = false;
              imported = true;
              return {
                state: 'finished',
                revision: 4,
                jobId: key,
                result: {
                  status: 'imported',
                  articleKey: key,
                  title: summary.title,
                  warnings: [],
                },
              };
            }
            return { state: 'idle', revision: 0 };
          },
          cancelArticleImport: async () => {
            active = false;
            return {
              state: 'finished',
              revision: 5,
              jobId: key,
              result: { status: 'cancelled' },
            };
          },
          listArticles: async (cursor: unknown) => {
            state.cursors.push(cursor);
            if (scenario === 'listfail' && imported)
              return { status: 'unavailable' };
            return {
              status: 'ok',
              page: {
                totalCount:
                  scenario === 'empty' && !imported
                    ? 0
                    : scenario === 'paging'
                      ? 11
                      : 1,
                membershipRevision: 0,
                pageNumber: cursor ? 2 : 1,
                totalPages: scenario === 'paging' ? 2 : 1,
                items:
                  scenario === 'empty' && !imported
                    ? []
                    : scenario === 'paging' && !cursor
                      ? [
                          summary,
                          ...Array.from({ length: 9 }, (_, index) => ({
                            ...summary,
                            articleKey: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                            externalId: `paging-${index + 1}`,
                            title: `本页文章 ${index + 1}`,
                          })),
                        ]
                      : [
                          {
                            ...summary,
                            ...(cursor
                              ? {
                                  articleKey:
                                    '00000000-0000-4000-8000-000000000010',
                                  externalId: 'paging-10',
                                }
                              : {}),
                            title: cursor ? '第二页文章' : summary.title,
                          },
                        ],
                ...(!cursor && scenario === 'paging'
                  ? {
                      nextCursor: {
                        createdAt: summary.createdAt,
                        articleKey: '00000000-0000-4000-8000-000000000009',
                        membershipRevision: 0,
                        pageNumber: 2,
                      },
                    }
                  : {}),
              },
            };
          },
          getArticlePreview: async () => ({
            status: 'ok',
            article: {
              ...summary,
              body: [
                {
                  type: 'paragraph',
                  text: '<script>window.bad=true</script>\n原始正文',
                },
                { type: 'image', image_id: 'one' },
                { type: 'paragraph', text: '图片之间的段落' },
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
          getArticleDeclarations: async () => ({
            status: 'ok',
            items: [
              {
                articleKey: key,
                title: summary.title,
                externalId: summary.externalId,
                contentDeclaration: summary.contentDeclaration,
              },
            ],
          }),
          setArticleDeclarations: async (change: {
            declaration: 'original' | 'repost';
          }) => {
            const changedCount =
              summary.contentDeclaration === change.declaration ? 0 : 1;
            summary.contentDeclaration = change.declaration;
            return {
              status: 'updated',
              changedCount,
              unchangedCount: 1 - changedCount,
              items: [
                {
                  articleKey: key,
                  title: summary.title,
                  externalId: summary.externalId,
                  contentDeclaration: summary.contentDeclaration,
                },
              ],
            };
          },
          getArticleImage: async () => {
            state.images++;
            if (scenario === 'busyimage' && state.images === 1)
              return { status: 'busy' };
            return {
              status: 'ok',
              mime: 'image/png',
              bytes: Uint8Array.from(
                atob(
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
                ),
                (c) => c.charCodeAt(0),
              ),
            };
          },
        },
      });
    },
    { scenario },
  );
  await installCoverBridge(page);
  await page.goto('http://library.test/');
}

test('empty library imports and selects literal ordered preview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await mount(page, 'empty');
  await expect(page.getByText('还没有文章')).toBeVisible();
  await page.getByRole('button', { name: '导入文章', exact: true }).click();
  await expect(page.locator('.operation')).toContainText('已导入');
  await expect(
    page.getByRole('heading', { name: '一篇汽车文章' }),
  ).toBeFocused();
  await expect(
    page.getByText('<script>window.bad=true</script>\n原始正文'),
  ).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(1);
  await page.screenshot({ path: resolve('.tmp/library-renderer-1000.png') });
  await page.getByRole('button', { name: '查看第 2 张图片' }).click();
  await expect(page.getByRole('img', { name: '第 2 张图片' })).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, 'bad'))).toBe(false);
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').revoked),
  ).toBeGreaterThan(0);
});
test('recovers unknown status without resubmission and polls serially', async ({
  page,
}) => {
  await mount(page, 'recover');
  await expect(page.getByText('连接状态未知，正在确认导入结果…')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '导入文章', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.operation')).toContainText('已导入');
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').starts),
  ).toBe(0);
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').maxQueries),
  ).toBe(1);
});
test('keeps committed success when list refresh fails', async ({ page }) => {
  await mount(page, 'listfail');
  await page.getByRole('button', { name: '导入文章', exact: true }).click();
  await expect(page.locator('.operation')).toContainText('已导入');
  await expect(page.getByRole('alert')).toContainText('列表暂时无法刷新');
  await expect(
    page.getByRole('heading', { name: '一篇汽车文章' }),
  ).toBeVisible();
});
test('cursor back stack and compact viewport remain usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await mount(page, 'paging');
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(
    page.getByRole('button', { name: /^第二页文章 文章编号/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: '上一页' }).click();
  await page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }).click();
  await expect(
    page.getByRole('heading', { name: '一篇汽车文章' }),
  ).toBeVisible();
  await page.screenshot({ path: resolve('.tmp/library-renderer-800.png') });
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(
    page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('image busy retries reading without importing again', async ({ page }) => {
  await mount(page, 'busyimage');
  await page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }).click();
  await expect(page.getByRole('img')).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').images),
  ).toBe(2);
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').starts),
  ).toBe(0);
});

test('initialization failure does not expose article operations', async ({
  page,
}) => {
  await mount(page, 'unavailable');
  await expect(page.getByRole('alert')).toHaveText(
    '应用暂时无法准备完成，请关闭后重试。',
  );
  await expect(
    page.getByRole('button', { name: '导入文章', exact: true }),
  ).toHaveCount(0);
});

test('late old job result cannot hide a newly started job', async ({
  page,
}) => {
  await mount(page);
  await expect(
    page.getByRole('button', { name: '导入文章', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    let starts = 0;
    let reads = 0;
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    Object.assign(window.desktopApi, {
      startArticleImport: async () => ({
        status: 'started',
        jobId: ++starts === 1 ? first : second,
      }),
      getImportStatus: async () => {
        reads++;
        if (reads === 1)
          return { state: 'importing', revision: 1, jobId: first };
        if (reads === 2)
          return new Promise((resolve) =>
            Object.assign(window, {
              resolveOld: () =>
                resolve({
                  state: 'finished',
                  revision: 2,
                  jobId: first,
                  result: { status: 'cancelled' },
                }),
            }),
          );
        return {
          state: 'finished',
          revision: 4,
          jobId: second,
          result: {
            status: 'imported',
            articleKey: first,
            title: '一篇汽车文章',
            warnings: [],
          },
        };
      },
      cancelArticleImport: async () => ({
        state: 'finished',
        revision: 2,
        jobId: first,
        result: { status: 'cancelled' },
      }),
    });
  });
  await page.getByRole('button', { name: '导入文章', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Object.hasOwn(window, 'resolveOld')))
    .toBe(true);
  await page.getByRole('button', { name: '取消导入' }).click();
  await expect(page.locator('.operation')).toContainText('已取消导入');
  await page.getByRole('button', { name: '导入文章', exact: true }).click();
  await page.evaluate(() => Reflect.get(window, 'resolveOld')());
  await expect(page.locator('.operation')).toContainText('已导入');
});

test('late image bytes are discarded and reads remain serial across positions', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const original = window.desktopApi.getArticleImage;
    let calls = 0;
    Object.assign(window.desktopApi, {
      getArticleImage: async (...args: [string, string]) => {
        calls++;
        Object.assign(window, { imageCalls: calls });
        if (calls === 1)
          await new Promise<void>((resolve) =>
            Object.assign(window, { releaseImage: resolve }),
          );
        return original(...args);
      },
    });
  });
  await page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'imageCalls')))
    .toBe(1);
  await page.getByRole('button', { name: '查看第 2 张图片' }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'imageCalls'))).toBe(1);
  await page.evaluate(() => Reflect.get(window, 'releaseImage')());
  await expect(page.getByRole('img', { name: '第 2 张图片' })).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(1);
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(
    page.getByRole('heading', { name: '选择一篇文章' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').revoked),
  ).toBe(1);
});

test('preview busy retries only the current article read', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const original = window.desktopApi.getArticlePreview;
    let calls = 0;
    Object.assign(window.desktopApi, {
      getArticlePreview: async (key: string) => {
        if (++calls === 1) return { status: 'busy' };
        return original(key);
      },
    });
  });
  await page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }).click();
  await expect(
    page.getByRole('heading', { name: '一篇汽车文章' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').starts),
  ).toBe(0);
});

test('reload resumes existing import by querying without a new start', async ({
  page,
}) => {
  await mount(page, 'recover');
  await expect(page.getByText('连接状态未知，正在确认导入结果…')).toBeVisible();
  await page.reload();
  await expect(page.locator('.operation')).toContainText('已导入');
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').starts),
  ).toBe(0);
});

test('unreadable preview never displays partial text or requests image bytes', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() =>
    Object.assign(window.desktopApi, {
      getArticlePreview: async () => ({ status: 'unavailable' }),
    }),
  );
  await page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }).click();
  await expect(page.getByRole('alert')).toContainText(
    '文章素材无法读取，请检查本地存储',
  );
  await expect(
    page.getByText('<script>window.bad=true</script>\n原始正文'),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').images),
  ).toBe(0);
});

test('single declaration edit updates persisted projection and disables unchanged save', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }).click();
  await expect(
    page.getByRole('button', { name: '保存声明', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('文章声明', { exact: true }).selectOption('repost');
  await page.getByRole('button', { name: '保存声明', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已更新' }),
  ).toContainText('已更新 1 篇，0 篇原本已是该属性');
  await expect(
    page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }),
  ).toContainText('转载');
});

async function declarationFixture(page: Page, mode = 'normal') {
  await mount(page);
  await expect(
    page.getByRole('button', { name: '导入文章', exact: true }),
  ).toBeEnabled();
  await page.evaluate(
    ({ mode }) => {
      const items = Array.from({ length: 105 }, (_, index) => ({
        articleKey: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
        externalId: `article-${index + 1}`,
        title: `文章 ${index + 1}`,
        contentDeclaration:
          index % 2 ? ('repost' as const) : ('original' as const),
        createdAt: '2026-09-16T00:00:00.000Z',
        imageCount: 0,
        articleRevision: 1,
      }));
      const state = { writes: 0, reads: 0 };
      Object.assign(window, { declarationState: state });
      Object.assign(window.desktopApi, {
        listArticles: async (cursor?: { articleKey: string }) => {
          if (mode === 'refreshfail' && state.writes)
            return { status: 'unavailable' };
          const start = cursor ? Number(cursor.articleKey.slice(-12)) : 0;
          return {
            status: 'ok',
            page: {
              totalCount: items.length,
              membershipRevision: 0,
              pageNumber: Math.floor(start / 10) + 1,
              totalPages: 11,
              items: items
                .slice(start, start + 10)
                .map((item) => ({ ...item })),
              ...(start + 10 < items.length
                ? {
                    nextCursor: {
                      articleKey: items[start + 9].articleKey,
                      createdAt: items[start + 9].createdAt,
                      membershipRevision: 0,
                      pageNumber: Math.floor(start / 10) + 2,
                    },
                  }
                : {}),
            },
          };
        },
        getArticleDeclarations: async (keys: string[]) => {
          state.reads++;
          if (mode === 'readfail') return { status: 'unavailable' };
          if (mode === 'fresh') items[0].contentDeclaration = 'repost';
          return {
            status: 'ok',
            items: items
              .filter((item) => keys.includes(item.articleKey))
              .map(({ articleKey, title, externalId, contentDeclaration }) => ({
                articleKey,
                title,
                externalId,
                contentDeclaration,
              })),
          };
        },
        getArticlePreview: async (key: string) =>
          mode === 'brokenpreview'
            ? { status: 'unavailable' }
            : {
                status: 'ok',
                article: {
                  ...items.find((item) => item.articleKey === key),
                  body: [{ type: 'paragraph', text: '正文' }],
                  assets: [],
                },
              },
        setArticleDeclarations: async (change: {
          targets: {
            articleKey: string;
            expectedDeclaration: 'original' | 'repost';
          }[];
          declaration: 'original' | 'repost';
        }) => {
          state.writes++;
          if (mode === 'conflict')
            return {
              status: 'conflict',
              articleKeys: [change.targets[0].articleKey],
            };
          if (mode === 'pending')
            await new Promise<void>((resolve) =>
              Object.assign(window, { releaseSave: resolve }),
            );
          const targets = items.filter((item) =>
            change.targets.some(
              (target) => target.articleKey === item.articleKey,
            ),
          );
          const changedCount = targets.filter(
            (item) => item.contentDeclaration !== change.declaration,
          ).length;
          targets.forEach((item) => {
            item.contentDeclaration = change.declaration;
          });
          if (mode === 'unknown') throw new Error('private transport details');
          return {
            status: 'updated',
            changedCount,
            unchangedCount: targets.length - changedCount,
            items: targets.map(
              ({ articleKey, title, externalId, contentDeclaration }) => ({
                articleKey,
                title,
                externalId,
                contentDeclaration,
              }),
            ),
          };
        },
      });
    },
    { mode },
  );
  // Existing next page causes an ordinary read of the fixture without reopening the app.
  await page
    .getByRole('checkbox', { name: '选择 一篇汽车文章', exact: true })
    .check();
  await page.getByRole('button', { name: '设为原创', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章 1', exact: true }),
  ).toBeVisible();
}

test('cross page batch confirmation uses all selected current values and counts unchanged', async ({
  page,
}) => {
  await declarationFixture(page);
  await page
    .getByRole('checkbox', { name: '选择 文章 1', exact: true })
    .check();
  await page.getByRole('button', { name: '下一页' }).click();
  await page
    .getByRole('checkbox', { name: '选择 文章 12', exact: true })
    .check();
  await page.getByRole('button', { name: '设为原创', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('文章编号 article-1', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText('文章编号 article-12', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '确认修改' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已更新' }),
  ).toContainText('已更新 1 篇，1 篇原本已是该属性');
  await expect(page.getByText('已选择 0 篇', { exact: true })).toBeVisible();
});

test('page selection cap is 100 and clearing selection restores all controls', async ({
  page,
}) => {
  await declarationFixture(page);
  for (let i = 0; i < 10; i++) {
    await page.getByRole('checkbox', { name: '全选本页', exact: true }).check();
    await page.getByRole('button', { name: '下一页' }).click();
  }
  await expect(page.getByText('已选择 100 篇', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章 101', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('已达上限，每次最多选择 100 篇')).toBeVisible();
  await page.getByRole('button', { name: '清空选择' }).click();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章 101', exact: true }),
  ).toBeEnabled();
});

test('dialog reads current values, traps focus, closes with Escape and restores trigger at 800', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await declarationFixture(page, 'fresh');
  await page
    .getByRole('checkbox', { name: '选择 文章 1', exact: true })
    .check();
  const trigger = page.getByRole('button', { name: '设为原创', exact: true });
  await trigger.click();
  await expect(page.getByRole('dialog')).toContainText(
    '当前：转载 → 目标：原创',
  );
  await expect(
    page.getByRole('button', { name: '导入文章', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: resolve('.tmp/declaration-800.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(() => Reflect.get(window, 'declarationState').writes),
  ).toBe(0);
});

test('unconfirmed write only reconciles and never reports inferred success', async ({
  page,
}) => {
  await declarationFixture(page, 'unknown');
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await page.getByLabel('文章声明', { exact: true }).selectOption('repost');
  await page.getByRole('button', { name: '保存声明', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    '保存结果暂时无法确认，请核对当前属性',
  );
  await expect(
    page.getByRole('button', { name: '保存声明', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '导入文章', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '核对当前属性' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已核对' }),
  ).toBeVisible();
  await expect(page.getByLabel('文章声明', { exact: true })).toHaveValue(
    'repost',
  );
  expect(
    await page.evaluate(() => Reflect.get(window, 'declarationState').writes),
  ).toBe(1);
  await expect(page.getByText(/已更新/)).toHaveCount(0);
});

test('conflict prevents success and preserves bulk selection', async ({
  page,
}) => {
  await declarationFixture(page, 'conflict');
  await page
    .getByRole('checkbox', { name: '选择 文章 1', exact: true })
    .check();
  await page.getByRole('button', { name: '设为转载', exact: true }).click();
  await page.getByRole('button', { name: '确认修改' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    '文章属性已变化，请刷新后重新确认',
  );
  await expect(page.getByText('已选择 1 篇', { exact: true })).toBeVisible();
});

test('declaration save succeeds even when article preview is unreadable', async ({
  page,
}) => {
  await declarationFixture(page, 'brokenpreview');
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await expect(page.getByRole('alert')).toContainText('文章素材无法读取');
  await page.getByLabel('文章声明', { exact: true }).selectOption('repost');
  await page.getByRole('button', { name: '保存声明', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已更新' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('文章素材无法读取');
});

test('committed declaration result survives failed list refresh', async ({
  page,
}) => {
  await declarationFixture(page, 'refreshfail');
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await page.getByLabel('文章声明', { exact: true }).selectOption('repost');
  await page.getByRole('button', { name: '保存声明', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已更新' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('列表暂时无法刷新');
});

test('saving blocks repeated writes, selection, paging and import until resolution', async ({
  page,
}) => {
  await declarationFixture(page, 'pending');
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await page.getByLabel('文章声明', { exact: true }).selectOption('repost');
  await page
    .getByRole('button', { name: '保存声明', exact: true })
    .dblclick({ force: true });
  await expect(
    page.getByRole('status').filter({ hasText: '正在保存声明' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: '全选本页' })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '导入文章', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => Reflect.get(window, 'releaseSave')());
  await expect(
    page.getByRole('status').filter({ hasText: '已更新' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'declarationState').writes),
  ).toBe(1);
});

test('read failure blocks confirmation and preserves selection', async ({
  page,
}) => {
  await declarationFixture(page, 'readfail');
  await page
    .getByRole('checkbox', { name: '选择 文章 1', exact: true })
    .check();
  await page.getByRole('button', { name: '设为转载', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认修改' })).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('无法读取当前声明');
  await page.keyboard.press('Escape');
  await expect(page.getByText('已选择 1 篇', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'declarationState').writes),
  ).toBe(0);
});

test('unknown uncommitted response resets draft after reading unchanged persisted value', async ({
  page,
}) => {
  await declarationFixture(page);
  await page.evaluate(() =>
    Object.assign(window.desktopApi, {
      setArticleDeclarations: async () => {
        throw new Error('transport');
      },
    }),
  );
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await page.getByLabel('文章声明', { exact: true }).selectOption('repost');
  await page.getByRole('button', { name: '保存声明', exact: true }).click();
  await page.getByRole('button', { name: '核对当前属性' }).click();
  await expect(page.getByLabel('文章声明', { exact: true })).toHaveValue(
    'original',
  );
  await expect(
    page.getByRole('button', { name: '保存声明', exact: true }),
  ).toBeDisabled();
});

test('switching preview discards unsaved edits and reload clears temporary selection', async ({
  page,
}) => {
  await declarationFixture(page);
  await page
    .getByRole('checkbox', { name: '选择 文章 1', exact: true })
    .check();
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await page.getByLabel('文章声明', { exact: true }).selectOption('repost');
  await page.getByRole('button', { name: /^文章 2 文章编号/ }).click();
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await expect(page.getByLabel('文章声明', { exact: true })).toHaveValue(
    'original',
  );
  await page.reload();
  await expect(page.getByText('已选择 0 篇', { exact: true })).toBeVisible();
  await expect(page.getByLabel('文章声明', { exact: true })).toHaveCount(0);
});

test('late preview cannot replace saved declaration and single save preserves batch selection', async ({
  page,
}) => {
  await declarationFixture(page);
  await page.evaluate(() => {
    const original = window.desktopApi.getArticlePreview;
    let calls = 0;
    Object.assign(window.desktopApi, {
      getArticlePreview: async (key: string) => {
        const result = await original(key);
        if (++calls === 1)
          await new Promise<void>((resolve) =>
            Object.assign(window, { releasePreview: resolve }),
          );
        return result;
      },
    });
  });
  await page
    .getByRole('checkbox', { name: '选择 文章 1', exact: true })
    .check();
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await expect
    .poll(() => page.evaluate(() => Object.hasOwn(window, 'releasePreview')))
    .toBe(true);
  await page.getByLabel('文章声明', { exact: true }).selectOption('repost');
  await page.getByRole('button', { name: '保存声明', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已更新' }),
  ).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'releasePreview')());
  await expect(
    page.getByRole('heading', { name: '文章 1', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('文章声明', { exact: true })).toHaveValue(
    'repost',
  );
  await expect(page.locator('.preview-meta')).toContainText('转载');
  await expect(page.getByText('已选择 1 篇', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设为原创', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('当前：转载');
});

test('active import and unknown import status disable declaration edits', async ({
  page,
}) => {
  await mount(page, 'recover');
  await expect(page.getByText('连接状态未知，正在确认导入结果…')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: '选择 一篇汽车文章', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }).click();
  await expect(page.getByLabel('文章声明', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '设为转载', exact: true }),
  ).toBeDisabled();
});

test('dialog return focus survives delayed list and preview refresh with an open preview', async ({
  page,
}) => {
  await declarationFixture(page);
  await page
    .getByRole('checkbox', { name: '选择 文章 1', exact: true })
    .check();
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await expect(
    page.getByRole('heading', { name: '文章 1', exact: true }),
  ).toBeVisible();
  const trigger = page.getByRole('button', { name: '设为原创', exact: true });
  await trigger.click();
  await expect(page.getByRole('button', { name: '确认修改' })).toBeEnabled();
  await page.getByRole('button', { name: '确认修改' }).focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: '关闭', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '确认修改' })).toBeFocused();
  await page.evaluate(() => {
    const list = window.desktopApi.listArticles;
    const preview = window.desktopApi.getArticlePreview;
    Object.assign(window.desktopApi, {
      listArticles: async () => {
        await new Promise<void>((resolve) =>
          Object.assign(window, { releaseList: resolve }),
        );
        return list();
      },
      getArticlePreview: async (key: string) => {
        await new Promise<void>((resolve) =>
          Object.assign(window, { releaseFocusPreview: resolve }),
        );
        return preview(key);
      },
    });
  });
  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => Object.hasOwn(window, 'releaseList')))
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, 'releaseList')());
  await expect(trigger).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => Object.hasOwn(window, 'releaseFocusPreview')),
    )
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, 'releaseFocusPreview')());
  await expect(
    page.getByRole('heading', { name: '文章 1', exact: true }),
  ).toBeVisible();
  await expect(trigger).toBeFocused();
});
