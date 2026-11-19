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
                  schemaVersion: 15,
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
              editorBody: {
                version: 2,
                blocks: [
                  {
                    type: 'paragraph',
                    content: [
                      {
                        type: 'text',
                        text: '<script>window.bad=true</script>\n原始正文',
                        marks: [],
                      },
                    ],
                  },
                  { type: 'image', imageId: 'one' },
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: '图片之间的段落', marks: [] },
                    ],
                  },
                  { type: 'image', imageId: 'one' },
                ],
              },
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
  const literal = page.locator('p.body-text').filter({ hasText: '原始正文' });
  await expect(literal).toBeVisible();
  await expect(literal).toHaveText('<script>window.bad=true</script>原始正文');
  await expect(literal.locator('br')).toHaveCount(1);
  await expect(page.getByRole('img')).toHaveCount(1);
  await page.screenshot({ path: resolve('.tmp/library-renderer-1000.png') });
  await page.getByRole('button', { name: '查看第 2 张图片' }).click();
  await expect(page.getByRole('img', { name: '第 2 张图片' })).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, 'bad'))).toBe(false);
  expect(
    await page.evaluate(() => Reflect.get(window, 'testState').revoked),
  ).toBeGreaterThan(0);
});

test('T5 top and bottom pagers share page state and selection', async ({
  page,
}) => {
  await mount(page, 'paging');
  const top = page.getByRole('navigation', {
    name: '文章顶部分页',
    exact: true,
  });
  const bottom = page.getByRole('navigation', {
    name: '文章分页',
    exact: true,
  });
  await expect(top.getByRole('button', { name: '上一页' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '全选本页', exact: true }).check();
  await top.getByRole('button', { name: '下一页' }).click();
  await expect(top).toContainText('第 2 页');
  await expect(bottom).toContainText('第 2 页');
  await bottom.getByRole('button', { name: '上一页' }).click();
  await expect(top).toContainText('第 1 页');
  await expect(
    page.getByRole('checkbox', { name: '全选本页', exact: true }),
  ).toBeChecked();
});

test('T5 Judongche preview hides declaration operations and redundant metadata', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: /^一篇汽车文章 文章编号/ }).click();
  await expect(page.getByLabel('文章声明', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /设为原创|设为转载|保存声明/ }),
  ).toHaveCount(0);
  await expect(page.locator('.preview-meta')).not.toContainText(/原创|转载/);
  await expect(page.locator('.article-rows')).not.toContainText(/原创|转载/);
});

test('T5 routine import help supports hover, keyboard focus and Escape at narrow width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await mount(page);
  const help = page.getByRole('button', { name: '导入文章帮助', exact: true });
  const tip = page.getByRole('tooltip');
  await expect(tip).not.toBeVisible();
  await help.hover();
  await expect(tip).toContainText('本地图片需保留相对目录');
  await tip.hover();
  await expect(tip).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(tip).not.toBeVisible();
  await help.focus();
  await expect(tip).toBeVisible();
  await expect(help).toHaveAttribute(
    'aria-describedby',
    (await tip.getAttribute('id'))!,
  );
  await page.screenshot({
    path: resolve(
      '.superpowers/sdd/2026-11-08-operator-recovery-ui/t5-import-help-800.png',
    ),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(tip).not.toBeVisible();
  await expect(help).toBeFocused();
});

test('T5 hover help closes with Escape while keyboard focus remains elsewhere', async ({
  page,
}) => {
  await mount(page);
  const focused = page.getByRole('button', { name: '导入文章', exact: true });
  const help = page.getByRole('button', { name: '导入文章帮助', exact: true });
  const tip = page.getByRole('tooltip');
  await focused.focus();
  await help.hover();
  await expect(tip).toBeVisible();
  await expect(focused).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tip).not.toBeVisible();
  await expect(focused).toBeFocused();
  // The pointer remains over the trigger; a second key must not reopen help.
  await page.keyboard.press('ArrowRight');
  await expect(tip).not.toBeVisible();
  await expect(focused).toBeFocused();
  await focused.evaluate((element) => {
    element.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape')
        element.setAttribute('data-escape-received', 'true');
    });
  });
  await page.keyboard.press('Escape');
  await expect(focused).toHaveAttribute('data-escape-received', 'true');
  await page.mouse.move(0, 0);
  await help.hover();
  await expect(tip).toBeVisible();
});

