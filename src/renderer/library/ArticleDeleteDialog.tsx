import { useEffect, useRef } from 'react';
import type { ArticleSummary } from '../../contracts/article-library';

export function ArticleDeleteDialog({
  article,
  onCancel,
  onConfirm,
  busy,
}: {
  article: ArticleSummary;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="delete-title"
      className="article-delete-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls =
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button:not(:disabled)',
          );
        const first = controls[0],
          last = controls[controls.length - 1];
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <h2 id="delete-title">从本机删除文章？</h2>
      <p>
        <strong>{article.title}</strong>
      </p>
      <p>文章编号 {article.externalId}</p>
      <p>从本机文章池移除，不会删除巨懂车草稿。执行历史和防重复记录保留。</p>
      <div className="manual-actions">
        <button autoFocus disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button disabled={busy} onClick={onConfirm}>
          确认删除
        </button>
      </div>
    </dialog>
  );
}
