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
        output: {
          path: resolve('.tmp/library-management'),
          filename: 'app.js',
        },
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

async function mount(page: Page, mode = 'normal', count = 11) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>',
      });
    if (!['/app.js', '/app.css'].includes(url.pathname)) return route.abort();
    return route.fulfill({
      contentType: url.pathname.endsWith('js')
        ? 'text/javascript; charset=utf-8'
        : 'text/css; charset=utf-8',
      body: readFileSync(
        resolve('.tmp/library-management', url.pathname.slice(1)),
      ),
    });
  });
  await page.addInitScript(
    ({ mode, count }) => {
      const items = Array.from({ length: count }, (_, i) => ({
        articleKey:
          '11111111-1111-4111-8111-' + String(i + 1).padStart(12, '0'),
        title: '文章 ' + (i + 1),
        externalId: 'a' + (i + 1),
        contentDeclaration: 'original',
        imageCount: 1,
        articleRevision: 1,
        createdAt: '2026-10-09T00:00:00.000Z',
      }));
      let membershipRevision = 0;
      const state = {
        writes: [] as unknown[],
        queries: 0,
        revoked: 0,
        reads: [] as unknown[],
      };
      const receipts = new Map();
      let imported = false;
      Object.assign(window, {
        managementState: state,
        changeMembership: () => {
          items.pop();
          membershipRevision++;
        },
        reviseArticle: () => {
          items[0].title = '新版标题';
          items[0].articleRevision = 2;
        },
      });
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => {
        state.revoked++;
        revoke(url);
      };
      Object.assign(window, {
        desktopApi: {
          getAppStatus: async () => ({
            state: 'ready',
            schemaVersion: 14,
            appVersion: '1',
          }),
          getManualArticleState: async () => ({ state: 'idle', revision: 0 }),
          onManualCloseRequest: () => () => undefined,
          openManualArticle: async () => ({
            status: 'busy',
            snapshot: { state: 'idle', revision: 0 },
          }),
          getImportStatus: async () =>
            imported
              ? {
                  state: 'finished',
                  revision: 1,
                  jobId: items[0].articleKey,
                  result: {
                    status: 'already_deleted',
                    articleKey: items[0].articleKey,
                    title: '已移除文章',
                  },
                }
              : { state: 'idle', revision: 0 },
          startArticleImport: async () => {
            imported = true;
            return { status: 'started', jobId: items[0].articleKey };
          },
          getDraftState: async () => ({
            session: {
              status: 'ready',
              bindingToken: items[0]?.articleKey,
              storeName: '测试门店',
              reason: null,
            },
            preparation: null,
            task: null,
          }),
          listArticles: async (cursor?: {
            membershipRevision: number;
            pageNumber: number;
          }) => {
            state.reads.push(cursor);
            if (mode === 'listfail') return { status: 'unavailable' };
            if (cursor && cursor.membershipRevision !== membershipRevision)
              return { status: 'stale_cursor' };
            const pageNumber = cursor?.pageNumber ?? 1,
              start = (pageNumber - 1) * 10;
            return {
              status: 'ok',
              page: {
                items: items.slice(start, start + 10).map((a) => ({ ...a })),
                totalCount: items.length,
                membershipRevision,
                pageNumber,
                totalPages: Math.max(1, Math.ceil(items.length / 10)),
                ...(start + 10 < items.length
                  ? {
                      nextCursor: {
                        articleKey: items[start + 9].articleKey,
                        createdAt: items[start + 9].createdAt,
                        membershipRevision,
                        pageNumber: pageNumber + 1,
                      },
                    }
                  : {}),
              },
            };
          },
          getArticlePreview: async (key: string) => {
            if (mode === 'metadata') return { status: 'unavailable' };
            const result = {
              status: 'ok',
              article: {
                ...items.find((a) => a.articleKey === key),
                body: [{ type: 'image', image_id: 'image' }],
                assets: [
                  {
                    assetKey: key,
                    imageId: 'image',
                    mime: 'image/png',
                    width: 1,
                    height: 1,
                  },
                ],
              },
            };
            if (mode === 'late')
              await new Promise<void>((r) =>
                Object.assign(window, { releasePreview: r }),
              );
            return result;
          },
          getArticleImage: async () => ({
            status: 'ok',
            mime: 'image/png',
            bytes: [
              137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0,
              0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 11,
              73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45,
              180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
            ],
          }),
          deleteArticle: async (c: {
            operationId: string;
            articleKey: string;
            expectedArticleRevision: number;
          }) => {
            state.writes.push(c);
            if (mode === 'notstarted') throw Error('lost before write');
            if (
              items.find((a) => a.articleKey === c.articleKey)
                ?.articleRevision !== c.expectedArticleRevision
            )
              return { status: 'conflict', operationId: c.operationId };
            const index = items.findIndex((a) => a.articleKey === c.articleKey);
            items.splice(index, 1);
            membershipRevision++;
            const result = {
              status: 'deleted',
              operationId: c.operationId,
              articleKey: c.articleKey,
              articleRevision: c.expectedArticleRevision + 1,
            };
            receipts.set(c.operationId, result);
            if (mode === 'lost') throw Error('lost reply');
            return result;
          },
          getArticleDeletionResult: async (id: string) => {
            state.queries++;
            if (mode === 'lost' || mode === 'notstarted')
              await new Promise<void>((r) =>
                Object.assign(window, { releaseQuery: r }),
              );
            return mode === 'notstarted'
              ? { status: 'not_started', operationId: id }
              : receipts.get(id);
          },
        },
      });
    },
    { mode, count },
  );
  await installCoverBridge(page);
  await page.goto('http://localhost');
  await expect(
    page.getByRole('button', { name: '导入文章', exact: true }),
  ).toBeEnabled();
}
const del = (page: Page, n = 1) =>
  page.getByRole('button', { name: '删除 文章 ' + n, exact: true });
