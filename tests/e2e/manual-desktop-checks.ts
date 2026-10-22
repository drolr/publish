import { _electron as electron, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export async function checkManualDesktop(executablePath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'draft-manual-'));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    for (let run = 0; run < 3; run++) {
      const application = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
        env: environment,
      });
      let completed = false;
      try {
        const page = await application.firstWindow();
        await expect(
          page.getByRole('heading', { name: '汽车经销商草稿助手' }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => window.desktopApi.getManualArticleState()),
        ).toMatchObject({ state: 'idle' });
        if (run === 0) {
          await page
            .getByRole('button', { name: '新建文章', exact: true })
            .click();
          await page
            .getByRole('button', { name: '手动录入', exact: true })
            .click();
          await page.getByLabel('文章标题', { exact: true }).fill('手动纯文字');
          await page
            .getByRole('textbox', { name: '文章正文', exact: true })
            .fill('<script>字面正文</script>');
          await page
            .getByRole('button', { name: '保存到文章池', exact: true })
            .click();
          await expect(
            page.getByRole('status').filter({ hasText: '文章已保存到本机' }),
          ).toBeVisible();
          await page
            .getByRole('button', { name: '新建文章', exact: true })
            .click();
          await page
            .getByRole('button', { name: '手动录入', exact: true })
            .click();
          await page.getByLabel('文章标题', { exact: true }).fill('手动图文');
          await page
            .getByRole('textbox', { name: '文章正文', exact: true })
            .fill('保留的段落');
          await page
            .getByLabel('文章声明', { exact: true })
            .selectOption('original');
          await expect(
            page.getByRole('status').filter({ hasText: '输入已同步' }),
          ).toBeVisible();
          await page.reload();
          await page
            .getByRole('button', { name: '手动录入', exact: true })
            .click();
          await expect(
            page.getByLabel('文章标题', { exact: true }),
          ).toHaveValue('手动图文');
          expect(
            await page.evaluate(() => window.desktopApi.startArticleImport()),
          ).toEqual({ status: 'unavailable' });
          const list = await page.evaluate(() =>
            window.desktopApi.listArticles(),
          );
          if (list.status !== 'ok') throw Error('list');
          expect(
            await page.evaluate(
              (key) =>
                window.desktopApi.setArticleDeclarations({
                  targets: [{ articleKey: key, expectedDeclaration: 'repost' }],
                  declaration: 'original',
                }),
              list.page.items[0].articleKey,
            ),
          ).toEqual({ status: 'busy' });
          for (let index = 0; index < 2; index++) {
            const directory = join(root, `source-${index}`);
            mkdirSync(directory);
            const file = join(directory, 'image.png');
            writeFileSync(
              file,
              Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
                'base64',
              ),
            );
            await application.evaluate(({ dialog }, selected) => {
              dialog.showOpenDialog = async () => ({
                canceled: false,
                filePaths: [selected],
              });
            }, file);
            await page
              .getByRole('textbox', { name: '文章正文', exact: true })
              .click();
            await page.keyboard.press('Control+End');
            await page
              .getByRole('button', { name: '添加图片', exact: true })
              .click();
            await expect
              .poll(() =>
                page.evaluate(() =>
                  window.desktopApi
                    .getManualArticleState()
                    .then((s) => ('images' in s ? s.images.length : 0)),
                ),
              )
              .toBe(index + 1);
          }
          await expect(
            page.getByRole('button', { name: /上移|下移/ }),
          ).toHaveCount(0);
          await page.screenshot({
            path: resolve(
              `test-results/manual-${executablePath ? 'package' : 'desktop'}.png`,
            ),
            fullPage: true,
          });
          await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(800, 600),
          );
          await page.screenshot({
            path: resolve(
              `test-results/manual-${executablePath ? 'package' : 'desktop'}-small.png`,
            ),
            fullPage: true,
          });
          // Cancel native close; the same session must remain writable afterwards.
          await application.evaluate(({ dialog, BrowserWindow }) => {
            dialog.showMessageBox = async () => ({
              response: 0,
              checkboxChecked: false,
            });
            BrowserWindow.getAllWindows()[0].close();
          });
          await expect(
            page.getByLabel('文章标题', { exact: true }),
          ).toHaveValue('手动图文');
          await page
            .getByRole('button', { name: '保存到文章池', exact: true })
            .click();
          await expect(
            page.getByRole('status').filter({ hasText: '文章已保存到本机' }),
          ).toBeVisible();
          for (let index = 0; index < 2; index++)
            rmSync(join(root, `source-${index}`), { recursive: true });
        }
        const list = await page.evaluate(() =>
          window.desktopApi.listArticles(),
        );
        if (list.status !== 'ok') throw Error('list');
        expect(list.page.items).toHaveLength(2);
        const article = list.page.items.find(
          (item) => item.title === '手动图文',
        );
        expect(article?.contentDeclaration).toBe('original');
        if (!article) throw Error('manual article');
        const preview = await page.evaluate(
          (key) => window.desktopApi.getArticlePreview(key),
          article.articleKey,
        );
        if (preview.status !== 'ok') throw Error('preview');
        expect(preview.article.body.map((block) => block.type)).toEqual([
          'paragraph',
          'image',
          'image',
        ]);
        expect(preview.article.assets).toHaveLength(2);
        for (const asset of preview.article.assets)
          expect(
            await page.evaluate(
              ({ key, asset }) =>
                window.desktopApi
                  .getArticleImage(key, asset)
                  .then((result) => result.status),
              { key: article.articleKey, asset: asset.assetKey },
            ),
          ).toBe('ok');
        if (run === 1) {
          await page
            .getByRole('button', { name: '新建文章', exact: true })
            .click();
          await page
            .getByRole('button', { name: '手动录入', exact: true })
            .click();
          await page.getByLabel('文章标题', { exact: true }).fill('放弃的文章');
          await application.evaluate(({ dialog }) => {
            dialog.showMessageBox = async () => ({
              response: 2,
              checkboxChecked: false,
            });
          });
        }
        completed = true;
      } catch (error) {
        console.error('Owned desktop check failed before cleanup', error);
        throw error;
      } finally {
        if (!completed) {
          // Failed acceptance cleanup uses only the child returned by this
          // launch. A forced exit is never evidence of ordinary shutdown.
          const child = application.process();
          if (child.exitCode === null && child.pid) {
            try {
              execFileSync(
                'taskkill',
                ['/PID', String(child.pid), '/T', '/F'],
                {
                  windowsHide: true,
                  stdio: 'ignore',
                },
              );
            } catch {
              /* the owned child may already be gone */
            }
            await expect
              .poll(() => child.exitCode, { timeout: 5000 })
              .not.toBeNull();
          }
          await application.close().catch(() => {});
        } else {
          await application
            .evaluate(({ dialog }) => {
              dialog.showMessageBox = async () => ({
                response: 2,
                checkboxChecked: false,
              });
            })
            .catch(() => {});
          await application.close();
        }
      }
    }
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}
