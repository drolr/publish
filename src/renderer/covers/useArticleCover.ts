import { useEffect, useRef, useState } from 'react';
import type { CoverImageFailure } from '../../contracts/article-cover';
import {
  CoverEditReplySchema,
  CoverReadResultSchema,
  CoverSaveResultSchema,
  type CoverEditReply,
  type CoverDraft,
} from '../../contracts/article-cover';
export const coverSession = (
  s: CoverEditReply | null,
): s is Extract<CoverEditReply, { sessionId: string }> =>
  !!s && 'sessionId' in s;
const imageFailureMessages: Record<CoverImageFailure['reason'], string> = {
  IMAGE_UNAVAILABLE: '无法读取，请重新选择本机图片。',
  IMAGE_UNSUPPORTED: '格式暂不支持，请选择 JPEG 或 PNG 静态图片。',
  IMAGE_INVALID: '内容损坏或无法解码，请重新选择图片。',
  IMAGE_LIMIT_EXCEEDED: '超出大小或尺寸限制，每张须不超过10 MB。',
  SOURCE_NOT_ALLOWED: '无法安全读取，请重新选择本机普通图片文件。',
};
const notices = {
  busy: '当前操作尚未结束，请等待后继续。',
  conflict: '文章或封面已发生变化，请核对后重新编辑。',
  blocked: '当前有未解决的文章或平台操作，暂时不能编辑封面。',
  image_invalid: '所选封面无法使用。请使用 JPEG 或 PNG，每张不超过10 MB。',
  cancelled: '已取消选择，原封面保持。',
  saved: '封面已保存到本机',
  needs_review: '封面状态待核对，请保留现场。',
};
type Completion = { ok: boolean; generation: number };
type CloseWaiter = {
  actionId: number;
  sessionId: string;
  articleKey: string;
  complete: (result: Completion) => void;
};
type SaveIntent = {
  operationId: string;
  sessionId: string;
  articleKey: string;
  coverRevision: number;
  articleRevision: number;
  draftRevision: number;
  mode: CoverDraft['mode'];
  actionId: number;
  complete: (result: Completion) => void;
};
const frozenNotice = (s: CoverEditReply) =>
  s.notice === 'needs_review' ||
  s.notice === 'conflict' ||
  s.notice === 'blocked';