async function confirm(page: Page, n = 1) {
  await del(page, n).click();
  await page
    .getByRole('dialog', { name: '从本机删除文章？' })
    .getByRole('button', { name: '确认删除', exact: true })
    .click();
}
test('eleven_articles_ten_then_one', async ({ page }) => {
  await mount(page);
  await expect(
    page.getByText('本机文章共 11 篇', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.article-rows > li')).toHaveCount(10);
  await expect(
    page.getByText('第 1 页 / 共 2 页', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('.article-rows > li')).toHaveCount(1);
  await expect(
    page.getByText('第 2 页 / 共 2 页', { exact: true }),
  ).toBeVisible();
});
test('delete_last_page_item preserves other selected keys', async ({
  page,
}) => {
  await mount(page);
  await page
    .getByRole('checkbox', { name: '选择 文章 1', exact: true })
    .check();
  await page.getByRole('button', { name: '下一页' }).click();
  await page
    .getByRole('checkbox', { name: '选择 文章 11', exact: true })
    .check();
  await confirm(page, 11);
  await expect(
    page.getByText('本机文章共 10 篇', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('第 1 页 / 共 1 页', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('已选择 1 篇', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章 1', exact: true }),
  ).toBeChecked();
});
test('delete_current_selection clears preview Blob and returns focus', async ({
  page,
}) => {
  await mount(page, 'normal', 2);
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await expect(page.locator('.article-preview img')).toHaveCount(1);
  await confirm(page);
  await expect(page.locator('.article-preview img')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'managementState').revoked),
    )
    .toBe(1);
  await expect(
    page.getByRole('heading', { name: '已导入本机', exact: true }),
  ).toBeFocused();
});
test('metadata_only_deletion does not need image preview', async ({ page }) => {
  await mount(page, 'metadata', 1);
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '文章素材无法读取' }),
  ).toBeVisible();
  await confirm(page);
  await expect(
    page.getByText('本机文章共 0 篇', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('第 1 页 / 共 1 页', { exact: true }),
  ).toBeVisible();
});
for (const oldQuery of ['resolved', 'rejected'])
  test(
    'late ' +
      oldQuery +
      ' deletion query cannot suppress or release a newer command',
    async ({ page }) => {
      await mount(page);
      await page.evaluate(() => {
        const remove = window.desktopApi.deleteArticle,
          query = window.desktopApi.getArticleDeletionResult;
        const originals: Array<() => void> = [],
          checks: Array<(fail?: boolean) => void> = [];
        Object.assign(window, { queryProbe: { originals, checks } });
        Object.assign(window.desktopApi, {
          deleteArticle: async (
            c: import('../../src/contracts/article-delete').DeleteArticleCommand,
          ) => {
            const result = await remove(c);
            await new Promise<void>((r) => originals.push(r));
            return result;
          },
          getArticleDeletionResult: async (id: string) => {
            const result = await query(id);
            await new Promise<void>((resolve, reject) =>
              checks.push((fail) =>
                fail ? reject(Error('late query failed')) : resolve(),
              ),
            );
            return result;
          },
        });
      });
      await confirm(page);
      await expect
        .poll(
          () =>
            page.evaluate(
              () => Reflect.get(window, 'queryProbe').checks.length,
            ),
          { timeout: 6500 },
        )
        .toBe(1);
      await page.evaluate(() =>
        Reflect.get(window, 'queryProbe').originals[0](),
      );
      await expect(
        page.getByText('本机文章共 10 篇', { exact: true }),
      ).toBeVisible();
      await del(page, 2).click();
      await page
        .getByRole('dialog', { name: '从本机删除文章？' })
        .getByRole('button', { name: '确认删除', exact: true })
        .click();
      await expect
        .poll(
          () =>
            page.evaluate(
              () => Reflect.get(window, 'queryProbe').checks.length,
            ),
          { timeout: 6500 },
        )
        .toBe(2);
      await page.evaluate(
        (fail) => Reflect.get(window, 'queryProbe').checks[0](fail),
        oldQuery === 'rejected',
      );
      await expect(
        page.getByRole('button', { name: '新建文章', exact: true }),
      ).toBeDisabled();
      await page.evaluate(() => Reflect.get(window, 'queryProbe').checks[1]());
      await expect(
        page.getByText('本机文章共 9 篇', { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => Reflect.get(window, 'managementState').writes.length,
        ),
      ).toBe(2);
      await page.evaluate(() =>
        Reflect.get(window, 'queryProbe').originals[1](),
      );
      await expect(
        page.getByRole('button', { name: '新建文章', exact: true }),
      ).toBeEnabled();
    },
  );

test('hung delete reconciles committed receipt once during slow refresh and retires late replies', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const remove = window.desktopApi.deleteArticle,
      list = window.desktopApi.listArticles;
    const replies: Array<(fail?: boolean) => void> = [];
    let refreshes = 0,
      holdRefresh = false;
    Object.assign(window, {
      deleteProbe: {
        replies,
        refreshes: () => refreshes,
        hold: () => {
          holdRefresh = true;
        },
        resume: () => {
          holdRefresh = false;
        },
      },
    });
    Object.assign(window.desktopApi, {
      deleteArticle: async (
        c: import('../../src/contracts/article-delete').DeleteArticleCommand,
      ) => {
        const result = await remove(c);
        await new Promise<void>((resolve, reject) =>
          replies.push((fail) =>
            fail ? reject(Error('late lost reply')) : resolve(),
          ),
        );
        return result;
      },
      listArticles: async (...args: Parameters<typeof list>) => {
        if (holdRefresh) {
          refreshes++;
          await new Promise<void>((r) =>
            Object.assign(window, { releaseDeleteRefresh: r }),
          );
        }
        return list(...args);
      },
    });
  });
  await del(page).click();
  await page.evaluate(() => Reflect.get(window, 'deleteProbe').hold());
  await page
    .getByRole('dialog', { name: '从本机删除文章？' })
    .getByRole('button', { name: '确认删除', exact: true })
    .click();
  await expect
    .poll(
      () => page.evaluate(() => Reflect.get(window, 'deleteProbe').refreshes()),
      { timeout: 6500 },
    )
    .toBe(1);
  await page.evaluate(() => Reflect.get(window, 'deleteProbe').replies[0]());
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'deleteProbe').refreshes()),
    )
    .toBe(1);
  await page.evaluate(() => {
    Reflect.get(window, 'deleteProbe').resume();
    Reflect.get(window, 'releaseDeleteRefresh')();
  });
  await expect(
    page.getByText('本机文章共 10 篇', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'managementState').writes.length,
    ),
  ).toBe(1);
});

