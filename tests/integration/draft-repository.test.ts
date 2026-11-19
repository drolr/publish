import { upgradeEditorBody } from '../../src/domain/rich-text-body';
import { createDraftSnapshotV2Digest } from '../../src/infrastructure/draft-snapshot-integrity';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { seedLegacyStoredArticle } from '../../src/infrastructure/persistence/testing/article-fixtures';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import { createArticleImportService } from '../../src/application/article-import';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { makeDraftTask } from '../fixtures/draft-task';
import {
  StoredArticleSchema,
  type StoredArticle,
} from '../../src/contracts/stored-article';
import type { ReserveInput } from '../../src/contracts/draft-task';
import { createDraftSnapshotDigest } from '../../src/infrastructure/draft-snapshot-integrity';
import {
  migrate,
  readMigrations,
} from '../../src/infrastructure/persistence/migrate';
const migrations = resolve('src/infrastructure/persistence/migrations');
const cleanup: (() => void)[] = [];
it('manual closure commits audit with preserved task, survives restart and permits one linked new preparation', async () => {
  const s = await setup();
  const input = await s.input();
  const repo = openDraftTaskRepository(s.path, migrations);
  cleanup.push(() => repo.close());
  const reserved = repo.reserve(input);
  if (reserved.status !== 'created') throw Error('not created');
  let task = repo.apply(input.taskId, 0, { type: 'begin' }, input.now);
  task = repo.apply(
    task.taskId,
    task.revision,
    { type: 'before-effect', stage: 'editor' },
    input.now,
  );
  task = repo.apply(
    task.taskId,
    task.revision,
    { type: 'settle', state: 'needs_human', reason: 'PAGE_CHANGED' },
    input.now,
  );
  const event = {
    type: 'close-without-save' as const,
    proof: {
      taskId: task.taskId,
      revision: task.revision,
      snapshotDigest: task.snapshot.digest,
      storeKey: task.store.storeKey,
      generation: 'fixture',
      checkedAt: input.now,
    },
    confirmedAt: input.now,
  };
  const db = new Database(s.path);
  cleanup.push(() => db.close());
  db.exec(
    "CREATE TRIGGER refuse_close BEFORE INSERT ON judongche_task_closures BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  expect(() =>
    repo.apply(task.taskId, task.revision, event, input.now),
  ).toThrow();
  expect(repo.get(task.taskId)).toEqual(task);
  db.exec('DROP TRIGGER refuse_close');
  repo.apply(task.taskId, task.revision, event, input.now);
  expect(repo.occupied()).toBeUndefined();
  expect(
    repo.findIdentity(task.articleKey, task.store.storeKey),
  ).toBeUndefined();
  expect(
    repo.findLatestIdentity(task.articleKey, task.store.storeKey)?.taskId,
  ).toBe(task.taskId);
  expect(repo.reserve(input)).toMatchObject({
    status: 'existing',
    task: {
      state: 'closed_without_save',
      possibleRemoteEffect: true,
      saveAttempted: false,
    },
  });
  const next = { ...input, taskId: randomUUID(), preparationId: randomUUID() };
  expect(repo.reserve(next).status).toBe('created');
  expect(
    repo.reserve({ ...next, taskId: randomUUID(), preparationId: randomUUID() })
      .status,
  ).toBe('blocked');
  expect(
    db
      .prepare(
        'SELECT successor_task_id FROM judongche_task_closures WHERE task_id=?',
      )
      .get(task.taskId),
  ).toEqual({ successor_task_id: next.taskId });
  repo.close();
  const reopened = openDraftTaskRepository(s.path, migrations);
  cleanup.push(() => reopened.close());
  expect(reopened.get(task.taskId)).toMatchObject({
    state: 'closed_without_save',
    snapshot: task.snapshot,
    evidence: task.evidence,
    reason: task.reason,
  });
});
it('interrupted body-stage manual closure retains the original stage in durable audit', async () => {
  const s = await setup();
  const input = await s.input();
  const repo = s.open();
  repo.reserve(input);
  let task = repo.apply(input.taskId, 0, { type: 'begin' }, input.now);
  task = repo.apply(
    task.taskId,
    task.revision,
    { type: 'before-effect', stage: 'body' },
    input.now,
  );
  repo.recover(input.now);
  task = repo.get(task.taskId)!;
  expect(task).toMatchObject({ state: 'interrupted', stage: 'body' });
  repo.apply(
    task.taskId,
    task.revision,
    {
      type: 'close-without-save',
      confirmedAt: input.now,
      proof: {
        taskId: task.taskId,
        revision: task.revision,
        snapshotDigest: task.snapshot.digest,
        storeKey: task.store.storeKey,
        generation: 'fixture',
        checkedAt: input.now,
      },
    },
    input.now,
  );
  expect(
    s
      .raw()
      .prepare(
        'SELECT prior_stage FROM judongche_task_closures WHERE task_id=?',
      )
      .get(task.taskId),
  ).toEqual({ prior_stage: 'body' });
  repo.close();
  expect(s.open().get(task.taskId)?.state).toBe('closed_without_save');
});
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function snapshot(article: StoredArticle) {
  const normalized = StoredArticleSchema.parse(article);
  normalized.assets.sort((a, b) => a.assetKey.localeCompare(b.assetKey));
  return {
    version: 1 as const,
    article: normalized,
    digest: createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex'),
  };
}
it('uses the shared canonical digest without mutating caller asset order', async () => {
  const s = await setup();
  const input = await s.input();
  const base = input.snapshot.article.assets[0];
  const low = {
    ...base,
    assetKey: '00000000-0000-4000-8000-000000000001',
    imageId: 'low',
    relativePath: `${input.snapshot.article.articleKey}/00000000-0000-4000-8000-000000000001.png`,
  };
  const high = {
    ...base,
    assetKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    imageId: 'high',
    relativePath: `${input.snapshot.article.articleKey}/ffffffff-ffff-4fff-8fff-ffffffffffff.png`,
  };
  const article = {
    ...input.snapshot.article,
    body: [
      { type: 'paragraph' as const, text: 'ordered body' },
      { type: 'image' as const, image_id: 'high' },
      { type: 'image' as const, image_id: 'low' },
    ],
    assets: [high, low],
  };
  const before = article.assets.map((asset) => asset.assetKey);
  const reversed = { ...article, assets: [...article.assets].reverse() };
  expect(createDraftSnapshotDigest(article)).toBe(
    createDraftSnapshotDigest(reversed),
  );
  expect(article.assets.map((asset) => asset.assetKey)).toEqual(before);
  expect(before).toEqual([high.assetKey, low.assetKey]);
});
async function setup(old = false) {
  const root = mkdtempSync(join(tmpdir(), 'draft-ledger-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'app.sqlite');
  const migrationPath = join(root, 'old');
  mkdirSync(migrationPath);
  for (const name of ['0001_baseline.sql', '0002_article_import.sql'])
    copyFileSync(join(migrations, name), join(migrationPath, name));
  const articles = openArticleRepository(
    path,
    old ? migrationPath : migrations,
  );
  cleanup.push(() => articles.close());
  const assets = createAssetStore(join(root, 'assets'));
  // Historical on-disk fixtures need the pre-schema7 writer. The current writer
  // must require membership metadata; production always upgrades before import.
  const importRepository = old
    ? {
        ...articles,
        commit: (_attempt: unknown, article: StoredArticle) =>
          seedLegacyStoredArticle(path, article),
      }
    : articles;
  const service = createArticleImportService(importRepository, assets, {
    read: async () =>
      new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
          'base64',
        ),
      ),
  });
  await service.recover();
  async function input(): Promise<ReserveInput> {
    const result = await service.importArticle({
      schema_version: 1,
      article_id: randomUUID(),
      title: 'Offline',
      body: [
        { type: 'paragraph', text: 'Offline body' },
        { type: 'image', image_id: 'i' },
      ],
      images: [{ image_id: 'i', source: { type: 'local', path: 'i.png' } }],
    });
    if (result.status !== 'imported') throw new Error(JSON.stringify(result));
    const task = makeDraftTask();
    return {
      taskId: randomUUID(),
      preparationId: randomUUID(),
      store: task.store,
      now: task.createdAt,
      // The old fixture has no revision column; migration 0006 assigns its first version 1.
      expectedArticleRevision: old
        ? 1
        : articles.loadEditableArticle(result.article.articleKey)!
            .articleRevision,
      snapshot: snapshot(articles.load(result.article.articleKey)!),
    };
  }
  function open() {
    const r = openDraftTaskRepository(path, migrations);
    cleanup.push(() => r.close());
    return r;
  }
  function raw() {
    const db = new Database(path);
    cleanup.push(() => {
      if (db.open) db.close();
    });
    return db;
  }
  return {
    root,
    path,
    migrationPath,
    articles,
    service,
    assets,
    input,
    open,
    raw,
  };
}
it('upgrades v2 with real imported assets, preserves checksums and reopens without replay', async () => {
  const s = await setup(true);
  const input = await s.input();
  const db = s.raw();
  const history = db.prepare('SELECT * FROM schema_migrations').all();
  const r = s.open();
  expect(r.reserve(input).status).toBe('created');
  r.close();
  s.open();
  expect(
    db.prepare('SELECT * FROM schema_migrations').all().slice(0, 2),
  ).toEqual(history);
  expect(s.articles.getSchemaVersion()).toBe(15);
  expect(s.articles.load(input.snapshot.article.articleKey)).toEqual(
    input.snapshot.article,
  );
  expect(await s.service.recover()).toBe(true);
  expect(await s.service.load(input.snapshot.article.articleKey)).toEqual(
    input.snapshot.article,
  );
  db.pragma('foreign_keys=ON');
  expect(() =>
    db
      .prepare('DELETE FROM articles WHERE article_key=?')
      .run(input.snapshot.article.articleKey),
  ).toThrow();
});
it('upgrades an existing v3 draft ledger for manual cover after save', async () => {
  const s = await setup(true);
  const input = await s.input();
  copyFileSync(
    join(migrations, '0003_judongche_draft_tasks.sql'),
    join(s.migrationPath, '0003_judongche_draft_tasks.sql'),
  );
  const old = openDraftTaskRepository(s.path, s.migrationPath);
  old.close();
  const current = s.open();
  expect(current.reserve(input).status).toBe('created');
  expect(s.articles.getSchemaVersion()).toBe(15);
});
it('migration 0005 preserves every v4 task field and snapshot with no closure inferred', async () => {
  const s = await setup(true);
  const input = await s.input();
  const db = s.raw();
  migrate(db, readMigrations(migrations).slice(0, 4));
  db.prepare(
    `INSERT INTO judongche_draft_tasks
    (task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,
    cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,
    evidence_json,reason,created_at,updated_at)
    VALUES(?,?,?,'judongche','draft',?,?,?,?,'manual-after-draft','needs_human','settled',3,1,0,0,1,?,'PAGE_CHANGED',?,?)`,
  ).run(
    input.taskId,
    input.preparationId,
    input.snapshot.article.articleKey,
    input.store.storeKey,
    JSON.stringify(input.store),
    JSON.stringify(input.snapshot),
    input.snapshot.digest,
    JSON.stringify({ remote: null, images: [], cover: null }),
    input.now,
    input.now,
  );
  const rows = db.prepare('SELECT * FROM judongche_draft_tasks').all();
  const history = db.prepare('SELECT * FROM schema_migrations').all();
  const repository = s.open();
  expect(db.prepare('SELECT * FROM judongche_draft_tasks').all()).toEqual(
    rows.map((row) => ({
      ...(row as Record<string, unknown>),
      cover_plan_version: 0,
      article_revision: null,
    })),
  );
  expect(
    db.prepare('SELECT * FROM schema_migrations').all().slice(0, 4),
  ).toEqual(history);
  expect(db.prepare('SELECT * FROM judongche_task_closures').all()).toEqual([]);
  expect(repository.occupied()).toMatchObject({
    taskId: input.taskId,
    saveAttempted: false,
    possibleRemoteEffect: true,
  });
});
it('retains v2 and its article when a v3 migration fails', async () => {
  const s = await setup(true);
  const input = await s.input();
  writeFileSync(
    join(s.migrationPath, '0003_failure.sql'),
    'CREATE TABLE doomed (id TEXT); SELECT * FROM missing;',
  );
  expect(() => openDraftTaskRepository(s.path, s.migrationPath)).toThrow();
  expect(s.articles.getSchemaVersion()).toBe(2);
  expect(s.articles.load(input.snapshot.article.articleKey)).toEqual(
    input.snapshot.article,
  );
});
it('retains preparation idempotency and blocks independent attempts until safe settlement', async () => {
  const s = await setup();
  const a = await s.input();
  const b = await s.input();
  const r = s.open();
  expect(r.reserve(a).status).toBe('created');
  s.articles.setArticleDeclarations!({
    targets: [
      {
        articleKey: a.snapshot.article.articleKey,
        expectedDeclaration: 'repost',
      },
    ],
    declaration: 'original',
  });
  const again = {
    ...a,
    taskId: randomUUID(),
    preparationId: randomUUID(),
    snapshot: snapshot(s.articles.load(a.snapshot.article.articleKey)!),
    expectedArticleRevision: s.articles.loadEditableArticle(
      a.snapshot.article.articleKey,
    )!.articleRevision,
  };
  expect(r.reserve(again)).toMatchObject({
    status: 'blocked',
    task: { taskId: a.taskId },
  });
  expect(r.findPreparation(a.preparationId)?.taskId).toBe(a.taskId);
  expect(
    r.findIdentity(a.snapshot.article.articleKey, a.store.storeKey)?.taskId,
  ).toBe(a.taskId);
  expect(r.reserve(b).status).toBe('blocked');
  r.apply(
    a.taskId,
    0,
    { type: 'settle', state: 'failed', reason: 'INPUT_UNSUPPORTED' },
    a.now,
  );
  expect(r.reserve(b).status).toBe('created');
  expect(r.reserve(again).status).toBe('blocked');
  expect(r.reserve(a)).toMatchObject({
    status: 'existing',
    task: { taskId: a.taskId },
  });
  expect(r.latest()).toBeDefined();
});
it('rejects a captured snapshot after F06 changes the persisted declaration', async () => {
  const s = await setup();
  const input = await s.input();
  expect(input.snapshot.article.contentDeclaration).toBe('repost');
  expect(
    s.articles.setArticleDeclarations!({
      targets: [
        {
          articleKey: input.snapshot.article.articleKey,
          expectedDeclaration: 'repost',
        },
      ],
      declaration: 'original',
    }).status,
  ).toBe('updated');
  expect(s.open().reserve(input)).toEqual({ status: 'stale' });
});
it('rejects changed preparation, forged digest, revision conflict, lock and failed checkpoint without granting permission', async () => {
  const s = await setup();
  const a = await s.input();
  const r = s.open();
  const changed = {
    ...a,
    snapshot: snapshot({ ...a.snapshot.article, title: 'Changed' }),
  };
  expect(r.reserve(changed).status).toBe('stale');
  expect(() =>
    r.reserve({ ...a, snapshot: { ...a.snapshot, digest: '0'.repeat(64) } }),
  ).toThrow();
  const db = s.raw();
  db.exec('BEGIN IMMEDIATE');
  expect(() => r.reserve(a)).toThrow();
  db.exec('ROLLBACK');
  expect(r.reserve(a).status).toBe('created');
  r.apply(a.taskId, 0, { type: 'begin' }, a.now);
  expect(() =>
    r.apply(a.taskId, 0, { type: 'before-effect', stage: 'editor' }, a.now),
  ).toThrow();
  db.exec(
    "CREATE TRIGGER refuse_checkpoint BEFORE UPDATE ON judongche_draft_tasks BEGIN SELECT RAISE(ABORT,'denied'); END;",
  );
  expect(() =>
    r.apply(a.taskId, 1, { type: 'before-effect', stage: 'editor' }, a.now),
  ).toThrow();
  expect(r.get(a.taskId)).toMatchObject({
    revision: 1,
    possibleRemoteEffect: false,
  });
});
it('two repository connections grant just one reservation and recovery retains occupancy', async () => {
  const s = await setup();
  const a = await s.input();
  const r = s.open();
  const other = s.open();
  expect(r.reserve(a).status).toBe('created');
  expect(
    other.reserve({ ...a, taskId: randomUUID(), preparationId: randomUUID() })
      .status,
  ).toBe('blocked');
  other.recover(a.now);
  expect(r.get(a.taskId)?.state).toBe('interrupted');
  expect(r.occupied()?.taskId).toBe(a.taskId);
  const revision = r.get(a.taskId)!.revision;
  other.recover(a.now);
  expect(r.get(a.taskId)?.revision).toBe(revision);
});
it.each(['editor', 'save'])(
  'retains the %s checkpoint after abnormal child exit, recovering only interrupted',
  async (stage) => {
    const s = await setup();
    const a = await s.input();
    const r = s.open();
    r.reserve(a);
    r.close();
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('tests/integration/draft-crash-child.ts'),
        s.path,
        migrations,
        a.taskId,
        a.now,
        stage,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(77);
    const reopened = s.open();
    reopened.recover(a.now);
    expect(reopened.get(a.taskId)).toMatchObject({
      state: 'interrupted',
      possibleRemoteEffect: true,
      saveAttempted: stage === 'save',
      holdsPlatform: true,
    });
  },
);
it.each([
  "snapshot_json='broken'",
  "store_key='other'",
  "snapshot_digest='wrong'",
])('fails initialization closed on corruption: %s', async (mutation) => {
  const s = await setup();
  const a = await s.input();
  const r = s.open();
  r.reserve(a);
  r.close();
  const db = s.raw();
  db.pragma('ignore_check_constraints=ON');
  db.exec(`UPDATE judongche_draft_tasks SET ${mutation}`);
  expect(() => s.open()).toThrow();
});

