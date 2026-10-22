import { useEffect, useRef, useState } from 'react';
import {
  OperationControlViewSchema,
  type OperationControlView,
  type OperationScope,
} from '../contracts/operation-control';

export function useOperationControl(
  onStop: () => void,
  onInitialized?: () => void,
) {
  const resetCallback = useRef(onInitialized);
  resetCallback.current = onInitialized;
  const initializing = useRef(false);
  const completed = useRef<(() => void) | undefined>(undefined);
  const [view, setView] = useState<OperationControlView | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState(false);
  const [longStop, setLongStop] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const querySequence = useRef(0);
  const latest = useRef<OperationControlView | null>(null);
  const isSettling = () => latest.current?.phase === 'stopping';
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      clearTimeout(timeout.current);
    };
  }, []);
  const accept = (value: unknown) => {
    const next = OperationControlViewSchema.parse(value);
    if (
      !alive.current ||
      (latest.current && next.revision < latest.current.revision)
    )
      return;
    latest.current = next;
    setView(next);
    setUncertain(false);
    if (next.phase === 'stopped' || next.phase === 'needs_review') {
      clearTimeout(timeout.current);
      setLongStop(false);
      inFlight.current = false;
      setPending(false);
      if (next.phase === 'stopped' && initializing.current) {
        initializing.current = false;
        resetCallback.current?.();
      }
      completed.current?.();
      completed.current = undefined;
    }
  };
  async function query(ticket: number) {
    if (!alive.current || ticket !== generation.current) return;
    clearTimeout(timer.current);
    const request = ++querySequence.current;
    try {
      const result = await window.desktopApi.getOperationControlState();
      if (ticket !== generation.current || request !== querySequence.current)
        return;
      accept(result);
    } catch {
      if (
        alive.current &&
        ticket === generation.current &&
        request === querySequence.current
      )
        setUncertain(true);
    }
    if (
      alive.current &&
      ticket === generation.current &&
      request === querySequence.current &&
      latest.current?.phase === 'stopping'
    )
      timer.current = setTimeout(() => void query(ticket), 1000);
  }
  async function stop() {
    if (inFlight.current) return;
    // A lost read must not make stop unreachable; this branch never resends content.
    if (isSettling()) {
      await query(generation.current);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setLongStop(false);
    setUncertain(false);
    const ticket = ++generation.current;
    initializing.current = true;
    const terminal = new Promise<void>((resolve) => {
      completed.current = resolve;
    });
    clearTimeout(timer.current);
    onStop(); // Invalidate renderer handovers before sending the privileged request.
    timeout.current = setTimeout(() => {
      if (alive.current) {
        setLongStop(true);
        if (!latest.current || latest.current.phase === 'idle')
          setUncertain(true);
        setPending(false);
        inFlight.current = false;
        void query(ticket);
      }
    }, 15000);
    try {
      await Promise.race([
        window.desktopApi.requestStopAll().then((value) => {
          if (ticket === generation.current) accept(value);
        }),
        terminal,
      ]);
    } catch {
      if (alive.current && ticket === generation.current) setUncertain(true);
    } finally {
      if (ticket === generation.current) {
        if (latest.current?.phase !== 'stopping') clearTimeout(timeout.current);
        inFlight.current = false;
        if (alive.current) {
          setPending(false);
          if (latest.current?.phase === 'stopping')
            timer.current = setTimeout(() => void query(ticket), 1000);
        }
      }
    }
  }
  return {
    view,
    uncertain,
    pending,
    longStop,
    stop,
    blocked: pending || uncertain || view?.phase === 'stopping',
  };
}
const labels: Record<OperationScope, string> = {
  draft: '草稿与浏览器',
  browser: '浏览器',
  manual: '正文编辑与图片',
  cover: '封面处理',
  import: '文章导入',
};
export function OperationControls({
  control,
  dirty = false,
  compact = false,
  showButton = true,
}: {
  control: ReturnType<typeof useOperationControl>;
  dirty?: boolean;
  compact?: boolean;
  showButton?: boolean;
}) {
  return (
    <div className="operation-controls">
      {showButton && (
        <button
          aria-label="停止并初始化"
          disabled={control.pending}
          onClick={() => void control.stop()}
        >
          停止并初始化
        </button>
      )}
      {compact &&
        (control.pending ||
          control.uncertain ||
          (control.view && control.view.phase !== 'idle')) && (
          <span className="stop-feedback" role="status">
            {control.pending || control.view?.phase === 'stopping'
              ? '正在停止…'
              : control.uncertain
                ? '停止结果待核对'
                : control.view?.phase === 'stopped'
                  ? '已停止并释放占用'
                  : '已停止，请核对历史结果'}
          </span>
        )}
      {!compact && (
        <>
          <p>停止后保留本地文章、图片和任务记录，不删除远端草稿。</p>
          <div role="status" aria-label="停止状态">
            {control.uncertain ? (
              <p>停止结果暂时无法确认，请保留现场，不要再次启动上传。</p>
            ) : control.pending || control.view?.phase === 'stopping' ? (
              <p>正在停止，等待当前操作安全结束。</p>
            ) : control.view?.phase === 'needs_review' ? (
              <p>停止请求已处理，仍有结果需要核对；不会自动重试。</p>
            ) : control.view?.phase === 'stopped' ? (
              <p>
                已停止并释放占用，可以重新上传。上次可能已生成草稿，请自行核对；重复上传可能产生重复草稿。
              </p>
            ) : null}
            {control.view &&
              control.view.phase !== 'idle' &&
              control.view.owners.map((owner) => (
                <p key={owner.scope}>
                  {labels[owner.scope]}：
                  {owner.state === 'active'
                    ? '仍在收尾'
                    : owner.state === 'needs_review'
                      ? '结果待核对'
                      : '无运行中的操作'}
                </p>
              ))}
            {dirty && <p>当前有未保存编辑，内容已保留在编辑器中。</p>}
          </div>
        </>
      )}
    </div>
  );
}
