import { _electron as electron, expect } from '@playwright/test';
import type { BrowserType, BrowserContext, Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { packagedEnvironment } from './browser-health-checks';
import { installProductionFixture } from '../fixtures/judongche-production';
import { makeDraftTask } from '../fixtures/draft-task';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { seedLegacyStoredArticle } from '../../src/infrastructure/persistence/testing/article-fixtures';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';

/** Fresh live controller -> artificial page activity -> manual handling on its
 * exact Page -> existing UI skip. Independent of the startup recovery helper. */
export async function checkLiveManualSkip(
  executablePath: string | undefined,
  evidence: string,
) {
  mkdirSync(evidence, { recursive: true });
  for (const action of ['saved', 'abandoned'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'operator-live-skip-'));
    mkdirSync(join(root, 'data'));
    const database = join(root, 'data/app.sqlite');
    const migrations = resolve('src/infrastructure/persistence/migrations');
    openArticleRepository(database, migrations).close();
    const articles = Array.from({ length: 2 }, (_, index) => ({
      ...makeDraftTask().snapshot.article,
      articleKey: randomUUID(),
      importId: randomUUID(),
      externalId: randomUUID(),
      title: `Live manual ${action} item ${index + 1}`,
      body: [
        {
          type: 'paragraph' as const,
          text: `Live synthetic body ${index + 1}`,
        },
      ],
      assets: [],
    }));
    for (const article of articles) seedLegacyStoredArticle(database, article);
    const app = await electron.launch({
      executablePath,
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
      env: packagedEnvironment(),
    });
    let confirmed = false;
    try {
      const boundary = await app.evaluateHandle(
        ({ app }, { source, firstTitle, businessProfile }) => {
          const localRequire = process
            .getBuiltinModule('module')
            .createRequire(
              app.getAppPath() + '/package.json',
            ) as NodeJS.Require;
          const runtime = localRequire('playwright-core') as {
            chromium: BrowserType;
          };
          const original = runtime.chromium.launchPersistentContext;
          const install = new Function('__name', `return (${source})`)(
            (fn: unknown) => fn,
          ) as typeof installProductionFixture;
          const records: {
            context: BrowserContext;
            page: Page;
            pages: Page[];
            closed: boolean;
            homes: number;
            blocked: string[];
            fixture: Awaited<ReturnType<typeof installProductionFixture>>;
          }[] = [];
          runtime.chromium.launchPersistentContext = async function (
            path,
            options,
          ) {
            const context = await original.call(this, path, options);
            const blocked: string[] = [];
            await context.route('**/*', (route) => {
              blocked.push(route.request().url());
              return route.abort();
            });
            // Health diagnostics use temporary contexts. Preserve those checks;
            // only the actual business profile is this helper's target.
            if (path !== businessProfile) return context;
            const fixture = await install(context, {
              batchHistory: true,
              observedTrailingParagraphs: true,
            });
            await context.addInitScript((firstTitle) => {
              // Main captures the seeded legacy articles as V2 snapshots. Add
              // the same rich-editor DOM surface as the controlled V2 fixtures;
              // the underlying production writer and its actions stay real.
              document.addEventListener('DOMContentLoaded', () => {
                const editor = document.querySelector<HTMLElement>('#body');
                if (!editor) return;
                const wrapper = document.createElement('div');
                wrapper.className = 'publish-editor';
                editor.before(wrapper);
                wrapper.append(editor);
                editor.classList.add('ProseMirror');
                for (const name of ['bold', 'italic', 'underline']) {
                  const tool = document.createElement('div');
                  tool.className = 'syl-toolbar-tool ' + name;
                  const button = document.createElement('button');
                  button.className = 'syl-toolbar-button';
                  button.textContent = name;
                  button.onmousedown = (event) => event.preventDefault();
                  button.onclick = () => {
                    const active = !tool.classList.contains('active');
                    editor.focus();
                    if (document.queryCommandState(name) !== active)
                      document.execCommand(name);
                    tool.classList.toggle('active', active);
                  };
                  tool.append(button);
                  document.querySelector('.syl-toolbar')!.append(tool);
                }
              });
              let injected = false;
              document.addEventListener('input', (event) => {
                if (
                  !injected &&
                  event.target instanceof HTMLTextAreaElement &&
                  event.target.value === firstTitle
                ) {
                  injected = true;
                  document
                    .querySelector('#save')!
                    .setAttribute('aria-busy', 'true');
                }
              });
            }, firstTitle);
            const page = context.pages()[0]!;
            const record = {
              context,
              page,
              pages: [...context.pages()],
              closed: false,
              homes: 0,
              blocked,
              fixture,
            };
            context.on('page', (page) => record.pages.push(page));
            context.on('close', () => {
              record.closed = true;
            });
            page.on('framenavigated', (frame) => {
              if (frame === page.mainFrame() && page.url() === fixture.home)
                record.homes++;
            });
            records.push(record);
            return context;
          };
          return {
            handle: async (action: 'saved' | 'abandoned') => {
              if (records.length !== 1)
                throw Error('Expected original live browser only');
              const record = records[0]!;
              await record.page
                .locator('#save')
                .evaluate((node) => node.removeAttribute('aria-busy'));
              await record.page
                .locator('#body')
                .fill('Manually handled different body');
              if (action === 'saved') {
                const finished = record.page.waitForEvent(
                  'requestfinished',
                  (request) => request.url().endsWith('/article/create'),
                );
                await record.page
                  .getByRole('button', { name: '存草稿', exact: true })
                  .click();
                await finished;
              }
            },
            snapshot: () =>
              records.map((record) => ({
                closed: record.closed,
                homes: record.homes,
                originalPage: record.context.pages()[0] === record.page,
                sameContext: record.page.context() === record.context,
                pageClosed: record.page.isClosed(),
                pageCount: record.pages.length,
                saves: record.fixture.saves(),
                undoes: record.fixture.undoes(),
                blocked: record.blocked,
              })),
            restore: async () => {
              runtime.chromium.launchPersistentContext = original;
              for (const record of records) await record.context.close();
            },
          };
        },
        {
          source: installProductionFixture.toString(),
          firstTitle: articles[0]!.title,
          businessProfile: resolve(root, 'profiles', 'judongche'),
        },
      );
      try {
        const page = await app.firstWindow();
        await expect(
          page.getByRole('button', { name: '新建文章', exact: true }),
        ).toBeEnabled();
        const opened = await page.evaluate(() =>
          window.desktopApi.openDraftSession(),
        );
        expect(opened.status).toBe('ok');
        const prepared = await page.evaluate(
          (input) => window.desktopApi.batch.prepare(input),
          {
            articleKeys: articles.map((article) => article.articleKey),
            bindingToken: opened.view.session.bindingToken!,
          },
        );
        if (prepared.status !== 'ready') throw Error(JSON.stringify(prepared));
        await page.evaluate((input) => window.desktopApi.batch.start(input), {
          preparationId: prepared.preparation.preparationId,
          requestId: randomUUID(),
        });
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.desktopApi.batch.getCurrent()))
                ?.state,
            { timeout: 30000 },
          )
          .toBe('paused');
        const paused = (await page.evaluate(() =>
          window.desktopApi.batch.getCurrent(),
        ))!;
        const taskId = paused.items[0]!.taskId!;
        const read = openDraftTaskRepository(database, migrations);
        let original;
        try {
          original = read.get(taskId)!;
        } finally {
          read.close();
        }
        await boundary.evaluate((b, action) => b.handle(action), action);
        const before = await boundary.evaluate((b) => b.snapshot());
        expect(before).toHaveLength(1);
        await page
          .getByRole('tab', { name: '批量存草稿', exact: true })
          .click();
        await page
          .getByRole('button', { name: '跳过这篇，继续上传', exact: true })
          .click();
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.desktopApi.batch.getCurrent()))
                ?.state,
            { timeout: 60000 },
          )
          .toBe('completed');
        const after = await boundary.evaluate((b) => b.snapshot());
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({
          originalPage: true,
          sameContext: true,
          pageClosed: false,
          pageCount: 1,
          closed: false,
          saves: action === 'saved' ? 2 : 1,
          undoes: 0,
          blocked: [],
          homes: before[0]!.homes + 2,
        });
        const result = (await page.evaluate(() =>
          window.desktopApi.batch.getCurrent(),
        ))!;
        expect(result.items.map((item) => item.state)).toEqual([
          'skipped',
          'submission_recorded',
        ]);
        const finalRead = openDraftTaskRepository(database, migrations);
        try {
          expect(finalRead.get(taskId)).toMatchObject({
            state: 'stopped_by_user',
            reason: original.reason,
            evidence: original.evidence,
            saveAttempted: original.saveAttempted,
            possibleRemoteEffect: original.possibleRemoteEffect,
          });
        } finally {
          finalRead.close();
        }
        writeFileSync(
          join(evidence, `${action}.json`),
          JSON.stringify(
            { syntheticOnly: true, before, after, result },
            null,
            2,
          ),
        );
      } finally {
        await boundary.evaluate((b) => b.restore());
        await boundary.dispose();
      }
      confirmed = true;
    } finally {
      await app.close();
      if (confirmed)
        rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 300,
        });
      else
        console.error(
          `PRESERVED live skip evidence/data after failure: ${root}`,
        );
    }
  }
}
