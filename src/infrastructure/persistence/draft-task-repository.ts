import Database from 'better-sqlite3';
import {
  DraftTaskSchema,
  TaskEventSchema,
  ReserveInputSchema,
  type DraftTask,
  type DraftSnapshot,
  type ReserveResult,
  type TaskEvent,
} from '../../contracts/draft-task';
import type { StoredArticle } from '../../contracts/stored-article';
import type { DraftTaskRepository } from '../../domain/ports/draft-task';
import { reduceTask } from '../../domain/draft-task';
import { migrate, readMigrations } from './migrate';
import { loadStoredArticle } from './stored-article-reader';
import {
  createDraftSnapshotDigest,
  serializeDraftArticle,
} from '../draft-snapshot-integrity';

import {
  CoverPlanSchema,
  type CoverTaskSnapshot,
} from '../../contracts/cover-task';
import { initialCoverReport } from '../../domain/cover-task';
import {
  coverRepository,
  coverConfigurationDigest,
} from './article-cover-repository';

function normalized(article: StoredArticle): string {
  return serializeDraftArticle(article);
}
function verifySnapshot(snapshot: DraftSnapshot): void {
  if (createDraftSnapshotDigest(snapshot.article) !== snapshot.digest)
    throw new Error('Invalid task snapshot digest');
}
function encodeTask(input: DraftTask) {
  const task = DraftTaskSchema.parse(input);
  verifySnapshot(task.snapshot);
  return {
    task_id: task.taskId,
    preparation_id: task.preparationId,
    article_revision: task.articleRevision ?? null,
    article_key: task.articleKey,
    platform: task.platform,
    mode: task.mode,
    store_key: task.store.storeKey,
    store_json: JSON.stringify(task.store),
    snapshot_json: JSON.stringify(task.snapshot),
    snapshot_digest: task.snapshot.digest,
    cover_policy: task.coverPolicy,
    cover_plan_version: task.coverPlan ? 1 : 0,
    state: task.state,
    stage: task.stage,
    revision: task.revision,
    possible_remote_effect: Number(task.possibleRemoteEffect),
    save_attempted: Number(task.saveAttempted),
    stop_requested: Number(task.stopRequested),
    holds_platform: Number(task.holdsPlatform),
    evidence_json: JSON.stringify(task.evidence),
    reason: task.reason,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}
function decodeTask(input: unknown, coverPlan?: unknown): DraftTask {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid task row');
  const row = input as Record<string, unknown>;
  function json(key: string): unknown {
    const value = row[key];
    if (typeof value !== 'string') throw new Error('Invalid task JSON column');
    return JSON.parse(value) as unknown;
  }
  function flag(key: string): boolean {
    const value = row[key];
    if (value !== 0 && value !== 1)
      throw new Error('Invalid task boolean column');
    return value === 1;
  }
  const task = DraftTaskSchema.parse({
    taskId: row.task_id,
    preparationId: row.preparation_id,
    articleRevision: row.article_revision,
    articleKey: row.article_key,
    platform: row.platform,
    mode: row.mode,
    store: json('store_json'),
    snapshot: json('snapshot_json'),
    coverPolicy: row.cover_policy,
    ...(coverPlan === undefined ? {} : { coverPlan }),
    state: row.state,
    stage: row.stage,
    revision: row.revision,
    possibleRemoteEffect: flag('possible_remote_effect'),
    saveAttempted: flag('save_attempted'),
    stopRequested: flag('stop_requested'),
    holdsPlatform: flag('holds_platform'),
    evidence: json('evidence_json'),
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (
    task.store.storeKey !== row.store_key ||
    task.snapshot.digest !== row.snapshot_digest
  )
    throw new Error('Inconsistent task columns');
  verifySnapshot(task.snapshot);
  return task;
}
export function openDraftTaskRepository(
  databasePath: string,
  migrationsDirectory: string,
): DraftTaskRepository {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 1000');
    migrate(db, readMigrations(migrationsDirectory));
    return draftTaskRepository(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Infrastructure-only shared connection for atomic batch/task reservation. */
export function draftTaskRepository(
  db: Database.Database,
): DraftTaskRepository {
  try {
    const covers = coverRepository(db);
    function verifyCoverSnapshot(snapshot: CoverTaskSnapshot) {
      if (
        snapshot.digest !==
        coverConfigurationDigest(
          snapshot.articleKey,
          snapshot.coverRevision,
          snapshot.mode,
          snapshot.assets,
        )
      )
        throw Error('Invalid task cover digest');
      const archived = covers.loadArchivedCoverVersion(
        snapshot.articleKey,
        snapshot.coverRevision,
      );
      if (
        !archived ||
        archived.configurationDigest !== snapshot.digest ||
        archived.mode !== snapshot.mode ||
        JSON.stringify(archived.assets) !== JSON.stringify(snapshot.assets)
      )
        throw Error('Invalid retained cover snapshot');
    }
    function decode(input: unknown): DraftTask {
      if (!input || typeof input !== 'object') throw Error('Invalid task row');
      const row = input as Record<string, unknown>;
      const side = db
        .prepare('SELECT * FROM judongche_task_covers WHERE task_id=?')
        .get(row.task_id) as
        | {
            policy: string;
            snapshot_json: string;
            snapshot_digest: string;
            report_json: string;
          }
        | undefined;
      if (row.cover_plan_version === 0) {
        if (side) throw Error('Unexpected legacy cover extension');
        return decodeTask(row);
      }
      if (row.cover_plan_version !== 1 || !side)
        throw Error('Missing task cover extension');
      const plan = CoverPlanSchema.parse({
        policy: side.policy,
        snapshot: JSON.parse(side.snapshot_json),
        report: JSON.parse(side.report_json),
      });
      if (plan.snapshot.digest !== side.snapshot_digest)
        throw Error('Inconsistent task cover digest');
      verifyCoverSnapshot(plan.snapshot);
      return decodeTask(row, plan);
    }
    // Every durable row must be readable; never skip a corrupt occupied task.
    for (const row of db.prepare('SELECT * FROM judongche_draft_tasks').all()) {
      const task = decode(row);
      const audit = db
        .prepare('SELECT * FROM judongche_task_closures WHERE task_id=?')
        .get(task.taskId) as
        | {
            prior_revision: number;
            prior_state: DraftTask['state'];
            prior_stage: DraftTask['stage'];
            prior_reason: DraftTask['reason'];
            event_json: string;
            closed_at: string;
          }
        | undefined;
      if (
        ['closed_without_save', 'closed_after_review'].includes(task.state) !==
        !!audit
      )
        throw new Error('Invalid closure audit');
      if (audit) {
        const event = TaskEventSchema.parse(JSON.parse(audit.event_json));
        if (
          event.type !== 'close-without-save' &&
          event.type !== 'close-after-review'
        )
          throw new Error('Invalid closure audit');
        const prior = {
          ...task,
          state: audit.prior_state,
          stage: audit.prior_stage,
          revision: audit.prior_revision,
          reason: audit.prior_reason,
          holdsPlatform: true,
        };
        const checked = reduceTask(prior, event, audit.closed_at);
        if (JSON.stringify(checked) !== JSON.stringify(task))
          throw new Error('Inconsistent closure audit');
      }
    }
    const update = db.prepare(`UPDATE judongche_draft_tasks SET
      state=@state, stage=@stage, revision=@revision,
      possible_remote_effect=@possible_remote_effect, save_attempted=@save_attempted,
      stop_requested=@stop_requested, holds_platform=@holds_platform,
      evidence_json=@evidence_json, reason=@reason, updated_at=@updated_at
      WHERE task_id=@task_id AND revision=@expectedRevision`);
    function one(sql: string, ...values: string[]): DraftTask | undefined {
      return db.transaction(() => {
        const row = db.prepare(sql).get(...values);
        return row === undefined ? undefined : decode(row);
      })();
    }
    const get = (id: string) =>
      one('SELECT * FROM judongche_draft_tasks WHERE task_id=?', id);
    const findPreparation = (id: string) =>
      one('SELECT * FROM judongche_draft_tasks WHERE preparation_id=?', id);
    const findLatestIdentity = (article: string, store: string) =>
      one(
        "SELECT * FROM judongche_draft_tasks WHERE article_key=? AND store_key=? AND platform='judongche' AND mode='draft' ORDER BY created_at DESC, rowid DESC LIMIT 1",
        article,
        store,
      );
    const findIdentity = (article: string, store: string) =>
      one(
        "SELECT * FROM judongche_draft_tasks WHERE article_key=? AND store_key=? AND platform='judongche' AND mode='draft' AND state NOT IN ('closed_without_save','stopped_by_user') ORDER BY created_at DESC, rowid DESC LIMIT 1",
        article,
        store,
      );
    const occupied = () =>
      one(
        "SELECT * FROM judongche_draft_tasks WHERE platform='judongche' AND holds_platform=1",
      );
    function transition(
      taskId: string,
      expectedRevision: number,
      event: TaskEvent,
      now: string,
    ): DraftTask {
      const current = get(taskId);
      if (!current || current.revision !== expectedRevision)
        throw new Error('Task revision conflict');
      const next = reduceTask(current, event, now);
      if (
        event.type === 'close-without-save' ||
        event.type === 'close-after-review'
      ) {
        db.prepare(
          'INSERT INTO judongche_task_closures(task_id,prior_revision,prior_state,prior_stage,prior_reason,event_json,closed_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          taskId,
          current.revision,
          current.state,
          current.stage,
          current.reason,
          JSON.stringify(TaskEventSchema.parse(event)),
          now,
        );
      }
      const result = update.run({ ...encodeTask(next), expectedRevision });
      if (result.changes !== 1) throw new Error('Task revision conflict');
      if (event.type === 'cover_report') {
        const saved = db
          .prepare(
            'UPDATE judongche_task_covers SET report_json=? WHERE task_id=?',
          )
          .run(JSON.stringify(next.coverPlan!.report), taskId);
        if (saved.changes !== 1) throw Error('Missing task cover extension');
      }
      return next;
    }
    return {
      get,
      findPreparation,
      findLatestIdentity,
      findIdentity,
      occupied,
      latest: () =>
        one(
          'SELECT * FROM judongche_draft_tasks ORDER BY created_at DESC, rowid DESC LIMIT 1',
        ),
      reserve(input) {
        return db
          .transaction((): ReserveResult => {
            const value = ReserveInputSchema.parse(input);
            if (
              !db
                .prepare(
                  'SELECT article_key FROM articles WHERE article_key = ? AND deleted_at IS NULL',
                )
                .get(value.snapshot.article.articleKey)
            )
              return { status: 'stale' };
            // An existing attempt is informational and can never be granted again.
            // Article/store history is deliberately not a reservation identity.
            const previous =
              findPreparation(value.preparationId) ?? get(value.taskId);
            if (previous) return { status: 'existing', task: previous };
            const busy = occupied();
            if (busy) return { status: 'blocked', task: busy };
            verifySnapshot(value.snapshot);
            const article = loadStoredArticle(
              db,
              'article_key',
              value.snapshot.article.articleKey,
            );
            const articleVersion = db
              .prepare(
                'SELECT content_revision FROM articles WHERE article_key=? AND deleted_at IS NULL',
              )
              .get(value.snapshot.article.articleKey) as
              { content_revision: number } | undefined;
            if (
              articleVersion?.content_revision !==
                value.expectedArticleRevision ||
              !article ||
              normalized(article) !== normalized(value.snapshot.article)
            )
              return { status: 'stale' };
            if (value.coverSnapshot) {
              verifyCoverSnapshot(value.coverSnapshot);
              const config = covers.loadCover(article.articleKey);
              if (
                !config ||
                config.coverRevision !== value.expectedCoverRevision ||
                config.configurationDigest !== value.coverSnapshot.digest
              )
                return { status: 'stale' };
            }
            const task = DraftTaskSchema.parse({
              taskId: value.taskId,
              preparationId: value.preparationId,
              articleRevision: value.expectedArticleRevision,
              articleKey: article.articleKey,
              platform: 'judongche',
              mode: 'draft',
              store: value.store,
              snapshot: {
                ...value.snapshot,
                article: JSON.parse(normalized(article)) as unknown,
              },
              coverPolicy: 'manual-after-draft',
              ...(value.coverSnapshot
                ? {
                    coverPlan: {
                      policy: 'local-upload-v1',
                      snapshot: value.coverSnapshot,
                      report: initialCoverReport(
                        value.coverSnapshot,
                        value.now,
                      ),
                    },
                  }
                : {}),
              state: 'queued',
              stage: 'reserved',
              revision: 0,
              possibleRemoteEffect: false,
              saveAttempted: false,
              stopRequested: false,
              holdsPlatform: true,
              evidence: { remote: null, images: [], cover: null },
              reason: null,
              createdAt: value.now,
              updatedAt: value.now,
            });
            const row = encodeTask(task);
            const columns = Object.keys(row);
            db.prepare(
              `INSERT INTO judongche_draft_tasks (${columns.join(',')}) VALUES (${columns.map((column) => '@' + column).join(',')})`,
            ).run(row);
            if (task.coverPlan)
              db.prepare(
                'INSERT INTO judongche_task_covers(task_id,policy,snapshot_json,snapshot_digest,report_json) VALUES(?,?,?,?,?)',
              ).run(
                task.taskId,
                task.coverPlan.policy,
                JSON.stringify(task.coverPlan.snapshot),
                task.coverPlan.snapshot.digest,
                JSON.stringify(task.coverPlan.report),
              );
            const priorClosure = db
              .prepare(
                `SELECT c.task_id FROM judongche_task_closures c JOIN judongche_draft_tasks t ON t.task_id=c.task_id WHERE t.article_key=? AND t.store_key=? AND c.successor_task_id IS NULL ORDER BY c.closed_at DESC LIMIT 1`,
              )
              .get(task.articleKey, task.store.storeKey) as
              { task_id: string } | undefined;
            if (priorClosure)
              db.prepare(
                'UPDATE judongche_task_closures SET successor_task_id=? WHERE task_id=? AND successor_task_id IS NULL',
              ).run(task.taskId, priorClosure.task_id);
            return { status: 'created', task };
          })
          .immediate();
      },
      apply: (id, revision, event, now) =>
        db.transaction(() => transition(id, revision, event, now)).immediate(),
      recover(now) {
        db.transaction(() => {
          DraftTaskSchema.shape.updatedAt.parse(now);
          const tasks = db
            .prepare('SELECT * FROM judongche_draft_tasks')
            .all()
            .map(decode);
          for (const task of tasks)
            if (task.state === 'queued' || task.state === 'running')
              transition(task.taskId, task.revision, { type: 'recover' }, now);
        }).immediate();
      },
      close() {
        if (db.open) db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
