import {
  AdapterOutcomeSchema,
  DraftAbsenceResultSchema,
  DraftViewSchema,
  ReasonCodeSchema,
  SessionProbeSchema,
  type AdapterOutcome,
  type DraftApi,
  type DraftCommandResult,
  type DraftTask,
  type DraftView,
  type PreparationView,
  type ReasonCode,
  type SessionProbe,
  type SessionView,
  type TaskEvent,
  type TaskView,
  type TaskClosureProof,
  type TaskClosureView,
} from '../contracts/draft-task';
import { coverSummary, coverReportView } from '../contracts/cover-task';
import { StorageIdSchema } from '../contracts/stored-article';
import { canCloseWithoutSave, canCloseAfterReview } from '../domain/draft-task';
import type { DraftPreparation } from './draft-preparation';
import type {
  DraftTaskRepository,
  SnapshotPort,
  DraftPlatform,
} from '../domain/ports/draft-task';

export interface DraftController extends DraftApi {
  /** Main/application only: executes an atomically linked, freshly queued task. */
  executeBatchTask(taskId: string, generation: string): Promise<DraftTask>;
  requestStop(): void;
  /** Explicit user stop: close the owned browser, drain writers, retain results and release admission. */
  stopForRestart(): Promise<void>;
  isActive(): boolean;
  isBlocked(): boolean;
  stopAndWait(): Promise<void>;
}
const terminal = (task: DraftTask) =>
  [
    'draft_saved',
    'submission_recorded',
    'failed',
    'stopped',
    'closed_without_save',
    'closed_after_review',
    'stopped_by_user',
  ].includes(task.state);
const localReasons = new Set<ReasonCode>([
  'INPUT_UNSUPPORTED',
  'TITLE_UNSUPPORTED',
  'IMAGE_FORMAT_UNSUPPORTED',
  'IMAGE_SIZE_UNSUPPORTED',
  'ASSET_UNAVAILABLE',
]);

