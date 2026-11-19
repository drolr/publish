import { _electron as electron, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import type { BrowserType, BrowserContext } from 'playwright-core';
import { packagedEnvironment } from './browser-health-checks';
import { returnToArticlePool } from './focused-editor-navigation';
import { installProductionFixture } from '../fixtures/judongche-production';
import { makeDraftTask } from '../fixtures/draft-task';
import { checkpointAttempt } from '../integration/draft-attempt-restart-child';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { seedLegacyStoredArticle } from '../../src/infrastructure/persistence/testing/article-fixtures';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import { createDraftSnapshotDigest } from '../../src/infrastructure/draft-snapshot-integrity';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { createDraftSnapshotPort } from '../../src/infrastructure/assets/draft-snapshot';
import { storeBinding } from '../../src/infrastructure/platforms/judongche/production-state';

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
async function decoded(page: Page, selector: string, width: number) {
  await expect
    .poll(() =>
      page.locator(selector).evaluateAll((nodes) =>
        nodes.map((node) => {
          const image = node as HTMLImageElement;
          return image.complete ? image.naturalWidth : 0;
        }),
      ),
    )
    .toEqual([width]);
}

/** Normal creation entry, real picker/decoder/save/SQLite/assets, then a fresh process.
 * Only the existing native chooser's returned selection is controlled by the test. */
export async function checkCreationCover(
  executablePath: string | undefined,
  evidence: string,
) {
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'operator-creation-'));
  const userData = join(root, 'user-data');
  const input = join(root, 'cover.png');
  await sharp({
    create: { width: 71, height: 49, channels: 3, background: '#236852' },
  })
    .png()
    .toFile(input);
  const expectedHash = sha(readFileSync(input));
  const replacement = join(root, 'replacement.png');
  await sharp({
    create: { width: 73, height: 51, channels: 3, background: '#9d5532' },
  })
    .png()
    .toFile(replacement);
  const replacementHash = sha(readFileSync(replacement));
  const closeEvidence = join(evidence, 'native-close-dialog.json');
  let key = '';
  let confirmed = false;
  try {
    for (let run = 0; run < 3; run++) {
      const app = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`],
        env: packagedEnvironment(),
      });
      let nativeClosed = false;
      try {
        expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(
          userData,
        );
        const page = await app.firstWindow();
        const network: string[] = [];
        await page.route(/^https?:/, (route) => {
          network.push(route.request().url());
          return route.abort();
        });
        await expect(
          page.getByRole('button', { name: '新建文章', exact: true }),
        ).toBeEnabled();
        if (run === 0) {
          await page
            .getByRole('button', { name: '新建文章', exact: true })
            .click();
          await page
            .getByLabel('文章标题', { exact: true })
            .fill('创建时封面本机验收');
          await page
            .getByRole('textbox', { name: '文章正文', exact: true })
            .fill('创建时选封面，正文和封面仅一次保存到本机。');
          await app.evaluate(({ dialog }, input) => {
            Reflect.set(globalThis, 'creationPickerCount', 0);
            dialog.showOpenDialog = async () => {
              Reflect.set(
                globalThis,
                'creationPickerCount',
                Reflect.get(globalThis, 'creationPickerCount') + 1,
              );
              return { canceled: false, filePaths: [input] };
            };
          }, input);
          await page
            .getByRole('region', { name: '文章封面', exact: true })
            .getByRole('button', { name: '从本地选择封面', exact: true })
            .click();
          await decoded(page, '.manual-cover-panel img', 71);
          const before = await page.evaluate(() =>
            window.desktopApi.listArticles(),
          );
          expect(before).toMatchObject({
            status: 'ok',
            page: { totalCount: 0 },
          });
          await page
            .getByRole('button', { name: '保存到本机', exact: true })
            .click();
          await expect(page.locator('.manual-cover-panel')).toContainText(
            '封面已保存到本机',
          );
          await expect(page.locator('.editor-save-status')).toContainText(
            '已保存到本机',
          );
          expect(
            await app.evaluate(() =>
              Reflect.get(globalThis, 'creationPickerCount'),
            ),
          ).toBe(1);
          await page.screenshot({
            path: join(evidence, 'creation-combined-save.png'),
            fullPage: true,
          });
          await returnToArticlePool(page);
        }
        const width = run === 2 ? 73 : 71;
        const coverRevision = run === 2 ? 2 : 1;
        await decoded(page, '.article-cover-thumbnail img', width);
        const list = await page.evaluate(() =>
          window.desktopApi.listArticles(),
        );
        if (list.status !== 'ok') throw Error('List unavailable');
        expect(list.page.totalCount).toBe(1);
        key ||= list.page.items[0].articleKey;
        expect(list.page.items[0].articleKey).toBe(key);
        const configuration = await page.evaluate(
          (key) => window.desktopApi.getArticleCover(key),
          key,
        );
        if (configuration.status !== 'ok') throw Error('Cover unavailable');
        expect(configuration.configuration).toMatchObject({
          articleKey: key,
          coverRevision,
          mode: 'single',
        });
        const request = {
          kind: 'stored' as const,
          articleKey: key,
          coverRevision,
          assetKey: configuration.configuration.images[0].assetKey,
        };
        await expect
          .poll(
            async () =>
              (
                await page.evaluate(
                  (request) => window.desktopApi.getCoverImage(request),
                  request,
                )
              ).status,
          )
          .toBe('ok');
        const bytes = await page.evaluate(async (request) => {
          const result = await window.desktopApi.getCoverImage(request);
          if (result.status !== 'ok') throw Error('Bytes unavailable');
          return Array.from(result.bytes);
        }, request);
        expect(sha(new Uint8Array(bytes))).toBe(
          run === 2 ? replacementHash : expectedHash,
        );
        await page.screenshot({
          path: join(evidence, `creation-thumbnail-${run}.png`),
          fullPage: true,
        });
        await page.getByRole('button', { name: /^创建时封面本机验收/ }).click();
        await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(
          '创建时封面本机验收',
        );
        await expect(
          page.getByRole('textbox', { name: '文章正文', exact: true }),
        ).toContainText('正文和封面仅一次保存到本机');
        await decoded(page, '.manual-cover-panel img', width);
        if (run === 1) {
          await app.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = async () => ({
              canceled: false,
              filePaths: [path],
            });
          }, replacement);
          await page
            .locator('.manual-cover-panel')
            .getByRole('button', { name: '从本地选择封面', exact: true })
            .click();
          await decoded(page, '.manual-cover-panel img', 73);
          expect(
            await page.evaluate(() =>
              window.desktopApi.getManualArticleState(),
            ),
          ).toMatchObject({
            dirty: false,
            hasUnsavedChanges: true,
            cover: { dirty: true },
          });
          await app.evaluate(({ dialog }, path) => {
            dialog.showMessageBox = async (...args: unknown[]) => {
              const options = args.at(-1) as {
                message: string;
                buttons: string[];
              };
              process
                .getBuiltinModule('fs')
                .writeFileSync(path, JSON.stringify(options));
              return {
                response: options.buttons.indexOf('保存并关闭'),
                checkboxChecked: false,
              };
            };
          }, closeEvidence);
          const closed = app.waitForEvent('close');
          await app.evaluate(({ BrowserWindow }) => {
            setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0);
          });
          await closed;
          nativeClosed = true;
          expect(JSON.parse(readFileSync(closeEvidence, 'utf8'))).toMatchObject(
            {
              message: '当前修改尚未保存。',
              buttons: ['继续编辑', '保存并关闭', '放弃并关闭'],
            },
          );
        } else await returnToArticlePool(page);
        expect(network).toEqual([]);
        expect(existsSync(join(userData, 'profiles'))).toBe(false);
      } finally {
        if (!nativeClosed) await app.close();
      }
      if (run === 0) rmSync(input);
    }
    const db = new Database(join(userData, 'data/app.sqlite'), {
      readonly: true,
    });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM articles').get()).toEqual({
        n: 1,
      });
      expect(
        db.prepare('SELECT count(*) AS n FROM article_edit_operations').get(),
      ).toEqual({ n: 1 });
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
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
    writeFileSync(
      join(evidence, 'creation-cover.json'),
      JSON.stringify(
        {
          status: 'PASS',
          userData,
          executablePath,
          articleKey: key,
          sha256: expectedHash,
          chooser: 'test-controlled existing Electron native picker result',
          combinedSaveClicks: 1,
          sourceRemovedBeforeReopen: true,
          bodyRevisions: 1,
          coverVersions: 2,
          nativeClose:
            'real BrowserWindow close; test-controlled save-and-close dialog answer; clean body revision unchanged',
          replacementSha256: replacementHash,
          remoteRequests: 0,
        },
        null,
        2,
      ),
    );
    confirmed = true;
  } finally {
    expect(resolve(root)).toBe(root);
    expect(root.startsWith(join(tmpdir(), 'operator-creation-'))).toBe(true);
    if (confirmed)
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 300,
      });
    else
      console.error(`PRESERVED creation evidence/data after failure: ${root}`);
  }
}

/** Persisted paused middle item -> real UI/IPC/controller -> fixture-only next items.
 * Interception is confined to this test's main-process Playwright dependency. */
export async function checkManualSkip(
  executablePath: string | undefined,
  evidence: string,
) {
  for (const action of ['saved', 'abandoned'] as const)
    await checkManualSkipScenario(
      executablePath,
      join(evidence, action),
      action,
    );
}

async function checkManualSkipScenario(
  executablePath: string | undefined,
  evidence: string,
  humanAction: 'saved' | 'abandoned',
) {
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'operator-skip-'));
  const database = join(root, 'data/app.sqlite');
  const migrations = resolve('src/infrastructure/persistence/migrations');
  mkdirSync(join(root, 'data'));
  openArticleRepository(database, migrations).close();
  const store = storeBinding('123456', '合成门店');
  const now = new Date().toISOString();
  const assetStore = createAssetStore(join(root, 'assets'));
  const snapshots = createDraftSnapshotPort(assetStore);
  const snapshotPreflight = [];
  const items = [];
  for (let index = 0; index < 4; index++) {
    const task = makeDraftTask({
      taskId: randomUUID(),
      preparationId: randomUUID(),
      store,
      createdAt: now,
      updatedAt: now,
    });
    task.snapshot.article = {
      ...task.snapshot.article,
      articleKey: randomUUID(),
      importId: randomUUID(),
      externalId: `synthetic-skip-${index}`,
      title: `离线接续验证第${index + 1}篇`,
      createdAt: now,
    };
    if (index >= 2) {
      const article = task.snapshot.article;
      const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
        'base64',
      );
      const attempt = {
        articleKey: article.articleKey,
        importId: article.importId,
        externalId: article.externalId,
        startedAt: now,
        status: 'preparing' as const,
      };
      const signal = new AbortController().signal;
      await assetStore.prepare(attempt, signal);
      article.assets = [];
      for (let image = 0; image < 2; image++)
        article.assets.push(
          await assetStore.put(attempt, `body-${image + 1}`, bytes, signal),
        );
      await assetStore.finalize(attempt, signal);
      article.body = [
        { type: 'paragraph', text: 'Synthetic introduction' },
        { type: 'image', image_id: 'body-1' },
        { type: 'paragraph', text: 'Synthetic middle paragraph' },
        { type: 'image', image_id: 'body-2' },
        { type: 'paragraph', text: 'Synthetic final paragraph' },
      ];
    }
    task.articleKey = task.snapshot.article.articleKey;
    task.snapshot.digest = createDraftSnapshotDigest(task.snapshot.article);
    await snapshots.verify(task.snapshot);
    snapshotPreflight.push({
      articleKey: task.articleKey,
      imageCount: task.snapshot.article.assets.length,
      status: 'PASS' as const,
    });
    seedLegacyStoredArticle(database, task.snapshot.article);
    items.push({
      view: {
        articleKey: task.articleKey,
        title: task.snapshot.article.title,
        contentDeclaration: task.snapshot.article.contentDeclaration,
        coverSummary: null,
        state: 'queued' as const,
        reason: null,
        taskId: null,
      },
      reservation: {
        taskId: task.taskId,
        preparationId: task.preparationId,
        store,
        snapshot: task.snapshot,
        expectedArticleRevision: 1,
        now,
      },
    });
  }
  writeFileSync(
    join(evidence, 'snapshot-preflight.json'),
    JSON.stringify(snapshotPreflight, null, 2),
  );
  const batches = openDraftBatchRepository(database, migrations);
  const tasks = openDraftTaskRepository(database, migrations);
  let original;
  try {
    let batch = batches.create({
      id: randomUUID(),
      requestId: randomUUID(),
      preparationId: randomUUID(),
      storeKey: store.storeKey,
      storeName: store.displayName,
      now,
      items,
    });
    for (let index = 0; index < 2; index++) {
      const task = batches.reserveNext(batch.id, batch.revision, now)!;
      let durable = checkpointAttempt(
        tasks,
        task.taskId,
        index === 0 ? 'submission-recorded' : 'save-in-flight',
        now,
      );
      if (index === 1)
        durable = tasks.apply(
          task.taskId,
          durable.revision,
          { type: 'settle', state: 'needs_human', reason: 'RESULT_AMBIGUOUS' },
          now,
        );
      batch = batches.settleItem(batch.id, task.taskId, now);
      if (index === 1) original = durable;
    }
  } finally {
    tasks.close();
    batches.close();
  }
  let confirmed = false;
  const app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
    env: packagedEnvironment(),
  });
  try {
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(root);
    const boundary = await app.evaluateHandle(
      (
        { app, BrowserWindow },
        {
          fixtureSource,
          manualProfile,
          businessProfile,
          diagnosticRoot,
          articleIdentities,
        },
      ) => {
        const localRequire = process
          .getBuiltinModule('module')
          .createRequire(app.getAppPath() + '/package.json') as NodeJS.Require;
        const runtime = localRequire('playwright-core') as {
          chromium: BrowserType;
        };
        const paths = localRequire('node:path') as typeof import('node:path');
        const original = runtime.chromium.launchPersistentContext;
        const records: {
          context: BrowserContext;
          contextId: number;
          originalPage: import('playwright-core').Page;
          pages: import('playwright-core').Page[];
          launch: {
            channel?: string;
            headless?: boolean;
            viewport?: unknown;
            persistent: true;
          };
          events: {
            sequence: number;
            pageId: number;
            articleKey: string | null;
            stage: string;
            imageCount: number;
            caretInBody: boolean;
            caretAfterLastImage: boolean;
          }[];
          focus: {
            pageId: number;
            electronAlive: boolean;
            electronFocused: boolean;
            edgeFocused: boolean;
            viewport: unknown;
          }[];
          path: string;
          fixture: {
            saves(): number;
            uploads(): number;
            savedArticles(): { title: string; html: string }[];
          };
          blocked: string[];
          role: 'manual' | 'diagnostic' | 'business';
          closed: boolean;
        }[] = [];
        // Test-owned source, never evaluated from page content or user data.
        const install = new Function('__name', `return (${fixtureSource})`)(
          (fn: unknown) => fn,
        ) as typeof installProductionFixture;
        const register = async (
          context: BrowserContext,
          path: string,
          role: 'manual' | 'diagnostic' | 'business',
          options: Parameters<BrowserType['launchPersistentContext']>[1],
        ) => {
          const blocked: string[] = [];
          await context.route('**/*', (route) => {
            blocked.push(route.request().url());
            return route.abort();
          });
          const fixture = await install(context, {
            batchHistory: true,
            fullDraftReview: 'unique',
            observedTrailingParagraphs: true,
          });
          const record = {
            context,
            contextId: records.length + 1,
            originalPage: context.pages()[0]!,
            pages: [...context.pages()],
            launch: {
              channel: options?.channel,
              headless: options?.headless,
              viewport: options?.viewport,
              persistent: true as const,
            },
            events: [] as (typeof records)[number]['events'],
            focus: [] as (typeof records)[number]['focus'],
            path,
            fixture,
            blocked,
            role,
            closed: false,
          };
          context.on('page', (page) => record.pages.push(page));
          await context.exposeBinding(
            '__t4BodyEvidence',
            (
              { page },
              value: {
                title: string;
                stage: string;
                imageCount: number;
                caretInBody: boolean;
                caretAfterLastImage: boolean;
              },
            ) => {
              record.events.push({
                sequence: record.events.length + 1,
                pageId: record.pages.indexOf(page) + 1,
                articleKey:
                  articleIdentities.find((item) => item.title === value.title)
                    ?.articleKey ?? null,
                stage: value.stage,
                imageCount: value.imageCount,
                caretInBody: value.caretInBody,
                caretAfterLastImage: value.caretAfterLastImage,
              });
            },
          );
          await context.addInitScript(() => {
            const report = (stage: string) => {
              const body = document.querySelector('#body');
              const node = getSelection()?.anchorNode;
              const leaf =
                node?.nodeType === Node.TEXT_NODE
                  ? node.parentElement
                  : (node as Element | null);
              const paragraph = leaf?.closest?.('p');
              const emit = (
                window as unknown as {
                  __t4BodyEvidence(value: unknown): Promise<void>;
                }
              ).__t4BodyEvidence;
              void emit({
                title:
                  document.querySelector<HTMLTextAreaElement>('textarea')
                    ?.value ?? '',
                stage,
                imageCount:
                  body?.querySelectorAll(':scope > [__syl_tag] .pgc-image')
                    .length ?? 0,
                caretInBody: !!(
                  node &&
                  body?.contains(node) &&
                  document.activeElement === body
                ),
                caretAfterLastImage: !!(
                  body &&
                  paragraph?.parentElement === body &&
                  paragraph.previousElementSibling?.hasAttribute('__syl_tag') &&
                  !Array.from(body.children)
                    .slice(Array.from(body.children).indexOf(paragraph) + 1)
                    .some((child) => child.hasAttribute('__syl_tag'))
                ),
              });
            };
            let pendingInsertions = 0;
            let observedImageCount = 0;
            document.addEventListener(
              'change',
              (event) => {
                if ((event.target as Element).matches('input[type=file]'))
                  report('select-file');
              },
              true,
            );
            document.addEventListener(
              'click',
              (event) => {
                const target = event.target as Element;
                if (
                  target.matches('[role=dialog] button') &&
                  target.textContent === '确定'
                ) {
                  pendingInsertions++;
                  report('confirm');
                }
                if (target.id === 'save') report('save');
              },
              true,
            );
            document.addEventListener(
              'beforeinput',
              (event) => {
                if ((event.target as Element).id === 'body')
                  report('paragraph-input');
              },
              true,
            );
            new MutationObserver(() => {
              const imageCount = document.querySelectorAll(
                '#body > [__syl_tag] .pgc-image',
              ).length;
              if (pendingInsertions && imageCount > observedImageCount) {
                pendingInsertions--;
                report('image-inserted');
              }
              observedImageCount = imageCount;
            }).observe(document, { childList: true, subtree: true });
          });
          if (role === 'business') {
            await context.route('**/fixture/upload', async (route) => {
              const page = route.request().frame().page();
              const title = await page.locator('textarea').inputValue();
              record.events.push({
                sequence: record.events.length + 1,
                pageId: record.pages.indexOf(page) + 1,
                articleKey:
                  articleIdentities.find((item) => item.title === title)
                    ?.articleKey ?? null,
                stage: 'upload-request',
                imageCount: 0,
                caretInBody: false,
                caretAfterLastImage: false,
              });
              const window = BrowserWindow.getAllWindows()[0];
              window?.focus();
              const electronFocused = window?.isFocused() ?? false;
              await page.bringToFront();
              record.focus.push({
                pageId: record.pages.indexOf(page) + 1,
                electronAlive: !!window && !window.isDestroyed(),
                electronFocused,
                edgeFocused: await page.evaluate(() => document.hasFocus()),
                viewport: page.viewportSize(),
              });
              await route.fallback();
            });
          }
          context.on('close', () => {
            record.closed = true;
          });
          records.push(record);
          return record;
        };
        runtime.chromium.launchPersistentContext = async function (
          path,
          options,
        ) {
          const context = await original.call(this, path, options);
          try {
            // Classify by the exact test-owned profile contract, never by the
            // headless value that the assertions below are meant to verify.
            const resolved = paths.resolve(path);
            const role =
              resolved === paths.resolve(businessProfile)
                ? 'business'
                : paths.dirname(resolved) === paths.resolve(diagnosticRoot) &&
                    /^diagnostic-[A-Za-z0-9]{6}$/.test(paths.basename(resolved))
                  ? 'diagnostic'
                  : null;
            if (!role) throw Error('Unexpected synthetic application profile');
            await register(context, path, role, options);
            return context;
          } catch (error) {
            await context.close();
            throw error;
          }
        };
        return {
          requireLoginForRuntimeProbe: async () => {
            const record = records
              .filter((item) => item.role === 'business')
              .at(-1);
            if (!record || record.closed)
              throw Error('Synthetic app session missing');
            await record.originalPage.evaluate(() => {
              document.body.insertAdjacentHTML(
                'beforeend',
                '<div>巨懂车欢迎您</div>',
              );
            });
          },
          handle: async ({
            action,
            title,
            taskId,
          }: {
            action: 'saved' | 'abandoned';
            title: string;
            taskId: string;
          }) => {
            // A human can handle the old platform page outside this restarted
            // app. Do not bypass the application's paused-batch admission gate.
            const manual = await original.call(
              runtime.chromium,
              manualProfile,
              {
                channel: 'msedge',
                headless: true,
                chromiumSandbox: true,
              },
            );
            let record: (typeof records)[number] | undefined;
            try {
              record = await register(manual, manualProfile, 'manual', {
                channel: 'msedge',
                headless: true,
                chromiumSandbox: true,
              });
              const primary = manual.pages()[0]!;
              await primary.goto(
                'https://www.autoengine.com/jdc/dealer/info/Article',
              );
              await primary.locator('textarea').fill(title);
              await primary
                .locator('#body')
                .fill('Synthetic operator handled body');
              if (action === 'saved') {
                const response = primary.waitForResponse(
                  '**/motor/dealer_admin/go_api/article/create',
                );
                await primary
                  .getByRole('button', { name: '存草稿', exact: true })
                  .click();
                await response;
              } else {
                await primary.goto('https://www.autoengine.com/jdc/cps/home');
              }
            } finally {
              await manual.close();
            }
            if (!record?.closed)
              throw Error('Manual test context closure unconfirmed');
            return {
              taskId,
              title,
              action,
              requests: record.fixture.saves(),
              closed: record.closed,
              syntheticOnly: true,
            };
          },
          snapshot: () =>
            records.map(
              ({
                path,
                fixture,
                blocked,
                role,
                closed,
                context,
                contextId,
                originalPage,
                pages,
                launch,
                events,
                focus,
              }) => ({
                path,
                contextId,
                originalPageId: pages.indexOf(originalPage) + 1,
                pages: pages.map((page, index) => ({
                  pageId: index + 1,
                  original: page === originalPage,
                  sameContext: page.context() === context,
                  closed: page.isClosed(),
                  viewport: page.viewportSize(),
                })),
                launch,
                events,
                focus,
                role,
                closed,
                saves: fixture.saves(),
                uploads: fixture.uploads(),
                titles: fixture.savedArticles().map((item) => item.title),
                blocked,
              }),
            ),
          restore: async () => {
            runtime.chromium.launchPersistentContext = original;
            for (const record of records) await record.context.close();
          },
        };
      },
      {
        fixtureSource: installProductionFixture
          .toString()
          .replaceAll('合成门店', store.displayName)
          .replaceAll('123456', store.identity.value),
        manualProfile: join(root, 'manual-profile'),
        businessProfile: resolve(root, 'profiles', 'judongche'),
        diagnosticRoot: resolve(root, 'browser-health'),
        articleIdentities: items.map((item) => item.view),
      },
    );
    try {
      const page = await app.firstWindow();
      await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
      const paused = await page.evaluate(() =>
        window.desktopApi.batch.getCurrent(),
      );
      expect(paused?.items.map((item) => item.state)).toEqual([
        'submission_recorded',
        'needs_human',
        'queued',
        'queued',
      ]);
      expect(await boundary.evaluate((b) => b.snapshot())).toEqual([]);
      const browserOpenAttempt = await page.evaluate(() =>
        window.desktopApi.openDraftSession(),
      );
      expect(browserOpenAttempt).toMatchObject({
        status: 'blocked',
        reason: 'PLATFORM_BUSY',
      });
      expect(await boundary.evaluate((b) => b.snapshot())).toEqual([]);
      const manualAction = await boundary.evaluate(
        (b, input) => b.handle(input),
        {
          action: humanAction,
          title: items[1].view.title,
          taskId: original!.taskId,
        },
      );
      expect(manualAction).toEqual({
        taskId: original!.taskId,
        title: items[1].view.title,
        action: humanAction,
        requests: humanAction === 'saved' ? 1 : 0,
        closed: true,
        syntheticOnly: true,
      });
      const handledTraffic = await boundary.evaluate((b) => b.snapshot());
      expect(handledTraffic.flatMap((record) => record.titles)).toEqual(
        humanAction === 'saved' ? [items[1].view.title] : [],
      );
      expect(
        await page.evaluate(() => window.desktopApi.batch.getCurrent()),
      ).toEqual(paused);
      const handledRead = openDraftTaskRepository(database, migrations);
      try {
        expect(handledRead.get(original!.taskId)).toEqual(original);
      } finally {
        handledRead.close();
      }
      await page
        .getByRole('button', { name: '跳过这篇，继续上传', exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktopApi.batch.getCurrent()))
              ?.state,
          { timeout: 90000 },
        )
        .toBe('completed');
      const after = await page.evaluate(() =>
        window.desktopApi.batch.getCurrent(),
      );
      expect(after?.items.map((item) => item.articleKey)).toEqual(
        items.map((item) => item.view.articleKey),
      );
      expect(after?.items.map((item) => item.state)).toEqual([
        'submission_recorded',
        'skipped',
        'submission_recorded',
        'submission_recorded',
      ]);
      expect(after?.items[1]).toMatchObject({
        taskId: original!.taskId,
        reason: original!.reason,
        saveAttempted: true,
      });
      const read = openDraftTaskRepository(database, migrations);
      try {
        expect(read.get(original!.taskId)).toMatchObject({
          taskId: original!.taskId,
          state: 'stopped_by_user',
          reason: original!.reason,
          saveAttempted: true,
          evidence: original!.evidence,
          snapshot: original!.snapshot,
        });
      } finally {
        read.close();
      }
      const traffic = await boundary.evaluate((b) => b.snapshot());
      expect(traffic.flatMap((record) => record.blocked)).toEqual([]);
      const diagnosticTraffic = traffic.filter(
        (record) => record.role === 'diagnostic',
      );
      expect(diagnosticTraffic.length).toBeGreaterThan(0);
      for (const record of diagnosticTraffic) {
        expect(record.launch).toEqual({
          channel: 'msedge',
          headless: true,
          viewport: null,
          persistent: true,
        });
        expect(record.closed).toBe(true);
        expect(record.originalPageId).toBe(1);
        expect(
          record.pages.every(
            (entry) => entry.sameContext && entry.viewport === null,
          ),
        ).toBe(true);
        expect(record.uploads).toBe(0);
        expect(record.saves).toBe(0);
        expect(record.titles).toEqual([]);
        expect(record.focus).toEqual([]);
        // The fixed health PNG may emit a file-selection observation, but it
        // must never contribute an article's business actions or ownership.
        expect(record.events.length).toBeLessThanOrEqual(1);
        expect(
          record.events.every(
            (event) =>
              event.articleKey === null && event.stage === 'select-file',
          ),
        ).toBe(true);
      }
      const businessTraffic = traffic.filter(
        (record) => record.role === 'business',
      );
      expect(businessTraffic.length).toBeGreaterThan(0);
      expect(
        businessTraffic.reduce((total, record) => total + record.uploads, 0),
      ).toBe(4);
      expect(
        businessTraffic.reduce((total, record) => total + record.saves, 0),
      ).toBe(2);
      for (const record of businessTraffic) {
        expect(record.launch).toEqual({
          channel: 'msedge',
          headless: false,
          viewport: null,
          persistent: true,
        });
        expect(record.originalPageId).toBe(1);
        expect(
          record.pages.every(
            (entry) => entry.sameContext && entry.viewport === null,
          ),
        ).toBe(true);
        expect(
          record.events.every(
            (event) => event.pageId === record.originalPageId,
          ),
        ).toBe(true);
        expect(
          record.focus.every(
            (entry) => entry.electronAlive && entry.viewport === null,
          ),
        ).toBe(true);
      }
      const articleEvidence = items.slice(2).map((item) => {
        const records = businessTraffic.filter((record) =>
          record.events.some(
            (event) => event.articleKey === item.view.articleKey,
          ),
        );
        const events = records.flatMap((record) =>
          record.events.filter(
            (event) => event.articleKey === item.view.articleKey,
          ),
        );
        const counts = Object.fromEntries(
          [
            'select-file',
            'confirm',
            'image-inserted',
            'upload-request',
            'save',
          ].map((stage) => [
            stage,
            events.filter((event) => event.stage === stage).length,
          ]),
        );
        expect(counts).toEqual({
          'select-file': 2,
          confirm: 2,
          'image-inserted': 2,
          'upload-request': 2,
          save: 1,
        });
        expect(
          events
            .filter((event) => event.stage === 'image-inserted')
            .map((event) => event.imageCount),
        ).toEqual([1, 2]);
        const finalInput = events
          .filter((event) => event.stage === 'paragraph-input')
          .at(-1);
        expect(finalInput).toMatchObject({
          imageCount: 2,
          caretInBody: true,
          caretAfterLastImage: true,
        });
        return {
          articleKey: item.view.articleKey,
          taskId: after!.items.find(
            (entry) => entry.articleKey === item.view.articleKey,
          )!.taskId,
          contextIds: records.map((record) => record.contextId),
          counts,
          events,
          caretAfterSecondImage: finalInput,
        };
      });
      const focusEvidence = businessTraffic.flatMap((record) => record.focus);
      expect(focusEvidence).toHaveLength(4);
      expect(traffic.flatMap((record) => record.titles)).toEqual([
        ...(humanAction === 'saved' ? [items[1].view.title] : []),
        ...items.slice(2).map((item) => item.view.title),
      ]);
      const stale = {
        batchId: paused!.id,
        expectedRevision: paused!.revision,
        taskId: original!.taskId,
      };
      expect(
        await page.evaluate(
          (input) => window.desktopApi.batch.skipCurrentAndContinue(input),
          stale,
        ),
      ).toMatchObject({ status: 'blocked' });
      expect(await boundary.evaluate((b) => b.snapshot())).toEqual(traffic);
      await page.screenshot({
        path: join(evidence, 'manual-skip-completed.png'),
        fullPage: true,
      });
      // Exercise main's real probe callback in this synthetic instance. Read the
      // physical ASAR from the test process, which has no Electron fs patch.
      const runningApp = await app.evaluate(({ app }) => ({
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
      }));
      const runtimeIdentity = {
        appVersion: runningApp.appVersion,
        packaged: runningApp.packaged,
        asarSha256: runningApp.packaged
          ? sha(readFileSync(runningApp.appPath))
          : null,
        asarStatus: runningApp.packaged ? 'verified' : 'not-packaged',
      };
      await boundary.evaluate((b) => b.requireLoginForRuntimeProbe());
      expect(
        await page.evaluate(() => window.desktopApi.checkDraftSession()),
      ).toMatchObject({
        status: 'blocked',
        reason: 'LOGIN_REQUIRED',
      });
      const probePath = join(root, 'judongche-probe.json');
      const runtimeFirstFailures = readdirSync(root)
        .filter((name) => /^judongche-first-failure-.*\.json$/.test(name))
        .map((name) => ({
          name,
          record: JSON.parse(readFileSync(join(root, name), 'utf8')),
        }));
      expect(runtimeFirstFailures.length).toBeGreaterThan(0);
      const runtimeProbe = JSON.parse(readFileSync(probePath, 'utf8'));
      expect(runtimeProbe.runtimeIdentity).toEqual(runtimeIdentity);
      for (const { record } of runtimeFirstFailures)
        expect(record.runtimeIdentity).toEqual(runtimeIdentity);
      writeFileSync(
        join(evidence, 'runtime-identity.json'),
        JSON.stringify(
          {
            expected: runtimeIdentity,
            probe: runtimeProbe,
            firstFailures: runtimeFirstFailures,
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(evidence, 'manual-skip.json'),
        JSON.stringify(
          {
            status: 'PASS',
            userData: root,
            executablePath,
            before: paused,
            after,
            originalTask: original,
            browserOpenAttempt,
            manualAction,
            humanAction,
            manualSaveRequests: humanAction === 'saved' ? 1 : 0,
            automaticSaveRequests: 2,
            articleEvidence,
            focusSwitch: {
              status: focusEvidence.every(
                (entry) => entry.electronFocused && entry.edgeFocused,
              )
                ? 'PASS'
                : 'NOT VERIFIED',
              evidence: focusEvidence,
              scope:
                'Controlled synthetic app Page; actual paragraph caret checked after upload-time window switches',
            },
            traffic,
            merchantRequests: 0,
            syntheticOnly: true,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      writeFileSync(
        join(evidence, 'manual-skip-first-failure.json'),
        JSON.stringify(
          {
            status: 'FAIL',
            syntheticOnly: true,
            userData: root,
            snapshotPreflight,
            rendererAlerts: await (
              await app.firstWindow()
            )
              .getByRole('alert')
              .allTextContents(),
            traffic: await boundary.evaluate((b) => b.snapshot()),
            batch: await (
              await app.firstWindow()
            ).evaluate(() => window.desktopApi.batch.getCurrent()),
            firstFailures: readdirSync(root)
              .filter((name) => /^judongche-first-failure-.*\.json$/.test(name))
              .map((name) => ({
                name,
                record: JSON.parse(readFileSync(join(root, name), 'utf8')),
              })),
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
      throw error;
    } finally {
      await boundary.evaluate((b) => b.restore());
      await boundary.dispose();
    }
    confirmed = true;
  } finally {
    await app.close();
    expect(resolve(root)).toBe(root);
    expect(root.startsWith(join(tmpdir(), 'operator-skip-'))).toBe(true);
    if (confirmed)
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 300,
      });
    else console.error(`PRESERVED skip evidence/data after failure: ${root}`);
  }
}
