import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ManualReply, ManualState } from '../../contracts/manual-article';
import {
  WebPasteInputSchema,
  type WebPasteInput,
} from '../../contracts/web-paste';
import type {
  DocumentCommand,
  DraftRange,
  InternalPasteInput,
} from '../../contracts/manual-edit';
import {
  EditorSession,
  documentTicket,
  isEditorSession,
  type EditorSessionState,
} from '../editor/editor-session';
import { emptyEditorKey } from '../editor/editor-codec';
export type Session = EditorSessionState;
export const isSession = isEditorSession;
const active = (s: ManualState | null) =>
  isSession(s) &&
  ['selecting', 'saving', 'stopping', 'pasting', 'retrying'].includes(s.state);
let outstanding: Promise<ManualState> | undefined;
function read() {
  if (!outstanding) {
    const pending = window.desktopApi.getManualArticleState().finally(() => {
      if (outstanding === pending) outstanding = undefined;
    });
    outstanding = pending;
  }
  return outstanding;
}
export function useManualArticle() {
  const [, render] = useState(0);
  const live = useRef(true);
  const coreRef = useRef<EditorSession | undefined>(undefined);
  if (!coreRef.current)
    coreRef.current = new EditorSession(window.desktopApi, () => {
      if (live.current) render((v) => v + 1);
    });
  const core = coreRef.current;
  const [pending, setPending] = useState(false),
    [operationUnknown, setOperationUnknown] = useState(false);
  const actionWaiters = useRef(new Set<() => void>());
  const nativeClosing = useRef(false);
  const restartRequested = useRef(false);
  const sealedSession = useRef<string | undefined>(undefined);
  const isSealed = () =>
    isSession(core.snapshot) &&
    core.snapshot.sessionId === sealedSession.current;
  const cancellation = useRef(0);
  const lock = useRef(false),
    queryUnknown = useRef(false),
    saveLookup = useRef<{ sessionId: string; operationId: string } | undefined>(
      undefined,
    );
  const conflictOperation = useRef<
    | {
        sessionId: string;
        documentRevision: number;
        target: string;
        operationId: string;
        nextSaveOperationId: string;
        proved: boolean;
      }
    | undefined
  >(undefined);
  const [epoch, setEpoch] = useState(0);
  const unknownDocument = useRef<DocumentCommand | undefined>(undefined);
  function message(text: string) {
    core.notice = text;
    render((v) => v + 1);
  }
  function accept(reply: ManualReply) {
    core.accept(reply.snapshot);
    const conflict = conflictOperation.current;
    if (
      conflict &&
      (!isSession(core.snapshot) ||
        core.snapshot.sessionId !== conflict.sessionId ||
        core.snapshot.documentRevision !== conflict.documentRevision ||
        JSON.stringify(core.snapshot.target) !== conflict.target ||
        core.snapshot.nextSaveOperationId !== conflict.nextSaveOperationId)
    )
      conflictOperation.current = undefined;
    if (reply.status === 'invalid')
      message('本次内容未能加入，请检查标题、正文或粘贴内容后继续。');
    if (reply.status === 'conflict')
      message('文章已发生变化，请核对后重新修改。');
    if (reply.status === 'unavailable') {
      if (conflictOperation.current) conflictOperation.current.proved = false;
      message('文章功能暂时无法使用，请关闭后重试。');
    }
    if (active(reply.snapshot)) setEpoch((v) => v + 1);
  }
  const reconciliation = useRef<Promise<void> | undefined>(undefined);
  function reconcile(): Promise<void> {
    if (reconciliation.current) return reconciliation.current;
    const pending = reconcileRead().finally(() => {
      if (reconciliation.current === pending)
        reconciliation.current = undefined;
    });
    reconciliation.current = pending;
    return pending;
  }
  async function reconcileRead() {
    const generation = cancellation.current;
    const save = saveLookup.current;
    const lookup = save
      ? await window.desktopApi.getManualSaveResult(
          save.sessionId,
          save.operationId,
        )
      : undefined;
    const state = await read();
    if (!live.current || generation !== cancellation.current) return;
    core.accept(state);
    if (saveLookup.current !== save) return;
    const conflict = conflictOperation.current;
    if (conflict) {
      conflict.proved = !!(
        save &&
        save.operationId === conflict.operationId &&
        lookup?.status === 'not_started' &&
        lookup.operationId === conflict.operationId &&
        isSession(state) &&
        state.sessionId === conflict.sessionId &&
        state.documentRevision === conflict.documentRevision &&
        JSON.stringify(state.target) === conflict.target &&
        state.nextSaveOperationId === conflict.nextSaveOperationId &&
        state.state === 'editing'
      );
    }
    const doc = unknownDocument.current;
    const docSettled =
      !doc ||
      state.state === 'idle' ||
      (isSession(state) &&
        state.sessionId === doc.sessionId &&
        state.state === 'editing' &&
        (state.nextClientSequence > doc.clientSequence ||
          (state.acknowledgedEdit?.commandId === doc.commandId &&
            state.acknowledgedEdit.clientSequence === doc.clientSequence)));
    const saveSettled =
      !save ||
      (lookup?.status === 'committed' &&
        lookup.receipt.operationId === save.operationId &&
        isSession(state) &&
        state.saveOutcome?.operationId === save.operationId) ||
      ((lookup?.status === 'failed' || lookup?.status === 'not_started') &&
        lookup.operationId === save.operationId);
    if (
      queryUnknown.current &&
      docSettled &&
      saveSettled &&
      (!isSession(state) || state.state === 'editing') &&
      state.state !== 'unavailable'
    ) {
      queryUnknown.current = false;
      if (!conflictOperation.current) saveLookup.current = undefined;
      unknownDocument.current = undefined;
      setOperationUnknown(false);
      message('已核对当前内容；请检查操作结果。');
    }
  }
  useEffect(() => {
    live.current = true;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        await reconcile();
      } catch {
        if (!disposed) {
          if (conflictOperation.current)
            conflictOperation.current.proved = false;
          queryUnknown.current = true;
          setOperationUnknown(true);
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 500);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [core, epoch]);
  useEffect(
    () => () => {
      live.current = false;
      core.dispose();
    },
    [core],
  );
  async function ensureRange(
    preferred?: DraftRange,
  ): Promise<DraftRange | undefined> {
    if (!(await core.flush())) return;
    const s = core.snapshot;
    if (!isSession(s) || !core.draft) return;
    let range = preferred ?? core.range;
    if (!range) {
      const first = core.draft.blocks[0];
      if (first)
        range = {
          anchor: {
            blockKey: first.blockKey,
            kind: first.type === 'paragraph' ? 'text' : 'edge',
            ...(first.type === 'paragraph'
              ? { offset: 0 }
              : { side: 'before' }),
          } as DraftRange['anchor'],
          head: {
            blockKey: first.blockKey,
            kind: first.type === 'paragraph' ? 'text' : 'edge',
            ...(first.type === 'paragraph'
              ? { offset: 0 }
              : { side: 'before' }),
          } as DraftRange['head'],
        };
    }
    // A display-only empty paragraph needs explicit confirmation before a range command.
    if (
      !core.draft.blocks.length ||
      range?.anchor.blockKey === emptyEditorKey
    ) {
      const key = crypto.randomUUID();
      core.change({
        ...core.draft,
        blocks: [{ type: 'paragraph', blockKey: key, text: '' }],
      });
      if (!(await core.flush())) return;
      range = {
        anchor: { blockKey: key, kind: 'text', offset: 0 },
        head: { blockKey: key, kind: 'text', offset: 0 },
      };
      core.range = range;
    }
    return range;
  }
  async function command(
    action:
      | 'open'
      | 'begin'
      | 'pick'
      | 'save'
      | 'discard'
      | 'cancel'
      | 'paste'
      | 'retry'
      | 'copy'
      | 'cut',
    payload?: WebPasteInput | InternalPasteInput | string,
  ) {
    if (
      lock.current ||
      nativeClosing.current ||
      isSealed() ||
      core.unknown ||
      queryUnknown.current
    )
      return;
    if (active(core.snapshot) && action !== 'cancel') return;
    if (
      action === 'paste' &&
      !(payload && 'kind' in Object(payload)) &&
      !WebPasteInputSchema.safeParse(payload).success
    ) {
      message('本次内容超出支持范围，请减少内容后再粘贴');
      return;
    }
    lock.current = true;
    const generation = cancellation.current;
    const starting = isSession(core.snapshot)
      ? core.snapshot.sessionId
      : undefined;
    try {
      // Keep fields editable until BOTH title/body IME ends and newest input is acknowledged.
      if (action !== 'cancel' && action !== 'begin' && action !== 'open')
        await core.waitForComposition();
      if (generation !== cancellation.current) return false;
      const requestedRange = core.range;
      setPending(true);
      if (
        action !== 'cancel' &&
        action !== 'discard' &&
        action !== 'begin' &&
        action !== 'open' &&
        !(await core.flush())
      )
        return;
      if (generation !== cancellation.current) return false;
      if (action === 'discard') {
        await core.waitForComposition();
        if (core.syncing) await core.flush();
      }
      const range = ['paste', 'pick', 'copy', 'cut'].includes(action)
        ? await ensureRange(requestedRange)
        : undefined;
      const state = core.snapshot;
      if (generation !== cancellation.current) return false;
      if (
        action !== 'begin' &&
        action !== 'open' &&
        (!isSession(state) || state.sessionId !== starting)
      )
        return;
      setPending(true);
      let reply: ManualReply;
      if (action === 'open')
        reply = await window.desktopApi.openManualArticle(payload as string);
      else if (action === 'begin')
        reply = await window.desktopApi.beginManualArticle();
      else {
        if (!isSession(state)) return;
        const ticket = documentTicket(state);
        if (['paste', 'pick', 'copy', 'cut', 'discard'].includes(action))
          unknownDocument.current = ticket;
        if (action === 'cancel') {
          if (!state.jobId) return;
          reply = await window.desktopApi.cancelManualOperation(
            state.sessionId,
            state.jobId,
          );
        } else if (action === 'save') {
          saveLookup.current = {
            sessionId: state.sessionId,
            operationId: state.nextSaveOperationId,
          };
          reply = await window.desktopApi.commitManualDocument({
            sessionId: state.sessionId,
            expectedDocumentRevision: state.documentRevision,
            operationId: state.nextSaveOperationId,
          });
          if (
            reply.status === 'conflict' &&
            isSession(reply.snapshot) &&
            reply.snapshot.sessionId === state.sessionId &&
            reply.snapshot.target.kind === 'existing'
          ) {
            conflictOperation.current = {
              sessionId: state.sessionId,
              documentRevision: reply.snapshot.documentRevision,
              target: JSON.stringify(reply.snapshot.target),
              operationId: state.nextSaveOperationId,
              nextSaveOperationId: reply.snapshot.nextSaveOperationId,
              proved: false,
            };
            await reconcile();
          } else saveLookup.current = undefined;
        } else if (action === 'discard')
          reply = await window.desktopApi.closeManualEditor(ticket, 'discard');
        else if (action === 'retry')
          reply = await window.desktopApi.retryManualPasteImage(
            {
              sessionId: state.sessionId,
              expectedRevision: state.revision,
              commandId: state.nextPasteCommandId,
            },
            payload as string,
          );
        else {
          if (!range) return;
          if (action === 'paste')
            reply = await window.desktopApi.spliceManualPaste(
              ticket,
              range,
              payload as WebPasteInput | InternalPasteInput,
            );
          else if (action === 'pick')
            reply = await window.desktopApi.insertManualImage(ticket, range);
          else
            reply = await window.desktopApi.copyManualSelection(
              ticket,
              range,
              action === 'cut',
            );
        }
      }
      if (generation !== cancellation.current) return false;
      accept(reply);
      unknownDocument.current = undefined;
      return reply.status === 'ok' || reply.status === 'started';
    } catch {
      if (generation !== cancellation.current) return false;
      if (conflictOperation.current) conflictOperation.current.proved = false;
      queryUnknown.current = true;
      setOperationUnknown(true);
      message('状态暂时无法确认，正在核对…');
      setEpoch((v) => v + 1);
    } finally {
      if (generation === cancellation.current) {
        lock.current = false;
        for (const resolve of actionWaiters.current) resolve();
        actionWaiters.current.clear();
        setPending(false);
      }
    }
  }
  useEffect(
    () =>
      window.desktopApi.onManualCloseRequest(({ requestId }) => {
        void (async () => {
          if (nativeClosing.current) return;
          nativeClosing.current = true;
          const initial = core.snapshot;
          const sessionId = isSession(initial) ? initial.sessionId : undefined;
          try {
            if (lock.current)
              await new Promise<void>((resolve) =>
                actionWaiters.current.add(resolve),
              );
            const deadline = Date.now() + 30_000;
            await reconcile();
            while (active(core.snapshot) && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              await reconcile();
            }
            // A bare editing read never proves an unknown save result.
            if (queryUnknown.current || core.unknown || active(core.snapshot))
              return;
            const before = core.snapshot;
            if (!isSession(before) || before.sessionId !== sessionId) return;
            const flushed = await core.flush();
            const state = core.snapshot;
            if (
              !isSession(state) ||
              state.sessionId !== sessionId ||
              queryUnknown.current ||
              core.unknown ||
              active(state)
            )
              return;
            if (restartRequested.current && flushed && !state.dirty) {
              // The clean proof authorizes main to release this session. Freeze
              // both the local input lane and its DOM before sending that proof;
              // keep it frozen until a different/idle session is read back.
              sealedSession.current = state.sessionId;
              flushSync(() => render((v) => v + 1));
            }
            const reply = await window.desktopApi.respondManualClose(
              requestId,
              state.sessionId,
              state.documentRevision,
              flushed ? 'flushed' : 'blocked',
            );
            if (reply.status !== 'ok') sealedSession.current = undefined;
            core.accept(reply.snapshot, core.unsynced);
          } catch {
            queryUnknown.current = true;
            setOperationUnknown(true);
            setEpoch((v) => v + 1);
          } finally {
            nativeClosing.current = false;
            restartRequested.current = false;
          }
        })();
      }),
    [core],
  );
  async function leave(choice: 'save' | 'discard' | 'keep') {
    const generation = cancellation.current;
    if (
      choice === 'keep' ||
      lock.current ||
      core.unknown ||
      queryUnknown.current
    )
      return false;
    if (choice === 'save') {
      if (!(await command('save'))) return false;
      if (generation !== cancellation.current) return false;
      // A started save owns resources until main reports its settled projection.
      while (active(core.snapshot)) {
        try {
          core.accept(await read());
        } catch {
          queryUnknown.current = true;
          setOperationUnknown(true);
          return false;
        }
        if (active(core.snapshot)) await new Promise((r) => setTimeout(r, 100));
        if (generation !== cancellation.current) return false;
      }
      if (
        !isSession(core.snapshot) ||
        core.snapshot.dirty ||
        core.unsynced ||
        core.unknown ||
        core.snapshot.issues?.length
      )
        return false;
    }
    if (generation !== cancellation.current || !(await command('discard')))
      return false;
    return (
      core.snapshot?.state === 'idle' && !core.unknown && !queryUnknown.current
    );
  }
  const snapshot = core.snapshot;
  const blocked =
    isSealed() ||
    pending ||
    operationUnknown ||
    core.unknown ||
    active(snapshot) ||
    snapshot?.state === 'unavailable' ||
    (isSession(snapshot) &&
      ((snapshot.result?.status === 'failed' &&
        snapshot.result.code === 'RECOVERY_REQUIRED') ||
        !!(snapshot.saveOutcome && snapshot.issues?.length)));
  return {
    snapshot,
    draft: core.draft,
    command,
    leave,
    openForSelection: async (key: string) => {
      const opened = !!(await command('open', key));
      return {
        opened,
        known:
          !queryUnknown.current &&
          !core.unknown &&
          core.snapshot?.state !== 'unavailable',
      };
    },
    isEditingArticle: (key: string) =>
      isSession(core.snapshot) &&
      core.snapshot.target.kind === 'existing' &&
      core.snapshot.target.articleKey === key,
    waitForComposition: () => core.waitForComposition(),
    prepareLeave: async () => {
      await core.waitForComposition();
      if (core.syncing) await core.flush();
      return {
        snapshot: core.snapshot,
        unsynced: core.unsynced,
        blocked:
          queryUnknown.current ||
          core.unknown ||
          lock.current ||
          active(core.snapshot) ||
          core.snapshot?.state === 'unavailable',
      };
    },
    initializeAfterStop: () => {
      cancellation.current++;
      core.initializeAfterStop();
      lock.current = false;
      setPending(false);
      queryUnknown.current = true;
      setOperationUnknown(true);
      outstanding = undefined;
      reconciliation.current = undefined;
      for (const resolve of actionWaiters.current) resolve();
      actionWaiters.current.clear();
      message('');
      setEpoch((v) => v + 1);
    },
    cancelPendingActions: () => {
      cancellation.current++;
      restartRequested.current = true;
      // Old renderer commands lose authority, while main still drains their
      // actual work. Release only this UI latch so the flush handshake can read
      // the settled result and preserve any remaining edits.
      lock.current = false;
      setPending(false);
      for (const resolve of actionWaiters.current) resolve();
      actionWaiters.current.clear();
    },
    change: (draft: Parameters<EditorSession['change']>[0]) => {
      if (!isSealed()) core.change(draft);
    },
    flushDraft: () => core.flush(),
    setComposition: (field: 'body' | 'title', value: boolean) =>
      core.composition(field, value),
    rangeChange: (range: DraftRange) => {
      core.range = range;
    },
    startPaste: (input: WebPasteInput | InternalPasteInput) =>
      command('paste', input),
    retryImage: (candidateId: string) => command('retry', candidateId),
    unknown: operationUnknown || core.unknown,
    pending,
    syncing: core.syncing,
    unsynced: core.unsynced,
    notice: core.notice,
    blocked,
    canDiscardConflict:
      !!conflictOperation.current?.proved &&
      isSession(snapshot) &&
      snapshot.sessionId === conflictOperation.current.sessionId &&
      snapshot.documentRevision ===
        conflictOperation.current.documentRevision &&
      JSON.stringify(snapshot.target) === conflictOperation.current.target &&
      snapshot.nextSaveOperationId ===
        conflictOperation.current.nextSaveOperationId &&
      !pending &&
      !operationUnknown &&
      !core.unknown &&
      !queryUnknown.current &&
      !active(snapshot),
    canEditSession: (id: string) =>
      isSession(core.snapshot) &&
      core.snapshot.sessionId === id &&
      core.snapshot.state === 'editing' &&
      !blocked,
  };
}
