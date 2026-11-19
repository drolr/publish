import { WorkspaceFooter, type WorkspaceTaskStatus } from '../WorkspaceFooter';
import {
  readArticlePreview,
  resetArticlePreviewReads,
} from '../library/readArticlePreview';
import { BatchCoverPanel } from '../covers/BatchCoverPanel';
import { BatchPanel } from '../drafts/BatchPanel';
import { CoverEditor } from '../covers/CoverEditor';
import { coverSession, useArticleCover } from '../covers/useArticleCover';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DraftPanel } from '../drafts/DraftPanel';
import { ArticleLibrary } from '../library/ArticleLibrary';
import { ManualEditor } from './ManualEditor';
import { isSession, useManualArticle } from './useManualArticle';
import { OperationControls, useOperationControl } from '../OperationControls';
export function ArticleWorkspace() {
  const [view, setView] = useState<'library' | 'editor'>('library');
  const [singleStatus, setSingleStatus] = useState<WorkspaceTaskStatus | null>(
    null,
  );
  const [batchStatus, setBatchStatus] = useState<WorkspaceTaskStatus | null>(
    null,
  );
  const [articleKey, setArticleKey] = useState<string | undefined>();
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [batchCoverExpanded, setBatchCoverExpanded] = useState(false);
  const [coverTitle, setCoverTitle] = useState('');
  const [contentEpoch, setContentEpoch] = useState(0);
  useEffect(() => {
    let current = true;
    setCoverTitle('');
    if (articleKey)
      void readArticlePreview(articleKey, () => current)
        .then((value) => {
          if (current)
            setCoverTitle(
              value?.status === 'ok'
                ? value.article.title
                : '文章标题暂时无法读取',
            );
        })
        .catch(() => {
          if (current) setCoverTitle('文章标题暂时无法读取');
        });
    return () => {
      current = false;
    };
  }, [articleKey, contentEpoch]);
  const [resetRevision, setResetRevision] = useState(0);
  const [draftIssue, setDraftIssue] = useState('');
  const [batchIssue, setBatchIssue] = useState('');
  const controller = useManualArticle();
  const latestController = useRef(controller);
  latestController.current = controller;
  const libraryView = useRef<HTMLDivElement>(null);
  const editorView = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target =
      view === 'library' ? libraryView.current : editorView.current;
    target
      ?.querySelector<HTMLElement>(
        view === 'library'
          ? '.article-rows button[aria-pressed=true], button'
          : '.focused-editor-header button',
      )
      ?.focus();
    target?.closest('main')?.scrollTo({ top: 0 });
  }, [view]);
  const [choice, setChoice] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const resolver = useRef<
    ((choice: 'save' | 'discard' | 'keep') => void) | undefined
  >(undefined);
  const moving = useRef(false);
  const [handover, setHandover] = useState(false);
  function changeMode(next: 'single' | 'batch') {
    if (next === mode) return;
    setMode(next);
    setContentEpoch((value) => value + 1);
  }
  const [batchBlocked, setBatchBlocked] = useState(true);
  const [coverWork, setCoverWork] = useState(false);
  const [platformBlocked, setPlatformBlocked] = useState(true);
  const projectPlatformActivity = useCallback(
    (blocked: boolean) => setPlatformBlocked(blocked),
    [],
  );
  const cover = useArticleCover(
    articleKey,
    () => setContentEpoch((v) => v + 1),
    contentEpoch,
  );
  const deletionLock = useRef(false);
  const [deletionBlocked, setDeletionBlocked] = useState(false);
  const operationGeneration = useRef(0);
  const operations = useOperationControl(
    () => {
      operationGeneration.current++;
      controller.cancelPendingActions();
      cover.cancelPendingActions();
      answer('keep');
      setContentEpoch((v) => v + 1);
    },
    () => {
      operationGeneration.current++;
      resetArticlePreviewReads();
      setResetRevision((v) => v + 1);
      if (
        !(
          isSession(controller.snapshot) &&
          (controller.snapshot.dirty ||
            controller.snapshot.cover?.dirty ||
            controller.unsynced)
        ) &&
        !(coverSession(cover.state) && cover.state.dirty)
      )
        setArticleKey(undefined);
      setCoverWork(false);
      setDraftIssue('');
      setBatchIssue('');
      moving.current = false;
      setHandover(false);
      controller.initializeAfterStop();
      cover.initializeAfterStop();
      setContentEpoch((v) => v + 1);
    },
  );
  useEffect(() => {
    if (choice) {
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      dialog.current?.showModal();
    } else if (dialog.current?.open) {
      const closedDialog = dialog.current;
      const target = returnFocus.current;
      closedDialog.close();
      const frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!target?.isConnected || closedDialog.open) return;
        // Native close can leave focus on body or a former dialog child.
        // Preserve a newer explicit focus choice outside the closed dialog.
        if (
          active?.isConnected &&
          active !== document.body &&
          active !== document.documentElement &&
          !closedDialog.contains(active)
        )
          return;
        target.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [choice]);
  function answer(value: 'save' | 'discard' | 'keep') {
    setChoice(false);
    resolver.current?.(value);
    resolver.current = undefined;
  }
  async function closeEditor() {
    const ticket = operationGeneration.current;
    if (
      (controller.blocked && !controller.canDiscardConflict) ||
      controller.unknown
    )
      return false;
    const settled = await controller.prepareLeave();
    if (ticket !== operationGeneration.current) return false;
    if (settled.blocked) return false;
    const state = settled.snapshot;
    if (!isSession(state) || state.state === 'finished')
      return state?.state !== 'unavailable';
    const decision =
      state.dirty || state.cover?.dirty || settled.unsynced
        ? await new Promise<'save' | 'discard' | 'keep'>((resolve) => {
            resolver.current = resolve;
            setChoice(true);
          })
        : 'discard';
    if (ticket !== operationGeneration.current) return false;
    return controller.leave(decision);
  }
  async function returnToLibrary() {
    if (operations.blocked || moving.current || deletionLock.current) return;
    const ticket = operationGeneration.current;
    moving.current = true;
    setHandover(true);
    try {
      const settled = await controller.prepareLeave();
      if (ticket !== operationGeneration.current || settled.blocked) return;
      const state = settled.snapshot;
      if (
        isSession(state) &&
        (state.dirty || state.cover?.dirty || settled.unsynced)
      ) {
        const decision = await new Promise<'save' | 'discard' | 'keep'>(
          (resolve) => {
            resolver.current = resolve;
            setChoice(true);
          },
        );
        if (ticket !== operationGeneration.current || decision === 'keep')
          return;
        if (decision === 'discard') {
          if (!(await controller.leave('discard'))) return;
        } else {
          if (!(await controller.command('save'))) return;
          let saved = await controller.prepareLeave();
          while (
            isSession(saved.snapshot) &&
            saved.snapshot.state === 'saving'
          ) {
            if (
              ticket !== operationGeneration.current ||
              latestController.current.unknown
            )
              return;
            await new Promise((resolve) => setTimeout(resolve, 100));
            saved = await controller.prepareLeave();
          }
          if (
            ticket !== operationGeneration.current ||
            saved.blocked ||
            saved.unsynced ||
            !isSession(saved.snapshot) ||
            saved.snapshot.sessionId !== state.sessionId ||
            saved.snapshot.dirty ||
            saved.snapshot.cover?.dirty ||
            saved.snapshot.issues?.length
          )
            return;
        }
      }
      if (ticket === operationGeneration.current) setView('library');
    } finally {
      if (ticket === operationGeneration.current) {
        moving.current = false;
        setHandover(false);
      }
    }
  }
  async function beforeWrite(bodyOnly = false) {
    if (operations.blocked || moving.current || deletionLock.current)
      return false;
    const ticket = operationGeneration.current;
    moving.current = true;
    setHandover(true);
    try {
      if (!bodyOnly && !(await cover.leave())) return false;
      if (ticket !== operationGeneration.current) return false;
      return (await closeEditor()) && ticket === operationGeneration.current;
    } finally {
      moving.current = false;
      setHandover(false);
    }
  }
  async function closeBatchCover() {
    if (operations.blocked || moving.current || deletionLock.current) return;
    const ticket = operationGeneration.current;
    moving.current = true;
    setHandover(true);
    try {
      if ((await cover.leave()) && ticket === operationGeneration.current)
        setBatchCoverExpanded(false);
    } finally {
      moving.current = false;
      setHandover(false);
    }
  }
  async function select(key?: string, fresh = false) {
    if (
      !fresh &&
      key &&
      key === articleKey &&
      controller.isEditingArticle(key) &&
      !operations.blocked &&
      !moving.current &&
      !deletionLock.current
    ) {
      setView('editor');
      return;
    }
    if (
      operations.blocked ||
      batchBlocked ||
      moving.current ||
      deletionLock.current ||
      (controller.blocked && !controller.canDiscardConflict) ||
      (!!key &&
        key === articleKey &&
        controller.isEditingArticle(key) &&
        !fresh)
    )
      return;
    moving.current = true;
    const ticket = operationGeneration.current;
    setHandover(true);
    try {
      if (!(await cover.leave())) return;
      if (ticket !== operationGeneration.current) return;
      if (!(await closeEditor())) return;
      if (ticket !== operationGeneration.current) return;
      if (fresh) {
        if (await controller.command('begin')) {
          setArticleKey(undefined);
          setView('editor');
        }
      } else if (!key) setArticleKey(undefined);
      else {
        const opened = await controller.openForSelection(key);
        if (opened.known) {
          setArticleKey(key);
          if (opened.opened) setView('editor');
        }
      }
    } finally {
      moving.current = false;
      setHandover(false);
    }
  }
  const snapshot = controller.snapshot;
  const observedSession = useRef<string | undefined>(undefined);
  const snapshotSession = isSession(snapshot) ? snapshot.sessionId : undefined;
  useEffect(() => {
    if (snapshot?.state === 'idle') {
      observedSession.current = undefined;
      setView('library');
    } else if (snapshotSession && observedSession.current !== snapshotSession) {
      // Restore a retained/new main-owned session once. Polls of the same session
      // must never undo an explicit view-only return to the pool.
      observedSession.current = snapshotSession;
      setView('editor');
    }
  }, [snapshot?.state, snapshotSession]);
  // Preparation follows visible editor content, not close/ack lifecycle revisions.
  // Retain the last semantic token through an authorized close to idle. Text stays
  // in this local ref; only the serial token reaches the draft panel.
  const editorContent = useRef<{
    articleKey?: string;
    generation: number;
    sessionId?: string;
    draft?: string;
    revision: number;
  }>({ articleKey, generation: operationGeneration.current, revision: 0 });
  if (
    editorContent.current.articleKey !== articleKey ||
    editorContent.current.generation !== operationGeneration.current
  )
    editorContent.current = {
      articleKey,
      generation: operationGeneration.current,
      revision: editorContent.current.revision + 1,
    };
  if (isSession(snapshot) && controller.draft) {
    const draft = JSON.stringify(controller.draft);
    if (
      editorContent.current.sessionId !== snapshot.sessionId ||
      editorContent.current.draft !== draft
    )
      editorContent.current = {
        ...editorContent.current,
        sessionId: snapshot.sessionId,
        draft,
        revision: editorContent.current.revision + 1,
      };
  }
  const editing = isSession(snapshot) && snapshot.state !== 'finished';
  const outcome = isSession(snapshot) ? snapshot.saveOutcome : undefined;
  useEffect(() => {
    if (!editing && coverSession(cover.state))
      setArticleKey(cover.state.articleKey);
  }, [
    editing,
    cover.state && 'sessionId' in cover.state
      ? cover.state.sessionId
      : undefined,
  ]);
  // Formal receipt identity refreshes the pool; input synchronisation is not a save.
  const refreshKey = outcome
    ? `${outcome.articleKey}:${outcome.articleRevision}:${outcome.operationId}`
    : undefined;
  const targetKey =
    isSession(snapshot) && snapshot.target.kind === 'existing'
      ? snapshot.target.articleKey
      : outcome?.articleKey;
  useEffect(() => {
    if (targetKey) setArticleKey(targetKey);
  }, [targetKey]);
  function renderWorkspace(keys: string[], selectionBlocked: boolean) {
    return (
      <DraftPanel
        onIssueChange={setDraftIssue}
        onTaskStatusChange={setSingleStatus}
        operationGeneration={() => operationGeneration.current}
        operationsBlocked={operations.blocked || batchBlocked || coverWork}
        onPlatformActivityChange={projectPlatformActivity}
        articleActionsBlocked={
          deletionBlocked || cover.blocked || cover.hasSession
        }
        articleKey={articleKey}
        beforeArticleAction={() => beforeWrite()}
        contentEpoch={contentEpoch}
        editorRevision={
          editorContent.current.sessionId
            ? editorContent.current.sessionId +
              ':' +
              editorContent.current.revision
            : undefined
        }
        renderSections={({ singleContent, browserContent }) => (
          <>
            <nav
              className="draft-mode-tabs"
              role="tablist"
              aria-label="存草稿方式"
              onKeyDown={(event) => {
                if (
                  !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'single'
                    : event.key === 'End'
                      ? 'batch'
                      : mode === 'single'
                        ? 'batch'
                        : 'single';
                changeMode(next);
                document.getElementById('draft-tab-' + next)?.focus();
              }}
            >
              <button
                role="tab"
                id="draft-tab-single"
                aria-controls="draft-mode-panel"
                tabIndex={mode === 'single' ? 0 : -1}
                aria-selected={mode === 'single'}
                onClick={() => changeMode('single')}
              >
                单篇存草稿
              </button>
              <button
                role="tab"
                id="draft-tab-batch"
                aria-controls="draft-mode-panel"
                tabIndex={mode === 'batch' ? 0 : -1}
                aria-selected={mode === 'batch'}
                onClick={() => changeMode('batch')}
              >
                批量存草稿
              </button>
            </nav>
            <section
              className="draft-workspace"
              role="tabpanel"
              id="draft-mode-panel"
              aria-labelledby={'draft-tab-' + mode}
            >
              {mode === 'single' && batchBlocked && (
                <p role="status">
                  批次正在执行、等待处理或状态待核对，请先处理后再开始单篇任务。
                </p>
              )}
              {mode === 'batch' && platformBlocked && (
                <p role="status">
                  单篇草稿正在执行、等待处理或状态待核对，请先处理后再开始批次。
                </p>
              )}
              {/* Visibility changes preserve this editor and its controller across modes. */}
              <div
                id="article-cover-editor"
                hidden={
                  mode === 'batch' && !batchCoverExpanded && !cover.choice
                }
                inert={coverWork && !cover.choice}
              >
                {articleKey && (
                  <p>当前封面文章：{coverTitle || '正在读取文章标题…'}</p>
                )}
                {mode === 'batch' && (
                  <button
                    disabled={
                      operations.blocked ||
                      handover ||
                      cover.blocked ||
                      (cover.hasSession && !cover.canLeave)
                    }
                    onClick={() => void closeBatchCover()}
                  >
                    关闭封面编辑区
                  </button>
                )}
                <CoverEditor
                  stopRevision={operationGeneration.current}
                  stopControl={
                    <OperationControls control={operations} compact />
                  }
                  controller={cover}
                  articleKey={
                    isSession(snapshot) &&
                    snapshot.target.kind === 'new' &&
                    !outcome
                      ? undefined
                      : articleKey
                  }
                  beforeBegin={() => beforeWrite(true)}
                  admissionBlocked={
                    operations.blocked ||
                    deletionBlocked ||
                    handover ||
                    controller.blocked ||
                    platformBlocked ||
                    coverWork ||
                    batchBlocked
                  }
                />
              </div>

              <div hidden={mode !== 'single'}>{singleContent}</div>
              <div hidden={mode !== 'batch'}>
                <BatchPanel
                  onIssueChange={setBatchIssue}
                  onTaskStatusChange={setBatchStatus}
                  articleKeys={keys}
                  contentEpoch={contentEpoch}
                  configurationBlocked={coverWork || cover.hasSession}
                  coverPanel={
                    <BatchCoverPanel
                      articleKeys={keys}
                      contentEpoch={contentEpoch}
                      operationGeneration={() => operationGeneration.current}
                      beforeWrite={() => beforeWrite()}
                      onBusyChange={setCoverWork}
                      onChanged={() => setContentEpoch((v) => v + 1)}
                      blocked={
                        operations.blocked ||
                        deletionBlocked ||
                        controller.blocked ||
                        platformBlocked ||
                        batchBlocked ||
                        (selectionBlocked && !coverWork && !batchBlocked)
                      }
                      onEdit={(key) => {
                        void (async () => {
                          if (!(await beforeWrite())) return;
                          setArticleKey(key);
                          setBatchCoverExpanded(true);
                          requestAnimationFrame(() =>
                            document
                              .getElementById('article-cover-editor')
                              ?.scrollIntoView({
                                behavior: 'smooth',
                                block: 'start',
                              }),
                          );
                        })();
                      }}
                    />
                  }
                  blocked={
                    operations.blocked ||
                    deletionBlocked ||
                    platformBlocked ||
                    controller.blocked ||
                    cover.blocked ||
                    (selectionBlocked && !batchBlocked)
                  }
                  beforeWrite={() => beforeWrite()}
                  operationGeneration={() => operationGeneration.current}
                  onBlockedChange={setBatchBlocked}
                />
              </div>
            </section>
            {browserContent}
          </>
        )}
      />
    );
  }
  const taskStatuses = [singleStatus, batchStatus].filter(
    (status): status is WorkspaceTaskStatus => status !== null,
  );
  const taskStatus = taskStatuses.length
    ? {
        message: taskStatuses.map((status) => status.message).join('；'),
        needsAttention: taskStatuses.some((status) => status.needsAttention),
        active: taskStatuses.some((status) => status.active),
      }
    : null;
  return (
    <>
      {!editing && controller.unknown && (
        <p role="alert">状态暂时无法确认，正在核对文章编辑状态…</p>
      )}
      {!editing && controller.notice && <p role="alert">{controller.notice}</p>}
      <div
        ref={libraryView}
        className="library-view"
        hidden={view !== 'library'}
        inert={view !== 'library'}
      >
        <ArticleLibrary
          resetRevision={resetRevision}
          renderSelectedActions={(keys, selectionBlocked) =>
            renderWorkspace(keys, selectionBlocked)
          }
          initialArticleKey={articleKey}
          onRequestSelection={(key) => void select(key)}
          refreshKey={refreshKey}
          coverEpoch={
            String(contentEpoch) +
            ':' +
            (isSession(snapshot) &&
            snapshot.cover?.outcome?.status === 'committed'
              ? snapshot.cover.outcome.receipt.operationId
              : '')
          }
          successMessage={
            outcome && !(isSession(snapshot) && snapshot.cover?.dirty)
              ? outcome.kind === 'updated'
                ? '修改已保存到本机'
                : '已保存到文章池'
              : undefined
          }
          manualBlocked={
            operations.blocked ||
            coverWork ||
            batchBlocked ||
            !snapshot ||
            controller.blocked ||
            handover ||
            cover.blocked
          }
          beforeWrite={() => beforeWrite()}
          onDeletionBusyChange={(busy) => {
            deletionLock.current = busy;
            setDeletionBlocked(busy);
          }}
          onArticleDeleted={(key) => {
            setArticleKey((previous) =>
              previous === key ? undefined : previous,
            );
            setContentEpoch((value) => value + 1);
          }}
          onContentChange={() => setContentEpoch((value) => value + 1)}
          onNewArticle={() => void select(undefined, true)}
        />
      </div>
      <div
        ref={editorView}
        className="editor-view"
        hidden={view !== 'editor'}
        inert={view !== 'editor'}
      >
        {editing && (
          <ManualEditor
            key={snapshot.sessionId}
            controller={controller}
            onFinish={() => void returnToLibrary()}
            taskStatus={taskStatus}
          />
        )}
      </div>
      <WorkspaceFooter
        control={operations}
        taskStatus={taskStatus}
        onReturn={view === 'editor' ? () => void returnToLibrary() : undefined}
        returnBlocked={
          handover || (controller.blocked && !controller.canDiscardConflict)
        }
        issue={
          draftIssue ||
          batchIssue ||
          (controller.unknown || controller.blocked ? controller.notice : '') ||
          ''
        }
      />
      <OperationControls
        control={operations}
        showButton={false}
        dirty={
          isSession(snapshot) && (snapshot.dirty || !!snapshot.cover?.dirty)
        }
      />
      <dialog
        ref={dialog}
        aria-labelledby="handover-title"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>(
            'button:not(:disabled)',
          );
          if (!buttons?.length) return;
          const first = buttons[0],
            last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        onCancel={(event) => {
          event.preventDefault();
          answer('keep');
        }}
      >
        <h2 id="handover-title">离开当前编辑？</h2>
        <p>当前修改尚未保存到本机，请选择如何继续。</p>
        <div className="manual-actions">
          <button autoFocus onClick={() => answer('keep')}>
            继续编辑
          </button>
          <button
            disabled={controller.canDiscardConflict}
            onClick={() => answer('save')}
          >
            保存并继续
          </button>
          <button onClick={() => answer('discard')}>放弃修改</button>
          <OperationControls control={operations} compact />
        </div>
      </dialog>
    </>
  );
}