it('verified settlement permits a distinct attempt without replaying the saved task', async () => {
  const s = await setup();
  const a = await s.input();
  const b = await s.input();
  const r = s.open();
  r.reserve(a);
  r.apply(a.taskId, 0, { type: 'begin' }, a.now);
  r.apply(a.taskId, 1, { type: 'before-save' }, a.now);
  r.apply(
    a.taskId,
    2,
    {
      type: 'evidence',
      evidence: {
        remote: {
          recordKey: 'synthetic-record',
          editUrl: 'https://example.test/draft/1',
        },
        cover: { source: 'store-material-first', resourceKey: 'b'.repeat(64) },
        images: [
          {
            bodyIndex: 1,
            imageId: 'i',
            assetKey: a.snapshot.article.assets[0].assetKey,
            resourceKey: 'c'.repeat(64),
          },
        ],
      },
    },
    a.now,
  );
  r.apply(a.taskId, 3, { type: 'verify' }, a.now);
  r.apply(
    a.taskId,
    4,
    { type: 'settle', state: 'draft_saved', reason: null },
    a.now,
  );
  expect(r.occupied()).toBeUndefined();
  const saved = r.get(a.taskId);
  expect(r.reserve(a)).toMatchObject({ status: 'existing', task: saved });
  const next = { ...a, taskId: randomUUID(), preparationId: randomUUID() };
  expect(r.reserve(next)).toMatchObject({
    status: 'created',
    task: { taskId: next.taskId },
  });
  expect(r.reserve(b).status).toBe('blocked');
  expect(r.get(a.taskId)).toEqual(saved);
  expect(() => r.apply(a.taskId, 5, { type: 'begin' }, a.now)).toThrow();
});
it('import recovery refuses cleanup of a committed article retained by a draft task', async () => {
  const s = await setup();
  const a = await s.input();
  s.open().reserve(a);
  const article = a.snapshot.article;
  s.raw()
    .prepare(
      'INSERT INTO article_import_attempts (import_id,article_key,external_id,started_at,status) VALUES (?,?,?,?,?)',
    )
    .run(
      article.importId,
      article.articleKey,
      article.externalId,
      article.createdAt,
      'preparing',
    );
  expect(await s.service.recover()).toBe(false);
  expect(s.articles.attempts()[0].status).toBe('needs_review');
  await expect(s.assets.verify(article)).resolves.toBeUndefined();
});
it.each([1, 2])(
  'competing child connections serialize V%s reservation and return only one created permission',
  async (version) => {
    const s = await setup();
    const a = await s.input();
    if (version === 2) {
      const article = a.snapshot.article,
        editorBody = upgradeEditorBody(null, article.body);
      a.snapshot = {
        version: 2,
        article,
        editorBody,
        digest: createDraftSnapshotV2Digest(article, editorBody),
      };
    }
    const file = join(s.root, 'reserve.json');
    writeFileSync(file, JSON.stringify(a));
    function contender() {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('tests/integration/draft-crash-child.ts'),
          s.path,
          migrations,
          a.taskId,
          a.now,
          'race',
          file,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      let errors = '';
      const ready = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('ready')) resolve();
        });
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      const done = new Promise<string>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve(output) : reject(new Error(errors)),
        );
      });
      return { child, ready, done };
    }
    const first = contender();
    const second = contender();
    await Promise.all([first.ready, second.ready]);
    first.child.stdin.end('go');
    second.child.stdin.end('go');
    const results = await Promise.all([first.done, second.done]);
    expect(results.filter((output) => output.includes('created'))).toHaveLength(
      1,
    );
    expect(results.filter((output) => output.includes('blocked'))).toHaveLength(
      1,
    );
    expect(s.open().occupied()?.snapshot.article.articleKey).toBe(
      a.snapshot.article.articleKey,
    );
  },
);

