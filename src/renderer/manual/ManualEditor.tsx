import { useEffect, useRef, useState } from 'react';
import { ContinuousBodyEditor } from '../editor/ContinuousBodyEditor';
import type { ImageProjection } from '../editor/InlineArticleImage';
import { isSession, type useManualArticle } from './useManualArticle';
import { pasteErrorMessages } from './PendingImage';
export function ManualEditor({
  controller: c,
  onFinish,
}: {
  controller: ReturnType<typeof useManualArticle>;
  onFinish?: () => void;
}) {
  const [mode, setMode] = useState<'rich-paste' | 'manual'>('rich-paste'),
    [confirm, setConfirm] = useState(false);
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
    block.type === 'paragraph'
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
      <div className="toolbar">
        <div>
          <h2>{existing ? '修改文章' : '新建文章'}</h2>
          <p>
            {state.dirty || c.unsynced
              ? '有尚未保存到本机的修改'
              : existing
                ? '当前文章已保存到本机'
                : '尚未保存到文章池'}
          </p>
        </div>
        <button
          ref={discard}
          disabled={c.blocked && !c.canDiscardConflict}
          onClick={() => {
            if (onFinish) {
              onFinish();
              return;
            }
            if (state.dirty || c.unsynced) setConfirm(true);
            else void c.command('discard');
          }}
        >
          {existing ? '结束编辑' : '放弃录入'}
        </button>
      </div>
      <p className="hint">
        输入同步只在本次运行期间保留。请明确保存到本机；未保存修改在关闭后丢失。
      </p>
      <div className="operation" role="status" aria-live="polite">
        {c.unknown
          ? '状态暂时无法确认，正在核对…'
          : state.state === 'saving'
            ? '正在保存文章…'
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
                  : c.syncing
                    ? '正在同步输入…'
                    : c.unsynced
                      ? '输入尚未同步，请检查提示'
                      : c.pending
                        ? '正在处理…'
                        : '输入已同步'}
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
      {c.notice && <p role="alert">{c.notice}</p>}
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
      {state.saveOutcome && !state.dirty && !c.unsynced && (
        <p role="status">
          {state.saveOutcome.kind === 'updated'
            ? '修改已保存到本机'
            : state.saveOutcome.kind === 'unchanged'
              ? '文章没有变化'
              : '文章已保存到本机'}
        </p>
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
          {summary.plainOnly && summary.admitted && (
            <p>本次剪贴板只提供文字，未取得网页图片信息</p>
          )}
        </div>
      )}
      <div
        role="group"
        aria-label="录入方式"
        className="manual-actions entry-mode"
      >
        <button
          aria-pressed={mode === 'rich-paste'}
          disabled={c.blocked}
          onClick={() => {
            void c.flushDraft().then((ok) => {
              if (ok) setMode('rich-paste');
            });
          }}
        >
          富文本粘贴
        </button>
        <button
          aria-pressed={mode === 'manual'}
          disabled={c.blocked}
          onClick={() => {
            void c.flushDraft().then((ok) => {
              if (ok) setMode('manual');
            });
          }}
        >
          手动录入
        </button>
      </div>
      <fieldset disabled={c.blocked} className="manual-fields">
        <label>
          文章标题
          <input
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
        <label>
          文章声明
          <select
            aria-label="文章声明"
            value={draft.contentDeclaration}
            onChange={(event) =>
              c.change({
                ...draft,
                contentDeclaration: event.target.value as 'original' | 'repost',
              })
            }
          >
            <option value="repost">转载</option>
            <option value="original">原创</option>
          </select>
        </label>
      </fieldset>
      <p id="continuous-body-help" className="hint">
        在正文光标处按 Ctrl+V
        插入图文；选中文字或图片可替换、删除。只保留基本段落、图片及顺序。
      </p>
      <ContinuousBodyEditor
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
      <div className="editor-footer">
        <div className="manual-actions">
          {mode === 'manual' && (
            <button disabled={c.blocked} onClick={() => void c.command('pick')}>
              添加图片
            </button>
          )}
          <button
            className="primary"
            disabled={
              c.blocked || unresolved > 0 || (!state.dirty && !c.unsynced)
            }
            aria-describedby={unresolved ? 'pending-save-help' : undefined}
            onClick={() => void c.command('save')}
          >
            {existing ? '保存修改' : '保存到文章池'}
          </button>
        </div>
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
