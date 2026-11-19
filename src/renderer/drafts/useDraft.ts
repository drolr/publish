import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DraftViewSchema,
  type DraftView,
  type DraftCommandResult,
  type PrepareResult,
  type TaskView,
} from '../../contracts/draft-task';
// Share outstanding reads across StrictMode mounts. A timed-out read still owns
// its bridge request until it settles; do not launch overlapping queries.
let stateRead: Promise<DraftView> | undefined;
function readState() {
  if (!stateRead) {
    const pending = Promise.resolve()
      .then(() => window.desktopApi.getDraftState())
      .then((value) => DraftViewSchema.parse(value))
      .finally(() => {
        if (stateRead === pending) stateRead = undefined;
      });
    stateRead = pending;
  }
  return stateRead;
}
const active = (view: DraftView | null) =>
  view?.task?.state === 'running' ||
  view?.task?.state === 'queued' ||
  view?.session.status === 'opening';
const occupied = (task: TaskView | null) =>
  !!task &&
  (['queued', 'running', 'needs_human', 'interrupted'].includes(task.state) ||
    task.platformPaused);
export function useDraft(
  articleKey?: string,
  operationsBlocked = false,
  resetRevision = 0,
  preparationContext = '',
): {
  view: DraftView | null;
  unknown: boolean;
  run: (
    command: () => Promise<DraftCommandResult | PrepareResult>,
    kind?: 'start' | 'control',
  ) => Promise<void>;
} {
  const [view, setView] = useState<DraftView | null>(null);
  const [unknown, setUnknown] = useState(false);
  // This is a selected result returned by main, not the canonical platform lane.
  const [existing, setExisting] = useState<TaskView | null>(null);
  // Renew the identity on every context change, even A -> B -> A. Running
  // task projections remain canonical; only preparation authorization is local.
  const selection = useRef({ articleKey, preparationContext, resetRevision });
  if (
    selection.current.articleKey !== articleKey ||
    selection.current.preparationContext !== preparationContext ||
    selection.current.resetRevision !== resetRevision
  )
    selection.current = { articleKey, preparationContext, resetRevision };
  const authorizedPreparation = useRef<{
    id: string;
    selection: typeof selection.current;
  } | null>(null);
  useEffect(() => {
    setExisting(null);
  }, [articleKey, preparationContext, resetRevision]);
  const latest = useRef<DraftView | null>(null);
  const sequence = useRef(0);
  const alive = useRef(false);
  const busy = useRef(false);
  const resetEpoch = useRef(0);
  const reading = useRef(false);
  const readAgain = useRef(false);
  const uncertain = useRef(false);
  const unresolved = useRef(new Map<number, TaskView | null>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const query = useRef<() => Promise<void>>(async () => {});
  const markUnknown = useCallback(() => {
    if (alive.current) {
      uncertain.current = true;
      setUnknown(true);
    }
  }, []);
  const schedule = useCallback(() => {
    clearTimeout(pollTimer.current);
    if (
      alive.current &&
      (active(latest.current) || uncertain.current || busy.current)
    )
      pollTimer.current = setTimeout(() => void query.current(), 1000);
  }, []);
  const accept = useCallback((value: DraftView, request: number) => {
    if (!alive.current || request !== sequence.current) return false;
    const previous = latest.current?.task;
    if (
      previous &&
      (!value.task ||
        (previous.taskId === value.task.taskId &&
          previous.revision > value.task.revision))
    )
      return false;
    // A newer persisted terminal task proves the outcome even if its command
    // reply was lost. An unchanged preparation never authorizes another start.
    if (value.task && !['queued', 'running'].includes(value.task.state)) {
      for (const [requestId, before] of unresolved.current) {
        if (
          !before ||
          before.taskId !== value.task.taskId ||
          before.revision < value.task.revision
        )
          unresolved.current.delete(requestId);
      }
    }
    latest.current = value;
    setView(value);
    setExisting((selected) => {
      if (occupied(value.task)) return null;
      if (selected?.taskId === value.task?.taskId)
        return value.task && value.task.revision >= selected!.revision
          ? value.task
          : selected;
      return selected;
    });
    uncertain.current = unresolved.current.size > 0;
    setUnknown(uncertain.current);
    return true;
  }, []);
  query.current = async () => {
    if (!alive.current) return;
    if (reading.current) {
      // A command may settle after this read took its snapshot. Retire that
      // snapshot and coalesce a fresh read after it releases the bridge lane.
      ++sequence.current;
      readAgain.current = true;
      return;
    }
    reading.current = true;
    const epoch = resetEpoch.current;
    const request = ++sequence.current;
    const timeout = setTimeout(markUnknown, 10000);
    timers.current.add(timeout);
    try {
      accept(await readState(), request);
    } catch {
      if (request === sequence.current) markUnknown();
    } finally {
      clearTimeout(timeout);
      if (timeout) timers.current.delete(timeout);
      if (epoch === resetEpoch.current) {
        reading.current = false;
        if (readAgain.current) {
          readAgain.current = false;
          await query.current();
        } else schedule();
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    reading.current = false;
    readAgain.current = false;
    void query.current();
    const ownedTimers = timers.current;
    return () => {
      alive.current = false;
      readAgain.current = false;
      ++sequence.current;
      clearTimeout(pollTimer.current);
      for (const timer of ownedTimers) clearTimeout(timer);
      ownedTimers.clear();
    };
  }, []);
  useEffect(() => {
    if (!resetRevision) return;
    resetEpoch.current++;
    sequence.current++;
    stateRead = undefined;
    reading.current = false;
    readAgain.current = false;
    busy.current = false;
    unresolved.current.clear();
    uncertain.current = false;
    setUnknown(true);
    setExisting(null);
    latest.current = null;
    clearTimeout(pollTimer.current);
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
    void query.current();
  }, [resetRevision]);
  // Global stop settles outside this hook; read the persisted release when its barrier changes.
  useEffect(() => {
    void query.current();
  }, [operationsBlocked]);
  const contextAtRender = selection.current;
  const run = useCallback(
    async (
      command: () => Promise<DraftCommandResult | PrepareResult>,
      kind: 'start' | 'control' = 'start',
    ) => {
      // The event may await local editor handover before calling run. Keep
      // its originating context rather than adopting a later render context.
      if (
        busy.current ||
        !alive.current ||
        contextAtRender !== selection.current
      )
        return;
      busy.current = true;
      const epoch = resetEpoch.current;
      const request = ++sequence.current;
      const commandSelection = contextAtRender;
      const commandTask = latest.current?.task ?? null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const expires = new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          if (kind === 'start') unresolved.current.set(request, commandTask);
          markUnknown();
          schedule();
          resolve();
        }, 10000);
        timers.current.add(timeout);
      });
      let refreshed = false;
      const operation = (async () => {
        try {
          const result = await command();
          unresolved.current.delete(request);
          if ('view' in result) accept(result.view, request);
          if (
            alive.current &&
            request === sequence.current &&
            !('view' in result) &&
            commandSelection === selection.current
          )
            setExisting(
              result.status === 'existing' &&
                result.task.articleKey === commandSelection.articleKey
                ? result.task
                : null,
            );
          if (
            result.status === 'ready' &&
            alive.current &&
            epoch === resetEpoch.current &&
            request === sequence.current &&
            commandSelection === selection.current
          ) {
            authorizedPreparation.current = {
              id: result.preparation.preparationId,
              selection: commandSelection,
            };
          }
          // Main owns preparation; refresh the public projection after preparation.
          // Unauthorized READY projections are filtered even on later state reads.
          if (
            alive.current &&
            request === sequence.current &&
            !('view' in result)
          ) {
            refreshed = true;
            await query.current();
          }
        } catch {
          if (epoch !== resetEpoch.current) return;
          // A rejected start reply does not prove main rejected the command.
          // Controls recover through real state reads; they never submit content.
          if (kind === 'start') unresolved.current.set(request, commandTask);
          markUnknown();
        } finally {
          clearTimeout(timeout);
          if (timeout) timers.current.delete(timeout);
          if (
            alive.current &&
            epoch === resetEpoch.current &&
            !refreshed &&
            request !== sequence.current
          )
            await query.current();
        }
      })();
      // Release the local interaction lock at timeout so safe stop/reconcile remain
      // available. Unknown blocks new submissions until outstanding commands settle.
      await Promise.race([operation, expires]);
      if (epoch === resetEpoch.current) {
        busy.current = false;
        schedule();
      }
    },
    [accept, markUnknown, schedule, contextAtRender],
  );
  const projected =
    view &&
    existing &&
    existing.articleKey === articleKey &&
    !occupied(view.task)
      ? { ...view, task: existing, preparation: null }
      : view;
  const preparation = projected?.preparation;
  const authorized = authorizedPreparation.current;
  return {
    view:
      projected &&
      preparation &&
      (authorized?.id !== preparation.preparationId ||
        authorized.selection !== selection.current)
        ? { ...projected, preparation: null }
        : projected,
    unknown,
    run,
  };
}