for (const width of [1280, 800, 480]) {
  test(`T5 shared pagination remains reachable without horizontal overflow at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await mount(page, 'paging');
    const top = page.getByRole('navigation', {
      name: '文章顶部分页',
      exact: true,
    });
    const bottom = page.getByRole('navigation', {
      name: '文章分页',
      exact: true,
    });
    await top.getByRole('button', { name: '下一页' }).click();
    await bottom.getByRole('button', { name: '上一页' }).click();
    await top.getByRole('button', { name: '下一页' }).focus();
    const box = (await top
      .getByRole('button', { name: '下一页' })
      .boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: resolve(
        `.superpowers/sdd/2026-11-08-operator-recovery-ui/t5-library-${width}.png`,
      ),
      fullPage: true,
    });
  });
}
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
  await page
    .getByRole('navigation', { name: '文章分页', exact: true })
    .getByRole('button', { name: '下一页' })
    .click();
  await expect(
    page.getByRole('button', { name: /^第二页文章 文章编号/ }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: '文章分页', exact: true })
    .getByRole('button', { name: '上一页' })
    .click();
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

// Declaration editing has left the Judongche UI; backend contract tests retain that API coverage.
async function pagingFixture(page: Page) {
  await mount(page, 'paging');
  await page.evaluate(() => {
    const items = Array.from({ length: 105 }, (_, index) => ({
      articleKey: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      externalId: `article-${index + 1}`,
      title: `文章 ${index + 1}`,
      contentDeclaration: index % 2 ? 'repost' : 'original',
      createdAt: '2026-09-16T00:00:00.000Z',
      imageCount: 0,
      articleRevision: 1,
    }));
    Object.assign(window.desktopApi, {
      listArticles: async (cursor?: { articleKey: string }) => {
        const start = cursor ? Number(cursor.articleKey.slice(-12)) : 0;
        return {
          status: 'ok',
          page: {
            totalCount: items.length,
            membershipRevision: 0,
            pageNumber: Math.floor(start / 10) + 1,
            totalPages: 11,
            items: items.slice(start, start + 10),
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
    });
  });
  const bottom = page.getByRole('navigation', {
    name: '文章分页',
    exact: true,
  });
  await bottom.getByRole('button', { name: '下一页' }).click();
  await bottom.getByRole('button', { name: '上一页' }).click();
}

test('T5 cross-page selection cap is 100 and clearing restores controls', async ({
  page,
}) => {
  await pagingFixture(page);
  const top = page.getByRole('navigation', {
    name: '文章顶部分页',
    exact: true,
  });
  const bottom = page.getByRole('navigation', {
    name: '文章分页',
    exact: true,
  });
  for (let i = 0; i < 10; i++) {
    await page.getByRole('checkbox', { name: '全选本页', exact: true }).check();
    await (i % 2 ? top : bottom)
      .getByRole('button', { name: '下一页' })
      .click();
  }
  await expect(page.getByText('已选择 100 篇', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章 101', exact: true }),
  ).toBeDisabled();
  await expect(top.getByRole('button', { name: '下一页' })).toBeDisabled();
  await expect(bottom.getByRole('button', { name: '下一页' })).toBeDisabled();
  await expect(page.getByText('已达上限，每次最多选择 100 篇')).toBeVisible();
  await page.getByRole('button', { name: '清空选择' }).click();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章 101', exact: true }),
  ).toBeEnabled();
});

test('T5 both pagers block during reads and recover stale cursors through the same first page', async ({
  page,
}) => {
  await mount(page, 'paging');
  const top = page.getByRole('navigation', {
    name: '文章顶部分页',
    exact: true,
  });
  const bottom = page.getByRole('navigation', {
    name: '文章分页',
    exact: true,
  });
  await page.evaluate(() => {
    const original = window.desktopApi.listArticles;
    Object.assign(window.desktopApi, {
      listArticles: async (cursor: unknown) => {
        if (cursor) {
          await new Promise<void>((resolve) =>
            Object.assign(window, { releasePage: resolve }),
          );
          return { status: 'stale_cursor' };
        }
        return original();
      },
    });
  });
  await top.getByRole('button', { name: '下一页' }).click();
  for (const pager of [top, bottom]) {
    await expect(pager.getByRole('button', { name: '下一页' })).toBeDisabled();
    await expect(pager.getByRole('button', { name: '上一页' })).toBeDisabled();
    await expect(pager).toContainText('正在读取页码');
  }
  await page.evaluate(() => Reflect.get(window, 'releasePage')());
  for (const pager of [top, bottom]) {
    await expect(pager).toContainText('第 1 页');
    await expect(pager.getByRole('button', { name: '上一页' })).toBeDisabled();
  }
});

test('T5 failed page read keeps recovery and errors visible with both pagers disabled', async ({
  page,
}) => {
  await mount(page, 'paging');
  await page.evaluate(() =>
    Object.assign(window.desktopApi, {
      listArticles: async () => ({ status: 'unavailable' }),
    }),
  );
  await page
    .getByRole('navigation', { name: '文章顶部分页', exact: true })
    .getByRole('button', { name: '下一页' })
    .click();
  await expect(page.getByRole('alert')).toContainText('列表暂时无法刷新');
  await expect(
    page.getByRole('button', { name: '重新加载', exact: true }),
  ).toBeVisible();
  for (const name of ['文章顶部分页', '文章分页']) {
    const pager = page.getByRole('navigation', { name, exact: true });
    await expect(pager).toContainText('页码暂时无法读取');
    await expect(pager.getByRole('button', { name: '上一页' })).toBeDisabled();
    await expect(pager.getByRole('button', { name: '下一页' })).toBeDisabled();
  }
});

test('T5 unknown import keeps operational state visible and selection blocked', async ({
  page,
}) => {
  await mount(page, 'recover');
  await expect(page.getByText('连接状态未知，正在确认导入结果…')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: '选择 一篇汽车文章', exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel('文章声明', { exact: true })).toHaveCount(0);
});

for (const { start, count, explicit } of [
  { start: 2147483648, count: 2, explicit: true },
  { start: Number.MAX_SAFE_INTEGER, count: 1, explicit: true },
  { start: 2147483647, count: 2, explicit: true },
  { start: 3, count: 2, explicit: false },
])
  test(
    'ordered preview actual numbering ' + start + ' count ' + count,
    async ({ page }) => {
      await page.setViewportSize({ width: 800, height: 600 });
      await mount(page);
      await page.evaluate(
        ({ start, count }) => {
          const original = window.desktopApi.getArticlePreview;
          Object.assign(window.desktopApi, {
            getArticlePreview: async (key: string) => {
              const result = await original(key);
              if (result.status !== 'ok') return result;
              const items = Array.from({ length: count }, (_, i) => ({
                type: 'paragraph' as const,
                content: [
                  {
                    type: 'text' as const,
                    text: '正文' + (i + 1) + 'LongWord'.repeat(30),
                    marks: ['bold' as const],
                  },
                ],
              }));
              const editorBody = {
                version: 2 as const,
                blocks: [
                  {
                    type: 'list' as const,
                    kind: 'ordered' as const,
                    start,
                    items,
                  },
                ],
              };
              Reflect.set(
                window,
                'numberedPreviewBody',
                structuredClone(editorBody),
              );
              return {
                ...result,
                article: {
                  ...result.article,
                  imageCount: 0,
                  assets: [],
                  body: items.map((p) => ({
                    type: 'paragraph' as const,
                    text: p.content[0].text,
                  })),
                  editorBody,
                },
              };
            },
          });
        },
        { start, count },
      );
      await page
        .getByRole('button', { name: /^一篇汽车文章 文章编号/ })
        .click();
      const list = page.locator('article ol');
      await expect(list).toBeVisible();
      const expected = Array.from(
        { length: count },
        (_, i) => String(start + i) + '.',
      );
      const cdp = await page.context().newCDPSession(page);
      const ax = await cdp.send('Accessibility.getFullAXTree');
      const nativeMarkers = ax.nodes
        .filter((n) => n.role?.value === 'ListMarker')
        .map((n) => String(n.name?.value).trim());
      if (explicit) {
        await expect(list.locator(':scope > li > span')).toHaveText(expected);
        for (const label of expected)
          await expect(list.getByText(label, { exact: true })).toBeVisible();
        const accessible = await list.ariaSnapshot();
        for (const label of expected) expect(accessible).toContain(label);
        expect(accessible).toContain('listitem');
        expect(nativeMarkers).toEqual([]);
      } else {
        expect(
          await list.evaluate((el) => (el as HTMLOListElement).start),
        ).toBe(start);
        expect(nativeMarkers).toEqual(expected);
        await expect(list.locator(':scope > li > span')).toHaveCount(0);
      }
      const bounds = await list.evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
        document: document.documentElement.clientWidth,
        documentScroll: document.documentElement.scrollWidth,
      }));
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
      expect(bounds.documentScroll).toBeLessThanOrEqual(bounds.document);
      expect(
        await page.evaluate(
          () =>
            Reflect.get(window, 'numberedPreviewBody').blocks[0].items[0]
              .content[0].text,
        ),
      ).toMatch(/^正文1LongWord/);
      await page.screenshot({
        path: resolve('.tmp/preview-numbering-' + start + '-' + count + '.png'),
      });
      console.log(
        JSON.stringify({
          start,
          count,
          explicit,
          visibleMarkers: explicit
            ? await list.locator(':scope > li > span').allTextContents()
            : nativeMarkers,
          bounds,
        }),
      );
      await cdp.detach();
    },
  );
