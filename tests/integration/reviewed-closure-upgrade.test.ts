import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  migrate,
  readMigrations,
} from '../../src/infrastructure/persistence/migrate';
it('schema8 to9 preserves nonempty tasks, closure successor and cover rows; failed migration rolls back', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  try {
    const migrations = readMigrations(
      resolve('src/infrastructure/persistence/migrations'),
    );
    migrate(db, migrations.slice(0, 8));
    db.exec(
      `INSERT INTO articles(article_key,external_id,import_id,title,body_json,content_declaration,created_at) VALUES('a','a','a','title','[]','repost','2026-10-13');`,
    );
    const insert = db.prepare(
      `INSERT INTO judongche_draft_tasks(task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,reason,created_at,updated_at,cover_plan_version) VALUES(?,?,'a','judongche','draft','store','{}','{}','digest','manual-after-draft',?,'settled',19,1,?,0,?,'{"images":[1,2,3]}','RESULT_AMBIGUOUS','2026-10-13','2026-10-13',1)`,
    );
    insert.run('old', 'old', 'closed_without_save', 0, 0);
    insert.run('current', 'current', 'needs_human', 1, 1);
    db.exec(
      `INSERT INTO judongche_task_closures VALUES('old',18,'needs_human','body','PAGE_CHANGED','{}','2026-10-13','current'); INSERT INTO judongche_task_covers VALUES('current','local-upload-v1','{}','digest','{}');`,
    );
    const names = [
      'articles',
      'judongche_draft_tasks',
      'judongche_task_closures',
      'judongche_task_covers',
    ];
    const rows = () =>
      names.map((n) => db.prepare('SELECT * FROM ' + n + ' ORDER BY 1').all());
    const before = rows();
    const oldSchema = db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE name LIKE 'judongche_%' ORDER BY name",
      )
      .all();
    const migration = migrations[8];
    expect(migration.version).toBe(9);
    expect(() =>
      migrate(db, [
        ...migrations.slice(0, 8),
        {
          ...migration,
          sql: migration.sql + '\nSELECT * FROM deliberately_missing_table;',
        },
      ]),
    ).toThrow();
    expect(rows()).toEqual(before);
    expect(
      db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE name LIKE 'judongche_%' ORDER BY name",
        )
        .all(),
    ).toEqual(oldSchema);
    expect(
      db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get(),
    ).toEqual({ v: 8 });
    migrate(db, migrations);
    expect(rows()).toEqual(
      before.map((items, index) =>
        names[index] === 'judongche_draft_tasks'
          ? items.map((row) => ({ ...(row as object), article_revision: null }))
          : items,
      ),
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(() =>
      db
        .prepare(
          "UPDATE judongche_draft_tasks SET state='failed',holds_platform=0 WHERE task_id='current'",
        )
        .run(),
    ).toThrow();
    db.prepare(
      "UPDATE judongche_draft_tasks SET state='closed_after_review',holds_platform=0 WHERE task_id='current'",
    ).run();
    expect(() =>
      insert.run('duplicate', 'current', 'needs_human', 1, 1),
    ).toThrow(/preparation_id/);
    migrate(db, migrations);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