export function createDraftController(deps: {
  tasks: DraftTaskRepository;
  preparation: DraftPreparation;
  snapshots: SnapshotPort;
  platform: DraftPlatform;
  newId: () => string;
  now: () => string;
  gate: () => 'ready' | 'busy' | 'unavailable';
  controlledPilot?: {
    /** Historical recovery only; normal execution uses the selected preparation. */
    reviewedTitle?: string;
    reviewedTaskId?: string;
    reviewedEmptyEditorTaskId?: string;
    reviewedUnsavedBodyTaskId?: string;
    reviewedUnsavedBodyImageCount?: number;
    reviewedAmbiguousSave?: {
      taskId: string;
      revision: number;
      snapshotDigest: string;
      title: string;
      storeKey: string;
    };
    storeIdentity: string;
  };
}): DraftController {
  let session: SessionView = {
    status: 'closed',
    bindingToken: null,
    storeName: null,
    reason: null,
  };
  let preparation: PreparationView | null = null;
  let cached: DraftTask | undefined;
  let storageFailed = false;
  let closing = false;
  let shutdown = false;
  let closeFlight: Promise<DraftCommandResult> | undefined;
  let epoch = 0;
  let browserBusy = false;
  let execution: Promise<void> | undefined;
  const stopped = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let closure:
    | { view: TaskClosureView; proof: TaskClosureProof; epoch: number }
    | undefined;

  function invalidate() {
    closure = undefined;
    deps.preparation.invalidate();
    preparation = null;
  }
  function storageFailure() {
    storageFailed = true;
    invalidate();
    session = {
      status: 'blocked',
      bindingToken: null,
      storeName: null,
      reason: 'STORAGE_UNAVAILABLE',
    };
  }
  function read<T>(fn: () => T): T {
    try {
      return fn();
    } catch {
      storageFailure();
      throw new Error('STORAGE_UNAVAILABLE');
    }
  }
  function get(id: string) {
    const task = read(() => deps.tasks.get(id));
    if (task) cached = task;
    return task;
  }
  function current() {
    const task = read(() => deps.tasks.occupied() ?? deps.tasks.latest());
    if (task) cached = task;
    return task;
  }
  function apply(id: string, event: TaskEvent) {
    if (storageFailed) throw new Error('STORAGE_UNAVAILABLE');
    const task = get(id);
    if (!task) throw new Error('INPUT_UNSUPPORTED');
    try {
      cached = deps.tasks.apply(id, task.revision, event, deps.now());
      return cached;
    } catch {
      // A conflict grants no permission to replay an action. Refresh once for the
      // projection, then fail closed just like any other failed durable write.
      try {
        cached = deps.tasks.get(id) ?? cached;
      } catch {
        /* retain last safe projection */
      }
      storageFailure();
      throw new Error('STORAGE_UNAVAILABLE');
    }
  }
  function project(task: DraftTask): TaskView {
    return {
      ...(task.evidence.submission
        ? { submission: task.evidence.submission }
        : {}),
      ...(deps.controlledPilot
        ? {
            manualReview: true,
            preEntryReviewed: reviewedBeforeEntry(task),
            emptyEditorReviewed: reviewedEmptyEditor(task),
            unsavedBodyReviewed: reviewedUnsavedBody(task),
            ambiguousSaveReviewed: reviewedAmbiguousSave(task),
          }
        : {}),
      ...(task.coverPlan
        ? {
            coverSummary: coverSummary(task.coverPlan.snapshot),
            coverReport: coverReportView(task.coverPlan.report),
          }
        : {}),
      taskId: task.taskId,
      articleKey: task.articleKey,
      title: task.snapshot.article.title,
      storeName: task.store.displayName,
      state: task.state,
      stage: task.stage,
      revision: task.revision,
      possibleRemoteEffect: task.possibleRemoteEffect,
      stopRequested: task.stopRequested || stopped.has(task.taskId),
      platformPaused:
        storageFailed ||
        task.state === 'needs_human' ||
        task.state === 'interrupted',
      reason: storageFailed ? 'STORAGE_UNAVAILABLE' : task.reason,
      canOpenDraft: !storageFailed && task.state === 'draft_saved',
      canCloseTask:
        !storageFailed &&
        (canCloseWithoutSave(task, reviewedUnsavedBody(task)) ||
          reviewedAmbiguousSave(task)),
    };
  }
  function view(): DraftView {
    try {
      current();
    } catch {
      /* surfaced by fixed storage projection */
    }
    return DraftViewSchema.parse({
      session,
      preparation,
      task: cached ? project(cached) : null,
    });
  }
  function result(
    reason?: ReasonCode,
    selected?: DraftTask,
  ): DraftCommandResult {
    const value = view();
    if (selected) value.task = project(selected);
    const effective = storageFailed ? 'STORAGE_UNAVAILABLE' : reason;
    return effective
      ? { status: 'blocked', reason: effective, view: value }
      : { status: 'ok', view: value };
  }
  function gateReason(): ReasonCode | undefined {
    if (storageFailed) return 'STORAGE_UNAVAILABLE';
    if (closing) return 'STOP_REQUESTED';
    const gate = deps.gate();
    return gate === 'busy'
      ? 'PLATFORM_BUSY'
      : gate === 'unavailable'
        ? 'STORAGE_UNAVAILABLE'
        : undefined;
  }
  function track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation();
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }
  function offered(probe: SessionProbe) {
    const old = session.bindingToken;
    session = deps.preparation.offer(probe);
    if (old !== session.bindingToken || probe.status === 'blocked') {
      preparation = null;
      closure = undefined;
    }
  }
  async function probe(
    open = false,
    contextOnly = false,
  ): Promise<SessionProbe> {
    try {
      return SessionProbeSchema.parse(
        await (open
          ? deps.platform.openSession()
          : contextOnly
            ? deps.platform.checkSession(true)
            : deps.platform.checkSession()),
      );
    } catch {
      return { status: 'blocked', reason: 'BROWSER_UNAVAILABLE' };
    }
  }
  function sameStore(
    task: Pick<DraftTask, 'store'>,
    value: SessionProbe,
  ): boolean {
    return (
      value.status === 'ready' &&
      value.store.storeKey === task.store.storeKey &&
      value.store.identity.source === task.store.identity.source &&
      value.store.identity.value === task.store.identity.value
    );
  }
  function isStopped(id: string) {
    return (
      closing ||
      storageFailed ||
      stopped.has(id) ||
      get(id)?.stopRequested === true
    );
  }
  function assertEffect(id: string) {
    const reason = gateReason();
    if (reason || isStopped(id)) throw new Error(reason ?? 'STOP_REQUESTED');
  }
  function settle(id: string, outcome: AdapterOutcome) {
    if (storageFailed) return;
    let task = get(id)!;
    if (terminal(task)) return;
    if (outcome.coverReport)
      apply(id, { type: 'cover_report', report: outcome.coverReport });
    if (outcome.status === 'submission_recorded') {
      if (task.stopRequested || stopped.has(id)) {
        apply(id, {
          type: 'settle',
          state: 'needs_human',
          reason: 'STOP_REQUESTED',
        });
        return;
      }
      apply(id, { type: 'evidence', evidence: outcome.evidence });
      apply(id, { type: 'record-submission', submission: outcome.submission });
      return;
    }
    if (outcome.status === 'verified') {
      apply(id, { type: 'evidence', evidence: outcome.evidence });
      task = get(id)!;
      if (task.state === 'running' && task.stage !== 'verify')
        apply(id, { type: 'verify' });
      apply(id, { type: 'settle', state: 'draft_saved', reason: null });
      return;
    }
    const stop = task.stopRequested || stopped.has(id);
    const local = localReasons.has(outcome.reason);
    const state = task.possibleRemoteEffect
      ? 'needs_human'
      : (outcome.reason === 'STOP_REQUESTED' || local) && stop
        ? 'stopped'
        : local
          ? 'failed'
          : 'needs_human';
    apply(id, { type: 'settle', state, reason: outcome.reason });
  }
  async function execute(task: DraftTask, operatorSubmissionReview = false) {
    try {
      const outcome = AdapterOutcomeSchema.parse(
        await deps.platform.execute(task, {
          ...(operatorSubmissionReview
            ? { batchSubmissionReview: 'operator' as const }
            : {}),
          stopped: () => {
            try {
              return isStopped(task.taskId) || !!gateReason();
            } catch {
              return true;
            }
          },
          checkpoint: async (stage) => {
            assertEffect(task.taskId);
            apply(
              task.taskId,
              stage === 'save'
                ? { type: 'before-save' }
                : { type: 'before-effect', stage },
            );
            assertEffect(task.taskId);
          },
          // Readonly verification is allowed after a stop, but never after a lost
          // durable checkpoint. It does not grant permission for further effects.
          verifying: async () => {
            apply(task.taskId, { type: 'verify' });
          },
          evidence: async (evidence) => {
            apply(task.taskId, { type: 'evidence', evidence });
          },
          coverReport: async (report) => {
            apply(task.taskId, { type: 'cover_report', report });
          },
          readCoverImage: async (assetKey) => {
            assertEffect(task.taskId);
            if (!task.coverPlan) throw Error('Invalid cover task');
            let bytes: Uint8Array;
            try {
              bytes = await deps.snapshots.readCoverImage(
                task.coverPlan.snapshot,
                assetKey,
              );
            } catch (error) {
              if (!(
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'IMAGE_UNAVAILABLE'
              ))
                storageFailure();
              throw error;
            }
            assertEffect(task.taskId);
            return bytes;
          },
          readImage: async (assetKey) => {
            assertEffect(task.taskId);
            const bytes = await deps.snapshots.readImage(
              task.snapshot,
              assetKey,
            );
            assertEffect(task.taskId);
            return bytes;
          },
        }),
      );
      settle(task.taskId, outcome);
    } catch {
      if (!storageFailed) {
        try {
          settle(task.taskId, { status: 'blocked', reason: 'PAGE_CHANGED' });
        } catch {
          /* latched by apply */
        }
      }
    }
  }
  function sessionCommand(open: boolean) {
    closure = undefined;
    return track(async () => {
      const reason = gateReason();
      if (reason) return result(reason);
      if (browserBusy || execution) return result('PLATFORM_BUSY');
      const ticket = epoch;
      browserBusy = true;
      try {
        const value = await probe(open);
        if (ticket !== epoch || gateReason())
          return result(gateReason() ?? 'STOP_REQUESTED');
        offered(value);
        return result(value.status === 'blocked' ? value.reason : undefined);
      } finally {
        browserBusy = false;
      }
    });
  }
  async function drain() {
    closing = true;
    epoch++;
    invalidate();
    try {
      const task = current();
      if (task && !terminal(task)) {
        stopped.add(task.taskId);
        if (!task.stopRequested && !storageFailed)
          apply(task.taskId, { type: 'stop' });
      }
    } catch {
      /* storage latch still stops all future effects */
    }
    await Promise.allSettled([...pending]);
    await execution;
  }
  async function stopAndWait() {
    shutdown = true;
    await drain();
    await closeFlight;
  }
  async function closureProof(
    task: DraftTask,
    generation: string,
    since: string,
  ): Promise<TaskClosureProof> {
    const basis = reviewedAmbiguousSave(task)
      ? ('owner-reviewed-ambiguous-save' as const)
      : reviewedBeforeEntry(task)
        ? ('owner-reviewed-before-entry' as const)
        : reviewedEmptyEditor(task)
          ? ('owner-reviewed-empty-editor' as const)
          : reviewedUnsavedBody(task)
            ? ('owner-reviewed-unsaved-body' as const)
            : undefined;
    if (basis)
      return {
        basis,
        taskId: task.taskId,
        revision: task.revision,
        snapshotDigest: task.snapshot.digest,
        storeKey: task.store.storeKey,
        generation,
        checkedAt: deps.now(),
      };
    const value = DraftAbsenceResultSchema.parse(
      await deps.platform.checkAbsence(task),
    );
    if (value.status === 'blocked') throw new Error(value.reason);
    const proof = value.proof;
    if (
      proof.taskId !== task.taskId ||
      proof.revision !== task.revision ||
      proof.snapshotDigest !== task.snapshot.digest ||
      proof.storeKey !== task.store.storeKey ||
      proof.generation !== generation ||
      Date.parse(proof.checkedAt) < Date.parse(since) ||
      Date.parse(proof.checkedAt) > Date.parse(deps.now())
    )
      throw new Error('RESULT_AMBIGUOUS');
    return proof;
  }
  function closureTask(id: string, revision?: number) {
    const task = get(id);
    if (
      !task ||
      !(
        canCloseWithoutSave(task, reviewedUnsavedBody(task)) ||
        reviewedAmbiguousSave(task)
      ) ||
      closing ||
      (revision !== undefined && task.revision !== revision)
    )
      throw new Error('RESULT_AMBIGUOUS');
    return task;
  }
  function reviewedAmbiguousSave(task: DraftTask): boolean {
    const approval = deps.controlledPilot?.reviewedAmbiguousSave;
    return (
      !!approval &&
      canCloseAfterReview(task) &&
      task.taskId === approval.taskId &&
      task.revision === approval.revision &&
      task.snapshot.digest === approval.snapshotDigest &&
      task.snapshot.article.title === approval.title &&
      task.store.storeKey === approval.storeKey &&
      task.store.identity.value === deps.controlledPilot?.storeIdentity
    );
  }
  function reviewedEmptyEditor(task: DraftTask): boolean {
    return reviewedTask(task, deps.controlledPilot?.reviewedEmptyEditorTaskId);
  }
  function reviewedBeforeEntry(task: DraftTask): boolean {
    return reviewedTask(task, deps.controlledPilot?.reviewedTaskId);
  }
  function reviewedUnsavedBody(task: DraftTask): boolean {
    return (
      task.stage === 'settled' &&
      task.possibleRemoteEffect &&
      reviewedTask(
        task,
        deps.controlledPilot?.reviewedUnsavedBodyTaskId,
        deps.controlledPilot?.reviewedUnsavedBodyImageCount ?? 0,
      )
    );
  }
  function reviewedTask(
    task: DraftTask,
    approvedTaskId: string | undefined,
    expectedImageCount = 0,
  ): boolean {
    const approval = deps.controlledPilot;
    return (
      !!approval &&
      task.taskId === approvedTaskId &&
      task.snapshot.article.title === approval.reviewedTitle &&
      task.store.identity.value === approval.storeIdentity &&
      !task.saveAttempted &&
      !task.evidence.remote &&
      !task.evidence.cover &&
      task.evidence.images.length === expectedImageCount
    );
  }
  function closureError(error: unknown) {
    const parsed =
      error instanceof Error
        ? ReasonCodeSchema.safeParse(error.message)
        : undefined;
    return result(
      storageFailed
        ? 'STORAGE_UNAVAILABLE'
        : parsed?.success
          ? parsed.data
          : 'RESULT_AMBIGUOUS',
    );
  }
  try {
    read(() => deps.tasks.recover(deps.now()));
    current();
  } catch {
    /* no browser startup on recovery failure */
  }

  return {
    executeBatchTask: (taskId, generation) =>
      track(async () => {
        const task = get(StorageIdSchema.parse(taskId));
        if (!task || task.state !== 'queued' || browserBusy || execution)
          throw Error('Batch task is not newly reserved');
        const ticket = epoch;
        browserBusy = true;
        const block = (reason: ReasonCode) => {
          settle(taskId, { status: 'blocked', reason });
          return get(taskId)!;
        };
        try {
          const reason = gateReason();
          if (reason || isStopped(taskId))
            return block(reason ?? 'STOP_REQUESTED');
          if (
            deps.controlledPilot &&
            task.store.identity.value !== deps.controlledPilot.storeIdentity
          )
            return block('STORE_CHANGED');
          const first = await probe(false, !!deps.controlledPilot);
          if (ticket !== epoch || isStopped(taskId))
            return block('STOP_REQUESTED');
          if (first.status === 'blocked') return block(first.reason);
          if (!sameStore(task, first)) return block('STORE_CHANGED');
          if (first.generation !== generation)
            return block('STALE_PREPARATION');
          try {
            await deps.snapshots.verify(task.snapshot);
          } catch (error) {
            const parsed =
              typeof error === 'object' && error !== null && 'code' in error
                ? ReasonCodeSchema.safeParse(error.code)
                : undefined;
            return block(
              parsed?.success && localReasons.has(parsed.data)
                ? parsed.data
                : 'ASSET_UNAVAILABLE',
            );
          }
          if (ticket !== epoch || isStopped(taskId))
            return block('STOP_REQUESTED');
          const last = await probe(false, !!deps.controlledPilot);
          if (ticket !== epoch || isStopped(taskId))
            return block('STOP_REQUESTED');
          if (last.status === 'blocked') return block(last.reason);
          if (!sameStore(task, last)) return block('STORE_CHANGED');
          if (last.generation !== generation) return block('STALE_PREPARATION');
          const finalGate = gateReason();
          if (finalGate) return block(finalGate);
          const runningTask = apply(taskId, { type: 'begin' });
          invalidate();
          // Retire consumed summaries, then retain the just-verified session
          // under a fresh binding for the next article. No extra browser probe.
          offered(last);
          const running = execute(runningTask, true);
          execution = running;
          try {
            await running;
          } finally {
            if (execution === running) execution = undefined;
          }
          return get(taskId)!;
        } finally {
          browserBusy = false;
        }
      }),
    requestStop() {
      epoch++;
      invalidate();
      const task = current();
      if (task && !terminal(task)) {
        stopped.add(task.taskId);
        if (!task.stopRequested && !storageFailed)
          apply(task.taskId, { type: 'stop' });
      }
    },
    isActive: () => !!execution || !!closeFlight || pending.size > 0,
    isBlocked: () => {
      try {
        return storageFailed || closing || !!current()?.holdsPlatform;
      } catch {
        return true;
      }
    },
    stopAndWait,
    async stopForRestart() {
      // Closing admission is synchronous. Closing the owned session also interrupts
      // a pending browser operation; never release a task while its writer is alive.
      const drained = drain();
      try {
        await deps.platform.closeSession();
        await drained;
        await closeFlight;
        if (storageFailed) throw Error('Storage unavailable');
        const task = current();
        if (
          task &&
          (!terminal(task) || ['failed', 'stopped'].includes(task.state))
        )
          apply(task.taskId, { type: 'release-after-stop' });
        session = {
          status: 'closed',
          bindingToken: null,
          storeName: null,
          reason: null,
        };
      } finally {
        await drained;
        closing = shutdown;
      }
    },
    prepareTaskClosure: (taskId) =>
      track(async () => {
        closure = undefined;
        const reason = gateReason();
        if (reason) return result(reason);
        if (browserBusy || execution) return result('PLATFORM_BUSY');
        browserBusy = true;
        const ticket = epoch;
        try {
          if (!StorageIdSchema.safeParse(taskId).success)
            return result('INPUT_UNSUPPORTED');
          const task = closureTask(taskId);
          const since = deps.now();
          const value = await probe();
          offered(value);
          if (value.status === 'blocked') return result(value.reason);
          if (!sameStore(task, value)) return result('STORE_CHANGED');
          const proof = await closureProof(task, value.generation, since);
          if (ticket !== epoch || gateReason())
            return result(gateReason() ?? 'STOP_REQUESTED');
          closureTask(taskId, task.revision);
          const summary: TaskClosureView = {
            ...(proof.basis ? { basis: proof.basis } : {}),
            token: deps.newId(),
            taskId,
            revision: task.revision,
            title: task.snapshot.article.title,
            storeName: task.store.displayName,
            expiresAt: new Date(Date.parse(deps.now()) + 120000).toISOString(),
          };
          closure = { view: summary, proof, epoch: ticket };
          const response = result();
          return response.status === 'ok'
            ? { ...response, closure: summary }
            : response;
        } catch (error) {
          return closureError(error);
        } finally {
          browserBusy = false;
        }
      }),
    confirmTaskClosure: (token) =>
      track(async () => {
        const requested = closure;
        closure = undefined; // Consume before any await; failed confirmation cannot be replayed.
        const reason = gateReason();
        if (reason) return result(reason);
        if (browserBusy || execution) return result('PLATFORM_BUSY');
        if (
          !requested ||
          requested.view.token !== token ||
          requested.epoch !== epoch ||
          Date.parse(deps.now()) >= Date.parse(requested.view.expiresAt)
        )
          return result('STALE_PREPARATION');
        browserBusy = true;
        try {
          const task = closureTask(
            requested.view.taskId,
            requested.view.revision,
          );
          if (
            task.snapshot.digest !== requested.proof.snapshotDigest ||
            task.store.storeKey !== requested.proof.storeKey
          )
            return result('STALE_PREPARATION');
          const confirmedAt = deps.now();
          const value = await probe();
          offered(value);
          if (value.status === 'blocked') return result(value.reason);
          if (!sameStore(task, value)) return result('STORE_CHANGED');
          if (value.generation !== requested.proof.generation)
            return result('STALE_PREPARATION');
          const proof = await closureProof(task, value.generation, confirmedAt);
          if (requested.epoch !== epoch || gateReason())
            return result(gateReason() ?? 'STOP_REQUESTED');
          if (Date.parse(deps.now()) >= Date.parse(requested.view.expiresAt))
            return result('STALE_PREPARATION');
          closureTask(task.taskId, task.revision);
          apply(
            task.taskId,
            proof.basis === 'owner-reviewed-ambiguous-save'
              ? {
                  type: 'close-after-review',
                  proof: { ...proof, basis: 'owner-reviewed-ambiguous-save' },
                  confirmedAt,
                }
              : { type: 'close-without-save', proof, confirmedAt },
          );
          invalidate();
          return result();
        } catch (error) {
          return closureError(error);
        } finally {
          browserBusy = false;
        }
      }),
    getDraftState: async () => view(),
    openDraftSession: () => sessionCommand(true),
    checkDraftSession: () => sessionCommand(false),
    closeDraftSession: () => {
      if (closeFlight) return closeFlight;
      const flight = (async () => {
        await drain();
        try {
          await deps.platform.closeSession();
        } catch {
          return result('BROWSER_UNAVAILABLE');
        } finally {
          closing = shutdown;
        }
        if (!storageFailed)
          session = {
            status: 'closed',
            bindingToken: null,
            storeName: null,
            reason: null,
          };
        return result();
      })();
      closeFlight = flight;
      void flight.finally(() => {
        if (closeFlight === flight) closeFlight = undefined;
      });
      return flight;
    },
    prepareDraft: (articleKey, bindingToken, intent) =>
      track(async () => {
        const reason = gateReason();
        if (reason) return { status: 'blocked', reason };
        const ticket = epoch;
        try {
          const prepared = await deps.preparation.prepare(
            articleKey,
            bindingToken,
            intent,
          );
          const after = gateReason();
          if (after || ticket !== epoch)
            return { status: 'blocked', reason: after ?? 'STALE_PREPARATION' };
          if (
            prepared.status === 'blocked' &&
            prepared.reason === 'STORAGE_UNAVAILABLE'
          )
            storageFailure();
          preparation = null;
          if (prepared.status === 'ready') {
            if (deps.controlledPilot) prepared.preparation.manualReview = true;
            preparation = prepared.preparation;
          }
          return prepared;
        } catch {
          storageFailure();
          return { status: 'blocked', reason: 'STORAGE_UNAVAILABLE' };
        }
      }),
    startDraft: (preparationId) =>
      track(async () => {
        try {
          if (!StorageIdSchema.safeParse(preparationId).success)
            return result('STALE_PREPARATION');
          const existing = read(() =>
            deps.tasks.findPreparation(preparationId),
          );
          if (existing) {
            cached = existing;
            return result(undefined, existing);
          }
          const reason = gateReason();
          if (reason) return result(reason);
          if (browserBusy || execution || read(() => deps.tasks.occupied()))
            return result('PLATFORM_BUSY');
          const prepared = deps.preparation.take(preparationId);
          if (!prepared) return result('STALE_PREPARATION');
          if (!prepared.coverSnapshot) {
            storageFailure();
            return result('STORAGE_UNAVAILABLE');
          }
          if (
            preparation?.preparationId !== preparationId ||
            preparation.title !== prepared.snapshot.article.title ||
            preparation.contentDeclaration !==
              prepared.snapshot.article.contentDeclaration ||
            preparation.bodyImageCount !==
              prepared.snapshot.article.body.filter(
                (block) => block.type === 'image',
              ).length
          )
            return result('STALE_PREPARATION');
          if (
            deps.controlledPilot &&
            prepared.store.identity.value !== deps.controlledPilot.storeIdentity
          )
            return result('STORE_CHANGED');
          const ticket = epoch;
          browserBusy = true;
          try {
            const value = await probe(false, !!deps.controlledPilot);
            if (ticket !== epoch || gateReason())
              return result(gateReason() ?? 'STOP_REQUESTED');
            offered(value);
            if (value.status === 'blocked') return result(value.reason);
            if (!sameStore(prepared, value)) return result('STORE_CHANGED');
            if (
              value.generation !== prepared.generation ||
              !deps.preparation.take(preparationId)
            )
              return result('STALE_PREPARATION');
            try {
              await deps.snapshots.verify(prepared.snapshot);
            } catch (error) {
              const code =
                typeof error === 'object' && error !== null && 'code' in error
                  ? ReasonCodeSchema.safeParse(error.code)
                  : undefined;
              return result(
                code?.success && localReasons.has(code.data)
                  ? code.data
                  : 'ASSET_UNAVAILABLE',
              );
            }
            if (ticket !== epoch || gateReason())
              return result(gateReason() ?? 'STOP_REQUESTED');
            if (
              preparation?.preparationId !== preparationId ||
              !deps.preparation.take(preparationId)
            )
              return result('STALE_PREPARATION');
            // Recheck session after asset IO; generation/store changes cannot be
            // hidden by a previously successful check.
            const finalProbe = await probe(false, !!deps.controlledPilot);
            if (ticket !== epoch || gateReason())
              return result(gateReason() ?? 'STOP_REQUESTED');
            offered(finalProbe);
            if (finalProbe.status === 'blocked')
              return result(finalProbe.reason);
            if (!sameStore(prepared, finalProbe))
              return result('STORE_CHANGED');
            if (
              finalProbe.generation !== prepared.generation ||
              preparation?.preparationId !== preparationId ||
              !deps.preparation.take(preparationId)
            )
              return result('STALE_PREPARATION');
            const reserved = read(() =>
              deps.tasks.reserve({
                taskId: deps.newId(),
                preparationId,
                expectedArticleRevision: prepared.articleRevision,
                expectedCoverRevision: prepared.coverSnapshot.coverRevision,
                coverSnapshot: prepared.coverSnapshot,
                snapshot: prepared.snapshot,
                store: prepared.store,
                now: deps.now(),
              }),
            );
            if (reserved.status === 'stale') return result('STALE_PREPARATION');
            cached = reserved.task;
            if (reserved.status === 'blocked') return result('PLATFORM_BUSY');
            if (reserved.status === 'existing')
              return result(undefined, reserved.task);
            const task = apply(reserved.task.taskId, { type: 'begin' });
            invalidate();
            // Keep the UI and preparation service on the same fresh binding.
            offered(finalProbe);
            // Both normal single and batch entries use operator review when the
            // production page capability supports it. No remote list gate.
            const running = execute(task, true);
            execution = running;
            void running.finally(() => {
              if (execution === running) execution = undefined;
            });
            return result();
          } finally {
            browserBusy = false;
          }
        } catch {
          return result(storageFailed ? 'STORAGE_UNAVAILABLE' : 'PAGE_CHANGED');
        }
      }),
    stopDraft: async (taskId) => {
      closure = undefined;
      epoch++;
      // The in-memory stop is synchronous and precedes all storage or awaits.
      stopped.add(taskId);
      try {
        const task = get(taskId);
        if (!task) {
          stopped.delete(taskId);
          return result('INPUT_UNSUPPORTED');
        }
        if (terminal(task)) {
          stopped.delete(taskId);
          return result(undefined, task);
        }
        if (!terminal(task) && !task.stopRequested && !storageFailed)
          apply(taskId, { type: 'stop' });
        return result();
      } catch {
        return result('STORAGE_UNAVAILABLE');
      }
    },
    reconcileDraft: (taskId) =>
      track(async () => {
        try {
          const reason = gateReason();
          if (reason) return result(reason);
          if (browserBusy || execution) return result('PLATFORM_BUSY');
          const task = get(taskId);
          if (!task) return result('INPUT_UNSUPPORTED');
          if (terminal(task)) return result();
          if (reviewedAmbiguousSave(task)) return result('RESULT_AMBIGUOUS');
          const ticket = epoch;
          browserBusy = true;
          try {
            const value = await probe();
            if (ticket !== epoch || gateReason())
              return result(gateReason() ?? 'STOP_REQUESTED');
            offered(value);
            if (value.status === 'blocked') return result(value.reason);
            if (!sameStore(task, value)) return result('STORE_CHANGED');
            const checked = get(taskId)!;
            if (!checked.possibleRemoteEffect) {
              apply(taskId, {
                type: 'settle',
                state: checked.stopRequested ? 'stopped' : 'failed',
                reason: checked.stopRequested
                  ? 'STOP_REQUESTED'
                  : 'INTERRUPTED',
              });
              return result();
            }
            const outcome = AdapterOutcomeSchema.parse(
              await deps.platform.reconcile(task),
            );
            if (storageFailed) return result('STORAGE_UNAVAILABLE');
            settle(taskId, outcome);
            return result(
              outcome.status === 'blocked' && get(taskId)?.holdsPlatform
                ? outcome.reason
                : undefined,
            );
          } finally {
            browserBusy = false;
          }
        } catch {
          return result(storageFailed ? 'STORAGE_UNAVAILABLE' : 'PAGE_CHANGED');
        }
      }),
    openSavedDraft: (taskId) =>
      track(async () => {
        try {
          const reason = gateReason();
          if (reason) return result(reason);
          if (browserBusy || execution) return result('PLATFORM_BUSY');
          const task = get(taskId);
          if (!task || task.state !== 'draft_saved')
            return result('INPUT_UNSUPPORTED');
          const ticket = epoch;
          browserBusy = true;
          try {
            const value = await probe();
            if (ticket !== epoch || gateReason())
              return result(gateReason() ?? 'STOP_REQUESTED');
            offered(value);
            if (value.status === 'blocked') return result(value.reason);
            if (!sameStore(task, value)) return result('STORE_CHANGED');
            await deps.platform.openVerified(task);
            return result();
          } finally {
            browserBusy = false;
          }
        } catch {
          return result(storageFailed ? 'STORAGE_UNAVAILABLE' : 'PAGE_CHANGED');
        }
      }),
  };
}
