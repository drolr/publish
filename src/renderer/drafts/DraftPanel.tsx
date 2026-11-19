import { HelpTip } from '../HelpTip';
import { BrowserHealthPanel } from './BrowserHealthPanel';
import type { WorkspaceTaskStatus } from '../WorkspaceFooter';
import { readArticlePreview } from '../library/readArticlePreview';
import { CoverTaskResult, coverModeLabel } from './CoverTaskResult';
import { manualUploadMessage, reasons } from './reasons';
import { useEffect, useRef, useState } from 'react';
import type { ArticlePreview } from '../../contracts/article-library';
import type {
  DraftCommandResult,
  PrepareResult,
  ReasonCode,
  TaskView,
  TaskClosureView,
} from '../../contracts/draft-task';
import { Preview } from '../library/Preview';
import { useDraft } from './useDraft';
export function DraftPanel({
  articleKey,
  beforeArticleAction,
  editorRevision,
  contentEpoch = 0,
  articleActionsBlocked = false,
  onPlatformActivityChange,
  operationGeneration,
  operationsBlocked = false,
  batchMode = false,
  onIssueChange,
  onTaskStatusChange,
  renderSections,
}: {
  articleKey?: string;
  batchMode?: boolean;
  onIssueChange?: (issue: string) => void;
  onTaskStatusChange?: (status: WorkspaceTaskStatus | null) => void;
  beforeArticleAction?: () => Promise<boolean>;
  editorRevision?: string;
  contentEpoch?: number;
  articleActionsBlocked?: boolean;
  onPlatformActivityChange?: (blocked: boolean) => void;
  operationGeneration?: () => number;
  operationsBlocked?: boolean;
  renderSections?: (sections: {
    singleContent: React.ReactNode;
    browserContent: React.ReactNode;
  }) => React.ReactNode;
}): React.JSX.Element {
  const [healthBusy, setHealthBusy] = useState(false);
  const [newAttempt, setNewAttempt] = useState(false);
  const retiredTask = useRef<string | undefined>(undefined);
  const generation = operationGeneration?.() ?? 0;
  const { view, unknown, run } = useDraft(
    articleKey,
    operationsBlocked,
    generation,
    JSON.stringify([newAttempt, contentEpoch, editorRevision]),
  );
  useEffect(() => {
    if (generation > 0) retiredTask.current = view?.task?.taskId;
    noticeSequence.current++;
    lock.current = false;
    setPending(false);
    setNotice(null);
    setClosure(null);
    setConfirmed(false);
    setNewAttempt(false);
    setInvalidSummary(view?.preparation?.preparationId ?? null);
  }, [generation]);
  useEffect(() => {
    setNewAttempt(false);
    setConfirmed(false);
    setInvalidSummary(view?.preparation?.preparationId ?? null);
  }, [articleKey]);
  const [pending, setPending] = useState(false);
  const [closure, setClosure] = useState<TaskClosureView | null>(null);
  const lock = useRef(false);
  const [notice, setNotice] = useState<{
    reason: ReasonCode;
    task: TaskView | null;
  } | null>(null);
  const noticeSequence = useRef(0);
  const [preview, setPreview] = useState<ArticlePreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const summaryHeading = useRef<HTMLHeadingElement>(null);
  const task = view?.task;
  const [invalidSummary, setInvalidSummary] = useState<string | null>(null);
  const preparation =
    view?.preparation &&
    view.preparation.articleKey === articleKey &&
    view.preparation.preparationId !== invalidSummary
      ? view.preparation
      : null;
  const session = view?.session;
  const running = task?.state === 'running' || task?.state === 'queued';
  const occupied =
    running ||
    task?.platformPaused ||
    task?.state === 'needs_human' ||
    task?.state === 'interrupted';

  useEffect(() => {
    onPlatformActivityChange?.(unknown || !view || !!occupied);
  }, [unknown, !!view, occupied, onPlatformActivityChange]);
  useEffect(() => {
    if (!closure) return;
    if (
      unknown ||
      closure.taskId !== task?.taskId ||
      closure.revision !== task?.revision ||
      !task.canCloseTask
    ) {
      setClosure(null);
      return;
    }
    const timer = setTimeout(
      () => setClosure(null),
      Math.max(0, Date.parse(closure.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [closure, task?.taskId, task?.revision, task?.canCloseTask, unknown]);

  useEffect(() => {
    setConfirmed(false);
    setPreview(null);
    setPreviewFailed(false);
    let disposed = false;
    if (preparation)
      void readArticlePreview(preparation.articleKey, () => !disposed)
        .then((result) => {
          if (disposed || !result) return;
          if (result.status === 'ok') {
            setPreview(result.article);
            summaryHeading.current?.focus();
          } else setPreviewFailed(true);
        })
        .catch(() => {
          if (!disposed) setPreviewFailed(true);
        });
    return () => {
      disposed = true;
    };
  }, [preparation?.preparationId, articleKey]);
  useEffect(() => {
    if ((editorRevision || contentEpoch > 0) && view?.preparation)
      setInvalidSummary(view.preparation.preparationId);
    setConfirmed(false);
  }, [editorRevision, contentEpoch]);
  async function command(
    kind: 'start' | 'control',
    action: () => Promise<DraftCommandResult | PrepareResult>,
    articleAction = false,
    editorHandover = articleAction,
  ) {
    if (
      operationsBlocked ||
      lock.current ||
      (articleAction && articleActionsBlocked)
    )
      return;
    const generation = operationGeneration?.();
    lock.current = true;
    setPending(true);
    setNotice(null);
    setClosure(null);
    const request = ++noticeSequence.current;
    try {
      if (
        editorHandover &&
        beforeArticleAction &&
        !(await beforeArticleAction())
      )
        return;
      if (generation !== operationGeneration?.()) return;
      await run(async () => {
        const result = await action();
        if (generation !== operationGeneration?.()) return result;
        if (result.status === 'ok' && result.closure)
          setClosure(result.closure);
        if (result.status === 'blocked' && request === noticeSequence.current)
          setNotice({
            reason: result.reason,
            task: 'view' in result ? result.view.task : (view?.task ?? null),
          });
        return result;
      }, kind);
    } finally {
      if (generation === operationGeneration?.()) {
        lock.current = false;
        setPending(false);
      }
    }
  }
  const disabled = operationsBlocked || pending || unknown || !view;
  const canPrepare =
    !healthBusy &&
    !articleActionsBlocked &&
    !!articleKey &&
    session?.status === 'ready' &&
    !!session.bindingToken &&
    !occupied;
  // Production supports none/single; triple remains deferred.
  const coverStartSupported =
    !!preparation &&
    (preparation.coverPolicy === 'local-upload-v1'
      ? preparation.coverSummary?.mode === 'none' ||
        preparation.coverSummary?.mode === 'single'
      : preparation.coverPolicy === 'manual-after-draft' &&
        preparation.coverSummary === undefined);
  const canStart =
    !healthBusy &&
    !articleActionsBlocked &&
    !!preparation &&
    coverStartSupported &&
    !!preview &&
    confirmed &&
    !occupied &&
    session?.status === 'ready' &&
    !disabled;
  const currentNotice =
    notice &&
    notice.task?.taskId === task?.taskId &&
    notice.task?.revision === task?.revision
      ? notice.reason
      : null;
  const uploadBlocked =
    !!task &&
    (task.platformPaused ||
      ['needs_human', 'failed', 'interrupted'].includes(task.state)) &&
    task.reason !== 'MANUAL_REVIEW_REQUIRED';
  const reason =
    currentNotice ??
    (['closed_without_save', 'closed_after_review', 'stopped_by_user'].includes(
      task?.state ?? '',
    )
      ? null
      : task?.reason) ??
    session?.reason;
  useEffect(() => {
    const currentReason =
      task?.taskId === retiredTask.current && !occupied
        ? (currentNotice ?? session?.reason)
        : reason;
    onIssueChange?.(
      unknown
        ? '草稿状态暂时无法读取，请停止并初始化。'
        : currentReason
          ? uploadBlocked && currentReason === task?.reason
            ? manualUploadMessage
            : reasons[currentReason]
          : '',
    );
  }, [
    unknown,
    uploadBlocked,
    task?.reason,
    reason,
    onIssueChange,
    onTaskStatusChange,
    task?.taskId,
    occupied,
    currentNotice,
    session?.reason,
    generation,
  ]);
  const taskMessage = unknown
    ? '草稿状态待核对'
    : !task
      ? ''
      : uploadBlocked
        ? manualUploadMessage
        : task.platformPaused
          ? '平台已暂停，请返回工作区处理'
          : task.state === 'needs_human'
            ? '文章需要人工处理'
            : task.state === 'failed'
              ? '文章失败，请返回工作区处理'
              : task.state === 'interrupted'
                ? '草稿任务已中断，需人工处理'
                : task.state === 'running' || task.state === 'queued'
                  ? task.stopRequested
                    ? '草稿任务正在停止'
                    : '草稿任务执行中'
                  : task.state === 'submission_recorded'
                    ? '已尝试保存，实际草稿待人工核对'
                    : task.state === 'draft_saved'
                      ? '草稿已保存'
                      : ['stopped', 'stopped_by_user'].includes(task.state)
                        ? '草稿任务已停止'
                        : '';
  const taskAttention =
    unknown ||
    !!task?.platformPaused ||
    ['needs_human', 'failed', 'interrupted'].includes(task?.state ?? '');
  useEffect(() => {
    onTaskStatusChange?.(
      taskMessage
        ? {
            message: taskMessage,
            needsAttention: taskAttention,
            active: !!occupied,
          }
        : null,
    );
  }, [taskMessage, taskAttention, occupied, onTaskStatusChange]);
  const taskContent = (
    <>
      <div
        hidden={batchMode}
        aria-live="polite"
        aria-atomic="true"
        className="draft-state"
      >
        {unknown && <p>状态待核对，正在查询现有记录，请勿重复提交。</p>}
        {!view ? (
          <p>正在读取草稿状态…</p>
        ) : task ? (
          <>
            <p className="draft-task-title">
              {task.state === 'draft_saved' ||
              task.state === 'closed_without_save' ||
              task.state === 'closed_after_review' ||
              task.state === 'stopped_by_user' ||
              task.state === 'failed' ||
              task.state === 'stopped'
                ? '上次任务：'
                : '当前任务：'}
              {task.title} · {task.storeName}
            </p>
            <p>
              {uploadBlocked
                ? manualUploadMessage
                : task.state === 'draft_saved'
                  ? '草稿已保存并核对'
                  : task.state === 'submission_recorded'
                    ? '已尝试保存，结果待运营人员核对'
                    : task.state === 'stopped_by_user'
                      ? '已停止并释放占用，可以重新上传；上次可能已生成草稿，请自行核对，重复上传可能产生重复草稿'
                      : task.state === 'closed_after_review'
                        ? '本次任务已人工结束，保存尝试及可能影响记录已保留'
                        : task.state === 'closed_without_save'
                          ? task.preEntryReviewed
                            ? '已按执行前失败证据结束本次任务'
                            : task.emptyEditorReviewed
                              ? '已按人工核对及空白编辑器失败记录结束本次任务'
                              : task.unsavedBodyReviewed
                                ? '已按人工核对结束未保存任务，原始记录已保留'
                                : '已核对未生成草稿，本次任务已结束'
                          : task.reason === 'MANUAL_REVIEW_REQUIRED'
                            ? '待人工核对草稿'
                            : task.possibleRemoteEffect && !running
                              ? '任务尚未核实，请先核对后台草稿'
                              : task.state === 'failed'
                                ? '文章检查失败，未生成草稿'
                                : task.state === 'stopped'
                                  ? '已停止，未生成草稿'
                                  : task.state === 'interrupted'
                                    ? '上次操作中断，请先核对状态'
                                    : running
                                      ? task.stopRequested
                                        ? '正在安全停止，请等待核对结果…'
                                        : '正在处理草稿…'
                                      : '平台已暂停，需要人工处理'}
            </p>
            {!uploadBlocked && <CoverTaskResult task={task} />}
          </>
        ) : (
          <p>
            {!articleKey
              ? '请先从文章列表打开一篇已保存文章。'
              : session?.status === 'closed'
                ? '请打开专用浏览器，人工登录后台。'
                : session?.status === 'opening'
                  ? '正在打开专用浏览器…'
                  : session?.status === 'ready'
                    ? '请检查文章摘要；开始前由运营人员确认后台门店。'
                    : '请在专用浏览器中处理提示，再检查登录状态。'}
          </p>
        )}
        {reason && (!uploadBlocked || reason !== task?.reason) && (
          <p>{reasons[reason]}</p>
        )}
        {pending && !unknown && <p>正在核对操作结果…</p>}
      </div>
    </>
  );
  const browserContent = (
    <section className="browser-module" aria-label="专用浏览器">
      <h2>专用浏览器</h2>
      <BrowserHealthPanel
        blocked={operationsBlocked || pending || unknown || !view || !!occupied}
        onBusyChange={setHealthBusy}
      />
      {(unknown || occupied || operationsBlocked) && (
        <p role="status">
          当前有草稿操作正在执行、等待处理或状态待核对，请先处理后再开始新任务。
        </p>
      )}
      <div className="draft-actions">
        <button
          disabled={
            disabled ||
            healthBusy ||
            running ||
            session?.status === 'opening' ||
            session?.status === 'ready'
          }
          onClick={() =>
            void command(
              'control',
              () => window.desktopApi.openDraftSession(),
              false,
              true,
            )
          }
        >
          {session?.status === 'ready'
            ? '专用浏览器已就绪'
            : session?.status === 'opening'
              ? '正在打开专用浏览器…'
              : '打开专用浏览器'}
        </button>
        <button
          disabled={
            disabled || healthBusy || running || session?.status === 'closed'
          }
          onClick={() =>
            void command(
              'control',
              () => window.desktopApi.checkDraftSession(),
              false,
              true,
            )
          }
        >
          检查登录状态
        </button>
        {session?.status !== 'closed' && (
          <button
            disabled={disabled || running}
            onClick={() =>
              void command('control', () =>
                window.desktopApi.closeDraftSession(),
              )
            }
          >
            关闭专用浏览器
          </button>
        )}
      </div>
      {session?.storeName && (
        <p>
          请运营人员在后台确认目标门店：{session.storeName}；助手不检查门店。
        </p>
      )}
    </section>
  );
  const singleContent = (
    <section className="draft-panel" aria-label="巨懂车草稿">
      <div className="heading-with-help">
        <h2>巨懂车草稿</h2>
        <HelpTip label="单篇草稿帮助">
          先检查文章摘要，核对门店和图文内容后再确认存草稿。作为新尝试可能生成重复草稿，请人工核对结果。
        </HelpTip>
      </div>
      {taskContent}
      <div hidden={batchMode}>
        <label>
          <input
            type="checkbox"
            checked={newAttempt}
            disabled={disabled || !canPrepare}
            onChange={(event) => {
              setNewAttempt(event.target.checked);
              setConfirmed(false);
              setInvalidSummary(view?.preparation?.preparationId ?? null);
            }}
          />
          作为新尝试
        </label>
        {newAttempt && (
          <p>可能生成重复草稿；请重新检查当前摘要，由运营人员核对结果。</p>
        )}
        <div className="draft-actions">
          <button
            disabled={disabled || !canPrepare}
            onClick={() =>
              void command(
                'control',
                () =>
                  window.desktopApi.prepareDraft(
                    articleKey!,
                    session!.bindingToken!,
                    newAttempt ? 'new_attempt' : 'default',
                  ),
                true,
              )
            }
          >
            检查文章摘要
          </button>
        </div>
        {preparation && (
          <div className="draft-summary">
            <h3 tabIndex={-1} ref={summaryHeading}>
              请确认本次存草稿摘要
            </h3>
            <p>门店：{preparation.storeName} · 仅存草稿</p>
            {preparation.previouslySubmitted && (
              <p>
                此前有提交记录；本次为当前内容的新尝试，保存结果待人工核对。
              </p>
            )}
            <p>正文图片出现 {preparation.bodyImageCount} 次</p>
            {preparation.coverSummary ? (
              <div>
                <p>
                  封面：{coverModeLabel(preparation.coverSummary.mode)} ·{' '}
                  {preparation.coverSummary.imageCount}张 · 按以下顺序
                </p>
                <ol>
                  {preparation.coverSummary.images.map((image, index) => (
                    <li key={image.assetKey}>
                      第{index + 1}张封面 ·{' '}
                      {image.mime === 'image/png' ? 'PNG' : 'JPEG'} ·{' '}
                      {image.width}×{image.height}
                    </li>
                  ))}
                </ol>
                <p>
                  {preparation.coverSummary.mode === 'none'
                    ? '未配置封面，将尝试保存正文草稿；平台可能要求人工补充。'
                    : preparation.coverSummary.mode === 'single'
                      ? '单图封面将在正文填写后、存草稿前上传，不保存到平台素材库。'
                      : '三图封面暂不支持自动存稿。'}
                </p>
              </div>
            ) : (
              <p>
                历史封面由人工处理；草稿保存后请进入巨懂车人工选择并核对封面。
              </p>
            )}
            {preview ? (
              <Preview article={preview} focus={false} />
            ) : (
              <p>
                {previewFailed
                  ? '正文预览暂时无法读取，请重新检查文章。'
                  : '正在读取正文预览…'}
              </p>
            )}
            <label className="draft-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={disabled || !preview || !!occupied}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {preparation.manualReview
                ? '我已人工确认本店无同标题草稿，并核对门店和图文内容；仅保存一次，保存后人工验收'
                : '我已核对门店和图文内容，仅存草稿'}
            </label>
          </div>
        )}
        <div className="draft-actions">
          <button
            className="primary"
            disabled={!canStart}
            onClick={() =>
              void command(
                'start',
                () => window.desktopApi.startDraft(preparation!.preparationId),
                true,
              )
            }
          >
            存到巨懂车草稿
          </button>
          {running && (
            <button
              disabled={pending || !!task.stopRequested}
              onClick={() =>
                void command('control', () =>
                  window.desktopApi.stopDraft(task.taskId),
                )
              }
            >
              停止操作
            </button>
          )}
          {task &&
            !task.ambiguousSaveReviewed &&
            !running &&
            (!task.manualReview ||
              [
                'MANUAL_REVIEW_REQUIRED',
                'RESULT_AMBIGUOUS',
                'CONTENT_MISMATCH',
              ].includes(task.reason ?? '')) &&
            task.state !== 'submission_recorded' &&
            task.state !== 'draft_saved' &&
            task.state !== 'closed_without_save' &&
            task.state !== 'closed_after_review' &&
            task.state !== 'stopped_by_user' && (
              <button
                disabled={pending}
                onClick={() =>
                  void command('control', () =>
                    window.desktopApi.reconcileDraft(task.taskId),
                  )
                }
              >
                {task.manualReview && task.reason === 'MANUAL_REVIEW_REQUIRED'
                  ? '核对已保存草稿并完成任务'
                  : '重新核对状态'}
              </button>
            )}
          {task &&
            ['needs_human', 'interrupted', 'failed', 'stopped'].includes(
              task.state,
            ) && (
              <button
                disabled={disabled}
                onClick={() =>
                  void command('control', () =>
                    window.desktopApi.finishHandledTask({
                      taskId: task.taskId,
                      expectedRevision: task.revision,
                    }),
                  )
                }
              >
                人工处理完成，结束这篇
              </button>
            )}
          {task?.canCloseTask && (
            <button
              disabled={disabled}
              onClick={() =>
                void command('control', () =>
                  window.desktopApi.prepareTaskClosure(task.taskId),
                )
              }
            >
              {task.ambiguousSaveReviewed
                ? '人工结束保存结果不明任务'
                : task.preEntryReviewed
                  ? '结束已审阅的执行前失败任务'
                  : '核对并结束未保存任务'}
            </button>
          )}
        </div>
        {closure && (
          <div
            className="draft-summary"
            role="group"
            aria-label="结束未保存任务确认"
          >
            <h3>
              {closure.basis === 'owner-reviewed-ambiguous-save'
                ? '确认人工结束本次任务'
                : '确认结束本次未保存任务'}
            </h3>
            <p>文章：{closure.title}</p>
            <p>门店：{closure.storeName}</p>
            <p>
              {closure.basis === 'owner-reviewed-ambiguous-save'
                ? '本次曾尝试保存，但无法唯一确认远端结果。确认后保留保存尝试、正文图片证据和失败记录，结束本次任务；不认定保存成功或从未保存，不重新执行原文章。'
                : closure.basis === 'owner-reviewed-before-entry'
                  ? '依据已审阅的进入编辑器前失败记录结束旧任务，保留审计，不查询草稿、不启动新任务。'
                  : closure.basis === 'owner-reviewed-empty-editor'
                    ? '请先人工确认上述门店的草稿箱中没有该完整标题。点击“确认结束本次任务”即确认已核对无同标题草稿，并依据空白编辑器失败记录结束旧任务；保留审计，不自动查询、不重新保存、不启动新任务。'
                    : closure.basis === 'owner-reviewed-unsaved-body'
                      ? '本任务未请求存草稿，编辑页可能保留既有图文。请先人工确认上述门店的草稿箱中没有该完整标题。点击“确认结束本次任务”即确认已核对无同标题草稿并结束该未保存任务；保留原始记录，不自动查询、不重新保存、不启动新任务。'
                      : '仅结束本次未保存任务，不会重新保存；不再核对草稿箱中是否存在同名草稿。'}
            </p>
            <button
              disabled={disabled}
              onClick={() =>
                void command('control', () =>
                  window.desktopApi.confirmTaskClosure(closure.token),
                )
              }
            >
              确认结束本次任务
            </button>
            <button disabled={disabled} onClick={() => setClosure(null)}>
              取消
            </button>
          </div>
        )}
      </div>
    </section>
  );
  return (
    <>
      {renderSections ? (
        renderSections({ singleContent, browserContent })
      ) : (
        <>
          {singleContent}
          {browserContent}
        </>
      )}
    </>
  );
}
