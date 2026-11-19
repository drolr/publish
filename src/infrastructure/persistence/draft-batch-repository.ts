import { coverRepository } from './article-cover-repository';
import { coverReportView } from '../../contracts/cover-task';
import Database from 'better-sqlite3';
import {
  BatchSeedSchema,
  BatchViewSchema,
  BatchItemViewSchema,
  type BatchView,
  type BatchRecoveryInput,
} from '../../contracts/draft-batch';
import {
  ReserveInputSchema,
  type DraftTask,
  type ReasonCode,
} from '../../contracts/draft-task';
import type { DraftBatchRepository } from '../../domain/ports/draft-batch';
import { batchCounts, classifyBatchTask } from '../../domain/draft-batch';
import { draftTaskRepository } from './draft-task-repository';
import { migrate, readMigrations } from './migrate';

type BatchRow = {
  id: string;
  request_id: string;
  store_name: string;
  seed_json: string;
  state: BatchView['state'];
  revision: number;
  stop_requested: number;
  reason: ReasonCode | null;
};
type ItemRow = {
  ordinal: number;
  view_json: string;
  reservation_json: string | null;
  task_id: string | null;
  state: BatchView['items'][number]['state'];
  reason: ReasonCode | null;
};
export function openDraftBatchRepository(
  path: string,
  migrations: string,
): DraftBatchRepository {
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 1000');
    migrate(db, readMigrations(migrations));
    const tasks = draftTaskRepository(db);
    const covers = coverRepository(db);
    const row = (id: string) =>
      db.prepare('SELECT * FROM draft_batches WHERE id=?').get(id) as
        BatchRow | undefined;
    const items = (id: string) =>
      db
        .prepare(
          'SELECT * FROM draft_batch_items WHERE batch_id=? ORDER BY ordinal',
        )
        .all(id) as ItemRow[];
    function view(id: string): BatchView | null {
      const batch = row(id);
      if (!batch) return null;
      const list = items(id).map((item) => {
        const task = item.task_id ? tasks.get(item.task_id) : undefined;
        return BatchItemViewSchema.parse({
          ...JSON.parse(item.view_json),
          state: item.state,
          reason: item.reason,
          taskId: item.task_id,
          ...(task ? { saveAttempted: task.saveAttempted } : {}),
          ...(task?.evidence.submission
            ? { submission: task.evidence.submission }
            : {}),
          ...(task?.coverPlan
            ? { coverReport: coverReportView(task.coverPlan.report) }
            : {}),
        });
      });
      return BatchViewSchema.parse({
        id: batch.id,
        revision: batch.revision,
        state: batch.state,
        storeName: batch.store_name,
        stopRequested: batch.stop_requested === 1,
        reason: batch.reason,
        items: list,
        counts: batchCounts(list),
      });
    }
    function requireRevision(id: string, revision: number) {
      const batch = row(id);
      if (!batch || batch.revision !== revision)
        throw Error('Batch revision conflict');
      return batch;
    }
    function update(
      id: string,
      state: BatchView['state'],
      reason: ReasonCode | null,
      now: string,
    ) {
      db.prepare(
        'UPDATE draft_batches SET state=?,reason=?,revision=revision+1,updated_at=? WHERE id=?',
      ).run(state, reason, now, id);
    }
    function settle(id: string, taskId: string, now: string) {
      const batch = row(id);
      const item = items(id).find((i) => i.task_id === taskId);
      const task = tasks.get(taskId);
      if (!batch || !item || !task) throw Error('Missing batch task');
      // A caller cannot mark an actually running task successful or release it.
      if (task.state === 'running' || task.state === 'queued')
        throw Error('Task still executing');
      const outcome = classifyBatchTask(task);
      db.prepare(
        'UPDATE draft_batch_items SET state=?,reason=?,updated_at=? WHERE batch_id=? AND task_id=?',
      ).run(outcome.state, outcome.reason, now, id, taskId);
      const pending = items(id).some((i) => i.state === 'queued');
      const state = outcome.pause
        ? 'paused'
        : batch.stop_requested
          ? 'stopped'
          : pending
            ? 'running'
            : 'completed';
      update(id, state, outcome.pause ? outcome.reason : null, now);
      if (state === 'stopped') stopWaiting(id, now);
      return view(id)!;
    }
    function stopWaiting(id: string, now: string) {
      db.prepare(
        "UPDATE draft_batch_items SET state='stopped',reason='STOP_REQUESTED',updated_at=? WHERE batch_id=? AND state='queued'",
      ).run(now, id);
    }
    function recovery(input: BatchRecoveryInput) {
      const batch = requireRevision(input.batchId, input.expectedRevision);
      const list = items(input.batchId);
      const unhandled = list.filter((i) =>
        ['running', 'needs_human'].includes(i.state),
      );
      if (
        !['paused', 'interrupted'].includes(batch.state) ||
        (batch.stop_requested && batch.state !== 'interrupted') ||
        (batch.state === 'interrupted' && batch.reason !== 'RESULT_AMBIGUOUS')
      )
        throw Error('Batch not recoverable');
      if (
        input.taskId === null
          ? unhandled.length !== 0 || batch.state !== 'interrupted'
          : unhandled.length !== 1 || unhandled[0].task_id !== input.taskId
      )
        throw Error('Batch task conflict');
      const seed = BatchSeedSchema.parse(JSON.parse(batch.seed_json));
      const queued = list
        .filter((i) => i.state === 'queued')
        .map((i) => ReserveInputSchema.parse(JSON.parse(i.reservation_json!)));
      const source = input.taskId
        ? tasks.get(input.taskId)?.store
        : queued[0]?.store;
      if (!source || source.storeKey !== seed.storeKey)
        throw Error('Missing recovery binding');
      return { store: source, queued };
    }
    const get = (id: string) => db.transaction(() => view(id))();
    return {
      get,
      recovery: (input) => db.transaction(() => recovery(input))(),
      skipCurrentAndContinue(input, now) {
        return db
          .transaction(() => {
            const context = recovery(input);
            for (const reservation of context.queued) {
              const article = db
                .prepare(
                  'SELECT content_revision FROM articles WHERE article_key=? AND deleted_at IS NULL',
                )
                .get(reservation.snapshot.article.articleKey) as
                { content_revision: number } | undefined;
              const cover = covers.loadCover(
                reservation.snapshot.article.articleKey,
              );
              if (
                article?.content_revision !==
                  reservation.expectedArticleRevision ||
                (reservation.coverSnapshot &&
                  (cover?.coverRevision !== reservation.expectedCoverRevision ||
                    cover?.configurationDigest !==
                      reservation.coverSnapshot.digest))
              )
                throw Error('STALE_PREPARATION');
            }
            if (tasks.occupied()) throw Error('Task still occupied');
            if (
              input.taskId &&
              tasks.get(input.taskId)?.state !== 'stopped_by_user'
            )
              throw Error('Task not released');
            if (input.taskId)
              db.prepare(
                "UPDATE draft_batch_items SET state='skipped',updated_at=? WHERE batch_id=? AND task_id=?",
              ).run(now, input.batchId, input.taskId);
            db.prepare(
              'UPDATE draft_batches SET stop_requested=0 WHERE id=?',
            ).run(input.batchId);
            update(
              input.batchId,
              context.queued.length ? 'running' : 'completed',
              null,
              now,
            );
            return view(input.batchId)!;
          })
          .immediate();
      },
      getCurrent() {
        return db.transaction(() => {
          const latest = db
            .prepare(
              "SELECT id FROM draft_batches WHERE archived_at IS NULL AND rowid > COALESCE((SELECT MAX(rowid) FROM draft_batches WHERE archived_at IS NOT NULL), 0) ORDER BY CASE WHEN state IN ('prepared','running','paused','interrupted') THEN 0 ELSE 1 END, rowid DESC LIMIT 1",
            )
            .get() as { id: string } | undefined;
          return latest ? view(latest.id) : null;
        })();
      },
      archiveFinished(id, revision, now) {
        db.transaction(() => {
          const current = requireRevision(id, revision);
          const summary = view(id)!;
          if (
            tasks.occupied() ||
            !['stopped', 'completed'].includes(current.state) ||
            (current.state === 'completed' &&
              !summary.counts.failed &&
              !summary.counts.needsHuman)
          )
            throw Error('Batch still active or not failed');
          if (
            items(id).some(
              (item) => item.state === 'running' || item.state === 'queued',
            )
          )
            throw Error('Batch not released');
          db.prepare(
            'UPDATE draft_batches SET archived_at=?,revision=revision+1,updated_at=? WHERE id=? AND archived_at IS NULL',
          ).run(now, now, id);
        }).immediate();
      },
      findRequest(requestId, preparationId) {
        return db.transaction(() => {
          const found = db
            .prepare('SELECT id FROM draft_batches WHERE request_id=?')
            .get(requestId) as { id: string } | undefined;
          if (
            found &&
            BatchSeedSchema.parse(JSON.parse(row(found.id)!.seed_json))
              .preparationId !== preparationId
          )
            throw Error('Batch request conflict');
          return found ? view(found.id) : null;
        })();
      },
      create(input) {
        const seed = BatchSeedSchema.parse(input);
        return db
          .transaction(() => {
            const existing = db
              .prepare('SELECT * FROM draft_batches WHERE request_id=?')
              .get(seed.requestId) as BatchRow | undefined;
            if (existing) {
              if (existing.seed_json !== JSON.stringify(seed))
                throw Error('Batch request conflict');
              return view(existing.id)!;
            }
            if (tasks.occupied()) throw Error('Platform occupied');
            // The complete executable selection must still match the approved
            // summary before the batch becomes durable and any task can start.
            for (const item of seed.items) {
              const reservation = item.reservation;
              if (!reservation) continue;
              const article = db
                .prepare(
                  'SELECT content_revision FROM articles WHERE article_key=? AND deleted_at IS NULL',
                )
                .get(item.view.articleKey) as
                { content_revision: number } | undefined;
              if (
                article?.content_revision !==
                reservation.expectedArticleRevision
              )
                throw Error('Stale batch article');
              if (reservation.coverSnapshot) {
                const cover = covers.loadCover(item.view.articleKey);
                if (
                  !cover ||
                  cover.coverRevision !== reservation.expectedCoverRevision ||
                  cover.configurationDigest !== reservation.coverSnapshot.digest
                )
                  throw Error('Stale batch cover');
              }
            }
            db.prepare(
              "INSERT INTO draft_batches(id,request_id,platform,store_key,store_name,seed_json,state,revision,stop_requested,created_at,updated_at) VALUES(?,?,'judongche',?,?,?,'prepared',0,0,?,?)",
            ).run(
              seed.id,
              seed.requestId,
              seed.storeKey,
              seed.storeName,
              JSON.stringify(seed),
              seed.now,
              seed.now,
            );
            for (const [ordinal, item] of seed.items.entries()) {
              db.prepare(
                'INSERT INTO draft_batch_items(batch_id,ordinal,article_key,view_json,reservation_json,state,reason,updated_at) VALUES(?,?,?,?,?,?,?,?)',
              ).run(
                seed.id,
                ordinal,
                item.view.articleKey,
                JSON.stringify(item.view),
                item.reservation ? JSON.stringify(item.reservation) : null,
                item.view.state,
                item.view.reason,
                seed.now,
              );
            }
            return view(seed.id)!;
          })
          .immediate();
      },
      reserveNext(id, revision, now) {
        return db
          .transaction((): DraftTask | null => {
            const batch = requireRevision(id, revision);
            if (
              batch.stop_requested ||
              !['prepared', 'running'].includes(batch.state)
            )
              return null;
            const list = items(id);
            if (list.some((i) => i.state === 'running')) return null;
            const next = list.find((i) => i.state === 'queued');
            if (!next) {
              update(id, 'completed', null, now);
              return null;
            }
            const input = ReserveInputSchema.parse(
              JSON.parse(next.reservation_json!),
            );
            const reserved = tasks.reserve({ ...input, now });
            if (reserved.status === 'blocked') {
              update(id, 'paused', 'PLATFORM_BUSY', now);
              return null;
            }
            if (reserved.status === 'stale') {
              update(id, 'paused', 'STALE_PREPARATION', now);
              return null;
            }
            db.prepare(
              "UPDATE draft_batch_items SET task_id=?,state='running',updated_at=? WHERE batch_id=? AND ordinal=?",
            ).run(reserved.task.taskId, now, id, next.ordinal);
            update(id, 'running', null, now);
            // An existing task is evidence to reconcile, never authority to execute again.
            if (reserved.status === 'existing') {
              if (['queued', 'running'].includes(reserved.task.state))
                update(id, 'paused', 'PLATFORM_BUSY', now);
              else settle(id, reserved.task.taskId, now);
              return null;
            }
            return reserved.task;
          })
          .immediate();
      },
      settleItem: (id, taskId, now) =>
        db.transaction(() => settle(id, taskId, now)).immediate(),
      requestStop(id, revision, now) {
        return db
          .transaction(() => {
            const batch = requireRevision(id, revision);
            if (['completed', 'stopped'].includes(batch.state))
              return view(id)!;
            db.prepare(
              'UPDATE draft_batches SET stop_requested=1 WHERE id=?',
            ).run(id);
            const active = items(id).some((i) => i.state === 'running');
            update(
              id,
              active
                ? batch.state
                : ['paused', 'interrupted'].includes(batch.state)
                  ? batch.state
                  : 'stopped',
              'STOP_REQUESTED',
              now,
            );
            if (!active) stopWaiting(id, now);
            return view(id)!;
          })
          .immediate();
      },
      finish(id, revision, now) {
        return db
          .transaction(() => {
            requireRevision(id, revision);
            if (items(id).some((i) => i.state === 'running'))
              throw Error('Task still executing');
            db.prepare(
              'UPDATE draft_batches SET stop_requested=1 WHERE id=?',
            ).run(id);
            stopWaiting(id, now);
            update(id, 'stopped', 'STOP_REQUESTED', now);
            return view(id)!;
          })
          .immediate();
      },
      pause(id, reason, now) {
        return db
          .transaction(() => {
            if (!row(id)) throw Error('Missing batch');
            update(id, 'paused', reason, now);
            return view(id)!;
          })
          .immediate();
      },
      recover(now) {
        db.transaction(() => {
          tasks.recover(now);
          const active = db
            .prepare(
              "SELECT id FROM draft_batches WHERE state IN ('prepared','running','paused','interrupted')",
            )
            .all() as Array<{ id: string }>;
          for (const batch of active) {
            const before = row(batch.id)!;
            const intentionalStop =
              before.stop_requested === 1 &&
              (before.state !== 'interrupted' ||
                before.reason === 'STOP_REQUESTED');
            for (const item of items(batch.id)) {
              if (item.state === 'running' && item.task_id)
                settle(batch.id, item.task_id, now);
            }
            db.prepare(
              'UPDATE draft_batches SET stop_requested=1 WHERE id=?',
            ).run(batch.id);
            if (row(batch.id)!.state !== 'completed')
              update(
                batch.id,
                'interrupted',
                intentionalStop ? 'STOP_REQUESTED' : 'RESULT_AMBIGUOUS',
                now,
              );
          }
        }).immediate();
      },
      close() {
        if (db.open) db.close();
      },
    };
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}
