import { returnToArticlePool } from './focused-editor-navigation';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Offline worker/bridge proof. This is deliberately NOT native browser clipboard evidence. */
export async function checkWebPasteDesktop(
  application: ElectronApplication,
): Promise<void> {
  const page = await application.firstWindow();
  if (
    await page
      .getByRole('button', { name: '返回文章池', exact: true })
      .isVisible()
  )
    await returnToArticlePool(page);
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: '正文格式' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '插入图片', exact: true }),
  ).toBeVisible();
  // Controlled synthetic event exercises the real renderer command synchronization.
  // Browser-native evidence is exclusively continuous-editor-native.spec.ts.
  await page.getByRole('textbox', { name: '文章正文', exact: true }).click();
  await page
    .getByRole('textbox', { name: '文章正文', exact: true })
    .evaluate((element) => {
      const data = new DataTransfer();
      data.setData(
        'text/html',
        '<p>Worker 前文</p><img src="data:image/png,unsupported"><p>Worker 后文</p>',
      );
      data.setData('text/plain', 'ignored');
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.desktopApi
          .getManualArticleState()
          .then(
            (s) =>
              s.state === 'editing' &&
              'candidates' in s &&
              s.candidates.length === 1 &&
              s.candidates[0].state === 'failed',
          ),
      ),
    )
    .toBe(true);
  const before = await page.evaluate(() =>
    window.desktopApi.getManualArticleState(),
  );
  if (!('draft' in before)) throw Error('draft');
  expect(before.draft.blocks.map((b) => b.type)).toEqual([
    'paragraph',
    'image-pending',
    'paragraph',
  ]);
  await expect(
    page.getByRole('button', { name: '保存到本机', exact: true }),
  ).toBeDisabled();
  await page.reload();
  expect(
    await page.evaluate(() => window.desktopApi.getManualArticleState()),
  ).toEqual(before);
  await expect(
    page.getByRole('textbox', { name: '文章正文', exact: true }),
  ).toBeEditable();
  await expect(
    page.getByRole('textbox', { name: '文章正文', exact: true }),
  ).toContainText('Worker 前文');
  await page.getByRole('button', { name: '返回文章池', exact: true }).click();
  await page
    .getByRole('dialog', { name: '离开当前编辑？' })
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  expect(
    await page.evaluate(() => window.desktopApi.getManualArticleState()),
  ).toEqual(before);
  await page
    .getByRole('textbox', { name: '文章正文', exact: true })
    .fill('Worker 前文');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Worker 后文');
  await page.getByLabel('文章标题', { exact: true }).fill('Worker offline');
  await page.getByRole('button', { name: '保存到本机', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已保存到本机' }),
  ).toBeVisible();
}
export async function checkWebPasteRuntime(executablePath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'draft-web-paste-'));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    for (let run = 0; run < 2; run++) {
      const application = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
        env: environment,
      });
      let completed = false;
      try {
        if (run === 0) await checkWebPasteDesktop(application);
        else {
          await application.evaluate(({ session }) =>
            session.defaultSession.enableNetworkEmulation({ offline: true }),
          );
          const page = await application.firstWindow();
          await expect
            .poll(() =>
              page.evaluate(() =>
                window.desktopApi.getAppStatus().then((s) => s.state),
              ),
            )
            .toBe('ready');
          const list = await page.evaluate(() =>
            window.desktopApi.listArticles(),
          );
          if (list.status !== 'ok') throw Error('list');
          expect(list.page.items).toHaveLength(1);
          const preview = await page.evaluate(
            (key) => window.desktopApi.getArticlePreview(key),
            list.page.items[0].articleKey,
          );
          expect(preview).toMatchObject({
            status: 'ok',
            article: {
              title: 'Worker offline',
              body: [
                { type: 'paragraph', text: 'Worker 前文' },
                { type: 'paragraph', text: 'Worker 后文' },
              ],
            },
          });
          expect(
            await page.evaluate(() =>
              window.desktopApi.getManualArticleState(),
            ),
          ).toMatchObject({ state: 'idle' });
        }
        completed = true;
      } catch (error) {
        console.error('Owned desktop check failed before cleanup', error);
        throw error;
      } finally {
        if (!completed) {
          const child = application.process();
          if (child.exitCode === null && child.pid) {
            try {
              execFileSync(
                'taskkill',
                ['/PID', String(child.pid), '/T', '/F'],
                { windowsHide: true, stdio: 'ignore' },
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
    if (
      !resolve(root).startsWith(resolve(tmpdir()) + sep) ||
      !root.includes('draft-web-paste-')
    )
      expect(false, 'unsafe cleanup').toBe(true);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}
