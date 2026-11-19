import { useEffect, useState } from 'react';
import { AppStatusSchema, type AppStatus } from '../contracts/app-status';
import { ArticleWorkspace } from './manual/ArticleWorkspace';
import { UploadWaitSettingsMenuDialog } from './UploadWaitSettings';
export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = AppStatusSchema.parse(
          await window.desktopApi.getAppStatus(),
        );
        if (active) setStatus(result);
      } catch {
        if (active)
          setStatus({ state: 'unavailable', code: 'INITIALIZATION_FAILED' });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);
  return (
    <main>
      <UploadWaitSettingsMenuDialog />
      <header>
        <span className="eyebrow">文章 · 草稿</span>
        <h1>汽车经销商草稿助手</h1>
      </header>
      {status?.state === 'ready' ? (
        <ArticleWorkspace />
      ) : (
        <section className="preparation" aria-label="应用状态">
          <div className="mark" aria-hidden="true">
            文
          </div>
          {status?.state === 'unavailable' ? (
            <p role="alert">应用暂时无法准备完成，请关闭后重试。</p>
          ) : (
            <p role="status">{status ? '文章功能尚未开放' : '正在准备应用…'}</p>
          )}
        </section>
      )}
    </main>
  );
}