for (const absence of [
  'not_started',
  'unavailable',
  'error',
  'wrong_receipt',
  'late_rejection',
])
  test(
    'pending delete remains frozen for ' +
      absence +
      ' before admission and ignores its late reply after a new command',
    async ({ page }) => {
      await mount(page);
      await page.evaluate((absence) => {
        const remove = window.desktopApi.deleteArticle,
          query = window.desktopApi.getArticleDeletionResult;
        const admissions: Array<() => void> = [],
          replies: Array<(fail?: boolean) => void> = [];
        let queryMode = absence === 'late_rejection' ? 'unavailable' : absence,
          queries = 0,
          calls = 0;
        Object.assign(window, {
          deleteProbe: {
            admissions,
            replies,
            queries: () => queries,
            calls: () => calls,
            reconcile: () => {
              queryMode = 'real';
            },
          },
        });
        Object.assign(window.desktopApi, {
          deleteArticle: async (
            c: import('../../src/contracts/article-delete').DeleteArticleCommand,
          ) => {
            calls++;
            await new Promise<void>((r) => admissions.push(r));
            const result = await remove(c);
            await new Promise<void>((resolve, reject) =>
              replies.push((fail) =>
                fail
                  ? reject(Error('late rejected original reply'))
                  : resolve(),
              ),
            );
            return result;
          },
          getArticleDeletionResult: async (id: string) => {
            queries++;
            if (queryMode === 'error') throw Error('receipt unavailable');
            if (queryMode === 'wrong_receipt')
              return {
                status: 'deleted',
                operationId: id,
                articleKey: '00000000-0000-4000-8000-000000000999',
                articleRevision: 2,
              };
            if (queryMode !== 'real')
              return { status: queryMode, operationId: id };
            return query(id);
          },
        });
      }, absence);
      await confirm(page);
      await expect
        .poll(
          () =>
            page.evaluate(() => Reflect.get(window, 'deleteProbe').queries()),
          { timeout: 6500 },
        )
        .toBeGreaterThan(0);
      await expect(
        page.getByRole('button', { name: '新建文章', exact: true }),
      ).toBeDisabled();
      await expect(del(page, 2)).toBeDisabled();
      expect(
        await page.evaluate(() => Reflect.get(window, 'deleteProbe').calls()),
      ).toBe(1);
      expect(
        await page.evaluate(
          () => Reflect.get(window, 'managementState').writes.length,
        ),
      ).toBe(0);
      await page.evaluate(() => {
        Reflect.get(window, 'deleteProbe').admissions[0]();
        Reflect.get(window, 'deleteProbe').reconcile();
      });
      await expect(
        page.getByText('本机文章共 10 篇', { exact: true }),
      ).toBeVisible();
      const priorQueries = await page.evaluate(() =>
        Reflect.get(window, 'deleteProbe').queries(),
      );
      await del(page, 2).click();
      await page
        .getByRole('dialog', { name: '从本机删除文章？' })
        .getByRole('button', { name: '确认删除', exact: true })
        .click();
      await page.evaluate(
        (fail) => Reflect.get(window, 'deleteProbe').replies[0](fail),
        absence === 'late_rejection',
      );
      await expect(
        page.getByRole('button', { name: '新建文章', exact: true }),
      ).toBeDisabled();
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, 'deleteProbe').queries()),
        )
        .toBeGreaterThan(priorQueries);
      await page.evaluate(() =>
        Reflect.get(window, 'deleteProbe').admissions[1](),
      );
      await expect(
        page.getByText('本机文章共 9 篇', { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => Reflect.get(window, 'deleteProbe').calls()),
      ).toBe(2);
      expect(
        await page.evaluate(
          () => Reflect.get(window, 'managementState').writes.length,
        ),
      ).toBe(2);
    },
  );