it.each([3, 4])(
  'schema %s preserves saved and ambiguous tasks plus article assets through v5 recovery',
  async (version) => {
    const s = await setup(true);
    const saved = await s.input();
    const unknown = await s.input();
    const db = s.raw();
    migrate(db, readMigrations(migrations).slice(0, version));
    const insert = db.prepare(
      "INSERT INTO judongche_draft_tasks (task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,reason,created_at,updated_at) VALUES (?,?,?,'judongche','draft',?,?,?,?,?,?,'settled',3,1,1,0,?,?,?, ?,?)",
    );
    for (const [input, state, hold] of [
      [saved, 'draft_saved', 0],
      [unknown, 'needs_human', 1],
    ] as const) {
      insert.run(
        input.taskId,
        input.preparationId,
        input.snapshot.article.articleKey,
        input.store.storeKey,
        JSON.stringify(input.store),
        JSON.stringify(input.snapshot),
        input.snapshot.digest,
        version === 3 ? 'store-material-first' : 'manual-after-draft',
        state,
        hold,
        JSON.stringify({
          remote: {
            recordKey: 'offline-record',
            editUrl: 'https://example.test/edit/offline-record',
          },
          images: [
            {
              bodyIndex: 1,
              imageId: 'i',
              assetKey: input.snapshot.article.assets[0].assetKey,
              resourceKey: 'b'.repeat(64),
            },
          ],
          cover:
            version === 3
              ? { resourceKey: 'a'.repeat(64), source: 'store-material-first' }
              : null,
        }),
        hold ? 'RESULT_AMBIGUOUS' : null,
        input.now,
        input.now,
      );
    }
    const before = db
      .prepare('SELECT * FROM judongche_draft_tasks ORDER BY task_id')
      .all();
    const repo = s.open();
    repo.recover(saved.now);
    expect(s.articles.getSchemaVersion()).toBe(15);
    expect(
      db.prepare('SELECT * FROM judongche_draft_tasks ORDER BY task_id').all(),
    ).toEqual(
      before.map((row) => ({
        ...(row as Record<string, unknown>),
        cover_plan_version: 0,
        article_revision: null,
      })),
    );
    expect(repo.get(saved.taskId)).toMatchObject({
      state: 'draft_saved',
      articleRevision: null,
    });
    expect(repo.occupied()?.taskId).toBe(unknown.taskId);
    expect(
      repo.reserve({
        ...saved,
        taskId: randomUUID(),
        preparationId: randomUUID(),
      }).status,
    ).toBe('blocked');
    for (const input of [saved, unknown]) {
      expect(await s.service.load(input.snapshot.article.articleKey)).toEqual(
        input.snapshot.article,
      );
    }
    repo.close();
    expect(s.open().occupied()?.taskId).toBe(unknown.taskId);
  },
);
it('reviewed attempted-save closure is durable and permits a distinct confirmed attempt', async () => {
  const s = await setup();
  const input = await s.input();
  const repo = s.open();
  repo.reserve(input);
  let task = repo.apply(input.taskId, 0, { type: 'begin' }, input.now);
  task = repo.apply(
    task.taskId,
    task.revision,
    { type: 'before-save' },
    input.now,
  );
  task = repo.apply(
    task.taskId,
    task.revision,
    { type: 'settle', state: 'needs_human', reason: 'RESULT_AMBIGUOUS' },
    input.now,
  );
  const event = {
    type: 'close-after-review' as const,
    proof: {
      taskId: task.taskId,
      revision: task.revision,
      snapshotDigest: task.snapshot.digest,
      storeKey: task.store.storeKey,
      generation: 'fixture',
      checkedAt: input.now,
      basis: 'owner-reviewed-ambiguous-save' as const,
    },
    confirmedAt: input.now,
  };
  repo.apply(task.taskId, task.revision, event, input.now);
  expect(repo.occupied()).toBeUndefined();
  expect(repo.findIdentity(task.articleKey, task.store.storeKey)?.taskId).toBe(
    task.taskId,
  );
  expect(
    repo.reserve({
      ...input,
      taskId: randomUUID(),
      preparationId: randomUUID(),
    }),
  ).toMatchObject({ status: 'created' });
  repo.close();
  const reopened = s.open();
  expect(reopened.get(task.taskId)).toMatchObject({
    state: 'closed_after_review',
    saveAttempted: true,
    possibleRemoteEffect: true,
    evidence: task.evidence,
    snapshot: task.snapshot,
    reason: task.reason,
  });
});

