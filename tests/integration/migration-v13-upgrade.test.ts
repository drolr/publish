import Database from 'better-sqlite3';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { STORAGE_SCHEMA_VERSION } from '../../src/contracts/storage-version';
import { openBaselineStore } from '../../src/infrastructure/persistence/database';
import { readMigrations } from '../../src/infrastructure/persistence/migrate';

const directory = resolve('src/infrastructure/persistence/migrations');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function query<T>(dbPath: string, sql: string): T[] {
  const db = new Database(dbPath);
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}
function exec(dbPath: string, sql: string) {
  const db = new Database(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
function pragma(dbPath: string, name: string) {
  const db = new Database(dbPath);
  try {
    return db.pragma(name);
  } finally {
    db.close();
  }
}
function snapshot(dbPath: string, tables: string[]) {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      query(dbPath, 'SELECT * FROM ' + table + ' ORDER BY 1'),
    ]),
  );
}
function seedV13(dbPath: string) {
  exec(
    dbPath,
    `INSERT INTO articles(article_key,external_id,import_id,title,body_json,content_declaration,created_at)
     VALUES('a1','ext-1','imp-1','历史文章','[{"type":"paragraph","text":"正文"}]','repost','2026-11-01T00:00:00.000Z');
     INSERT INTO article_assets VALUES('asset-1','a1','front','a1/asset-1.png','image/png',16,2,2,'asset-digest');
     INSERT INTO article_cover_versions VALUES('a1',1,'triple','[{"assetKey":"asset-1"}]','cover-digest','cover-op-1','2026-11-01T00:01:00.000Z');
     INSERT INTO article_cover_heads VALUES('a1',1);
     INSERT INTO article_cover_operations(operation_id,article_key,session_id,expected_article_revision,expected_cover_revision,draft_revision,requested_mode,payload_digest,status,owned_files_json,committed_cover_revision,started_at,committed_at,cleanup_complete)
     VALUES('cover-op-1','a1','session-1',1,0,1,'triple','payload-digest','committed','[]',1,'2026-11-01T00:00:00.000Z','2026-11-01T00:01:00.000Z',1);
     INSERT INTO judongche_draft_tasks(task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,reason,created_at,updated_at,cover_plan_version)
     VALUES('task-saved','prep-saved','a1','judongche','draft','store-1','{}','{}','digest-1','manual-after-draft','draft_saved','settled',3,1,1,0,0,'{"remote":{"recordKey":"record-1"}}',NULL,'2026-11-01T00:00:00.000Z','2026-11-01T00:02:00.000Z',1);
     INSERT INTO judongche_draft_tasks(task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,reason,created_at,updated_at,cover_plan_version)
     VALUES('task-closed','prep-closed','a1','judongche','draft','store-0','{}','{}','digest-0','store-material-first','closed_without_save','settled',4,1,0,0,0,'[]','RESULT_AMBIGUOUS','2026-11-01T00:00:00.000Z','2026-11-01T00:03:00.000Z',0);
     INSERT INTO judongche_task_closures VALUES('task-closed',3,'needs_human','body','PAGE_CHANGED','{"type":"manual_close"}','2026-11-01T00:03:00.000Z',NULL);
     INSERT INTO judongche_task_covers VALUES('task-saved','local-upload-v1','{"cover":"snapshot"}','cover-digest','{"phase":"ok"}');
     INSERT INTO draft_batches(id,request_id,platform,store_key,store_name,seed_json,state,revision,stop_requested,reason,created_at,updated_at,archived_at)
     VALUES('batch-1','request-1','judongche','store-1','示例门店','{}','completed',2,0,NULL,'2026-11-01T00:00:00.000Z','2026-11-01T00:04:00.000Z',NULL);
     INSERT INTO draft_batches(id,request_id,platform,store_key,store_name,seed_json,state,revision,stop_requested,reason,created_at,updated_at,archived_at)
     VALUES('batch-2','request-2','judongche','store-1','示例门店','{}','completed',1,0,'ARCHIVED','2026-11-01T00:00:00.000Z','2026-11-02T00:00:00.000Z','2026-11-02T00:00:00.000Z');
     INSERT INTO draft_batch_items VALUES('batch-1',0,'a1','{"ordinal":0}','{"reserved":true}','task-saved','draft_saved',NULL,'2026-11-01T00:04:00.000Z');
     INSERT INTO draft_batch_items VALUES('batch-2',0,'a1','{"ordinal":0}',NULL,NULL,'skipped','ARCHIVED','2026-11-02T00:00:00.000Z');`,
  );
}
it('upgrades a real v13 database file to the current schema preserving cover, batch and task history', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-v13-'));
  roots.push(root);
  const previous = join(root, 'previous');
  mkdirSync(previous);
  for (const name of readdirSync(directory).sort().slice(0, 13))
    copyFileSync(join(directory, name), join(previous, name));
  const dbPath = join(root, 'app.sqlite');
  const store = openBaselineStore(dbPath, previous);
  expect(store.getSchemaVersion()).toBe(13);
  store.close();
  seedV13(dbPath);
  const tables = [
    'articles',
    'article_assets',
    'article_cover_versions',
    'article_cover_heads',
    'article_cover_operations',
    'judongche_draft_tasks',
    'judongche_task_covers',
    'judongche_task_closures',
    'draft_batches',
    'draft_batch_items',
  ];
  const before = snapshot(dbPath, tables);
  const historyBefore = query<{
    version: number;
    name: string;
    checksum: string;
  }>(
    dbPath,
    'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
  );
  expect(historyBefore).toHaveLength(13);
  const upgraded = openBaselineStore(dbPath, directory);
  expect(upgraded.getSchemaVersion()).toBe(STORAGE_SCHEMA_VERSION);
  upgraded.close();
  const migrations = readMigrations(directory);
  const history = query<{
    version: number;
    name: string;
    checksum: string;
  }>(
    dbPath,
    'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
  );
  expect(history).toHaveLength(migrations.length);
  expect(history.slice(0, 13)).toEqual(historyBefore);
  expect(history.slice(13)).toEqual(
    migrations.slice(13).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum,
    })),
  );
  expect(history.every((row) => /^[0-9a-f]{64}$/.test(row.checksum))).toBe(
    true,
  );
  expect(snapshot(dbPath, tables)).toEqual({
    ...before,
    judongche_draft_tasks: before.judongche_draft_tasks.map((row) => ({
      ...(row as Record<string, unknown>),
      article_revision: null,
    })),
  });
  expect(
    query<{ name: string }>(
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('judongche_draft_attempt_history','judongche_one_unclosed_identity') ORDER BY name",
    ),
  ).toEqual([{ name: 'judongche_draft_attempt_history' }]);
  expect(pragma(dbPath, 'foreign_key_check')).toEqual([]);
  expect(pragma(dbPath, 'integrity_check')).toEqual([
    { integrity_check: 'ok' },
  ]);
  expect(() =>
    exec(
      dbPath,
      "UPDATE judongche_draft_tasks SET article_revision=0 WHERE task_id='task-saved'",
    ),
  ).toThrow(/CHECK/);
  exec(
    dbPath,
    "UPDATE judongche_draft_tasks SET article_revision=7 WHERE task_id='task-saved'",
  );
  expect(
    query(
      dbPath,
      "SELECT article_revision FROM judongche_draft_tasks WHERE task_id='task-saved'",
    ),
  ).toEqual([{ article_revision: 7 }]);
  openBaselineStore(dbPath, directory).close();
  expect(
    query(
      dbPath,
      "SELECT article_revision FROM judongche_draft_tasks WHERE task_id='task-saved'",
    ),
  ).toEqual([{ article_revision: 7 }]);
});