test('lost_delete_reply only queries and freezes related actions', async ({
  page,
}) => {
  await mount(page, 'lost');
  await confirm(page);
  await expect(
    page.getByText('删除结果暂时无法确认，正在核对…', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '新建文章', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '导入文章', exact: true }),
  ).toBeDisabled();
  await expect(del(page, 2)).toBeDisabled();
  await expect(
    page.getByRole('dialog', { name: '从本机删除文章？' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '检查登录状态', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => Reflect.get(window, 'releaseQuery')());
  await expect(
    page.getByText('本机文章共 10 篇', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'managementState').writes.length,
    ),
  ).toBe(1);
});
test('not_started receipt unlocks without replay', async ({ page }) => {
  await mount(page, 'notstarted');
  await confirm(page);
  await expect
    .poll(() => page.evaluate(() => Object.hasOwn(window, 'releaseQuery')))
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, 'releaseQuery')());
  await expect(
    page.getByRole('alert').filter({ hasText: '尚未开始' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'managementState').writes.length,
    ),
  ).toBe(1);
});
test('keyboard cancel and confirm at minimum size', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await mount(page, 'normal', 2);
  await del(page).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '从本机删除文章？' });
  await expect(dialog).toContainText('文章 1');
  await page.screenshot({
    path: resolve(
      '.superpowers/sdd/2026-10-09-article-library-count-delete/task-4-delete-800.png',
    ),
  });
  await expect(
    dialog.getByRole('button', { name: '取消', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    dialog.getByRole('button', { name: '确认删除', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: '取消', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(del(page)).toBeFocused();
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'managementState').writes.length,
    ),
  ).toBe(0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('本机文章共 1 篇', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('late preview cannot resurrect deleted item', async ({ page }) => {
  await mount(page, 'late');
  await page.getByRole('button', { name: /^文章 1 文章编号/ }).click();
  await expect
    .poll(() => page.evaluate(() => Object.hasOwn(window, 'releasePreview')))
    .toBe(true);
  await confirm(page);
  await page.evaluate(() => Reflect.get(window, 'releasePreview')());
  await expect(
    page.getByRole('heading', { name: '文章 1', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('本机文章共 10 篇', { exact: true }),
  ).toBeVisible();
});
test('membership_change_resets_cursor', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => Reflect.get(window, 'changeMembership')());
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(
    page.getByText('第 1 页 / 共 1 页', { exact: true }),
  ).toBeVisible();
});

test('delete_after_revision_change refuses old confirmation and re-reads new title', async ({
  page,
}) => {
  await mount(page, 'normal', 1);
  await del(page).click();
  await page.evaluate(() => Reflect.get(window, 'reviseArticle')());
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '文章已更新' }),
  ).toBeVisible();
  await expect(
    page.getByText('本机文章共 1 篇', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('已从本机文章池移除，不会删除巨懂车草稿。', { exact: true }),
  ).toHaveCount(0);
  await del(page).click();
  await expect(page.getByRole('dialog')).toContainText('新版标题');
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(
    page.getByText('本机文章共 0 篇', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Reflect.get(window, 'managementState').writes.map(
        (c: { expectedArticleRevision: number }) => c.expectedArticleRevision,
      ),
    ),
  ).toEqual([1, 2]);
});

test('already_deleted import gives business reason without opening removed article', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: '导入文章', exact: true }).click();
  await expect(
    page.getByText('该文章已从本机文章池移除，未重新导入', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '选择一篇文章', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('本机文章共 11 篇', { exact: true }),
  ).toBeVisible();
});

