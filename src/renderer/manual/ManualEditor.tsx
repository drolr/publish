import { HelpTip } from '../HelpTip';
import { ManualCoverEditor } from './ManualCoverEditor';
import type { WorkspaceTaskStatus } from '../WorkspaceFooter';
import { isManualImageBlock } from '../../contracts/manual-article';
import { useEffect, useRef, useState } from 'react';
import { ContinuousBodyEditor } from '../editor/ContinuousBodyEditor';
import type { ImageProjection } from '../editor/InlineArticleImage';
import { isSession, type useManualArticle } from './useManualArticle';
import { pasteErrorMessages } from './PendingImage';
export function ManualEditor({
  controller: c,
  onFinish,
  taskStatus,
}: {
  controller: ReturnType<typeof useManualArticle>;
  onFinish?: () => void;
  taskStatus?: WorkspaceTaskStatus | null;
}) {
  const [confirm, setConfirm] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    discard = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
    else if (dialog.current?.open) {
      dialog.current.close();
      discard.current?.focus();
    }
  }, [confirm]);
  const state = c.snapshot,
    draft = c.draft;
  if (!isSession(state) || !draft) return null;
  const unresolved = draft.blocks.filter(
    (b) => b.type === 'image-pending',
  ).length;
  const issues =
    state.issues ??
    (state.result?.status === 'invalid' ? state.result.issues : []);
  const projections: ImageProjection[] = draft.blocks.flatMap((block) =>
    !isManualImageBlock(block)
      ? []
      : [
          {
            blockKey: block.blockKey,
            image:
              block.type === 'image'
                ? state.images.find((i) => i.imageToken === block.imageToken)
                : undefined,
            candidate:
              block.type === 'image-pending'
                ? state.candidates.find(
                    (i) => i.candidateId === block.candidateId,
                  )
                : undefined,
            disabled: c.blocked,
            retry:
              block.type === 'image-pending'
                ? () => void c.retryImage(block.candidateId)
                : undefined,
          },
        ],
  );
  const existing = state.target.kind === 'existing';
  const confirmedLocalSave =
    !c.unknown &&
    !!state.saveOutcome &&
    !state.dirty &&
    !state.cover?.dirty &&
    !c.unsynced;
  const busy = [
    'saving',
    'selecting',
    'pasting',
    'retrying',
    'stopping',
  ].includes(state.state);
  const summary = state.pasteSummary;
  return (
    <section
      className="manual-editor"
      aria-label={existing ? '修改文章' : '新建文章'}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 's'
        ) {
          event.preventDefault();
          if (!c.blocked && !unresolved) void c.command('save');
        }
      }}
    >
      <div className="focused-editor-header toolbar">
        <button
          ref={discard}
          disabled={c.blocked && !c.canDiscardConflict}
          onClick={() => {
            if (onFinish) {
              onFinish();
              return;
            }
            if (state.dirty || state.cover?.dirty || c.unsynced)
              setConfirm(true);
            else void c.command('discard');
          }}
        >
          {onFinish ? '返回文章池' : existing ? '结束编辑' : '放弃录入'}
        </button>
        <h2>{existing ? '修改文章' : '新建文章'}</h2>
        <p
          className="editor-save-status"
          role="status"
          aria-live="polite"
          data-input-pending={c.syncing || c.unsynced}
        >
          {c.unknown
            ? '状态暂时无法确认，正在核对…'
            : state.state === 'saving'
              ? '正在保存到本机…'
              : state.state === 'pasting' || state.state === 'retrying'
                ? state.pasteProgress?.phase === 'images'
                  ? `正在取得第${state.pasteProgress.current}/${state.pasteProgress.total}张图片…`
                  : '正在整理粘贴内容…'
                : state.state === 'selecting'
                  ? state.operationKind === 'open'
                    ? '正在加载文章…'
                    : '正在检查图片…'
                  : state.state === 'stopping'
                    ? '正在停止…'
                    : !state.dirty &&
                        !c.unsynced &&
                        state.cover?.dirty &&
                        existing
                      ? '文章已保存，封面未保存'
                      : state.dirty || state.cover?.dirty || c.unsynced
                        ? '有未保存修改'
                        : existing || confirmedLocalSave
                          ? '已保存到本机'
                          : '尚未保存到本机'}
        </p>
        <button
          className="primary"
          disabled={
            c.blocked ||
            unresolved > 0 ||
            (!state.dirty && !state.cover?.dirty && !c.unsynced)
          }
          aria-describedby={unresolved ? 'pending-save-help' : undefined}
          onClick={() => void c.command('save')}
        >
          {existing ? '保存修改' : '保存到本机'}
        </button>
        {busy && (
          <button
            disabled={c.pending || c.unknown || state.state === 'stopping'}
            onClick={() => void c.command('cancel')}
          >
            {state.state === 'pasting' || state.state === 'retrying'
              ? '停止取图'
              : state.state === 'selecting'
                ? '取消选图'
                : '取消保存'}
          </button>
        )}
      </div>
      {taskStatus && <p className="editor-task-status">{taskStatus.message}</p>}
      {c.notice && (
        <p
          role={
            c.notice === '已核对当前内容；请检查操作结果。' ? 'status' : 'alert'
          }
        >
          {c.notice}
        </p>
      )}
      {!!issues.length && (
        <div role="alert">
          <ul>
            {issues.map((issue, index) => (
              <li key={index}>
                {issue.position ? `${issue.position}：` : ''}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.result?.status === 'failed' && (
        <p role="alert">{state.result.message}</p>
      )}
      {state.result?.status === 'cancelled' && (
        <p role="status">已取消，正文内容已保留。</p>
      )}
      {summary && state.state === 'editing' && (
        <div role={summary.outcome === 'rejected' ? 'alert' : 'status'}>
          <p>
            {summary.outcome === 'rejected'
              ? pasteErrorMessages[summary.reason ?? 'INVALID_FRAGMENT']
              : summary.outcome === 'cancelled'
                ? '已停止取图，正文及未完成的图片位置已保留'
                : summary.unresolved
                  ? `还有${summary.unresolved}张图片需要处理`
                  : '粘贴内容已加入正文'}
          </p>
          {summary.admitted &&
            [...new Set(summary.warnings ?? [])].map((warning) => (
              <p key={warning}>
                {warning === 'HEADING_NORMALIZED'
                  ? '标题层级已统一为小标题'
                  : warning === 'STYLE_NORMALIZED'
                    ? '已移除不支持的样式，保留可用的文字格式'
                    : '本次按纯文本粘贴，未包含文字格式或网页图片信息'}
              </p>
            ))}
          {summary.admitted &&
            summary.plainOnly &&
            !summary.warnings?.includes('PLAIN_ONLY') && (
              <p>本次按纯文本粘贴，未包含文字格式或网页图片信息</p>
            )}
        </div>
      )}
      <ContinuousBodyEditor
        onInsertImage={() => void c.command('pick')}
        beforeBody={
          <label className="article-title-field">
            文章标题
            <input
              placeholder="输入文章标题"
              disabled={c.blocked}
              value={draft.title}
              onCompositionStart={() => c.setComposition('title', true)}
              onCompositionEnd={(event) => {
                c.change({ ...draft, title: event.currentTarget.value });
                c.setComposition('title', false);
              }}
              onChange={(event) =>
                c.change({ ...draft, title: event.target.value })
              }
            />
          </label>
        }
        session={state.sessionId}
        draft={draft}
        imageProjection={projections}
        editable={!c.blocked && state.state === 'editing'}
        onTransaction={(value, composing) => {
          c.setComposition('body', composing);
          c.change(value);
        }}
        onPaste={(input) => void c.startPaste(input)}
        onCopyCut={(cut) => void c.command(cut ? 'cut' : 'copy')}
        onRangeChange={c.rangeChange}
      />
      <ManualCoverEditor controller={c} />
      <div className="editor-footer">
        <HelpTip label="正文编辑帮助">
          在正文光标处按 Ctrl+V 插入图文，Ctrl+Shift+V
          仅粘贴文字。请明确保存到本机，未保存修改在关闭后丢失。
        </HelpTip>
        {unresolved > 0 && (
          <p id="pending-save-help" className="hint">
            还有 {unresolved} 张图片需要处理，可重试或通过正文选区移除后保存。
          </p>
        )}
      </div>
      <dialog
        ref={dialog}
        aria-labelledby="discard-title"
        onCancel={(event) => {
          event.preventDefault();
          setConfirm(false);
        }}
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
      >
        <h2 id="discard-title">放弃尚未保存的修改？</h2>
        <p>已保存的文章保留，尚未保存的修改无法恢复。</p>
        <div className="manual-actions">
          <button autoFocus onClick={() => setConfirm(false)}>
            继续录入
          </button>
          <button
            onClick={() => {
              setConfirm(false);
              void c.command('discard');
            }}
          >
            确认放弃
          </button>
        </div>
      </dialog>
    </section>
  );
}
