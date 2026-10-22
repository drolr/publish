import { _electron as electron, expect } from '@playwright/test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  cpSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  copyHistoricalBusinessData,
  verifyHistoricalUpgrade,
  treeHashes,
  schema6Backup,
  hasSchema6Backup,
  prepareEmptyCopiedLedger,
} from '../fixtures/library-historical-data';

const evidence = resolve(
  '.superpowers/sdd/2026-10-09-article-library-count-delete',
);
function environment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
export async function checkLibraryManagement(
  executablePath?: string,
  prefix = 'task-5',
  evidenceDirectory = evidence,
) {
  mkdirSync(evidenceDirectory, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'library-management-'));
  const label = executablePath ? 'package' : 'desktop';
  const source = join(root, 'input');
  mkdirSync(source);
  writeFileSync(
    join(source, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
      'base64',
    ),
  );
  let retainedAssets: ReturnType<typeof treeHashes> = [];
  const pids: number[] = [];
  let deletedKey = '';
  let deletedTitle = '';
  try {
    for (let run = 0; run < 2; run++) {
      const app = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
        env: environment(),
      });
      pids.push(app.process().pid!);
      try {
        const page = await app.firstWindow();
        await expect(
          page.getByRole('heading', { name: '汽车经销商草稿助手' }),
        ).toBeVisible();
        const remoteRequests: string[] = [];
        page.on('request', (request) => {
          if (/^https?:/.test(request.url()))
            remoteRequests.push(request.url());
        });
        const closeEditor = async () => {
          const end = page.getByRole('button', {
            name: '结束编辑',
            exact: true,
          });
          if (await end.isVisible()) await end.click();
          await expect
            .poll(() =>
              page.evaluate(() =>
                window.desktopApi.getManualArticleState().then((s) => s.state),
              ),
            )
            .toBe('idle');
        };
        if (run === 0) {
          await expect(
            page.getByText('本机文章共 0 篇', { exact: true }),
          ).toBeVisible();
          for (let i = 0; i < 11; i++) {
            const file = join(source, `article-${i}.json`);
            writeFileSync(
              file,
              JSON.stringify({
                schema_version: 1,
                article_id: `management-${i}`,
                title: `本机管理验证 ${i}`,
                body: [
                  { type: 'paragraph', text: '仅用于本机工程门，不调用平台。' },
                  { type: 'image', image_id: 'local' },
                ],
                images: [
                  {
                    image_id: 'local',
                    source: { type: 'local', path: 'image.png' },
                  },
                ],
              }),
            );
            // Native picker substitution exists only in this test driver.
            await app.evaluate(({ dialog }, selected) => {
              dialog.showOpenDialog = async () => ({
                canceled: false,
                filePaths: [selected],
              });
            }, file);
            await page
              .getByRole('button', { name: '导入文章', exact: true })
              .click();
            await expect
              .poll(() =>
                page.evaluate(() =>
                  window.desktopApi
                    .getImportStatus()
                    .then((s) =>
                      s.state === 'finished' ? s.result.status : s.state,
                    ),
                ),
              )
              .toBe('imported');
            await closeEditor();
          }
          await expect(
            page.getByText('本机文章共 11 篇', { exact: true }),
          ).toBeVisible();
          await expect(page.locator('.article-rows > li')).toHaveCount(10);
          await expect(
            page.getByText('第 1 页 / 共 2 页', { exact: true }),
          ).toBeVisible();
          const first = await page.evaluate(() =>
            window.desktopApi.listArticles(),
          );
          if (first.status !== 'ok' || !first.page.nextCursor)
            throw Error('first page unavailable');
          const second = await page.evaluate(
            (cursor) => window.desktopApi.listArticles(cursor),
            first.page.nextCursor,
          );
          if (second.status !== 'ok') throw Error('second page unavailable');
          expect(second.page.items).toHaveLength(1);
          expect(
            new Set(
              [...first.page.items, ...second.page.items].map(
                (a) => a.articleKey,
              ),
            ).size,
          ).toBe(11);
          deletedKey = second.page.items[0].articleKey;
          deletedTitle = second.page.items[0].title;
          retainedAssets = treeHashes(join(root, 'assets'));
          await page
            .getByRole('button', { name: '下一页', exact: true })
            .click();
          await expect(page.locator('.article-rows > li')).toHaveCount(1);
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(800, 600),
          );
          const trigger = page.getByRole('button', {
            name: `删除 ${deletedTitle}`,
            exact: true,
          });
          await trigger.click();
          const dialog = page.getByRole('dialog', { name: '从本机删除文章？' });
          await expect(dialog).toContainText(deletedTitle);
          await expect(dialog).toContainText('不会删除巨懂车草稿');
          await page.screenshot({
            path: join(evidenceDirectory, `${prefix}-${label}-delete-800.png`),
            fullPage: true,
          });
          await dialog
            .getByRole('button', { name: '取消', exact: true })
            .click();
          await expect(trigger).toBeFocused();
          expect(
            await page.evaluate(() => window.desktopApi.listArticles()),
          ).toMatchObject({ status: 'ok', page: { totalCount: 11 } });
          await trigger.click();
          await dialog
            .getByRole('button', { name: '确认删除', exact: true })
            .click();
          await expect(
            page.getByText('本机文章共 10 篇', { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText('第 1 页 / 共 1 页', { exact: true }),
          ).toBeVisible();
          await expect(page.locator('.article-rows > li')).toHaveCount(10);
          await expect(
            page.getByRole('heading', { name: '已导入本机', exact: true }),
          ).toBeFocused();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: join(evidenceDirectory, `${prefix}-${label}-deleted-800.png`),
            fullPage: true,
          });
        } else {
          await expect(
            page.getByText('本机文章共 10 篇', { exact: true }),
          ).toBeVisible();
          const list = await page.evaluate(() =>
            window.desktopApi.listArticles(),
          );
          expect(list).toMatchObject({
            status: 'ok',
            page: { totalCount: 10, totalPages: 1, pageNumber: 1 },
          });
          if (list.status !== 'ok') throw Error('restart list unavailable');
          expect(list.page.items.some((a) => a.articleKey === deletedKey)).toBe(
            false,
          );
          expect(
            await page.evaluate(
              (key) => window.desktopApi.getArticlePreview(key),
              deletedKey,
            ),
          ).toEqual({ status: 'not_found' });
          expect(treeHashes(join(root, 'assets'))).toEqual(retainedAssets);
          const file = join(source, 'article-0.json');
          await app.evaluate(({ dialog }, selected) => {
            dialog.showOpenDialog = async () => ({
              canceled: false,
              filePaths: [selected],
            });
          }, file);
          await page
            .getByRole('button', { name: '导入文章', exact: true })
            .click();
          await expect
            .poll(() =>
              page.evaluate(() =>
                window.desktopApi
                  .getImportStatus()
                  .then((s) =>
                    s.state === 'finished' ? s.result.status : s.state,
                  ),
              ),
            )
            .toBe('already_deleted');
          await expect(
            page.getByText('该文章已从本机文章池移除，未重新导入', {
              exact: true,
            }),
          ).toBeVisible();
          expect(
            await page.evaluate(() => window.desktopApi.listArticles()),
          ).toMatchObject({ status: 'ok', page: { totalCount: 10 } });
        }
        expect(
          await page.evaluate(() => window.desktopApi.getDraftState()),
        ).toMatchObject({ session: { status: 'closed' }, task: null });
        expect(existsSync(join(root, 'profiles'))).toBe(false);
        expect(remoteRequests).toEqual([]);
      } finally {
        await app.close();
      }
    }
    expect(pids[0]).not.toBe(pids[1]);
    writeFileSync(
      join(evidenceDirectory, `${prefix}-${label}-management.json`),
      JSON.stringify(
        {
          status: 'PASS',
          executable: executablePath ?? 'compiled .webpack',
          independentUserData: root,
          pids,
          imported: 11,
          firstPage: 10,
          secondPage: 1,
          cancelUnchanged: true,
          deletedTitle,
          restartedCount: 10,
          assetsRetained: retainedAssets.length,
          alreadyDeletedImport: true,
          remoteRequests: 0,
          profileCreated: false,
        },
        null,
        2,
      ),
    );
  } finally {
    expect(resolve(root)).toBe(root);
    expect(root.startsWith(join(tmpdir(), 'library-management-'))).toBe(true);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}