test('count failure remains distinct from empty count', async ({ page }) => {
  await mount(page, 'listfail');
  await expect(
    page.getByText('数量暂时无法读取', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('本机文章共 0 篇', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: '重新加载', exact: true }),
  ).toBeEnabled();
});

for (const scenario of ['repeated_cursor', 'second_stale', 'page_limit'])
  test(`deletion_metadata_walk_fails_closed_${scenario}`, async ({ page }) => {
    await mount(page, 'normal', 21);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(del(page, 21)).toBeVisible();
    await page.evaluate((scenario) => {
      const original = window.desktopApi.listArticles;
      let calls = 0;
      let firstCursor: unknown;
      Object.assign(window, { metadataWalkReads: () => calls });
      Object.assign(window.desktopApi, {
        listArticles: async (cursor?: Parameters<typeof original>[0]) => {
          calls++;
          if (scenario === 'second_stale' && cursor)
            return { status: 'stale_cursor' };
          const result = await original(cursor);
          if (result.status !== 'ok') return result;
          if (!cursor) firstCursor = result.page.nextCursor;
          if (scenario === 'repeated_cursor' && cursor)
            return {
              ...result,
              page: { ...result.page, nextCursor: firstCursor },
            };
          if (scenario === 'page_limit')
            return { ...result, page: { ...result.page, totalPages: 1 } };
          return result;
        },
      });
    }, scenario);
    await del(page, 21).click();
    await expect(
      page.getByRole('alert').filter({ hasText: '文章信息暂时无法读取' }),
    ).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: '从本机删除文章？' }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => Reflect.get(window, 'managementState').writes.length,
      ),
    ).toBe(0);
    expect(
      await page.evaluate(() => Reflect.get(window, 'metadataWalkReads')()),
    ).toBe(
      scenario === 'repeated_cursor' ? 2 : scenario === 'second_stale' ? 4 : 1,
    );
  });

