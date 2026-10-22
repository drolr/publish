// Valid synthetic schema6 rows captured before deletion; no production downgrade is involved.
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  migrate,
  readMigrations,
} from '../../src/infrastructure/persistence/migrate';
import { logicalSnapshot } from './library-historical-data';
function quoted(value: string) {
  assert.match(value, /^[a-zA-Z0-9_]+$/);
  return `"${value}"`;
}
export function captureSchema6Tables(path: string) {
  const current = logicalSnapshot(path);
  const old = Object.fromEntries(
    Object.entries(current)
      .filter(
        ([name]) =>
          ![
            'article_library_meta',
            'article_delete_operations',
            'article_cover_heads',
            'article_cover_versions',
            'article_cover_operations',
            'judongche_task_covers',
            'draft_batch_items',
            'draft_batches',
          ].includes(name),
      )
      .map(([name, table]) => [
        name,
        {
          columns: table.columns.filter(
            (column) =>
              (name !== 'articles' || column !== 'deleted_at') &&
              (name !== 'judongche_draft_tasks' ||
                !['cover_plan_version', 'article_revision'].includes(column)),
          ),
          rows: [],
        },
      ]),
  ) as ReturnType<typeof logicalSnapshot>;
  return logicalSnapshot(path, old);
}
export function createSchema6Fixture(
  path: string,
  tables: ReturnType<typeof logicalSnapshot>,
) {
  assert.equal(
    existsSync(path),
    false,
    'Synthetic legacy fixture must use a fresh owned database',
  );
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    migrate(
      db,
      readMigrations(
        resolve('src/infrastructure/persistence/migrations'),
      ).slice(0, 6),
    );
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      db.prepare('DELETE FROM schema_migrations').run();
      for (const [name, table] of Object.entries(tables)) {
        const insert = db.prepare(
          `INSERT INTO ${quoted(name)} (${table.columns.map(quoted).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`,
        );
        for (const row of table.rows)
          insert.run(
            ...table.columns.map(
              (column) => (row as Record<string, unknown>)[column],
            ),
          );
      }
    }).immediate();
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
}
