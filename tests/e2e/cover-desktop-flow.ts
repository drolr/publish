import { returnToArticlePool } from './focused-editor-navigation';
// Real Electron/main/picker/decoder/SQLite/assets. Only native chooser selection is test controlled.
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { treeHashes } from '../fixtures/library-historical-data';
const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const cover = (p: Page) => p.getByRole('region', { name: '封面图片' });
async function choose(app: ElectronApplication, paths?: string[]) {
  await app.evaluate(({ dialog }, paths) => {
    Reflect.set(globalThis, 'task7ChooserCalls', 0);
    dialog.showOpenDialog = async () => {
      Reflect.set(
        globalThis,
        'task7ChooserCalls',
        Reflect.get(globalThis, 'task7ChooserCalls') + 1,
      );
      return { canceled: paths === null, filePaths: paths ?? [] };
    };
  }, paths ?? null);
}
async function waitIdle(p: Page) {
  await expect
    .poll(() =>
      p.evaluate(() =>
        window.desktopApi.getCoverEditState().then((s) => s.status),
      ),
    )
    .toBe('idle');
}
async function closeBody(p: Page) {
  await returnToArticlePool(p);
}
async function selectCoverArticle(page: Page, index: number, dirty = false) {
  await expect(
    page.getByRole('button', { name: '新建文章', exact: true }),
  ).toBeEnabled();
  const modal = page.getByRole('dialog', { name: '离开封面编辑？' });
  const alreadyOpen = await modal.isVisible();
  console.info(
    'T7 before single selection event',
    index,
    'leaveModalOpen',
    alreadyOpen,
  );
  expect(
    alreadyOpen,
    'No leave request exists before this single operator event',
  ).toBe(false);
  const row = page.getByRole('button', {
    name: new RegExp('^封面本机验证' + index),
  });
  await row.focus();
  await expect(row).toBeFocused();
  await expect(modal).not.toBeVisible();
  // One real keyboard event avoids pointer retries when this event opens a modal.
  await page.keyboard.press('Enter');
  if (dirty) await expect(modal).toBeVisible();
  else {
    await expect(page.getByLabel('文章标题')).toHaveValue(
      '封面本机验证' + index,
    );
    await returnToArticlePool(page);
    await expect(
      page.getByRole('button', { name: '新建文章', exact: true }),
    ).toBeEnabled();
  }
}
export async function checkCoverDesktop(
  executablePath?: string,
  evidence = resolve('.tmp/operator-recovery/cover-evidence'),
) {
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'cover-native-'));
  const input = join(root, 'input');
  mkdirSync(input);
  const userData = join(root, 'user-data');
  mkdirSync(userData);
  const label = executablePath ? 'package' : 'desktop';
  const paths: string[] = [],
    hashes: string[] = [];
  for (const [i, color] of [
    'red',
    'green',
    'blue',
    'yellow',
    'magenta',
  ].entries()) {
    const bytes = await sharp({
      create: { width: 24 + i, height: 18 + i, channels: 3, background: color },
    })
      .png()
      .toBuffer();
    const p = join(input, `${i}.png`);
    writeFileSync(p, bytes);
    paths.push(p);
    hashes.push(hash(bytes));
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const pids: number[] = [];
  let keys: string[] = [];
  const before: unknown[] = [];
  const configs: unknown[] = [];
  let retained: ReturnType<typeof treeHashes> = [];
  let bodyFiles: ReturnType<typeof treeHashes> = [];
  const orderedHashes = [[hashes[0]], [hashes[1], hashes[4], hashes[2]]];
  try {
    for (let run = 0; run < 3; run++) {
      const app = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`],
        env,
      });
      pids.push(app.process().pid!);
      expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(
        userData,
      );
      let ownedPage: Page | undefined;
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async (...args: unknown[]) => {
          const options = args.at(-1) as { buttons?: string[] };
          return {
            response: Math.max(0, (options.buttons?.length ?? 1) - 1),
            checkboxChecked: false,
          };
        };
      });
      try {
        const page = await app.firstWindow();
        ownedPage = page;
        console.info('T7 native checkpoint', run, 'window');
        const remote: string[] = [];
        page.on('request', (r) => {
          if (/^https?:/.test(r.url())) remote.push(r.url());
        });
        await expect(
          page.getByRole('heading', { name: '汽车经销商草稿助手' }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => window.desktopApi.getAppStatus()),
        ).toMatchObject({ state: 'ready', schemaVersion: 15 });
        if (run === 0) {
          for (let i = 0; i < 2; i++) {
            const article = join(input, `article-${i}.json`);
            writeFileSync(
              article,
              JSON.stringify({
                schema_version: 1,
                article_id: `cover-native-${i}`,
                title: `封面本机验证${i + 1}`,
                body: [
                  {
                    type: 'paragraph',
                    text: `本机测试正文${i + 1}，不发送到平台。`,
                  },
                  { type: 'image', image_id: 'body' },
                ],
                images: [
                  {
                    image_id: 'body',
                    source: { type: 'local', path: '0.png' },
                  },
                ],
              }),
            );
            await choose(app, [article]);
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
            await expect(page.getByLabel('文章标题')).toHaveValue(
              '封面本机验证' + (i + 1),
            );
            await closeBody(page);
          }
          const list = await page.evaluate(() =>
            window.desktopApi.listArticles(),
          );
          if (list.status !== 'ok') throw Error('list');
          keys = [0, 1].map(
            (i) =>
              list.page.items.find((a) => a.title === `封面本机验证${i + 1}`)!
                .articleKey,
          );
          for (const key of keys)
            before.push(
              await page.evaluate(
                (key) => window.desktopApi.getArticlePreview(key),
                key,
              ),
            );
          console.info(
            'T7 native checkpoint',
            run,
            'article1 before selection',
          );
          await selectCoverArticle(page, 1);
          await page
            .getByRole('button', { name: '编辑封面', exact: true })
            .click();
          console.info(
            'T7 native checkpoint',
            run,
            'cover begun',
            await page.evaluate(() => window.desktopApi.getCoverEditState()),
          );
          await expect(
            cover(page).getByRole('radio', { name: '单图', exact: true }),
          ).toBeChecked();
          await choose(app, [paths[0]]);
          await cover(page)
            .getByRole('button', { name: '从本地选择封面', exact: true })
            .click();
          await expect(cover(page).getByRole('img')).toHaveCount(1);
          console.info('T7 native checkpoint', run, 'single picked');
          await selectCoverArticle(page, 2, true);
          const leave = page.getByRole('dialog', { name: '离开封面编辑？' });
          await expect(leave).toBeVisible();
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(800, 600),
          );
          await page.screenshot({
            path: join(evidence, `task-7-${label}-leave-800.png`),
            fullPage: true,
          });
          await leave
            .getByRole('button', { name: '继续编辑', exact: true })
            .click();
          await cover(page)
            .getByRole('button', { name: '保存封面', exact: true })
            .click();
          await expect(cover(page)).toContainText('封面已保存到本机');
          await cover(page)
            .getByRole('button', { name: '完成封面编辑', exact: true })
            .click();
          await waitIdle(page);
          await page.screenshot({
            path: join(evidence, `task-7-${label}-single-800.png`),
            fullPage: true,
          });
          await selectCoverArticle(page, 2);
          await page
            .getByRole('button', { name: '编辑封面', exact: true })
            .click();
          await cover(page)
            .getByRole('radio', { name: '三图', exact: true })
            .click();
          await expect(
            cover(page).getByRole('radio', { name: '三图', exact: true }),
          ).toBeChecked();
          // Wrong chooser count and cancellation must retain all candidates atomically.
          await choose(app, paths.slice(1, 3));
          await cover(page)
            .getByRole('button', { name: '从本地选择封面', exact: true })
            .click();
          await expect(
            cover(page).getByRole('button', { name: '保存封面', exact: true }),
          ).toBeDisabled();
          await choose(app, paths.slice(1, 5));
          await cover(page)
            .getByRole('button', { name: '从本地选择封面', exact: true })
            .click();
          await expect(
            cover(page).getByRole('button', { name: '保存封面', exact: true }),
          ).toBeDisabled();
          await choose(app, paths.slice(1, 4));
          await cover(page)
            .getByRole('button', { name: '从本地选择封面', exact: true })
            .click();
          await expect(cover(page).getByRole('img')).toHaveCount(3);
          const selected = await page.evaluate(() =>
            window.desktopApi.getCoverEditState(),
          );
          await choose(app);
          await cover(page)
            .getByRole('button', { name: '从本地选择封面', exact: true })
            .click();
          await expect
            .poll(() =>
              page.evaluate(() =>
                window.desktopApi
                  .getCoverEditState()
                  .then((s) => ('draft' in s ? s.draft : null)),
              ),
            )
            .toEqual('draft' in selected ? selected.draft : null);
          await expect
            .poll(() =>
              page.evaluate(() =>
                window.desktopApi
                  .getCoverEditState()
                  .then((s) => ({ status: s.status, notice: s.notice })),
              ),
            )
            .toEqual({ status: 'open', notice: 'cancelled' });
          const orderBefore = await page.evaluate(() =>
            window.desktopApi.getCoverEditState(),
          );
          if (!('draft' in orderBefore)) throw Error('order state');
          await cover(page)
            .getByRole('button', { name: '第3张封面前移', exact: true })
            .click();
          await expect
            .poll(() =>
              page.evaluate(() =>
                window.desktopApi
                  .getCoverEditState()
                  .then((s) => ('draft' in s ? s.draft.imageTokens : null)),
              ),
            )
            .toEqual([
              orderBefore.draft.imageTokens[0],
              orderBefore.draft.imageTokens[2],
              orderBefore.draft.imageTokens[1],
            ]);
          await expect
            .poll(() =>
              cover(page)
                .getByRole('img')
                .evaluateAll((nodes) =>
                  nodes.map((n) =>
                    (n as HTMLImageElement).complete
                      ? (n as HTMLImageElement).naturalWidth
                      : 0,
                  ),
                ),
            )
            .toEqual([25, 27, 26]);
          await expect(
            cover(page).getByRole('button', {
              name: '替换第2张封面',
              exact: true,
            }),
          ).toBeEnabled();
          await choose(app, [paths[4]]);
          await cover(page)
            .getByRole('button', { name: '替换第2张封面', exact: true })
            .click();
          await expect(
            cover(page).getByRole('button', { name: '保存封面', exact: true }),
          ).toBeEnabled();
          await expect
            .poll(() =>
              app.evaluate(() => Reflect.get(globalThis, 'task7ChooserCalls')),
            )
            .toBe(1);
          await expect
            .poll(() =>
              page.evaluate(() =>
                window.desktopApi
                  .getCoverEditState()
                  .then((s) => ('draftRevision' in s ? s.draftRevision : null)),
              ),
            )
            .toBe(orderBefore.draftRevision + 2);
          await expect
            .poll(() =>
              cover(page)
                .getByRole('img')
                .evaluateAll((nodes) =>
                  nodes.map((n) =>
                    (n as HTMLImageElement).complete
                      ? (n as HTMLImageElement).naturalWidth
                      : 0,
                  ),
                ),
            )
            .toEqual([25, 28, 26]);
          console.info(
            'T7 native replacement proof: one dialog; canonical next revision; decoded green/magenta/blue widths25/28/26',
          );
          await selectCoverArticle(page, 1, true);
          await expect(leave).toBeVisible();
          await leave
            .getByRole('button', { name: '保存并继续', exact: true })
            .click();
          await waitIdle(page);
          await expect(page.getByLabel('文章标题')).toHaveValue(
            '封面本机验证1',
          );
          await returnToArticlePool(page);
          await selectCoverArticle(page, 2);
          await page
            .getByRole('button', { name: '编辑封面', exact: true })
            .click();
          await expect(
            cover(page).getByRole('radio', { name: '三图', exact: true }),
          ).toBeChecked();
          await cover(page)
            .getByRole('radio', { name: '无封面', exact: true })
            .click();
          await page
            .getByRole('dialog', { name: '移除当前封面？' })
            .getByRole('button', { name: '确认移除封面', exact: true })
            .click();
          await cover(page)
            .getByRole('button', { name: '完成封面编辑', exact: true })
            .click();
          await expect(leave).toBeVisible();
          await leave
            .getByRole('button', { name: '放弃修改', exact: true })
            .click();
          await waitIdle(page);
          await expect(cover(page)).toContainText('三图 · 3');
          await expect(cover(page).getByRole('img')).toHaveCount(3);
          await expect
            .poll(() =>
              cover(page)
                .getByRole('img')
                .evaluateAll((nodes) =>
                  nodes.every(
                    (n) =>
                      (n as HTMLImageElement).complete &&
                      (n as HTMLImageElement).naturalWidth > 0,
                  ),
                ),
            )
            .toBe(true);
          await page.screenshot({
            path: join(evidence, `task-7-${label}-triple-800.png`),
            fullPage: true,
          });
          for (const key of keys)
            configs.push(
              await page.evaluate(
                (key) => window.desktopApi.getArticleCover(key),
                key,
              ),
            );
          await closeBody(page);
        }
        if (run < 2) {
          const list = await page.evaluate(() =>
            window.desktopApi.listArticles(),
          );
          expect(list).toMatchObject({ status: 'ok', page: { totalCount: 2 } });
          for (const [i, key] of keys.entries()) {
            expect(
              await page.evaluate(
                (key) => window.desktopApi.getArticlePreview(key),
                key,
              ),
            ).toEqual(before[i]);
            const read = await page.evaluate(
              (key) => window.desktopApi.getArticleCover(key),
              key,
            );
            expect(read).toEqual(configs[i]);
            if (read.status !== 'ok') throw Error('cover');
            expect(read.configuration.mode).toBe(i === 0 ? 'single' : 'triple');
            for (const [j, image] of read.configuration.images.entries()) {
              const bytes = await page.evaluate(
                async (request) => {
                  for (let n = 0; n < 50; n++) {
                    const r = await window.desktopApi.getCoverImage(request);
                    if (r.status === 'ok') return Array.from(r.bytes);
                    if (r.status !== 'busy') throw Error(r.status);
                    await new Promise((r) => setTimeout(r, 50));
                  }
                  throw Error('busy');
                },
                {
                  kind: 'stored' as const,
                  articleKey: key,
                  coverRevision: read.configuration.coverRevision,
                  assetKey: image.assetKey,
                },
              );
              expect(hash(new Uint8Array(bytes))).toBe(orderedHashes[i][j]);
            }
          }
          if (run === 1) {
            expect(treeHashes(join(userData, 'covers'))).toEqual(retained);
            expect(treeHashes(join(userData, 'assets'))).toEqual(bodyFiles);
            await page
              .getByRole('button', { name: '删除 封面本机验证2', exact: true })
              .click();
            await page
              .getByRole('dialog', { name: '从本机删除文章？' })
              .getByRole('button', { name: '确认删除', exact: true })
              .click();
            await expect(
              page.getByText('本机文章共 1 篇', { exact: true }),
            ).toBeVisible();
            expect(
              await page.evaluate(
                (key) => window.desktopApi.getArticleCover(key),
                keys[1],
              ),
            ).toEqual({ status: 'not_found' });
          }
        } else {
          expect(
            await page.evaluate(() => window.desktopApi.listArticles()),
          ).toMatchObject({ status: 'ok', page: { totalCount: 1 } });
          expect(treeHashes(join(userData, 'covers'))).toEqual(retained);
          expect(treeHashes(join(userData, 'assets'))).toEqual(bodyFiles);
          expect(
            await page.evaluate(
              (key) => window.desktopApi.getArticleCover(key),
              keys[1],
            ),
          ).toEqual({ status: 'not_found' });
        }
        expect(
          await page.evaluate(() => window.desktopApi.getDraftState()),
        ).toMatchObject({ session: { status: 'closed' }, task: null });
        expect(existsSync(join(userData, 'profiles'))).toBe(false);
        expect(remote).toEqual([]);
      } catch (error) {
        if (ownedPage) {
          const stamp = Date.now();
          console.info(
            'T7 native failure state',
            await ownedPage
              .evaluate(async () => ({
                cover: await window.desktopApi.getCoverEditState(),
                manual: await window.desktopApi.getManualArticleState(),
                coverText: document.querySelector('.cover-panel')?.textContent,
              }))
              .catch(() => null),
          );
          await ownedPage
            .screenshot({
              path: join(
                evidence,
                'task-7-' + label + '-failure-' + stamp + '.png',
              ),
              fullPage: true,
            })
            .catch(() => {});
        }
        throw error;
      } finally {
        await app.close();
      }
      if (run === 0) {
        retained = treeHashes(join(userData, 'covers'));
        bodyFiles = treeHashes(join(userData, 'assets'));
        renameSync(input, join(root, 'source-removed'));
        expect(existsSync(input)).toBe(false);
      }
    }
    expect(new Set(pids).size).toBe(3);
    const db = new Database(join(userData, 'data/app.sqlite'), {
      readonly: true,
    });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(
        db.prepare('SELECT count(*) AS n FROM article_cover_versions').get(),
      ).toEqual({ n: 2 });
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM article_cover_operations WHERE status='committed'",
          )
          .get(),
      ).toEqual({ n: 2 });
    } finally {
      db.close();
    }
    // Verify retained files and persist their exact hashes; do not retain userData/session state.
    for (const c of configs as {
      configuration: {
        images: { assetKey: string }[];
        coverRevision: number;
      };
    }[])
      for (const a of c.configuration.images) {
        const item = retained.find((f) =>
          f.path.endsWith(a.assetKey + '.png'),
        )!;
        expect(hash(readFileSync(join(userData, 'covers', item.path)))).toBe(
          item.sha256,
        );
      }
    writeFileSync(
      join(evidence, `task-7-${label}-cover.json`),
      JSON.stringify(
        {
          status: 'PASS',
          executable: executablePath ?? 'compiled .webpack',
          independentUserData: userData,
          pids,
          configurations: configs,
          orderedImageSha256: orderedHashes,
          bodyExact: true,
          bodyRevisionUnchanged: true,
          bodyFiles,
          coverFiles: retained,
          sourceRemoved: true,
          sourceAction:
            'Original paths moved to owned source-removed directory',
          deletionHistoryRetained: true,
          actualNativePickerPath: true,
          chooser:
            'External test-controlled dialog result; no physical human OS/IME claim',
          remoteRequests: 0,
          profileCreated: false,
        },
        null,
        2,
      ),
    );
  } finally {
    expect(resolve(root)).toBe(root);
    expect(root.startsWith(join(tmpdir(), 'cover-native-'))).toBe(true);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}
