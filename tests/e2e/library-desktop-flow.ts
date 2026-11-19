import { returnToArticlePool } from './focused-editor-navigation';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { checkDeclarationFlow } from './declaration-desktop-flow';

export async function checkLibraryFlow(
  application: ElectronApplication,
  page: Page,
  root: string,
  run: number,
  packaged: boolean,
) {
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  // The first ordered body image is the user-visible editor image, not the retained hidden preview.
  const firstBodyImage = body
    .getByRole('img', { name: '正文图片', exact: true })
    .first();
  if (run === 0) {
    await expect(page.getByText('还没有文章', { exact: true })).toBeVisible();
    const source = join(root, 'input');
    mkdirSync(source);
    const file = join(source, 'article.json');
    writeFileSync(
      join(source, 'image.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
        'base64',
      ),
    );
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        article_id: 'desktop-test',
        content_declaration: 'original',
        title: '秋日自驾笔记',
        body: [
          { type: 'paragraph', text: '周末沿着山路出发，记录沿途的风景。' },
          { type: 'image', image_id: 'road' },
          {
            type: 'paragraph',
            text: '<script>window.untrusted = true</script>',
          },
          { type: 'image', image_id: 'road' },
        ],
        images: [
          { image_id: 'road', source: { type: 'local', path: 'image.png' } },
        ],
      }),
    );
    // Test-only native dialog substitution. Everything after selection is production code.
    await application.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, file);
    await returnToArticlePool(page);
    await page.getByRole('button', { name: '导入文章', exact: true }).click();
    await expect
      .poll(async () => {
        const s = await page.evaluate(() =>
          window.desktopApi.getImportStatus(),
        );
        return s.state === 'finished' ? s.result.status : s.state;
      })
      .toBe('imported');
    await expect(body).toBeVisible();
    await expect(firstBodyImage).toBeVisible();
    await expect
      .poll(() =>
        firstBodyImage.evaluate(
          (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await expect(
      body.getByText('<script>window.untrusted = true</script>', {
        exact: true,
      }),
    ).toBeVisible();
    expect(await page.evaluate(() => Object.hasOwn(window, 'untrusted'))).toBe(
      false,
    );
    const list = await page.evaluate(() => window.desktopApi.listArticles());
    expect(list.status).toBe('ok');
    if (list.status !== 'ok') throw new Error('list');
    expect(list.page.items).toHaveLength(1);
    const key = list.page.items[0].articleKey;
    const preview = await page.evaluate(
      (key) => window.desktopApi.getArticlePreview(key),
      key,
    );
    expect(preview.status).toBe('ok');
    for (const secret of ['relativePath', 'importId', 'sha256', source])
      expect(JSON.stringify(preview)).not.toContain(secret);
    await expect(
      page.evaluate(() =>
        window.desktopApi.startArticleImport.apply(null, [
          { path: 'C:/secret' },
        ] as never),
      ),
    ).rejects.toThrow();
    expect(
      await page.evaluate(
        (key) => window.desktopApi.getArticleImage(key, key),
        key,
      ),
    ).toEqual({ status: 'not_found' });
    await returnToArticlePool(page);
    await page.getByRole('button', { name: '导入文章', exact: true }).click();
    await expect
      .poll(async () => {
        const s = await page.evaluate(() =>
          window.desktopApi.getImportStatus(),
        );
        return s.state === 'finished' ? s.result.status : s.state;
      })
      .toBe('already_exists');
    // Import completion precedes the renderer's asynchronous editor handover.
    await expect(
      page.getByRole('textbox', { name: '文章标题', exact: true }),
    ).toHaveValue('秋日自驾笔记');
    await page.reload();
    await expect(
      page.getByRole('textbox', { name: '文章标题', exact: true }),
    ).toHaveValue('秋日自驾笔记');
    // Cancellation and renderer reload while the native chooser is still unresolved.
    await application.evaluate(({ dialog }) => {
      let calls = 0;
      dialog.showOpenDialog = () => {
        calls++;
        if (calls !== 1) throw Error('Second native chooser must not start');
        return new Promise((resolve) =>
          setTimeout(() => resolve({ canceled: true, filePaths: [] }), 1500),
        );
      };
    });
    await returnToArticlePool(page);
    await page.getByRole('button', { name: '导入文章', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.desktopApi.getImportStatus().then((s) => s.state),
        ),
      )
      .toBe('selecting');
    await page.reload();
    const selecting = await page.evaluate(() =>
      window.desktopApi.getImportStatus(),
    );
    expect(selecting.state).toBe('selecting');
    expect(
      await page.evaluate(
        (articleKey) =>
          window.desktopApi.setArticleDeclarations({
            targets: [{ articleKey, expectedDeclaration: 'repost' }],
            declaration: 'original',
          }),
        key,
      ),
    ).toEqual({ status: 'busy' });
    if (!('jobId' in selecting)) throw new Error('selection');
    expect(
      await page.evaluate(() => window.desktopApi.startArticleImport()),
    ).toEqual({ status: 'unavailable' });
    expect(
      await page.evaluate(() => window.desktopApi.getImportStatus()),
    ).toEqual(selecting);
    await page.evaluate(
      (id) => window.desktopApi.cancelArticleImport(id),
      selecting.jobId,
    );
    await expect
      .poll(async () => {
        const s = await page.evaluate(() =>
          window.desktopApi.getImportStatus(),
        );
        return s.state === 'finished' ? s.result.status : s.state;
      })
      .toBe('cancelled');
    await checkDeclarationFlow(application, page, source);
    expect(resolve(source)).toBe(source);
    expect(source.startsWith(resolve(root) + sep)).toBe(true);
    rmSync(source, { recursive: true });
    await page
      .getByRole('region', { name: '文章列表', exact: true })
      .getByRole('button', { name: /^秋日自驾笔记 文章编号/ })
      .click();
    await expect(body).toBeVisible();
    await expect(firstBodyImage).toBeVisible();
    await page.screenshot({
      path: resolve(
        `test-results/library-${packaged ? 'package' : 'desktop'}.png`,
      ),
      fullPage: true,
    });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(800, 600),
    );
    await returnToArticlePool(page);
    await expect(
      page.getByRole('button', { name: '导入文章', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(
        `test-results/library-${packaged ? 'package' : 'desktop'}-small.png`,
      ),
      fullPage: true,
    });
  } else {
    const list = await page.evaluate(() => window.desktopApi.listArticles());
    expect(list.status).toBe('ok');
    if (list.status !== 'ok') throw new Error('list');
    expect(list.page.items).toHaveLength(2);
    expect(
      Object.fromEntries(
        list.page.items.map((item) => [item.title, item.contentDeclaration]),
      ),
    ).toEqual({
      秋日自驾笔记: 'original',
      城市通勤随记: 'repost',
    });
    await page
      .getByRole('region', { name: '文章列表', exact: true })
      .getByRole('button', { name: /^秋日自驾笔记 文章编号/ })
      .click();
    await expect(body).toBeVisible();
    await expect(firstBodyImage).toBeVisible();
    // Close during selection: application must cancel and settle, then exit cleanly.
    // Selecting a saved article now opens the one canonical editor session;
    // settle that unchanged session before starting the import chooser.
    await returnToArticlePool(page);
    await expect(
      page.getByRole('button', { name: '导入文章', exact: true }),
    ).toBeVisible();
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ canceled: true, filePaths: [] }), 500),
        );
    });
    await page.getByRole('button', { name: '导入文章', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.desktopApi.getImportStatus().then((s) => s.state),
        ),
      )
      .toBe('selecting');
  }
}

export {
  checkLibraryManagement,
  checkHistoricalLibraryUpgrade,
} from './library-management-desktop-flow';