it('reviewed unsaved body images persist through closure without a schema change or evidence loss', async () => {
  const s = await setup();
  const input = await s.input();
  const repo = s.open();
  repo.reserve(input);
  let task = repo.apply(input.taskId, 0, { type: 'begin' }, input.now);
  task = repo.apply(
    task.taskId,
    task.revision,
    { type: 'before-effect', stage: 'body' },
    input.now,
  );
  task = repo.apply(
    task.taskId,
    task.revision,
    {
      type: 'evidence',
      evidence: {
        remote: null,
        cover: null,
        images: [
          {
            bodyIndex: 1,
            imageId: 'i',
            assetKey: task.snapshot.article.assets[0].assetKey,
            resourceKey: 'a'.repeat(64),
          },
        ],
      },
    },
    input.now,
  );
  task = repo.apply(
    task.taskId,
    task.revision,
    { type: 'settle', state: 'needs_human', reason: 'PAGE_CHANGED' },
    input.now,
  );
  const proof = {
    taskId: task.taskId,
    revision: task.revision,
    snapshotDigest: task.snapshot.digest,
    storeKey: task.store.storeKey,
    generation: 'fixture',
    checkedAt: input.now,
  };
  expect(() =>
    repo.apply(
      task.taskId,
      task.revision,
      { type: 'close-without-save', proof, confirmedAt: input.now },
      input.now,
    ),
  ).toThrow();
  repo.apply(
    task.taskId,
    task.revision,
    {
      type: 'close-without-save',
      proof: { ...proof, basis: 'owner-reviewed-unsaved-body' },
      confirmedAt: input.now,
    },
    input.now,
  );
  repo.close();
  expect(s.open().get(task.taskId)).toMatchObject({
    state: 'closed_without_save',
    saveAttempted: false,
    evidence: task.evidence,
    snapshot: task.snapshot,
    reason: task.reason,
    possibleRemoteEffect: true,
    holdsPlatform: false,
  });
});

