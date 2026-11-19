import { HelpTip } from '../HelpTip';
import { useEffect, useRef, useState } from 'react';
import {
  BrowserHealthViewSchema,
  BrowserHealthResultSchema,
  type BrowserHealthView,
} from '../../contracts/browser-health';
const initial: BrowserHealthView = {
  status: 'unchecked',
  version: null,
  stage: null,
  reason: null,
};
let readFlight: Promise<BrowserHealthView> | undefined;
function readHealth() {
  if (!readFlight) {
    const flight = Promise.resolve()
      .then(() => window.desktopApi.getBrowserHealth())
      .then((value) => BrowserHealthViewSchema.parse(value))
      .finally(() => {
        if (readFlight === flight) readFlight = undefined;
      });
    readFlight = flight;
  }
  return readFlight;
}
function statusText(view: BrowserHealthView): string {
  if (view.status === 'busy') {
    if (view.reason === 'business_open')
      return '请先手动关闭专用浏览器，再检查浏览器或打开更新页。';
    if (view.reason === 'maintenance_open')
      return 'Edge 更新页仍在使用，请手动关闭后返回重新检查。';
    if (view.reason === 'ownership_unconfirmed')
      return '浏览器占用尚未确认，请保留现场并联系维护人员。';
    return '请先处理当前任务，再检查浏览器或打开更新页。';
  }
  if (view.reason === 'update_unavailable')
    return '未能打开 Edge 更新页，请联网后再试，也可使用 Edge 菜单 → 帮助和反馈 → 关于 Microsoft Edge。';
  if (view.reason === 'ownership_unconfirmed')
    return '浏览器占用尚未确认，请保留现场并联系维护人员。';
  if (view.reason === 'cleanup_failed')
    return '临时检查窗口已关闭，但清理未完成。请重新检查；若仍失败，请联系维护人员。';
  if (view.reason === 'version_changed')
    return 'Edge 版本在启动期间发生变化，请关闭专用浏览器后重新检查。';
  if (view.reason === 'timeout')
    return '浏览器检查未能及时完成，请确认窗口状态后重新检查。';
  switch (view.status) {
    case 'unchecked':
      return '尚未检查浏览器';
    case 'checking':
      return view.stage === 'update'
        ? '正在打开 Edge 更新页…'
        : '正在检查浏览器…';
    case 'missing':
      return '未找到 Microsoft Edge，请安装系统正式版后重新检查。';
    case 'too_old':
      return 'Edge 版本过旧，请更新到 Edge 当前正式版后重新检查。';
    case 'unknown_version':
      return '无法识别 Edge 版本，请打开更新页查看版本后重新检查。';
    case 'check_failed':
      return '浏览器基础能力检查未通过。若 Edge 已是最新版本，请联系维护者发布新版助手。';
    case 'passed':
      return '浏览器基础检查通过';
    case 'update_open':
      return '已打开 Edge 更新页。请在 Edge 中查看更新提示；若 Edge 要求重启，请先保存浏览内容。手动关闭该窗口后返回重新检查，助手不会自动重启 Edge。';
    case 'unavailable':
      return '浏览器暂时无法启动，请检查系统 Edge 是否可正常打开，再重新检查。';
  }
}
export function BrowserHealthPanel({
  blocked,
  onBusyChange,
}: {
  blocked: boolean;
  onBusyChange: (busy: boolean) => void;
}): React.JSX.Element {
  const [view, setView] = useState<BrowserHealthView>(initial);
  const [pending, setPending] = useState(false),
    [readFailed, setReadFailed] = useState(false);
  const lock = useRef(false),
    alive = useRef(false);
  const busy =
    pending ||
    view.status === 'checking' ||
    view.status === 'update_open' ||
    view.status === 'busy' ||
    view.reason === 'ownership_unconfirmed';
  const browserExclusive =
    pending ||
    view.status === 'checking' ||
    view.status === 'update_open' ||
    view.reason === 'maintenance_open' ||
    view.reason === 'ownership_unconfirmed';
  useEffect(() => {
    onBusyChange(browserExclusive);
  }, [browserExclusive, onBusyChange]);
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await readHealth();
        if (!disposed && !lock.current) {
          setView(value);
          setReadFailed(false);
        }
      } catch {
        if (!disposed) setReadFailed(true);
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      alive.current = false;
      clearTimeout(timer);
    };
  }, []);
  async function command(update: boolean) {
    if (blocked || lock.current || busy) return;
    lock.current = true;
    setPending(true);
    setReadFailed(false);
    setView({
      status: 'checking',
      version: null,
      stage: update ? 'update' : 'launch',
      reason: null,
    });
    try {
      const result = BrowserHealthResultSchema.parse(
        await (update
          ? window.desktopApi.openBrowserUpdate()
          : window.desktopApi.checkBrowserHealth()),
      );
      if (alive.current) setView(result.view);
    } catch {
      if (alive.current) {
        setReadFailed(true);
        setView({
          status: 'unavailable',
          version: null,
          stage: update ? 'update' : 'launch',
          reason: update ? 'update_unavailable' : null,
        });
      }
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <section
      className="browser-health"
      aria-label="浏览器基础检查"
      aria-busy={busy}
    >
      <div className="heading-with-help">
        <h3>浏览器基础检查</h3>
        <HelpTip label="浏览器检查帮助">
          打开专用浏览器时会自动执行当次基础检查。更新由你在 Edge
          中完成；若要求重启，请先保存浏览内容，助手不会自动重启。完成后请返回重新检查。
        </HelpTip>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <p>{statusText(view)}</p>
        {view.version && <p>Edge 版本：{view.version}</p>}
        {readFailed && (
          <p>
            浏览器状态暂时无法读取，请稍后重新检查；操作结果以窗口实际状态为准。
          </p>
        )}
      </div>
      <div className="draft-actions">
        <button disabled={blocked || busy} onClick={() => void command(false)}>
          检查浏览器
        </button>
        <button disabled={blocked || busy} onClick={() => void command(true)}>
          打开 Edge 更新页
        </button>
      </div>
    </section>
  );
}
