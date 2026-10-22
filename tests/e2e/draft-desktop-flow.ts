import {
  expect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  migrate,
  readMigrations,
} from '../../src/infrastructure/persistence/migrate';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import { makeDraftTask } from '../fixtures/draft-task';

// Public bridge only: never open the merchant entry or manufacture readiness.
export async function exerciseDraftBridge(
  app: ElectronApplication,
): Promise<void> {
  const page = await app.firstWindow();
  const root = await app.evaluate(({ app }) => app.getPath('userData'));
  const before = await page.evaluate(() => window.desktopApi.getDraftState());
  expect(before.session.status).toBe('closed');
  expect(before.preparation).toBeNull();
  for (let n = 0; n < 3; n++)
    expect(
      await page.evaluate(() => window.desktopApi.getDraftState()),
    ).toEqual(before);
  const id = '33333333-3333-4333-8333-333333333333';
  expect(
    await page.evaluate((id) => window.desktopApi.startDraft(id), id),
  ).toMatchObject({ status: 'blocked' });
  await expect(
    page.evaluate(() =>
      window.desktopApi.getDraftState.apply(null, [
        'https://example.invalid',
      ] as never),
    ),
  ).rejects.toThrow();
  await expect(
    page.evaluate(
      (id) =>
        window.desktopApi.openSavedDraft.apply(null, [
          id,
          'https://example.invalid',
        ] as never),
      id,
    ),
  ).rejects.toThrow();
  await expect(
    page.evaluate(() =>
      window.desktopApi.prepareDraft('C:/private', 'arbitrary'),
    ),
  ).rejects.toThrow();
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => window.desktopApi.getDraftState()))
    .toEqual(before);
  expect(existsSync(join(root, 'profiles'))).toBe(false);
  for (const privateField of [
    'profileDirectory',
    'snapshot',
    'storeKey',
    'recordKey',
    'editUrl',
  ])
    expect(JSON.stringify(before)).not.toContain(privateField);
}

export async function checkDraftRecovery(
  executablePath?: string,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'draft-upgrade-'));
  const database = join(root, 'data/app.sqlite');
  const migrations = resolve('src/infrastructure/persistence/migrations');
  const fixture = makeDraftTask();
  const article = fixture.snapshot.article;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    mkdirSync(join(root, 'data'));
    const db = new Database(database);
    try {
      migrate(db, readMigrations(migrations).slice(0, 2));
      db.prepare(
        'INSERT INTO articles (article_key,external_id,import_id,title,body_json,content_declaration,created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(
        article.articleKey,
        article.externalId,
        article.importId,
        article.title,
        JSON.stringify(article.body),
        article.contentDeclaration,
        article.createdAt,
      );
    } finally {
      db.close();
    }
    for (let run = 0; run < 2; run++) {
      const app = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
        env: environment,
      });
      try {
        const page = await app.firstWindow();
        await expect(
          page.getByRole('heading', { name: '汽车经销商草稿助手' }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => window.desktopApi.getAppStatus()),
        ).toMatchObject({ state: 'ready', schemaVersion: 14 });
        expect(
          await page.evaluate(() => window.desktopApi.listArticles()),
        ).toMatchObject({
          status: 'ok',
          page: {
            items: [{ articleKey: article.articleKey, title: article.title }],
          },
        });
        await exerciseDraftBridge(app);
        const state = await page.evaluate(() =>
          window.desktopApi.getDraftState(),
        );
        if (run === 0) expect(state.task).toBeNull();
        else
          expect(state.task).toMatchObject({
            taskId: fixture.taskId,
            state: 'interrupted',
            platformPaused: true,
            possibleRemoteEffect: false,
          });
        if (run === 1) {
          await page
            .getByRole('button', {
              name: /停止所有未完成操作|停止并初始化/,
              exact: true,
            })
            .click();
          await expect
            .poll(
              async () =>
                (
                  await page.evaluate(() =>
                    window.desktopApi.getOperationControlState(),
                  )
                ).phase,
            )
            .toBe('stopped');
          expect(
            (await page.evaluate(() => window.desktopApi.getDraftState())).task,
          ).toMatchObject({
            state: 'stopped_by_user',
            platformPaused: false,
            stopRequested: true,
          });
          await expect(
            page.getByText(
              '已停止并释放占用，可以重新上传；上次可能已生成草稿，请自行核对，重复上传可能产生重复草稿',
              { exact: true },
            ),
          ).toBeVisible();
          await page
            .getByRole('button', { name: '新建文章', exact: true })
            .click();
          await expect(
            page.getByRole('button', { name: '手动录入', exact: true }),
          ).toBeVisible();
        }
      } finally {
        await app.close();
      }
      if (run === 0) {
        // Test-only durable crash fixture. No product debug IPC or fake readiness.
        const tasks = openDraftTaskRepository(database, migrations);
        try {
          expect(
            tasks.reserve({
              taskId: fixture.taskId,
              preparationId: fixture.preparationId,
              expectedArticleRevision: 1,
              snapshot: fixture.snapshot,
              store: fixture.store,
              now: fixture.createdAt,
            }).status,
          ).toBe('created');
        } finally {
          tasks.close();
        }
      }
    }
  } finally {
    expect(resolve(root)).toBe(root);
    expect(root.startsWith(join(tmpdir(), 'draft-upgrade-'))).toBe(true);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}
