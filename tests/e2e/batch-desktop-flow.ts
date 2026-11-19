import { _electron as electron, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { seedLegacyStoredArticle } from '../../src/infrastructure/persistence/testing/article-fixtures';
import { makeDraftTask } from '../fixtures/draft-task';
import {
  checkpointAttempt,
  restartCheckpoints,
} from '../integration/draft-attempt-restart-child';

// Four independently seeded durable checkpoints, each through two actual launches.
// Abrupt child exit is integration evidence; these launches prove the real main
// composition/bridge recovers without ever creating a merchant Profile.
export async function checkBatchRecovery(executablePath?: string) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  const migrations = resolve('src/infrastructure/persistence/migrations');
  for (const checkpoint of restartCheckpoints) {
    const root = mkdtempSync(join(tmpdir(), 'batch-desktop-'));
    const database = join(root, 'data/app.sqlite');
    const task = makeDraftTask();
    const recorded = checkpoint === 'submission-recorded';
    try {
      mkdirSync(join(root, 'data'));
      openArticleRepository(database, migrations).close();
      seedLegacyStoredArticle(database, task.snapshot.article);
      const batches = openDraftBatchRepository(database, migrations);
      const seed = {
        id: randomUUID(),
        requestId: randomUUID(),
        preparationId: randomUUID(),
        storeKey: task.store.storeKey,
        storeName: task.store.displayName,
        now: task.createdAt,
        items: [
          {
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
              store: task.store,
              snapshot: task.snapshot,
              expectedArticleRevision: 1,
              now: task.createdAt,
            },
          },
        ],
      };
      try {
        const created = batches.create(seed);
        expect(
          batches.reserveNext(created.id, created.revision, task.createdAt)
            ?.taskId,
        ).toBe(task.taskId);
      } finally {
        batches.close();
      }
      const seeded = openDraftTaskRepository(database, migrations);
      let durable;
      try {
        durable = checkpointAttempt(
          seeded,
          task.taskId,
          checkpoint,
          task.createdAt,
        );
      } finally {
        seeded.close();
      }
      for (let run = 0; run < 2; run++) {
        const app = await electron.launch({
          executablePath,
          args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
          env: environment,
        });
        try {
          const page = await app.firstWindow();
          await page
            .getByRole('tab', { name: '批量存草稿', exact: true })
            .click();
          await expect(
            page.getByRole('heading', { name: '批量存草稿', exact: true }),
          ).toBeVisible();
          expect(
            await page.evaluate(() =>
              Object.keys(window.desktopApi.batch).sort(),
            ),
          ).toEqual([
            'archiveFinishedBatch',
            'finish',
            'getCurrent',
            'prepare',
            'skipCurrentAndContinue',
            'start',
            'stop',
          ]);
          expect(
            await page.evaluate(() => Object.isFrozen(window.desktopApi.batch)),
          ).toBe(true);
          await expect(
            page.evaluate(() =>
              window.desktopApi.batch.getCurrent.apply(null, ['bad'] as never),
            ),
          ).rejects.toThrow();
          expect(
            await page.evaluate(() => window.desktopApi.batch.getCurrent()),
          ).toMatchObject({
            id: seed.id,
            state: recorded ? 'completed' : 'interrupted',
            stopRequested: true,
            counts: {
              needsHuman: recorded ? 0 : 1,
              saved: 0,
              attempted: recorded ? 1 : 0,
            },
            items: [
              {
                taskId: task.taskId,
                state: recorded ? 'submission_recorded' : 'needs_human',
              },
            ],
          });
          expect(
            (await page.evaluate(() => window.desktopApi.getDraftState())).task,
          ).toMatchObject({
            taskId: task.taskId,
            state: recorded ? 'submission_recorded' : 'interrupted',
            platformPaused: !recorded,
            possibleRemoteEffect: true,
          });
          if (!recorded) {
            await expect(
              page.getByText('上次批次已中断', { exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole('button', { name: '检查批量草稿摘要' }),
            ).toBeDisabled();
          }
          // Public queries cannot spend another save budget or launch a browser.
          const tasks = openDraftTaskRepository(database, migrations);
          try {
            expect(tasks.latest()?.taskId).toBe(task.taskId);
            expect(tasks.get(task.taskId)).toMatchObject({
              taskId: durable.taskId,
              preparationId: durable.preparationId,
              snapshot: durable.snapshot,
              articleRevision: durable.articleRevision,
              evidence: durable.evidence,
              saveAttempted: durable.saveAttempted,
              stage: durable.stage,
              holdsPlatform: !recorded,
            });
            expect(tasks.occupied()?.taskId).toBe(
              recorded ? undefined : task.taskId,
            );
          } finally {
            tasks.close();
          }
          expect(existsSync(join(root, 'profiles'))).toBe(false);
          if (run === 1 && !recorded) {
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
              (await page.evaluate(() => window.desktopApi.getDraftState()))
                .task,
            ).toMatchObject({
              taskId: task.taskId,
              state: 'stopped_by_user',
              platformPaused: false,
              stopRequested: true,
            });
            expect(
              await page.evaluate(() => window.desktopApi.batch.getCurrent()),
            ).toMatchObject({ state: 'stopped' });
          }
        } finally {
          await app.close();
        }
        const reopened = openDraftTaskRepository(database, migrations);
        try {
          expect(reopened.latest()?.taskId).toBe(task.taskId);
          expect(reopened.get(task.taskId)).toMatchObject({
            taskId: durable.taskId,
            preparationId: durable.preparationId,
            snapshot: durable.snapshot,
            evidence: durable.evidence,
            saveAttempted: durable.saveAttempted,
            possibleRemoteEffect: true,
            holdsPlatform: !recorded && run === 0,
            state: recorded
              ? 'submission_recorded'
              : run === 0
                ? 'interrupted'
                : 'stopped_by_user',
          });
        } finally {
          reopened.close();
        }
        expect(existsSync(join(root, 'profiles'))).toBe(false);
      }
    } finally {
      expect(resolve(root)).toBe(root);
      expect(root.startsWith(join(tmpdir(), 'batch-desktop-'))).toBe(true);
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 300,
      });
    }
  }
}