it('safe failure permits a fresh attempt but preserves preparation and frozen-version protection', async () => {
  const s = await setup();
  const input = await s.input();
  const repo = s.open();
  repo.reserve(input);
  const old = repo.apply(
    input.taskId,
    0,
    { type: 'settle', state: 'failed', reason: 'INPUT_UNSUPPORTED' },
    input.now,
  );
  expect(old.holdsPlatform).toBe(false);
  expect(repo.reserve({ ...input, taskId: randomUUID() })).toEqual({
    status: 'existing',
    task: old,
  });
  expect(repo.reserve({ ...input, preparationId: randomUUID() })).toEqual({
    status: 'existing',
    task: old,
  });
  const next = { ...input, taskId: randomUUID(), preparationId: randomUUID() };
  expect(
    repo.reserve({
      ...next,
      expectedArticleRevision: input.expectedArticleRevision + 1,
    }),
  ).toEqual({ status: 'stale' });
  expect(() =>
    repo.reserve({
      ...next,
      snapshot: { ...next.snapshot, digest: '0'.repeat(64) },
    }),
  ).toThrow();
  expect(repo.reserve(next)).toMatchObject({
    status: 'created',
    task: {
      taskId: next.taskId,
      articleRevision: input.expectedArticleRevision,
    },
  });
  expect(repo.get(input.taskId)).toEqual(old);
  repo.close();
  const reopened = s.open();
  expect(reopened.get(next.taskId)?.articleRevision).toBe(
    input.expectedArticleRevision,
  );
  expect(reopened.reserve({ ...input, taskId: randomUUID() })).toEqual({
    status: 'existing',
    task: old,
  });
  expect(
    reopened.reserve({
      ...next,
      taskId: randomUUID(),
      preparationId: randomUUID(),
    }),
  ).toMatchObject({ status: 'blocked', task: { taskId: next.taskId } });
});

