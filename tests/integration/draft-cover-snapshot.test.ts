import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { createCoverAssetStore } from '../../src/infrastructure/assets/cover-asset-store';
import { createDraftSnapshotPort } from '../../src/infrastructure/assets/draft-snapshot';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createDraftController } from '../../src/application/draft-controller';
import type { DraftPlatform } from '../../src/domain/ports/draft-task';
import { makeDraftTask } from '../fixtures/draft-task';
import type { ReserveInput } from '../../src/contracts/draft-task';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanup.splice(0).reverse()) clean();
});
const migrations = resolve('src/infrastructure/persistence/migrations');
async function setup() {
  const base = resolve('.tmp/draft-cover');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'app.sqlite');
  const articles = openArticleRepository(path, migrations);
  cleanup.push(() => articles.close());
  const reserved = articles.reserve(randomUUID());
  articles.commit(reserved, {
    articleKey: reserved.articleKey,
    importId: reserved.importId,
    externalId: reserved.externalId,
    title: '离线封面任务文章',
    body: [{ type: 'paragraph', text: 'original body' }],
    assets: [],
    contentDeclaration: 'repost',
    createdAt: reserved.startedAt,
  });
  const taskStore = openDraftTaskRepository(path, migrations);
  cleanup.push(() => taskStore.close());
  const db = new Database(path);
  cleanup.push(() => db.close());
  const coverAssets = createCoverAssetStore(root, articles);
  const snapshots = createDraftSnapshotPort(
    createAssetStore(join(root, 'assets')),
    { repository: articles, assets: coverAssets },
  );
  const article = articles.loadEditableArticle(reserved.articleKey)!;
  async function input() {
    const config = articles.loadCover(reserved.articleKey)!;
    return {
      taskId: randomUUID(),
      preparationId: randomUUID(),
      expectedArticleRevision: article.articleRevision,
      expectedCoverRevision: config.coverRevision,
      coverSnapshot: snapshots.captureCover(config),
      snapshot: await snapshots.capture(article),
      store: makeDraftTask().store,
      now: '2026-10-09T00:00:00.000Z',
    } satisfies ReserveInput;
  }
  async function save(mode: 'none' | 'single' = 'none') {
    const config = articles.loadCover(reserved.articleKey)!;
    const intent = {
      operationId: randomUUID(),
      sessionId: randomUUID(),
      articleKey: reserved.articleKey,
      expectedArticleRevision: 1,
      expectedCoverRevision: config.coverRevision,
      draftRevision: 0,
      mode,
      payloadDigest: 'a'.repeat(64),
      startedAt: '2026-10-09T00:00:00.000Z',
    };
    expect(articles.beginCoverSave(intent).status).toBe('not_started');
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const assets = await coverAssets.prepareCoverFiles(
      intent,
      mode === 'none' ? [] : [{ bytes }],
      new AbortController().signal,
    );
    expect(articles.commitCoverVersion(intent, assets).status).toBe(
      'committed',
    );
    return articles.loadCover(reserved.articleKey)!;
  }
  return {
    root,
    path,
    db,
    articles,
    taskStore,
    snapshots,
    coverAssets,
    article,
    input,
    save,
    key: reserved.articleKey,
  };
}
it('none_does_not_block_body persists new none extension atomically and reopens without replay', async () => {
  const s = await setup();
  const input = await s.input();
  const value = s.taskStore.reserve(input);
  expect(value).toMatchObject({
    status: 'created',
    task: {
      coverPlan: {
        policy: 'local-upload-v1',
        snapshot: { mode: 'none', coverRevision: 0 },
        report: { phase: 'not_configured' },
      },
    },
  });
  expect(
    s.db
      .prepare(
        'SELECT cover_plan_version AS version FROM judongche_draft_tasks',
      )
      .get(),
  ).toEqual({ version: 1 });
  expect(
    s.db.prepare('SELECT count(*) AS count FROM judongche_task_covers').get(),
  ).toEqual({ count: 1 });
  s.taskStore.close();
  const reopened = openDraftTaskRepository(s.path, migrations);
  cleanup.push(() => reopened.close());
  reopened.recover(input.now);
  expect(reopened.get(input.taskId)).toMatchObject({
    state: 'interrupted',
    holdsPlatform: true,
    coverPlan: { report: { phase: 'not_configured' } },
  });
  expect(
    reopened.reserve({
      ...input,
      taskId: randomUUID(),
      preparationId: randomUUID(),
    }).status,
  ).toBe('blocked');
});
it('stale_cover_preparation refuses changed cover head without making any task', async () => {
  const s = await setup();
  const old = await s.input();
  await s.save();
  expect(s.taskStore.reserve(old)).toEqual({ status: 'stale' });
  expect(
    s.db.prepare('SELECT count(*) AS count FROM judongche_draft_tasks').get(),
  ).toEqual({ count: 0 });
});
it('deleted_article_reserve refuses tombstones even with exact old snapshots', async () => {
  const s = await setup();
  const input = await s.input();
  s.db
    .prepare('UPDATE articles SET deleted_at=? WHERE article_key=?')
    .run(input.now, s.key);
  expect(s.taskStore.reserve(input)).toEqual({ status: 'stale' });
});
it('missing_cover_file_reported_later leaves body capture, verification and preparation available', async () => {
  const s = await setup();
  const config = await s.save('single');
  unlinkSync(join(s.root, 'covers', config.assets[0].relativePath));
  const prep = createDraftPreparation({
    contentCapabilities: () => ({
      revision: 'judongche-rich-unknown-v1',
      features: {},
    }),
    repository: s.articles,
    covers: s.articles,
    snapshots: s.snapshots,
    tasks: s.taskStore,
    newId: randomUUID,
  });
  const offer = prep.offer({
    status: 'ready',
    store: makeDraftTask().store,
    generation: randomUUID(),
  });
  const ready = await prep.prepare(s.key, offer.bindingToken!);
  expect(ready.status).toBe('ready');
  if (ready.status !== 'ready') throw Error('not ready');
  const captured = prep.take(ready.preparation.preparationId)!;
  expect(captured.coverSnapshot).toMatchObject({
    mode: 'single',
    coverRevision: 1,
  });
  await expect(s.snapshots.verify(captured.snapshot)).resolves.toBeUndefined();
  await expect(
    s.snapshots.readCoverImage(
      captured.coverSnapshot!,
      config.assets[0].assetKey,
    ),
  ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
  const input = await s.input();
  expect(s.taskStore.reserve(input)).toMatchObject({
    status: 'created',
    task: { coverPlan: { report: { phase: 'pending' } } },
  });
});
it('legacy_task_roundtrip keeps stored body and evidence bytes plus marker0 unchanged', async () => {
  const s = await setup();
  const legacy: ReserveInput = await s.input();
  delete legacy.coverSnapshot;
  delete legacy.expectedCoverRevision;
  s.taskStore.reserve(legacy);
  const before = s.db
    .prepare(
      'SELECT snapshot_json,evidence_json,cover_policy,cover_plan_version FROM judongche_draft_tasks',
    )
    .get();
  expect(s.taskStore.get(legacy.taskId)?.coverPlan).toBeUndefined();
  s.taskStore.close();
  const reopened = openDraftTaskRepository(s.path, migrations);
  cleanup.push(() => reopened.close());
  expect(
    s.db
      .prepare(
        'SELECT snapshot_json,evidence_json,cover_policy,cover_plan_version FROM judongche_draft_tasks',
      )
      .get(),
  ).toEqual(before);
  expect(
    s.db.prepare('SELECT count(*) AS count FROM judongche_task_covers').get(),
  ).toEqual({ count: 0 });
});
it.each(['missing', 'digest', 'foreign'])(
  'marker1 %s side row is storage error, never legacy',
  async (kind) => {
    const s = await setup();
    s.taskStore.reserve(await s.input());
    s.taskStore.close();
    if (kind === 'missing') s.db.exec('DELETE FROM judongche_task_covers');
    if (kind === 'digest')
      s.db
        .prepare('UPDATE judongche_task_covers SET snapshot_digest=?')
        .run('f'.repeat(64));
    if (kind === 'foreign') {
      const row = s.db
        .prepare('SELECT snapshot_json FROM judongche_task_covers')
        .get() as { snapshot_json: string };
      const v = JSON.parse(row.snapshot_json);
      v.articleKey = randomUUID();
      s.db
        .prepare('UPDATE judongche_task_covers SET snapshot_json=?')
        .run(JSON.stringify(v));
    }
    expect(() => {
      const unexpected = openDraftTaskRepository(s.path, migrations);
      unexpected.close();
    }).toThrow();
  },
);
it('side insert failure rolls back task insert and both checkpoints', async () => {
  const s = await setup();
  s.db.exec(
    "CREATE TRIGGER fail_side BEFORE INSERT ON judongche_task_covers BEGIN SELECT RAISE(ABORT,'denied'); END;",
  );
  const input = await s.input();
  expect(() => s.taskStore.reserve(input)).toThrow();
  expect(
    s.db.prepare('SELECT count(*) AS count FROM judongche_draft_tasks').get(),
  ).toEqual({ count: 0 });
});

it('cover warning and core revision commit together, retain old body success and allow a fresh attempt with a new cover', async () => {
  const s = await setup();
  await s.save('single');
  const input = await s.input();
  const created = s.taskStore.reserve(input);
  if (created.status !== 'created') throw Error('not created');
  const oldJson = s.db
    .prepare('SELECT snapshot_json,evidence_json FROM judongche_draft_tasks')
    .get();
  let task = s.taskStore.apply(input.taskId, 0, { type: 'begin' }, input.now);
  task = s.taskStore.apply(
    input.taskId,
    task.revision,
    { type: 'before-effect', stage: 'cover' },
    input.now,
  );
  const failed = {
    ...task.coverPlan!.report,
    phase: 'failed' as const,
    reason: 'IMAGE_UNAVAILABLE' as const,
  };
  s.db.exec(
    "CREATE TRIGGER reject_report BEFORE UPDATE ON judongche_task_covers BEGIN SELECT RAISE(ABORT,'denied'); END;",
  );
  expect(() =>
    s.taskStore.apply(
      task.taskId,
      task.revision,
      { type: 'cover_report', report: failed },
      input.now,
    ),
  ).toThrow();
  expect(s.taskStore.get(task.taskId)).toMatchObject({
    revision: task.revision,
    coverPlan: { report: { phase: 'pending' } },
  });
  s.db.exec('DROP TRIGGER reject_report');
  task = s.taskStore.apply(
    task.taskId,
    task.revision,
    { type: 'cover_report', report: failed },
    input.now,
  );
  expect(
    s.db
      .prepare('SELECT snapshot_json,evidence_json FROM judongche_draft_tasks')
      .get(),
  ).toEqual(oldJson);
  task = s.taskStore.apply(
    task.taskId,
    task.revision,
    { type: 'before-save' },
    input.now,
  );
  task = s.taskStore.apply(
    task.taskId,
    task.revision,
    {
      type: 'evidence',
      evidence: {
        remote: {
          recordKey: 'fixture-record',
          editUrl: 'https://example.test/edit/fixture-record',
        },
        images: [],
        cover: null,
      },
    },
    input.now,
  );
  task = s.taskStore.apply(
    task.taskId,
    task.revision,
    { type: 'verify' },
    input.now,
  );
  task = s.taskStore.apply(
    task.taskId,
    task.revision,
    { type: 'settle', state: 'draft_saved', reason: null },
    input.now,
  );
  expect(task).toMatchObject({
    state: 'draft_saved',
    reason: null,
    holdsPlatform: false,
    coverPlan: { report: { phase: 'failed', reason: 'IMAGE_UNAVAILABLE' } },
  });
  expect(() =>
    s.taskStore.apply(
      task.taskId,
      task.revision,
      {
        type: 'cover_report',
        report: { ...failed, phase: 'pending', reason: null },
      },
      input.now,
    ),
  ).toThrow();
  await s.save('none');
  const changed = await s.input();
  expect(s.taskStore.reserve(changed)).toMatchObject({
    status: 'created',
    task: {
      taskId: changed.taskId,
      state: 'queued',
      coverPlan: {
        snapshot: { coverRevision: 2 },
        report: { phase: 'not_configured' },
      },
    },
  });
  expect(s.taskStore.get(task.taskId)).toEqual(task);
  s.taskStore.close();
  const reopened = openDraftTaskRepository(s.path, migrations);
  cleanup.push(() => reopened.close());
  expect(reopened.get(task.taskId)).toMatchObject({
    state: 'draft_saved',
    coverPlan: { report: { reason: 'IMAGE_UNAVAILABLE' } },
  });
});
it('forged ordered cover digest and damaged current metadata fail closed with zero reservation', async () => {
  const s = await setup();
  await s.save('single');
  const input = await s.input();
  expect(() =>
    s.taskStore.reserve({
      ...input,
      coverSnapshot: { ...input.coverSnapshot, digest: 'f'.repeat(64) },
    }),
  ).toThrow();
  s.db.prepare('UPDATE article_cover_versions SET assets_json=?').run('{}');
  expect(() => s.taskStore.reserve(input)).toThrow();
  expect(
    s.db.prepare('SELECT count(*) AS count FROM judongche_draft_tasks').get(),
  ).toEqual({ count: 0 });
});

async function controlledExecution(
  s: Awaited<ReturnType<typeof setup>>,
  execute: DraftPlatform['execute'],
) {
  const probe = {
    status: 'ready' as const,
    store: makeDraftTask().store,
    generation: randomUUID(),
  };
  const platform: DraftPlatform = {
    contentCapabilities: () => ({
      revision: 'judongche-rich-unknown-v1',
      features: {},
    }),
    openSession: async () => probe,
    checkSession: async () => probe,
    closeSession: async () => {},
    execute,
    reconcile: async () => ({ status: 'blocked', reason: 'RESULT_AMBIGUOUS' }),
    checkAbsence: async () => ({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    }),
    openVerified: async () => {},
  };
  const controller = createDraftController({
    invalidateBrowserHealth: () => {},
    tasks: s.taskStore,
    snapshots: s.snapshots,
    preparation: createDraftPreparation({
      contentCapabilities: () => ({
        revision: 'judongche-rich-unknown-v1',
        features: {},
      }),
      repository: s.articles,
      covers: s.articles,
      snapshots: s.snapshots,
      tasks: s.taskStore,
      newId: randomUUID,
    }),
    platform,
    newId: randomUUID,
    now: () => '2026-10-09T00:00:00.000Z',
    gate: () => 'ready',
  });
  const opened = await controller.openDraftSession();
  const prepared = await controller.prepareDraft(
    s.key,
    opened.view.session.bindingToken!,
  );
  if (prepared.status !== 'ready') throw Error('not ready');
  expect(
    await controller.startDraft(prepared.preparation.preparationId),
  ).toMatchObject({ status: 'ok' });
  return controller;
}
it.each(['missing', 'unknown'] as const)(
  'controller cover reader classifies %s storage and binds its separate report hook',
  async (kind) => {
    const s = await setup();
    const configuration = await s.save('single');
    const file = join(s.root, 'covers', configuration.assets[0].relativePath);
    if (kind === 'missing') unlinkSync(file);
    else writeFileSync(file, new Uint8Array([1, 2, 3]));
    let stoppedAfterRead = false;
    let observedCode: unknown;
    const controller = await controlledExecution(s, async (task, hooks) => {
      await hooks.checkpoint('cover');
      try {
        await hooks.readCoverImage(task.coverPlan!.snapshot.assets[0].assetKey);
        throw Error('read unexpectedly succeeded');
      } catch (error) {
        observedCode =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
      }
      stoppedAfterRead = hooks.stopped();
      if (kind === 'missing')
        await hooks.coverReport({
          ...task.coverPlan!.report,
          phase: 'failed',
          reason: 'IMAGE_UNAVAILABLE',
        });
      return { status: 'blocked', reason: 'PAGE_CHANGED' };
    });
    await vi.waitFor(() => expect(controller.isActive()).toBe(false));
    expect(stoppedAfterRead).toBe(kind === 'unknown');
    if (kind === 'missing') {
      expect(observedCode).toBe('IMAGE_UNAVAILABLE');
      expect(s.taskStore.latest()).toMatchObject({
        state: 'needs_human',
        reason: 'PAGE_CHANGED',
        saveAttempted: false,
        coverPlan: { report: { phase: 'failed', reason: 'IMAGE_UNAVAILABLE' } },
      });
    } else {
      expect((await controller.getDraftState()).task).toMatchObject({
        reason: 'STORAGE_UNAVAILABLE',
        platformPaused: true,
      });
      expect(s.taskStore.latest()).toMatchObject({
        state: 'running',
        holdsPlatform: true,
        saveAttempted: false,
        coverPlan: { report: { phase: 'pending' } },
      });
    }
    await controller.stopAndWait();
  },
);
it('stop while a cover read settles denies new effects without misclassifying cancellation as storage loss', async () => {
  const s = await setup();
  await s.save('single');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = s.snapshots.readCoverImage;
  s.snapshots.readCoverImage = async (...args) => {
    const bytes = await original(...args);
    entered();
    await wait;
    return bytes;
  };
  const controller = await controlledExecution(s, async (task, hooks) => {
    await hooks.checkpoint('cover');
    try {
      await hooks.readCoverImage(task.coverPlan!.snapshot.assets[0].assetKey);
    } catch {
      return { status: 'blocked', reason: 'STOP_REQUESTED' };
    }
    throw Error('stop did not block');
  });
  await started;
  await controller.stopDraft(s.taskStore.latest()!.taskId);
  release();
  await vi.waitFor(() => expect(controller.isActive()).toBe(false));
  expect((await controller.getDraftState()).task).toMatchObject({
    reason: 'STOP_REQUESTED',
    platformPaused: true,
  });
  expect(s.taskStore.latest()).toMatchObject({
    state: 'needs_human',
    saveAttempted: false,
    stopRequested: true,
  });
  await controller.stopAndWait();
});