export async function checkHistoricalLibraryUpgrade(
  executablePath?: string,
  prefix = 'task-5',
  evidenceDirectory = evidence,
) {
  // Normal CI has no private historical business backup; the local release gate explicitly requires it.
  if (!hasSchema6Backup)
    throw Error(
      'Local historical compatibility gate requires the authorized immutable schema6 backup',
    );
  mkdirSync(evidenceDirectory, { recursive: true });
  const ownerRoot = mkdtempSync(join(tmpdir(), 'library-historical-upgrade-'));
  const root = join(ownerRoot, 'user-data');
  mkdirSync(root);
  const label = executablePath ? 'package' : 'desktop';
  try {
    const expected = copyHistoricalBusinessData(root);
    prepareEmptyCopiedLedger(ownerRoot, root, expected);
    const pids: number[] = [];
    for (let run = 0; run < 2; run++) {
      const app = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
        env: environment(),
      });
      pids.push(app.process().pid!);
      try {
        const page = await app.firstWindow();
        await expect(
          page.getByRole('heading', { name: '汽车经销商草稿助手' }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => window.desktopApi.getAppStatus()),
        ).toMatchObject({ state: 'ready', schemaVersion: 14 });
        const list = await page.evaluate(() =>
          window.desktopApi.listArticles(),
        );
        expect(list).toMatchObject({ status: 'ok', page: { totalCount: 1 } });
        if (list.status !== 'ok') throw Error('historical list unavailable');
        expect(
          await page.evaluate(
            (key) => window.desktopApi.getArticleCover(key),
            list.page.items[0].articleKey,
          ),
        ).toMatchObject({
          status: 'ok',
          configuration: { coverRevision: 0, mode: 'none', images: [] },
        });
        await page
          .getByRole('button')
          .filter({ hasText: list.page.items[0].title })
          .first()
          .click();
        // Real long documents load image bytes only inside the editor viewport.
        await page
          .locator('.inline-article-image')
          .first()
          .scrollIntoViewIfNeeded();
        await expect(
          page.locator('.article-preview img').first(),
        ).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator('.article-preview img')
              .first()
              .evaluate(
                (image: HTMLImageElement) =>
                  image.complete &&
                  image.naturalWidth === 1600 &&
                  image.naturalHeight === 1200,
              ),
          )
          .toBe(true);
        await page
          .getByRole('button', { name: '结束编辑', exact: true })
          .click();
        expect(existsSync(join(root, 'profiles'))).toBe(false);
        expect(
          await page.evaluate(() => window.desktopApi.getDraftState()),
        ).toMatchObject({ session: { status: 'closed' }, task: null });
      } finally {
        await app.close();
      }
    }
    expect(pids[0]).not.toBe(pids[1]);
    const result = verifyHistoricalUpgrade(root, expected);
    const escrowEvidence = join(
      evidenceDirectory,
      `${prefix}-${label}-empty-ledger-escrow.json`,
    );
    cpSync(expected.escrowLedger!, escrowEvidence);
    writeFileSync(
      join(evidenceDirectory, `${prefix}-${label}-historical-upgrade.json`),
      JSON.stringify(
        {
          ...result,
          independentUserData: root,
          pids,
          source: schema6Backup,
          originalImageDecoded: true,
          remoteOperations: 0,
          historicalOnly: true,
          copiedEmptyLedgerEscrow: escrowEvidence,
          copiedEmptyLedgerSha256: expected.nonDatabaseFiles.find(
            (file) => file.path === 'manual-temp-ledger.json',
          )!.sha256,
          sessionsBefore: 0,
          temporaryFilesBefore: 0,
          pendingImportsBefore: 0,
          pendingSavesBefore: 0,
          holdingTasksBefore: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    expect(resolve(ownerRoot)).toBe(ownerRoot);
    expect(
      ownerRoot.startsWith(join(tmpdir(), 'library-historical-upgrade-')),
    ).toBe(true);
    rmSync(ownerRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}
