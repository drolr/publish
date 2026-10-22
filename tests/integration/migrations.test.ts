import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openBaselineStore } from '../../src/infrastructure/persistence/database';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import {
  seedLegacyStoredArticle,
  inspectLibraryMigrationState,
  executeImportSql,
  inspectImportDb,
} from '../../src/infrastructure/persistence/testing/article-fixtures';
import type { StoredArticle } from '../../src/contracts/stored-article';
import {
  inspectDatabase,
  corruptHistory,
  seedFutureDatabase,
  upgradeSql,
  failingSql,
} from '../../src/infrastructure/persistence/testing/fixtures';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'draft-baseline-'));
  roots.push(root);
  const migrations = join(root, 'migrations');
  mkdirSync(migrations);
  writeFileSync(join(migrations, '0001_baseline.sql'), 'SELECT 1;\n');
  return { root, migrations, db: join(root, 'app.sqlite') };
}
it('initializes and reopens the approved schema without duplicate migrations', () => {
  const { db } = setup();
  const migrations = resolve('src/infrastructure/persistence/migrations');
  let store = openBaselineStore(db, migrations);
  const firstVersion = store.getSchemaVersion();
  store.close();
  store = openBaselineStore(db, migrations);
  const secondVersion = store.getSchemaVersion();
  store.close();
  expect(firstVersion).toBe(14);
  expect(secondVersion).toBe(14);
  expect(inspectDatabase(db)).toEqual({
    versions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    tables: [
      'article_assets',
      'article_cover_heads',
      'article_cover_operations',
      'article_cover_versions',
      'article_delete_operations',
      'article_edit_operations',
      'article_import_attempts',
      'article_library_meta',
      'articles',
      'draft_batch_items',
      'draft_batches',
      'judongche_draft_tasks',
      'judongche_task_closures',
      'judongche_task_covers',
      'schema_migrations',
    ],
  });
});
it.each([2, 6, 7])(
  'schema%s_to_8 preserves article identity, original image hash and task rows on repeated startup',
  (version) => {
    const { root, db } = setup();
    const migrations = resolve('src/infrastructure/persistence/migrations');
    const old = join(root, 'old');
    mkdirSync(old);
    for (const name of readdirSync(migrations).sort().slice(0, version))
      copyFileSync(join(migrations, name), join(old, name));
    openBaselineStore(db, old).close();
    const articleKey = randomUUID();
    const assetKey = randomUUID();
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJbkAAAAASUVORK5CYII=',
      'base64',
    );
    const hash = (content: Uint8Array) =>
      createHash('sha256').update(content).digest('hex');
    mkdirSync(join(root, articleKey));
    const image = join(root, articleKey, `${assetKey}.png`);
    writeFileSync(image, bytes);
    const article: StoredArticle = {
      articleKey,
      importId: randomUUID(),
      externalId: 'legacy',
      title: '原文章',
      body: [
        { type: 'paragraph', text: '原正文' },
        { type: 'image', image_id: 'front' },
      ],
      contentDeclaration: 'repost',
      createdAt: '2026-10-09T00:00:00.000Z',
      assets: [
        {
          assetKey,
          imageId: 'front',
          relativePath: `${articleKey}/${assetKey}.png`,
          mime: 'image/png',
          byteSize: bytes.length,
          width: 1,
          height: 1,
          sha256: hash(bytes),
        },
      ],
    };
    seedLegacyStoredArticle(db, article);
    if (version >= 6)
      executeImportSql(
        db,
        `INSERT INTO judongche_draft_tasks (task_id, preparation_id, article_key, platform, mode, store_key, store_json, snapshot_json, snapshot_digest, cover_policy, state, stage, revision, possible_remote_effect, save_attempted, stop_requested, holds_platform, evidence_json, created_at, updated_at) SELECT 'legacy-task', 'legacy-preparation', article_key, 'judongche', 'draft', 'legacy-store', '{}', '{}', 'digest', 'store-material-first', 'draft_saved', 'settled', 1, 1, 1, 0, 0, '[]', created_at, created_at FROM articles`,
      );
    if (version >= 6)
      executeImportSql(
        db,
        `INSERT INTO judongche_draft_tasks (task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,created_at,updated_at) SELECT 'closed-history','closed-prep',article_key,'judongche','draft','legacy-store','{}','{}','digest','manual-after-draft','closed_without_save','settled',2,0,0,0,0,'[]',created_at,created_at FROM articles; INSERT INTO judongche_task_closures (task_id,prior_revision,prior_state,prior_stage,prior_reason,event_json,closed_at) VALUES ('closed-history',1,'needs_human','settled','RESULT_AMBIGUOUS','{"type":"manual_close"}','2026-10-09T00:00:00.000Z');`,
      );
    const before = inspectLibraryMigrationState(db);
    const historyBefore = inspectImportDb(db).history;
    for (let start = 0; start < 2; start++) {
      const store = openArticleRepository(db, migrations);
      try {
        expect(store.getSchemaVersion()).toBe(14);
        expect(store.loadEditableArticle(articleKey)).toEqual({
          article,
          articleRevision: 1,
          editorBody: null,
        });
        expect(store.list!()).toMatchObject({
          status: 'ok',
          page: {
            totalCount: 1,
            membershipRevision: 0,
            pageNumber: 1,
            totalPages: 1,
          },
        });
      } finally {
        store.close();
      }
      const after = inspectLibraryMigrationState(db);
      expect({
        ...after,
        tasks: after.tasks.map((row) => {
          const { cover_plan_version, article_revision, ...old } =
            row as Record<string, unknown>;
          expect(article_revision).toBeNull();
          expect(cover_plan_version).toBe(0);
          return old;
        }),
      }).toEqual({
        ...before,
        tasks: before.tasks.map((row) => {
          const old = { ...(row as Record<string, unknown>) };
          delete old.cover_plan_version;
          return old;
        }),
      });
      expect(inspectImportDb(db).history.slice(0, version)).toEqual(
        historyBefore,
      );
      expect(inspectDatabase(db).tables).toContain('judongche_task_closures');
      expect(hash(readFileSync(image))).toBe(hash(bytes));
      expect(inspectDatabase(db).versions).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
      ]);
    }
  },
);
it('upgrades a previous supported schema and never replays it', () => {
  const { db, migrations } = setup();
  openBaselineStore(db, migrations).close();
  writeFileSync(join(migrations, '0002_test.sql'), upgradeSql);
  const store = openBaselineStore(db, migrations);
  expect(store.getSchemaVersion()).toBe(2);
  store.close();
  openBaselineStore(db, migrations).close();
  expect(inspectDatabase(db).versions).toEqual([1, 2]);
});
it('rolls back a failing migration while preserving the prior database', () => {
  const { db, migrations } = setup();
  openBaselineStore(db, migrations).close();
  writeFileSync(join(migrations, '0002_test.sql'), failingSql);
  expect(() => openBaselineStore(db, migrations)).toThrow();
  expect(inspectDatabase(db)).toEqual({
    versions: [1],
    tables: ['schema_migrations'],
  });
});
it('refuses modified migration history and releases the failed connection', () => {
  const { db, migrations } = setup();
  openBaselineStore(db, migrations).close();
  corruptHistory(db);
  expect(() => openBaselineStore(db, migrations)).toThrow(/history/i);
  expect(inspectDatabase(db).versions).toEqual([1]);
});
it('refuses a newer database without changing it', () => {
  const { db, migrations } = setup();
  openBaselineStore(db, migrations).close();
  seedFutureDatabase(db);
  expect(() => openBaselineStore(db, migrations)).toThrow(/newer/i);
  expect(inspectDatabase(db).versions).toEqual([1, 2]);
});
it.each(['0003_gap.sql', '0001_duplicate.sql'])(
  'rejects invalid migration ordering: %s',
  (name) => {
    const { db, migrations } = setup();
    writeFileSync(join(migrations, name), 'SELECT 1;');
    expect(() => openBaselineStore(db, migrations)).toThrow(/sequence/i);
  },
);