export function useArticleCover(
  articleKey: string | undefined,
  onSaved: () => void,
  contentEpoch: number,
) {
  const [state, setState] = useState<CoverEditReply | null>(null),
    [configuration, setConfiguration] = useState<
      | Extract<
          import('../../contracts/article-cover').CoverReadResult,
          { status: 'ok' }
        >['configuration']
      | null
    >(null);
  const [readStatus, setReadStatus] = useState('loading'),
    [pending, setPending] = useState(false),
    [unknown, setUnknown] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [choice, setChoice] = useState(false);
  const latest = useRef<CoverEditReply | null>(null),
    live = useRef(false),
    busy = useRef(false),
    uncertain = useRef(false),
    readSequence = useRef(0),
    viewSequence = useRef(0),
    selected = useRef(articleKey),
    saved = useRef(onSaved);
  selected.current = articleKey;
  saved.current = onSaved;
  const saveIntent = useRef<SaveIntent | null>(null);
  const closeWaiter = useRef<CloseWaiter | null>(null);
  const actionContext = useRef<{
    id: number;
    articleKey: string | undefined;
    sessionId?: string;
  } | null>(null);
  const saveRejection = useRef<{
    sessionId: string;
    status: 'conflict' | 'blocked';
  } | null>(null);
  const actionGeneration = useRef(0),
    timedOutAction = useRef<number | null>(null);
  const stateRead = useRef<Promise<CoverEditReply | null> | undefined>(
    undefined,
  );
  const reconciliation = useRef<Promise<void> | undefined>(undefined);
  const leaving = useRef<Promise<boolean> | undefined>(undefined);
  const cancellation = useRef(0);
  const resolveChoice = useRef<
    ((choice: 'save' | 'discard' | 'keep') => void) | undefined
  >(undefined);
  function markUnknown() {
    uncertain.current = true;
    if (live.current) setUnknown(true);
  }
  function releaseAction(id: number): number {
    if (actionGeneration.current === id) {
      actionGeneration.current++;
      timedOutAction.current = null;
      busy.current = false;
      if (live.current) setPending(false);
    }
    return actionGeneration.current;
  }
  function accept(value: CoverEditReply, actionId?: number) {
    if (
      !live.current ||
      (actionId !== undefined && actionId !== actionGeneration.current)
    )
      return;
    const prior = latest.current;
    const context = actionContext.current;
    if (
      context &&
      context.id === actionGeneration.current &&
      timedOutAction.current === context.id &&
      busy.current &&
      coverSession(value) &&
      value.articleKey === context.articleKey &&
      (!context.sessionId || context.sessionId === value.sessionId)
    )
      context.sessionId = value.sessionId;
    // A read can retire this exact closed non-save action; its navigation waiter must fail before a newer session starts.
    if (
      actionId === undefined &&
      value.status === 'idle' &&
      coverSession(prior) &&
      context?.id === actionGeneration.current &&
      context.articleKey === prior.articleKey &&
      context.sessionId === prior.sessionId &&
      busy.current &&
      !saveIntent.current &&
      timedOutAction.current === actionGeneration.current
    ) {
      const retiredId = actionGeneration.current;
      const generation = releaseAction(retiredId);
      const waiter = closeWaiter.current;
      if (
        waiter?.actionId === retiredId &&
        waiter.sessionId === prior.sessionId &&
        waiter.articleKey === prior.articleKey
      ) {
        closeWaiter.current = null;
        waiter.complete({ ok: false, generation });
      }
    }
    if (
      coverSession(prior) &&
      coverSession(value) &&
      prior.sessionId === value.sessionId &&
      prior.draftRevision > value.draftRevision
    )
      return;
    if (
      saveRejection.current &&
      (value.status === 'idle' ||
        (coverSession(value) &&
          value.sessionId !== saveRejection.current.sessionId))
    )
      saveRejection.current = null;
    latest.current = value;
    setState(value);
    if (value.status === 'idle' && resolveChoice.current) {
      setChoice(false);
      resolveChoice.current('keep');
      resolveChoice.current = undefined;
    }
    if (
      !uncertain.current &&
      (!prior ||
        (coverSession(prior) ? prior.sessionId : prior.status) !==
          (coverSession(value) ? value.sessionId : value.status) ||
        prior.notice !== value.notice ||
        (coverSession(prior) &&
          coverSession(value) &&
          (prior.sessionId !== value.sessionId ||
            prior.draftRevision !== value.draftRevision)))
    )
      setNotice(value.notice ? notices[value.notice] : null);
  }
  async function loadConfiguration() {
    const key = selected.current,
      request = ++viewSequence.current;
    if (!key) {
      setConfiguration(null);
      setReadStatus('new');
      return;
    }
    setReadStatus('loading');
    try {
      const r = CoverReadResultSchema.parse(
        await window.desktopApi.getArticleCover(key),
      );
      if (
        !live.current ||
        request !== viewSequence.current ||
        key !== selected.current
      )
        return;
      if (r.status === 'ok' && r.configuration.articleKey === key) {
        setConfiguration(r.configuration);
        setReadStatus('ok');
      } else {
        setConfiguration(null);
        setReadStatus(r.status === 'not_found' ? 'removed' : 'unavailable');
      }
    } catch {
      if (live.current && request === viewSequence.current) {
        setConfiguration(null);
        setReadStatus('unavailable');
      }
    }
  }
  function read(): Promise<CoverEditReply | null> {
    if (stateRead.current) return stateRead.current;
    const request = ++readSequence.current;
    const promise = Promise.resolve()
      .then(() => window.desktopApi.getCoverEditState())
      .then((value) => {
        const r = CoverEditReplySchema.parse(value);
        if (!live.current || request !== readSequence.current) return null;
        accept(r);
        return r;
      })
      .finally(() => {
        if (stateRead.current === promise) stateRead.current = undefined;
      });
    stateRead.current = promise;
    return promise;
  }
  async function settleReceipt(
    result: import('../../contracts/article-cover').CoverSaveResult,
    intent: SaveIntent | null,
    fromQuery = false,
  ) {
    if (!intent || saveIntent.current !== intent) return false;
    const generation = cancellation.current;
    const r = CoverSaveResultSchema.parse(result),
      s = await read();
    if (saveIntent.current !== intent || generation !== cancellation.current)
      return false;
    const boundReceipt =
      r.status === 'committed' &&
      r.receipt.operationId === intent.operationId &&
      r.receipt.articleKey === intent.articleKey &&
      r.receipt.coverRevision === intent.coverRevision + 1;
    let canonicalCommit =
      coverSession(s) &&
      s.sessionId === intent.sessionId &&
      s.articleKey === intent.articleKey &&
      s.baseCoverRevision === intent.coverRevision + 1 &&
      !s.dirty &&
      s.status === 'open' &&
      s.notice === 'saved';
    // Native main may already have released this clean session. Require the same immutable receipt plus its formal version.
    if (boundReceipt && s?.status === 'idle') {
      const formal = CoverReadResultSchema.parse(
        await window.desktopApi.getArticleCover(intent.articleKey),
      );
      canonicalCommit =
        formal.status === 'ok' &&
        formal.configuration.articleKey === intent.articleKey &&
        formal.configuration.coverRevision === intent.coverRevision + 1 &&
        formal.configuration.mode === intent.mode;
    }
    if (
      saveIntent.current !== intent ||
      !live.current ||
      generation !== cancellation.current
    )
      return false;
    if (boundReceipt && canonicalCommit) {
      saveIntent.current = null;
      uncertain.current = false;
      setUnknown(false);
      const generation = releaseAction(intent.actionId);
      saved.current();
      // Metadata refresh must not hold a settled save/leave command or expose candidates before close.
      void loadConfiguration();
      setNotice('封面已保存到本机');
      intent.complete({ ok: true, generation });
      return true;
    }
    if (
      (!fromQuery || r.status === 'failed') &&
      r.status !== 'committed' &&
      r.operationId === intent.operationId &&
      ['failed', 'conflict', 'blocked', 'not_started'].includes(r.status) &&
      coverSession(s) &&
      s.sessionId === intent.sessionId &&
      s.articleKey === intent.articleKey &&
      (r.status !== 'failed' ||
        (s.baseCoverRevision === intent.coverRevision &&
          s.baseArticleRevision === intent.articleRevision &&
          s.draftRevision === intent.draftRevision)) &&
      s.status === 'open' &&
      s.notice !== 'needs_review'
    ) {
      saveIntent.current = null;
      uncertain.current = false;
      setUnknown(false);
      if (r.status === 'conflict' || r.status === 'blocked')
        saveRejection.current = {
          sessionId: intent.sessionId,
          status: r.status,
        };
      setNotice(
        r.status === 'failed'
          ? '封面未保存，请检查图片后重新操作。'
          : '封面未保存，文章或当前操作已变化，请核对。',
      );
      intent.complete({
        ok: false,
        generation: releaseAction(intent.actionId),
      });
      return false;
    }
    markUnknown();
    setNotice('封面保存结果待核对，请勿重复保存或离开。');
    return false;
  }
  function reconcile(): Promise<void> {
    if (reconciliation.current) return reconciliation.current;
    const promise = reconcileRead().finally(() => {
      if (reconciliation.current === promise)
        reconciliation.current = undefined;
    });
    reconciliation.current = promise;
    return promise;
  }
  async function reconcileRead() {
    const generation = cancellation.current;
    try {
      const intent = saveIntent.current;
      if (intent) {
        const receipt = await window.desktopApi.getCoverSaveResult(
          intent.operationId,
        );
        if (generation !== cancellation.current) return;
        await settleReceipt(receipt, intent, true);
        return;
      }
      const previous = latest.current;
      const s = await read();
      if (!s) return;
      if (
        !busy.current &&
        (s.status === 'idle' ||
          (s.status === 'open' && s.notice !== 'needs_review'))
      ) {
        const wasUncertain = uncertain.current;
        uncertain.current = false;
        setUnknown(false);
        if (wasUncertain) setNotice(s.notice ? notices[s.notice] : null);
      }
      if (s.status === 'idle' && coverSession(previous)) {
        await loadConfiguration();
        saved.current();
      }
    } catch {
      if (generation === cancellation.current) markUnknown();
    }
  }
  useEffect(() => {
    live.current = true;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (
        !busy.current ||
        (timedOutAction.current !== null && !saveIntent.current)
      )
        await reconcile();
      if (!disposed) timer = setTimeout(() => void poll(), 700);
    }
    void poll();
    return () => {
      disposed = true;
      live.current = false;
      clearTimeout(timer);
      readSequence.current++;
      viewSequence.current++;
    };
  }, []);
  useEffect(() => {
    void loadConfiguration();
  }, [articleKey, contentEpoch]);
  async function action<T>(
    fn: (actionId: number) => Promise<T>,
    before?: () => Promise<boolean>,
  ): Promise<T | undefined> {
    if (busy.current || uncertain.current) return;
    const id = ++actionGeneration.current;
    const cancelledAt = cancellation.current;
    actionContext.current = {
      id,
      articleKey: selected.current,
      ...(coverSession(latest.current)
        ? { sessionId: latest.current.sessionId }
        : {}),
    };
    busy.current = true;
    setPending(true);
    readSequence.current++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The human body-handoff decision has no cover command in flight and no command deadline.
      if (before && !(await before())) return;
      if (
        !live.current ||
        id !== actionGeneration.current ||
        cancelledAt !== cancellation.current
      )
        return;
      timer = setTimeout(() => {
        if (id !== actionGeneration.current || !live.current) return;
        timedOutAction.current = id;
        markUnknown();
        setNotice(
          saveIntent.current
            ? '封面保存结果待核对，请勿重复保存或离开。'
            : '封面操作状态待核对，请等待后核对状态。',
        );
      }, 3000);
      return await fn(id);
    } catch {
      if (id === actionGeneration.current && live.current) {
        markUnknown();
        setNotice(
          saveIntent.current
            ? '封面保存结果待核对，请勿重复保存或离开。'
            : '封面操作状态待核对，请等待后核对状态。',
        );
      }
    } finally {
      clearTimeout(timer);
      if (id === actionGeneration.current) {
        busy.current = false;
        timedOutAction.current = null;
        if (live.current) setPending(false);
      }
    }
  }
  async function begin(beforeBegin: () => Promise<boolean>) {
    const cancelledAt = cancellation.current;
    const key = selected.current;
    if (!key) return;
    await action(
      async (id) => {
        const r = CoverEditReplySchema.parse(
          await window.desktopApi.beginCoverEdit(key),
        );
        if (id !== actionGeneration.current || !live.current) return;
        accept(r, id);
        if (cancelledAt !== cancellation.current) return;
        if (
          coverSession(r) &&
          r.articleKey === key &&
          r.status === 'open' &&
          r.baseCoverRevision === 0
        ) {
          accept(
            CoverEditReplySchema.parse(
              await window.desktopApi.setCoverDraft(
                {
                  sessionId: r.sessionId,
                  expectedDraftRevision: r.draftRevision,
                },
                { mode: 'single', imageTokens: [] },
              ),
            ),
            id,
          );
        }
      },
      async () => (await beforeBegin()) && selected.current === key,
    );
  }
  async function update(draft: CoverDraft) {
    const s = latest.current;
    if (
      !coverSession(s) ||
      s.status !== 'open' ||
      frozenNotice(s) ||
      saveRejection.current?.sessionId === s.sessionId
    )
      return;
    await action(async (id) =>
      accept(
        CoverEditReplySchema.parse(
          await window.desktopApi.setCoverDraft(
            { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
            draft,
          ),
        ),
        id,
      ),
    );
  }
  async function pick(slots: number[]) {
    const s = latest.current;
    if (
      !coverSession(s) ||
      s.status !== 'open' ||
      frozenNotice(s) ||
      saveRejection.current?.sessionId === s.sessionId
    )
      return;
    await action(async (id) => {
      const r = CoverEditReplySchema.parse(
        await window.desktopApi.pickCoverImages(
          { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
          slots,
        ),
      );
      if (id !== actionGeneration.current || !live.current) return;
      accept(r, id);
      if (r.notice === 'image_invalid')
        setNotice(
          coverSession(r) && r.imageFailure
            ? '第' +
                (r.imageFailure.position + 1) +
                '张封面' +
                imageFailureMessages[r.imageFailure.reason] +
                ' 原封面保持。'
            : '本次选择的封面无法使用。请使用 JPEG 或 PNG，每张不超过10 MB；原封面保持。',
        );
    });
  }
  async function save(): Promise<boolean> {
    return (await startSave()).ok;
  }
  function startSave(): Promise<Completion> {
    const current = latest.current;
    if (
      !coverSession(current) ||
      current.status !== 'open' ||
      frozenNotice(current) ||
      saveRejection.current?.sessionId === current.sessionId ||
      saveIntent.current ||
      busy.current ||
      uncertain.current
    )
      return Promise.resolve({
        ok: false,
        generation: actionGeneration.current,
      });
    const expected =
      current.draft.mode === 'none'
        ? 0
        : current.draft.mode === 'single'
          ? 1
          : 3;
    if (current.draft.imageTokens.length !== expected)
      return Promise.resolve({
        ok: false,
        generation: actionGeneration.current,
      });
    let complete!: (result: Completion) => void;
    const completion = new Promise<Completion>((resolve) => {
      complete = resolve;
    });
    let admitted = false;
    // Transport completion and logical receipt settlement belong to the same single intent.
    void action(async (actionId) => {
      const intent: SaveIntent = {
        operationId: crypto.randomUUID(),
        sessionId: current.sessionId,
        articleKey: current.articleKey,
        coverRevision: current.baseCoverRevision,
        articleRevision: current.baseArticleRevision,
        draftRevision: current.draftRevision,
        mode: current.draft.mode,
        actionId,
        complete,
      };
      saveIntent.current = intent;
      admitted = true;
      return settleReceipt(
        await window.desktopApi.saveCoverEdit({
          sessionId: intent.sessionId,
          expectedDraftRevision: current.draftRevision,
          operationId: intent.operationId,
        }),
        intent,
      );
    }).then(() => {
      if (!admitted)
        complete({ ok: false, generation: actionGeneration.current });
    });
    return completion;
  }
  function closeOrigin(
    origin: {
      sessionId: string;
      articleKey: string;
      selection: string | undefined;
    },
    generation: number,
  ): Promise<Completion> {
    if (
      generation !== actionGeneration.current ||
      selected.current !== origin.selection
    )
      return Promise.resolve({
        ok: false,
        generation: actionGeneration.current,
      });
    let complete!: (result: Completion) => void;
    const completion = new Promise<Completion>((resolve) => {
      complete = resolve;
    });
    let waiter: CloseWaiter | undefined;
    void action(async (id) => {
      const current = latest.current;
      if (
        !coverSession(current) ||
        current.sessionId !== origin.sessionId ||
        current.articleKey !== origin.articleKey
      )
        return;
      waiter = {
        actionId: id,
        sessionId: origin.sessionId,
        articleKey: origin.articleKey,
        complete,
      };
      closeWaiter.current = waiter;
      const response = await window.desktopApi.closeCoverEdit(origin.sessionId);
      if (
        !live.current ||
        id !== actionGeneration.current ||
        selected.current !== origin.selection
      )
        return;
      const closed = CoverEditReplySchema.parse(response);
      accept(closed, id);
      if (
        id !== actionGeneration.current ||
        selected.current !== origin.selection
      )
        return;
      closeWaiter.current = null;
      if (closed.status === 'idle') {
        uncertain.current = false;
        setUnknown(false);
        setNotice(null);
        const settledGeneration = releaseAction(id);
        void loadConfiguration();
        complete({ ok: true, generation: settledGeneration });
      } else complete({ ok: false, generation: releaseAction(id) });
    }).then(() => {
      // Rejected/retired close cannot authorize the old outward navigation.
      if (!waiter || closeWaiter.current === waiter) {
        if (closeWaiter.current === waiter) closeWaiter.current = null;
        complete({ ok: false, generation: actionGeneration.current });
      }
    });
    return completion;
  }
  function leave(): Promise<boolean> {
    if (leaving.current) return leaving.current;
    const promise = leaveRead().finally(() => {
      if (leaving.current === promise) leaving.current = undefined;
    });
    leaving.current = promise;
    return promise;
  }
  async function leaveRead() {
    const cancelledAt = cancellation.current;
    if (busy.current || uncertain.current || saveIntent.current) return false;
    const state = await read().catch(() => {
      markUnknown();
      return null;
    });
    if (!state || cancelledAt !== cancellation.current) return false;
    if (!coverSession(state)) return state.status === 'idle';
    if (state.status !== 'open' || state.notice === 'needs_review')
      return false;
    const origin = {
      sessionId: state.sessionId,
      articleKey: state.articleKey,
      selection: selected.current,
    };
    let generation = actionGeneration.current;
    const decision = state.dirty
      ? await new Promise<'save' | 'discard' | 'keep'>((resolve) => {
          resolveChoice.current = resolve;
          setChoice(true);
        })
      : 'discard';
    if (
      decision === 'keep' ||
      cancelledAt !== cancellation.current ||
      generation !== actionGeneration.current ||
      selected.current !== origin.selection
    )
      return false;
    if (decision === 'save') {
      const savedCompletion = await startSave();
      if (!savedCompletion.ok) return false;
      generation = savedCompletion.generation;
    }
    if (
      cancelledAt !== cancellation.current ||
      generation !== actionGeneration.current ||
      selected.current !== origin.selection
    )
      return false;
    const current = latest.current;
    if (current?.status === 'idle') return true;
    if (
      !coverSession(current) ||
      current.sessionId !== origin.sessionId ||
      current.articleKey !== origin.articleKey
    )
      return false;
    const closed = await closeOrigin(origin, generation);
    return (
      closed.ok &&
      closed.generation === actionGeneration.current &&
      selected.current === origin.selection &&
      latest.current?.status === 'idle'
    );
  }
  function answer(value: 'save' | 'discard' | 'keep') {
    setChoice(false);
    resolveChoice.current?.(value);
    resolveChoice.current = undefined;
  }
  const hasSession = coverSession(state);
  const blocked =
    pending ||
    unknown ||
    state?.status === 'unavailable' ||
    (hasSession &&
      (state.status !== 'open' ||
        frozenNotice(state) ||
        saveRejection.current?.sessionId === state.sessionId));
  const canLeave =
    hasSession &&
    !pending &&
    !unknown &&
    state.status === 'open' &&
    state.notice !== 'needs_review';
  return {
    state,
    configuration,
    readStatus,
    pending,
    unknown,
    notice,
    hasSession,
    blocked,
    canLeave,
    choice,
    answer,
    begin,
    update,
    pick,
    save,
    leave,
    reconcile,
    initializeAfterStop() {
      cancellation.current++;
      actionGeneration.current++;
      busy.current = false;
      setPending(false);
      setNotice(null);
      stateRead.current = undefined;
      reconciliation.current = undefined;
      readSequence.current++;
      answer('keep');
      void reconcile();
    },
    cancelPendingActions() {
      cancellation.current++;
      answer('keep');
    },
  };
}
export type ArticleCoverController = ReturnType<typeof useArticleCover>;
