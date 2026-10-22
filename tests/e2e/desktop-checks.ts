import { _electron as electron, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { checkLibraryFlow } from './library-desktop-flow';
import { exerciseDraftBridge } from './draft-desktop-flow';

export async function checkDesktop(executablePath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'draft-desktop-'));
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
      try {
        const page = await application.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await expect(
          page.getByRole('heading', { name: '汽车经销商草稿助手' }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => Object.keys(window.desktopApi).sort()),
        ).toEqual([
          'applyManualEdit',
          'batch',
          'beginCoverEdit',
          'beginManualArticle',
          'cancelArticleImport',
          'cancelManualOperation',
          'checkDraftSession',
          'closeCoverEdit',
          'closeDraftSession',
          'closeManualEditor',
          'commitManualDocument',
          'confirmTaskClosure',
          'copyCoverImage',
          'copyManualSelection',
          'deleteArticle',
          'discardManualArticle',
          'getAppStatus',
          'getArticleCover',
          'getArticleDeclarations',
          'getArticleDeletionResult',
          'getArticleImage',
          'getArticlePreview',
          'getCoverEditState',
          'getCoverImage',
          'getCoverSaveResult',
          'getDraftState',
          'getImportStatus',
          'getManualArticleState',
          'getManualImage',
          'getManualSaveResult',
          'getOperationControlState',
          'insertManualImage',
          'listArticles',
          'onManualCloseRequest',
          'openDraftSession',
          'openManualArticle',
          'openSavedDraft',
          'pickCoverImages',
          'pickManualImage',
          'prepareDraft',
          'prepareTaskClosure',
          'reconcileDraft',
          'requestStopAll',
          'respondManualClose',
          'retryManualPasteImage',
          'saveCoverEdit',
          'saveManualArticle',
          'setArticleDeclarations',
          'setCoverDraft',
          'spliceManualPaste',
          'startArticleImport',
          'startDraft',
          'startManualPaste',
          'stopDraft',
          'updateManualDraft',
        ]);
        expect(
          await page.evaluate(() => window.desktopApi.getAppStatus()),
        ).toEqual({ state: 'ready', appVersion: '0.1.0', schemaVersion: 14 });
        await page
          .getByRole('button', {
            name: /停止所有未完成操作|停止并初始化/,
            exact: true,
          })
          .click();
        await expect(
          page.getByRole('status', { name: '停止状态' }),
        ).toContainText('已停止并释放占用');
        expect(
          await page.evaluate(() =>
            window.desktopApi.getOperationControlState(),
          ),
        ).toMatchObject({ phase: 'stopped' });
        expect(
          await application.evaluate(({ app }) => app.hasSingleInstanceLock()),
        ).toBe(true);
        if (run === 0) {
          const second = spawn(
            application.process().spawnfile,
            [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
            { env: environment, windowsHide: true, stdio: 'ignore' },
          );
          try {
            const exitCode = await new Promise<number | null>(
              (done, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('Second instance did not exit')),
                  15000,
                );
                second.once('exit', (code) => {
                  clearTimeout(timer);
                  done(code);
                });
                second.once('error', (error) => {
                  clearTimeout(timer);
                  reject(error);
                });
              },
            );
            expect(exitCode).toBe(0);
            expect(application.windows()).toHaveLength(1);
          } finally {
            if (second.exitCode === null) second.kill();
          }
        }
        expect(await page.evaluate(() => 'require' in window)).toBe(false);
        await expect(
          page.evaluate(() =>
            window.desktopApi.getAppStatus.apply(null, [1] as never),
          ),
        ).rejects.toThrow();
        const preferences = await application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          // Electron's internal read-only inspection API; test-only, pinned runtime.
          const prefs = (
            window.webContents as unknown as {
              getLastWebPreferences(): Electron.WebPreferences;
            }
          ).getLastWebPreferences();
          return {
            nodeIntegration: prefs.nodeIntegration,
            contextIsolation: prefs.contextIsolation,
            sandbox: prefs.sandbox,
            webSecurity: prefs.webSecurity,
          };
        });
        expect(preferences).toEqual({
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        });
        expect(
          await application.evaluate(({ app, BrowserWindow }) => {
            const pid =
              BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
            return app.getAppMetrics().find((metric) => metric.pid === pid)
              ?.sandboxed;
          }),
        ).toBe(true);
        await page.evaluate(() => window.open('https://example.invalid/'));
        expect(application.windows()).toHaveLength(1);
        await exerciseDraftBridge(application);
        await checkLibraryFlow(application, page, root, run, !!executablePath);
        expect(errors).toEqual([]);
      } finally {
        await application.close();
      }
    }
    const blockedRoot = join(root, 'blocked');
    mkdirSync(blockedRoot);
    // A file at the required directory is a deterministic unavailable-storage condition.
    writeFileSync(join(blockedRoot, 'data'), 'not a directory');
    const failed = await electron.launch({
      executablePath,
      args: [
        ...(executablePath ? [] : ['.']),
        `--user-data-dir=${blockedRoot}`,
      ],
      env: environment,
    });
    try {
      const page = await failed.firstWindow();
      await expect(page.getByRole('alert')).toHaveText(
        '应用暂时无法准备完成，请关闭后重试。',
      );
      expect(await page.locator('body').innerText()).not.toContain(root);
    } finally {
      await failed.close();
    }
  } finally {
    expect(resolve(root)).toBe(root);
    expect(root.startsWith(join(tmpdir(), 'draft-desktop-'))).toBe(true);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}
