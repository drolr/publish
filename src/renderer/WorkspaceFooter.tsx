import { useEffect, useRef } from 'react';
import {
  OperationControls,
  type useOperationControl,
} from './OperationControls';

export type WorkspaceTaskStatus = {
  message: string;
  needsAttention: boolean;
  active: boolean;
};

export function WorkspaceFooter({
  control,
  issue,
  taskStatus,
  onReturn,
  returnBlocked = false,
}: {
  control: ReturnType<typeof useOperationControl>;
  issue: string;
  taskStatus?: WorkspaceTaskStatus | null;
  onReturn?: () => void;
  returnBlocked?: boolean;
}) {
  const footer = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = footer.current,
      main = element?.closest('main');
    if (!element || !main) return;
    const update = () =>
      main.style.setProperty(
        '--workspace-footer-height',
        element.getBoundingClientRect().height + 'px',
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      main.style.removeProperty('--workspace-footer-height');
    };
  }, []);
  return (
    <section
      ref={footer}
      className="workspace-footer"
      role="region"
      aria-label="全局操作状态"
    >
      <div className="workspace-footer-message" aria-live="polite">
        {issue &&
        !['stopping', 'needs_review'].includes(control.view?.phase ?? '') ? (
          <p className="workspace-error">
            {taskStatus?.message && <span>{taskStatus.message} · </span>}
            {issue}
          </p>
        ) : (
          <p>
            {control.pending || control.view?.phase === 'stopping'
              ? control.longStop
                ? '仍在停止，请等待当前操作结束；占用尚未释放。'
                : '正在停止，等待占用释放…'
              : control.view?.phase === 'stopped'
                ? '已停止并初始化，可重新选择文章。'
                : control.view?.phase === 'needs_review'
                  ? '需要处理：' +
                    control.view.owners
                      .filter((o) => o.state === 'needs_review')
                      .map(
                        (o) =>
                          ({
                            draft: '草稿与浏览器',
                            browser: '浏览器',
                            manual: '正文编辑与图片',
                            cover: '封面处理',
                            import: '文章导入',
                          })[o.scope],
                      )
                      .join('、') +
                    (control.view.owners.some(
                      (o) =>
                        ['manual', 'cover'].includes(o.scope) &&
                        o.state === 'needs_review',
                    )
                      ? '；本地编辑内容已保留，请保存或放弃后再停止。'
                      : '；请保留现场并核对结果，然后再次停止。')
                  : taskStatus?.message || '准备就绪'}
          </p>
        )}
      </div>
      {onReturn && taskStatus && (
        <button disabled={returnBlocked} onClick={onReturn}>
          返回工作区处理
        </button>
      )}
      <OperationControls control={control} compact />
    </section>
  );
}