for (const [count, pages] of [
  [0, 1],
  [1, 1],
  [10, 1],
  [20, 2],
  [21, 3],
])
  test(`count_boundary_${count}`, async ({ page }) => {
    await mount(page, 'normal', count);
    await expect(
      page.getByText(`本机文章共 ${count} 篇`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`第 1 页 / 共 ${pages} 页`, { exact: true }),
    ).toBeVisible();
    const seen: string[] = [];
    for (let i = 1; i <= pages; i++) {
      seen.push(
        ...(await page.locator('.article-rows strong').allTextContents()),
      );
      if (i < pages) await page.getByRole('button', { name: '下一页' }).click();
    }
    expect(seen).toEqual(
      Array.from({ length: count }, (_, i) => `文章 ${i + 1}`),
    );
    await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

test('batch uses cross-page selection in click order and invalidates changed summary', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
  const panel = page.getByRole('region', { name: '批量存草稿' });
  await expect(
    panel.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeDisabled();
  await page.evaluate(() => {
    const api = window.desktopApi.batch;
    api.prepare = async (input) => {
      Reflect.set(window, 'batchSelectedKeys', input.articleKeys);
      return {
        status: 'ready',
        preparation: {
          preparationId: '11111111-1111-4111-8111-111111111111',
          storeName: '测试门店',
          items: input.articleKeys.map((key, index) => ({
            articleKey: key,
            title: `批次文章${index + 1}`,
            contentDeclaration: 'repost',
            coverSummary: null,
            state: 'queued',
            reason: null,
            taskId: null,
          })),
        },
      };
    };
  });
  await page
    .getByRole('checkbox', { name: '选择 文章 2', exact: true })
    .check();
  await page
    .getByRole('checkbox', { name: '选择 文章 3', exact: true })
    .check();
  await page.getByRole('button', { name: '下一页' }).click();
  await page
    .getByRole('checkbox', { name: '选择 文章 11', exact: true })
    .check();
  await page.getByRole('button', { name: '上一页' }).click();
  await page
    .getByRole('checkbox', { name: '选择 文章 3', exact: true })
    .uncheck();
  await page.getByRole('button', { name: '下一页' }).click();
  await panel.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(
    panel.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'batchSelectedKeys')),
  ).toEqual([
    '11111111-1111-4111-8111-000000000002',
    '11111111-1111-4111-8111-000000000011',
  ]);
  await page
    .getByRole('checkbox', { name: '选择 文章 11', exact: true })
    .uncheck();
  await expect(
    panel.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toHaveCount(0);
});
