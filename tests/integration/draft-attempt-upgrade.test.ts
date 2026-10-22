import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  migrate,
  readMigrations,
} from '../../src/infrastructure/persistence/migrate';

it.each([8, 9, 10, 11, 12, 13])(
  'schema %s to14 preserves attempt and related history and retains occupied/preparation/request constraints',
  (version) => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    try {
      const migrations = readMigrations(
        resolve('src/infrastructure/persistence/migrations'),
      );
      migrate(db, migrations.slice(0, version));
      db.exec(`INSERT INTO articles(article_key,external_id,import_id,title,body_json,content_declaration,created_at) VALUES('a','a','a','original title','[{"type":"paragraph","text":"original body"}]','repost','now');
      INSERT INTO article_assets VALUES('asset','a','image','a/asset.png','image/png',1,1,1,'hash');
      INSERT INTO article_cover_versions VALUES('a',1,'single','[{"assetKey":"cover"}]','cover-digest','cover-operation','now');
      INSERT INTO article_cover_heads VALUES('a',1);`);
      const insert = db.prepare(
        `INSERT INTO judongche_draft_tasks(task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,reason,created_at,updated_at,cover_plan_version) VALUES(?,?,'a','judongche','draft','store','{}','{"article":"frozen-original"}','original-digest','manual-after-draft',?,'settled',19,1,?,0,?,'{"remote":{"recordKey":"retained-record"},"images":[1,2,3]}','RESULT_AMBIGUOUS','now','now',1)`,
      );
      insert.run('old', 'old-preparation', 'closed_without_save', 0, 0);
      insert.run('current', 'current-preparation', 'needs_human', 1, 1);
      db.exec(`INSERT INTO judongche_task_closures VALUES('old',18,'needs_human','body','PAGE_CHANGED','{"type":"retained-event"}','now','current');
      INSERT INTO judongche_task_covers VALUES('old','local-upload-v1','{"cover":"retained"}','cover-digest','{"phase":"retained"}');
      INSERT INTO judongche_task_covers VALUES('current','local-upload-v1','{"cover":"retained"}','cover-digest','{"phase":"retained"}');`);
      const tables = [
        'articles',
        'article_assets',
        'article_cover_versions',
        'article_cover_heads',
        'judongche_draft_tasks',
        'judongche_task_covers',
        'judongche_task_closures',
      ];
      if (version >= 10) {
        db.exec(`INSERT INTO draft_batches(id,request_id,platform,store_key,store_name,seed_json,state,revision,stop_requested,reason,created_at,updated_at) VALUES('batch','request','judongche','store','store','{}','paused',2,0,'RESULT_AMBIGUOUS','now','now');
        INSERT INTO draft_batch_items VALUES('batch',0,'a','{}','{}','current','needs_human','RESULT_AMBIGUOUS','now');`);
        tables.push('draft_batches', 'draft_batch_items');
      }
      const rows = () =>
        Object.fromEntries(
          tables.map((name) => [
            name,
            db.prepare('SELECT * FROM ' + name + ' ORDER BY 1').all(),
          ]),
        );
      const before = rows();
      const history = db
        .prepare('SELECT * FROM schema_migrations ORDER BY version')
        .all();
      if (version === 13) {
        const migration = migrations[13];
        expect(migration).toBeDefined();
        expect(() =>
          migrate(db, [
            ...migrations.slice(0, 13),
            {
              ...migration,
              sql: migration.sql + '\nSELECT * FROM missing_attempt_table;',
            },
          ]),
        ).toThrow();
        expect(rows()).toEqual(before);
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name='judongche_one_unclosed_identity'",
            )
            .get(),
        ).toBeDefined();
        expect(
          db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
        ).toEqual(history);
      }
      migrate(db, migrations);
      const expected: Record<string, unknown[]> = {
        ...before,
        judongche_draft_tasks: before.judongche_draft_tasks.map((row) => ({
          ...(row as object),
          article_revision: null,
        })),
      };
      if (version >= 10 && version < 13)
        expected.draft_batches = before.draft_batches.map((row) => ({
          ...(row as object),
          archived_at: null,
        }));
      expect(rows()).toEqual(expected);
      expect(
        db
          .prepare('SELECT MAX(version) AS version FROM schema_migrations')
          .get(),
      ).toEqual({ version: 14 });
      expect(
        db
          .prepare('SELECT * FROM schema_migrations ORDER BY version')
          .all()
          .slice(0, version),
      ).toEqual(history);
      expect(() =>
        insert.run('blocked', 'new-preparation', 'needs_human', 1, 1),
      ).toThrow(/judongche_draft_tasks.platform/);
      db.exec(
        "UPDATE judongche_draft_tasks SET state='stopped_by_user',holds_platform=0,stop_requested=1 WHERE task_id='current'",
      );
      expect(() =>
        insert.run(
          'duplicate-preparation',
          'current-preparation',
          'needs_human',
          1,
          1,
        ),
      ).toThrow(/preparation_id/);
      expect(() =>
        insert.run('current', 'fresh-preparation', 'needs_human', 1, 1),
      ).toThrow(/task_id/);
      insert.run('new-attempt', 'new-preparation', 'needs_human', 1, 1);
      expect(
        db
          .prepare(
            'SELECT snapshot_json,save_attempted,evidence_json FROM judongche_draft_tasks WHERE task_id=?',
          )
          .get('current'),
      ).toEqual({
        snapshot_json: '{"article":"frozen-original"}',
        save_attempted: 1,
        evidence_json:
          '{"remote":{"recordKey":"retained-record"},"images":[1,2,3]}',
      });
      expect(() =>
        db.exec(
          "UPDATE judongche_draft_tasks SET save_attempted=1,possible_remote_effect=0 WHERE task_id='new-attempt'",
        ),
      ).toThrow(/CHECK/);
      expect(() =>
        db.exec(
          "UPDATE judongche_draft_tasks SET article_key='missing' WHERE task_id='new-attempt'",
        ),
      ).toThrow(/FOREIGN KEY/);
      for (const invalid of ['0', '-1', '1.5', '9007199254740992', "'invalid'"])
        expect(() =>
          db.exec(
            'UPDATE judongche_draft_tasks SET article_revision=' +
              invalid +
              " WHERE task_id='new-attempt'",
          ),
        ).toThrow(/CHECK/);
      db.exec(
        "UPDATE judongche_draft_tasks SET article_revision=7 WHERE task_id='new-attempt'",
      );
      if (version >= 10)
        expect(() =>
          db.exec(
            "INSERT INTO draft_batches(id,request_id,platform,store_key,store_name,seed_json,state,revision,stop_requested,created_at,updated_at) VALUES('duplicate-request','request','judongche','store','store','{}','completed',0,0,'now','now')",
          ),
        ).toThrow(/request_id/);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      const completed = rows();
      migrate(db, migrations);
      expect(rows()).toEqual(completed);
    } finally {
      db.close();
    }
  },
);