it('latest identity includes closed and stopped history and deterministically orders equal timestamps', async () => {
  const s = await setup();
  const input = await s.input();
  const repo = s.open();
  const first = repo.reserve(input);
  expect(first.status).toBe('created');
  repo.apply(
    input.taskId,
    0,
    { type: 'settle', state: 'failed', reason: 'INPUT_UNSUPPORTED' },
    input.now,
  );
  const second = {
    ...input,
    taskId: randomUUID(),
    preparationId: randomUUID(),
    now: '2026-10-18T02:00:00.000Z',
  };
  expect(repo.reserve(second).status).toBe('created');
  repo.apply(
    second.taskId,
    0,
    { type: 'settle', state: 'failed', reason: 'INPUT_UNSUPPORTED' },
    second.now,
  );
  const third = {
    ...second,
    taskId: randomUUID(),
    preparationId: randomUUID(),
  };
  expect(repo.reserve(third).status).toBe('created');
  repo.apply(third.taskId, 0, { type: 'stop' }, third.now);
  repo.apply(
    third.taskId,
    1,
    { type: 'settle', state: 'stopped', reason: 'STOP_REQUESTED' },
    third.now,
  );
  expect(
    repo.findLatestIdentity(
      input.snapshot.article.articleKey,
      input.store.storeKey,
    )?.taskId,
  ).toBe(third.taskId);
  expect(
    repo.findLatestIdentity(input.snapshot.article.articleKey, 'other-store'),
  ).toBeUndefined();
  const fourth = {
    ...input,
    taskId: randomUUID(),
    preparationId: randomUUID(),
    now: '2026-10-17T02:00:00.000Z',
  };
  expect(repo.reserve(fourth).status).toBe('created');
  expect(
    repo.findLatestIdentity(
      input.snapshot.article.articleKey,
      input.store.storeKey,
    )?.taskId,
  ).toBe(third.taskId);
});
