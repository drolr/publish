import {
  BatchPrepareInputSchema,
  BatchStartInputSchema,
  BatchIdentityInputSchema,
  type BatchApi,
  type BatchSeed,
  type BatchCommandResult,
} from '../contracts/draft-batch';
import type { ReasonCode } from '../contracts/draft-task';
import { coverSummary } from '../contracts/cover-task';
import { batchLocalReasons } from '../domain/draft-batch';
import type { DraftBatchRepository } from '../domain/ports/draft-batch';
import type { ArticleRevisionRepository } from '../domain/ports/article-revision';
import type { ArticleCoverRepository } from '../domain/ports/article-cover';
import type { SnapshotPort } from '../domain/ports/draft-task';
import type { DraftController } from './draft-controller';
import type { DraftPreparation } from './draft-preparation';

export interface BatchController extends BatchApi {
  requestStop(): void;
  stopForRestart(): Promise<void>;
  isActive(): boolean;
  isBlocked(): boolean;
  waitForIdle(): Promise<void>;
  stopAndWait(): Promise<void>;
}
export function createBatchController(deps: {
  repository: DraftBatchRepository;
  draft: DraftController;
  preparation: DraftPreparation;
  articles: Pick<ArticleRevisionRepository, 'loadEditableArticle'> &
    Pick<ArticleCoverRepository, 'loadCover'>;
  snapshots: SnapshotPort;
  newId(): string;
  now(): string;
  gate(): 'ready' | 'busy' | 'unavailable';
}): BatchController {
  let prepared:
    | {
        seed: BatchSeed;
        generation: string;
        expires: number;
        versions: Array<{
          articleKey: string;
          articleRevision: number;
          coverRevision: number;
          digest: string;
        }>;
      }
    | undefined;
  let busy = false;
  let stopping = false;
  let storageFailed = false;
  let epoch = 0;
  let running: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  function track<T>(fn: () => Promise<T>): Promise<T> {
    const p = fn();
    pending.add(p);
    void p.then(
      () => pending.delete(p),
      () => pending.delete(p),
    );
    return p;
  }
  function view() {
    return deps.repository.getCurrent();
  }
  function result(reason?: ReasonCode): BatchCommandResult {
    return reason
      ? { status: 'blocked', reason, view: view() }
      : { status: 'ok', view: view() };
  }
  function gate(): ReasonCode | undefined {
    if (storageFailed || deps.gate() === 'unavailable')
      return 'STORAGE_UNAVAILABLE';
    if (deps.gate() === 'busy') return 'PLATFORM_BUSY';
    return undefined;
  }
  function occupied() {
    const current = view();
    return !!current && !['completed', 'stopped'].includes(current.state);
  }
  function requestStop() {
    stopping = true;
    epoch++;
    prepared = undefined;
    // Stop both admission and the current writer synchronously before persistence.
    try {
      deps.draft.requestStop();
    } catch {
      storageFailed = true;
    }
    try {
      const current = view();
      if (current && !['completed', 'stopped'].includes(current.state))
        deps.repository.requestStop(current.id, current.revision, deps.now());
    } catch {
      storageFailed = true;
    }
  }
  async function loop(id: string, generation: string) {
    try {
      while (!stopping && !storageFailed) {
        const current = deps.repository.get(id);
        if (
          !current ||
          !['prepared', 'running'].includes(current.state) ||
          current.stopRequested
        )
          return;
        const reason = gate();
        if (reason) {
          deps.repository.pause(id, reason, deps.now());
          return;
        }
        const task = deps.repository.reserveNext(
          id,
          current.revision,
          deps.now(),
        );
        if (!task) {
          const after = deps.repository.get(id);
          if (
            after?.revision !== current.revision &&
            after?.state === 'running'
          )
            continue;
          return;
        }
        if (stopping) deps.draft.requestStop();
        await deps.draft.executeBatchTask(task.taskId, generation);
        const after = deps.repository.settleItem(id, task.taskId, deps.now());
        if (after.state !== 'running') return;
      }
    } catch {
      try {
        deps.repository.pause(id, 'RESULT_AMBIGUOUS', deps.now());
      } catch {
        storageFailed = true;
      }
    }
  }
  const api: BatchController = {
    isActive: () => busy || !!running || pending.size > 0,
    isBlocked: () => {
      try {
        return storageFailed || occupied();
      } catch {
        return true;
      }
    },
    requestStop,
    async stopForRestart() {
      requestStop();
      await deps.draft.stopForRestart();
      await api.waitForIdle();
      if (storageFailed) throw Error('Storage unavailable');
      const current = view();
      if (current && !['completed', 'stopped'].includes(current.state))
        deps.repository.finish(current.id, current.revision, deps.now());
    },
    async waitForIdle() {
      await Promise.allSettled([...pending]);
      await running;
    },
    async stopAndWait() {
      requestStop();
      await api.waitForIdle();
    },
    getCurrent: async () => view(),
    prepare: (input) =>
      track(async () => {
        const parsed = BatchPrepareInputSchema.safeParse(input);
        if (!parsed.success)
          return { status: 'blocked', reason: 'INPUT_UNSUPPORTED' };
        const reason = gate();
        if (reason) return { status: 'blocked', reason };
        if (
          busy ||
          running ||
          occupied() ||
          deps.draft.isActive() ||
          deps.draft.isBlocked()
        )
          return { status: 'blocked', reason: 'PLATFORM_BUSY' };
        busy = true;
        stopping = false;
        prepared = undefined;
        const ticket = ++epoch;
        try {
          const items: BatchSeed['items'] = [];
          const versions: Array<{
            articleKey: string;
            articleRevision: number;
            coverRevision: number;
            digest: string;
          }> = [];
          let first:
            NonNullable<ReturnType<DraftPreparation['take']>> | undefined;
          for (const articleKey of parsed.data.articleKeys) {
            if (ticket !== epoch || stopping)
              return { status: 'blocked', reason: 'STOP_REQUESTED' };
            const article = deps.articles.loadEditableArticle(articleKey);
            if (!article)
              return { status: 'blocked', reason: 'STALE_PREPARATION' };
            const config = deps.articles.loadCover(articleKey);
            if (!config)
              return { status: 'blocked', reason: 'STALE_PREPARATION' };
            versions.push({
              articleKey,
              articleRevision: article.articleRevision,
              coverRevision: config.coverRevision,
              digest: config.configurationDigest,
            });
            const offered = await deps.draft.prepareDraft(
              articleKey,
              parsed.data.bindingToken,
              parsed.data.newAttemptArticleKeys?.includes(articleKey)
                ? 'new_attempt'
                : 'default',
            );
            if (ticket !== epoch || stopping)
              return { status: 'blocked', reason: 'STOP_REQUESTED' };
            const basic = {
              articleKey,
              title: article.article.title,
              contentDeclaration: article.article.contentDeclaration,
              coverSummary: coverSummary(deps.snapshots.captureCover(config)),
              taskId: null,
              reason: null,
            };
            if (offered.status === 'existing') {
              const submitted =
                offered.task.state === 'submission_recorded' &&
                offered.task.stage === 'settled' &&
                !offered.task.platformPaused &&
                !offered.task.stopRequested &&
                !!offered.task.submission;
              if (offered.task.state !== 'draft_saved' && !submitted)
                return { status: 'blocked', reason: 'PLATFORM_BUSY' };
              items.push({
                view: {
                  ...basic,
                  ...(submitted ? { submission: offered.task.submission } : {}),
                  state: 'skipped',
                },
                reservation: null,
              });
            } else if (offered.status === 'blocked') {
              if (
                !batchLocalReasons.has(offered.reason) &&
                offered.reason !== 'NEW_ATTEMPT_REQUIRED'
              )
                return offered;
              items.push({
                view: { ...basic, state: 'failed', reason: offered.reason },
                reservation: null,
              });
            } else {
              const selected = deps.preparation.take(
                offered.preparation.preparationId,
              );
              if (!selected)
                return { status: 'blocked', reason: 'STALE_PREPARATION' };
              if (selected.coverSnapshot.mode === 'triple')
                return { status: 'blocked', reason: 'INPUT_UNSUPPORTED' };
              if (
                first &&
                (selected.generation !== first.generation ||
                  selected.store.storeKey !== first.store.storeKey)
              )
                return { status: 'blocked', reason: 'STORE_CHANGED' };
              first ??= selected;
              items.push({
                view: {
                  ...basic,
                  state: 'queued',
                  coverSummary: coverSummary(selected.coverSnapshot),
                },
                reservation: {
                  taskId: deps.newId(),
                  preparationId: offered.preparation.preparationId,
                  snapshot: selected.snapshot,
                  store: selected.store,
                  expectedArticleRevision: selected.articleRevision,
                  expectedCoverRevision: selected.coverSnapshot.coverRevision,
                  coverSnapshot: selected.coverSnapshot,
                  now: deps.now(),
                },
              });
            }
          }
          if (!first) {
            const current = await deps.draft.getDraftState();
            if (ticket !== epoch || stopping)
              return { status: 'blocked', reason: 'STOP_REQUESTED' };
            if (
              current.session.status !== 'ready' ||
              current.session.bindingToken !== parsed.data.bindingToken ||
              !current.session.storeName
            )
              return { status: 'blocked', reason: 'STALE_PREPARATION' };
            // A diagnostic summary is useful even when every item failed or
            // was already saved. No executable seed is retained for this ID.
            return {
              status: 'ready',
              preparation: {
                preparationId: deps.newId(),
                storeName: current.session.storeName,
                items: items.map((item) => item.view),
              },
            };
          }
          const seed: BatchSeed = {
            id: deps.newId(),
            requestId: deps.newId(),
            preparationId: deps.newId(),
            storeKey: first.store.storeKey,
            storeName: first.store.displayName,
            items,
            now: deps.now(),
          };
          prepared = {
            seed,
            generation: first.generation,
            versions,
            expires: Date.parse(deps.now()) + 120000,
          };
          return {
            status: 'ready',
            preparation: {
              preparationId: seed.preparationId,
              storeName: seed.storeName,
              items: items.map((i) => i.view),
            },
          };
        } catch {
          return { status: 'blocked', reason: 'STORAGE_UNAVAILABLE' };
        } finally {
          busy = false;
        }
      }),
    start: (input) =>
      track(async () => {
        const parsed = BatchStartInputSchema.safeParse(input);
        if (!parsed.success) return result('INPUT_UNSUPPORTED');
        try {
          const existing = deps.repository.findRequest(
            parsed.data.requestId,
            parsed.data.preparationId,
          );
          if (existing) return { status: 'ok', view: existing };
        } catch {
          return result('INPUT_UNSUPPORTED');
        }
        const reason = gate();
        if (reason) return result(reason);
        if (busy || running || occupied()) return result('PLATFORM_BUSY');
        const chosen = prepared;
        if (
          !chosen ||
          chosen.seed.preparationId !== parsed.data.preparationId ||
          Date.parse(deps.now()) >= chosen.expires
        )
          return result('STALE_PREPARATION');
        busy = true;
        const ticket = epoch;
        try {
          const versionsMatch = () =>
            chosen.versions.every((version) => {
              const article = deps.articles.loadEditableArticle(
                version.articleKey,
              );
              const cover = deps.articles.loadCover(version.articleKey);
              return (
                article?.articleRevision === version.articleRevision &&
                cover?.coverRevision === version.coverRevision &&
                cover?.configurationDigest === version.digest
              );
            });
          if (!versionsMatch()) return result('STALE_PREPARATION');
          for (const item of chosen.seed.items) {
            if (!item.reservation) continue;
            const value = item.reservation;
            const current = deps.articles.loadEditableArticle(
              item.view.articleKey,
            );
            const cover = deps.articles.loadCover(item.view.articleKey);
            if (
              current?.articleRevision !== value.expectedArticleRevision ||
              cover?.configurationDigest !== value.coverSnapshot?.digest ||
              cover?.coverRevision !== value.expectedCoverRevision
            )
              return result('STALE_PREPARATION');
            await deps.snapshots.verify(value.snapshot);
            if (ticket !== epoch || stopping) return result('STOP_REQUESTED');
          }
          const checked = await deps.draft.checkDraftSession();
          if (ticket !== epoch || stopping) return result('STOP_REQUESTED');
          if (checked.status === 'blocked') return result(checked.reason);
          for (const item of chosen.seed.items) {
            if (
              item.reservation &&
              !deps.preparation.take(item.reservation.preparationId)
            )
              return result('STALE_PREPARATION');
          }
          const after = gate();
          if (after) return result(after);
          if (!versionsMatch()) return result('STALE_PREPARATION');
          const created = deps.repository.create({
            ...chosen.seed,
            requestId: parsed.data.requestId,
          });
          prepared = undefined;
          stopping = false;
          const flight = loop(created.id, chosen.generation);
          running = flight;
          void flight.finally(() => {
            if (running === flight) running = undefined;
          });
          return { status: 'ok', view: deps.repository.get(created.id) };
        } catch {
          return result('STORAGE_UNAVAILABLE');
        } finally {
          busy = false;
        }
      }),
    stop(input) {
      const parsed = BatchIdentityInputSchema.safeParse(input);
      if (!parsed.success || view()?.id !== parsed.data.batchId)
        return Promise.resolve(result('INPUT_UNSUPPORTED'));
      requestStop();
      return Promise.resolve(
        result(storageFailed ? 'STORAGE_UNAVAILABLE' : undefined),
      );
    },
    async archiveFinishedBatch(input) {
      const parsed = BatchIdentityInputSchema.safeParse(input);
      if (!parsed.success) return result('INPUT_UNSUPPORTED');
      if (
        running ||
        busy ||
        pending.size ||
        deps.draft.isActive() ||
        deps.draft.isBlocked()
      )
        return result('PLATFORM_BUSY');
      if (storageFailed) return result('STORAGE_UNAVAILABLE');
      const current = view();
      if (
        !current ||
        current.id !== parsed.data.batchId ||
        !['stopped', 'completed'].includes(current.state)
      )
        return result('INPUT_UNSUPPORTED');
      try {
        deps.repository.archiveFinished(
          current.id,
          current.revision,
          deps.now(),
        );
        prepared = undefined;
        epoch++;
        return result();
      } catch {
        return result('PLATFORM_BUSY');
      }
    },
    async finish(input) {
      const parsed = BatchIdentityInputSchema.safeParse(input);
      if (!parsed.success) return result('INPUT_UNSUPPORTED');
      if (running || busy) return result('PLATFORM_BUSY');
      const current = deps.repository.get(parsed.data.batchId);
      if (!current) return result('INPUT_UNSUPPORTED');
      deps.repository.finish(current.id, current.revision, deps.now());
      return result();
    },
  };
  try {
    deps.repository.recover(deps.now());
  } catch {
    storageFailed = true;
  }
  return api;
}
