import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  migrate,
  readMigrations,
} from '../../src/infrastructure/persistence/migrate';
it('upgrades schema10 with occupied task, cover, closure and linked batch without dropping history', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  try {
    const ms = readMigrations(
      resolve('src/infrastructure/persistence/migrations'),
    );
    migrate(db, ms.slice(0, 10));
    db.exec(`INSERT INTO articles(article_key,external_id,import_id,title,body_json,content_declaration,created_at) VALUES('a','a','a','title','[]','repost','now');
 INSERT INTO judongche_draft_tasks(task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,reason,created_at,updated_at) VALUES('t','p','a','judongche','draft','s','{}','{}','d','manual-after-draft','needs_human','settled',7,1,1,1,1,'{"images":[1]}','RESULT_AMBIGUOUS','now','now');
 INSERT INTO judongche_task_covers VALUES('t','local-upload-v1','{}','d','{}');
 INSERT INTO draft_batches VALUES('b','r','judongche','s','store','{}','paused',2,1,'RESULT_AMBIGUOUS','now','now');
 INSERT INTO draft_batch_items VALUES('b',0,'a','{}','{}','t','needs_human','RESULT_AMBIGUOUS','now');`);
    const names = [
      'articles',
      'judongche_draft_tasks',
      'judongche_task_covers',
      'judongche_task_closures',
      'draft_batches',
      'draft_batch_items',
    ];
    const rows = () => names.map((n) => db.prepare('SELECT * FROM ' + n).all());
    const before = rows();
    expect(() =>
      migrate(db, [
        ...ms.slice(0, 10),
        { ...ms[10], sql: ms[10].sql + '\nSELECT * FROM no_such_table;' },
      ]),
    ).toThrow();
    expect(rows()).toEqual(before);
    migrate(db, ms);
    expect(rows()).toEqual(
      before.map((items, index) =>
        names[index] === 'draft_batches'
          ? items.map((row) => ({ ...(row as object), archived_at: null }))
          : names[index] === 'judongche_draft_tasks'
            ? items.map((row) => ({
                ...(row as object),
                article_revision: null,
              }))
            : items,
      ),
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.exec(
      "UPDATE judongche_draft_tasks SET state='stopped_by_user',holds_platform=0 WHERE task_id='t'",
    );
    expect(
      db
        .prepare(
          'SELECT save_attempted,possible_remote_effect,evidence_json FROM judongche_draft_tasks',
        )
        .get(),
    ).toEqual({
      save_attempted: 1,
      possible_remote_effect: 1,
      evidence_json: '{"images":[1]}',
    });
    migrate(db, ms);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
});
