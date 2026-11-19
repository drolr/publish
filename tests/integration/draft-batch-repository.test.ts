import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import {
  migrate,
  readMigrations,
} from '../../src/infrastructure/persistence/migrate';
import { seedLegacyStoredArticle } from '../../src/infrastructure/persistence/testing/article-fixtures';
import { createDraftSnapshotDigest } from '../../src/infrastructure/draft-snapshot-integrity';
import { makeDraftTask } from '../fixtures/draft-task';
import type { BatchSeed } from '../../src/contracts/draft-batch';

const migrations = resolve('src/infrastructure/persistence/migrations');
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'batch-repository-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'app.sqlite');
  const db = new Database(path);
  migrate(db, readMigrations(migrations).slice(0, 9));
  db.close();
  const task = makeDraftTask();
  seedLegacyStoredArticle(path, task.snapshot.article);
  task.snapshot.digest = createDraftSnapshotDigest(task.snapshot.article);
  const seed: BatchSeed = {
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
          contentDeclaration: 'repost',
          coverSummary: null,
          state: 'queued',
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
  const repo = openDraftBatchRepository(path, migrations);
  cleanup.push(() => repo.close());
  return { path, repo, seed, task };
}
it('upgrades v9 without losing articles and creates an idempotent frozen batch', () => {
  const { repo, seed, path } = setup();
  const first = repo.create(seed);
  expect(repo.create(seed)).toEqual(first);
  expect(() => repo.create({ ...seed, preparationId: randomUUID() })).toThrow();
  expect(() =>
    repo.create({ ...seed, id: randomUUID(), requestId: randomUUID() }),
  ).toThrow();
  const db = new Database(path);
  cleanup.push(() => db.close());
  expect(db.prepare('SELECT COUNT(*) AS n FROM articles').get()).toEqual({
    n: 1,
  });
  expect(
    db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get(),
  ).toEqual({ v: 15 });
  expect(first.items[0].taskId).toBeNull();
});
it('reservation and task association roll back together and are never replayed', () => {
  const { repo, seed, path, task } = setup();
  const batch = repo.create(seed);
  const db = new Database(path);
  cleanup.push(() => db.close());
  db.exec(
    "CREATE TRIGGER refuse_batch_link BEFORE UPDATE OF task_id ON draft_batch_items BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  expect(() => repo.reserveNext(batch.id, batch.revision, seed.now)).toThrow();
  expect(
    db.prepare('SELECT COUNT(*) AS n FROM judongche_draft_tasks').get(),
  ).toEqual({ n: 0 });
  db.exec('DROP TRIGGER refuse_batch_link');
  expect(repo.reserveNext(batch.id, batch.revision, seed.now)?.taskId).toBe(
    task.taskId,
  );
  const current = repo.getCurrent()!;
  expect(current.items[0]).toMatchObject({
    state: 'running',
    taskId: task.taskId,
  });
  expect(repo.reserveNext(batch.id, current.revision, seed.now)).toBeNull();
});
it('stop persists before the next reservation, including after reopening', () => {
  const { repo, seed, path } = setup();
  const batch = repo.create(seed);
  repo.requestStop(batch.id, batch.revision, seed.now);
  repo.close();
  const next = openDraftBatchRepository(path, migrations);
  cleanup.push(() => next.close());
  expect(next.getCurrent()?.stopRequested).toBe(true);
  expect(
    next.reserveNext(batch.id, next.getCurrent()!.revision, seed.now),
  ).toBeNull();
});
it('recover interrupts a linked in-flight task and never starts waiting work', () => {
  const { repo, seed, path } = setup();
  const batch = repo.create(seed);
  const task = repo.reserveNext(batch.id, batch.revision, seed.now)!;
  repo.recover(seed.now);
  expect(repo.getCurrent()).toMatchObject({
    state: 'interrupted',
    stopRequested: true,
    items: [{ state: 'needs_human', taskId: task.taskId }],
  });
  const tasks = openDraftTaskRepository(path, migrations);
  cleanup.push(() => tasks.close());
  expect(tasks.get(task.taskId)?.state).toBe('interrupted');
  expect(tasks.occupied()?.taskId).toBe(task.taskId);
});
it('a safe local failure settles from the real task and completes the batch', () => {
  const { repo, seed, path } = setup();
  const batch = repo.create(seed);
  const task = repo.reserveNext(batch.id, batch.revision, seed.now)!;
  const tasks = openDraftTaskRepository(path, migrations);
  cleanup.push(() => tasks.close());
  const running = tasks.apply(
    task.taskId,
    task.revision,
    { type: 'begin' },
    seed.now,
  );
  tasks.apply(
    task.taskId,
    running.revision,
    { type: 'settle', state: 'failed', reason: 'ASSET_UNAVAILABLE' },
    seed.now,
  );
  expect(repo.settleItem(batch.id, task.taskId, seed.now)).toMatchObject({
    state: 'completed',
    counts: { failed: 1, saved: 0 },
  });
});

it('projects the persisted per-task cover report without exposing remote resource keys', async () => {
  const { repo, seed, path } = setup();
  const { openArticleRepository } =
    await import('../../src/infrastructure/persistence/article-repository');
  const articles = openArticleRepository(path, migrations);
  cleanup.push(() => articles.close());
  const config = articles.loadCover(seed.items[0].view.articleKey)!;
  seed.items[0].reservation!.expectedCoverRevision = config.coverRevision;
  seed.items[0].reservation!.coverSnapshot = {
    version: 1,
    articleKey: config.articleKey,
    coverRevision: config.coverRevision,
    mode: config.mode,
    assets: config.assets,
    digest: config.configurationDigest,
  };
  const batch = repo.create(seed);
  const task = repo.reserveNext(batch.id, batch.revision, seed.now)!;
  expect(task.coverPlan).toBeDefined();
  expect(repo.getCurrent()!.items[0].coverReport).toEqual({
    phase: 'not_configured',
    requestedMode: 'none',
    expectedCount: 0,
    confirmedCount: 0,
    reason: null,
    updatedAt: seed.now,
  });
  expect(JSON.stringify(repo.getCurrent())).not.toContain('confirmedItems');
});

it('rechecks every executable article version atomically before persisting a batch', () => {
  const { repo, seed, path } = setup();
  const db = new Database(path);
  cleanup.push(() => db.close());
  db.prepare(
    'UPDATE articles SET content_revision=content_revision+1 WHERE article_key=?',
  ).run(seed.items[0].view.articleKey);
  expect(() => repo.create(seed)).toThrow();
  expect(db.prepare('SELECT COUNT(*) AS n FROM draft_batches').get()).toEqual({
    n: 0,
  });
});

it('archives a released stopped batch without erasing tasks or revealing earlier batches after reopen', () => {
  const { repo, seed, path } = setup();
  const first = repo.create(seed);
  const stopped = repo.finish(first.id, first.revision, seed.now);
  const nextSeed = {
    ...seed,
    id: randomUUID(),
    requestId: randomUUID(),
    preparationId: randomUUID(),
  };
  const second = repo.create(nextSeed);
  expect(() =>
    repo.archiveFinished(second.id, second.revision, seed.now),
  ).toThrow();
  const ended = repo.finish(second.id, second.revision, seed.now);
  repo.archiveFinished(ended.id, ended.revision, seed.now);
  expect(repo.getCurrent()).toBeNull();
  expect(repo.get(first.id)).toEqual(stopped);
  expect(repo.get(second.id)?.items).toEqual(ended.items);
  const reopened = openDraftBatchRepository(path, migrations);
  cleanup.push(() => reopened.close());
  expect(reopened.getCurrent()).toBeNull();
  const db = new Database(path);
  cleanup.push(() => db.close());
  expect(db.prepare('SELECT COUNT(*) AS n FROM draft_batches').get()).toEqual({
    n: 2,
  });
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('legacy snapshot skip is transactional and preserves the original ambiguous-save task across reopen', () => {
  const { repo, seed, path } = setup();
  const batch = repo.create(seed);
  const task = repo.reserveNext(batch.id, batch.revision, seed.now)!;
  const tasks = openDraftTaskRepository(path, migrations);
  cleanup.push(() => tasks.close());
  let current = tasks.apply(
    task.taskId,
    task.revision,
    { type: 'begin' },
    seed.now,
  );
  current = tasks.apply(
    task.taskId,
    current.revision,
    { type: 'before-save' },
    seed.now,
  );
  current = tasks.apply(
    task.taskId,
    current.revision,
    { type: 'settle', state: 'needs_human', reason: 'RESULT_AMBIGUOUS' },
    seed.now,
  );
  const paused = repo.settleItem(batch.id, task.taskId, seed.now);
  const input = {
    batchId: batch.id,
    expectedRevision: paused.revision,
    taskId: task.taskId,
  };
  expect(() => repo.skipCurrentAndContinue(input, seed.now)).toThrow();
  current = tasks.apply(
    task.taskId,
    current.revision,
    { type: 'stop' },
    seed.now,
  );
  const released = tasks.apply(
    task.taskId,
    current.revision,
    { type: 'release-after-stop' },
    seed.now,
  );
  const db = new Database(path);
  cleanup.push(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_skip_batch BEFORE UPDATE OF state ON draft_batches BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
  );
  expect(() => repo.skipCurrentAndContinue(input, seed.now)).toThrow();
  expect(repo.getCurrent()).toEqual(paused);
  db.exec('DROP TRIGGER fail_skip_batch');
  expect(repo.skipCurrentAndContinue(input, seed.now)).toMatchObject({
    state: 'completed',
    counts: { skipped: 1, pending: 0 },
  });
  expect(() => repo.skipCurrentAndContinue(input, seed.now)).toThrow();
  repo.close();
  const reopened = openDraftBatchRepository(path, migrations);
  cleanup.push(() => reopened.close());
  reopened.recover(seed.now);
  expect(reopened.getCurrent()).toMatchObject({
    state: 'completed',
    items: [
      {
        taskId: task.taskId,
        state: 'skipped',
        reason: 'RESULT_AMBIGUOUS',
        saveAttempted: true,
      },
    ],
  });
  expect(tasks.get(task.taskId)).toEqual(released);
});

it('restart preserves an intentional stop even when settling the interrupted writer replaces its reason', () => {
  const { repo, seed } = setup();
  const batch = repo.create(seed);
  const task = repo.reserveNext(batch.id, batch.revision, seed.now)!;
  const active = repo.getCurrent()!;
  repo.requestStop(batch.id, active.revision, seed.now);
  repo.recover(seed.now);
  const interrupted = repo.getCurrent()!;
  expect(interrupted).toMatchObject({
    state: 'interrupted',
    stopRequested: true,
    reason: 'STOP_REQUESTED',
  });
  expect(() =>
    repo.recovery({
      batchId: batch.id,
      expectedRevision: interrupted.revision,
      taskId: task.taskId,
    }),
  ).toThrow();
});
