import { HelpTip } from '../HelpTip';
import { CoverImage } from '../covers/CoverImage';
import { CoverModeControls } from '../covers/CoverModeControls';
import { isSession, type useManualArticle } from './useManualArticle';
import type { CoverImageRequest } from '../../contracts/article-cover';
const readManualImage = (request: CoverImageRequest) =>
  request.kind === 'session'
    ? window.desktopApi.getManualCoverImage(
        request.sessionId,
        request.imageToken,
      )
    : window.desktopApi.getCoverImage(request);
export function ManualCoverEditor({
  controller,
}: {
  controller: ReturnType<typeof useManualArticle>;
}) {
  const snapshot = controller.snapshot;
  if (!isSession(snapshot) || !snapshot.cover) return null;
  const cover = snapshot.cover;
  const uncertain =
    !!cover.outcome &&
    ['pending', 'needs_review', 'unavailable', 'not_started'].includes(
      cover.outcome.status,
    );
  return (
    <section className="cover-panel manual-cover-panel" aria-label="文章封面">
      <div className="heading-with-help">
        <h3>文章封面</h3>
        <HelpTip label="文章封面帮助">
          封面与文章一起保存到本机，单图封面会在存草稿前上传。
        </HelpTip>
      </div>
      <CoverModeControls
        mode={cover.mode}
        modes={['none', 'single']}
        disabled={controller.blocked}
        onChange={(mode) => {
          if (mode !== 'triple')
            void controller.command(
              mode === 'single' ? 'cover-single' : 'cover-none',
            );
        }}
      />
      {cover.mode === 'triple' && (
        <p>已保存三图封面，保存正文会保留原封面。可选择单图或无封面替换。</p>
      )}
      <button
        disabled={controller.blocked}
        onClick={() => void controller.command('cover-pick')}
      >
        从本地选择封面
      </button>
      {cover.image && (
        <div className="cover-thumbnails">
          <CoverImage
            position={1}
            request={{
              kind: 'session',
              sessionId: snapshot.sessionId,
              imageToken: cover.image.imageToken,
            }}
            reader={readManualImage}
          />
        </div>
      )}
      <p role="status">
        {cover.dirty
          ? '封面尚未保存'
          : cover.mode === 'none'
            ? '未设封面'
            : '封面已保存到本机'}
      </p>
      {cover.notice && <p role="alert">{cover.notice}</p>}
      {cover.outcome &&
        ['failed', 'conflict', 'blocked'].includes(cover.outcome.status) && (
          <p role="alert">
            封面未能保存，候选已保留。请再次保存，或返回时放弃修改。
          </p>
        )}
      {uncertain && snapshot.state === 'editing' && (
        <>
          <p role="alert">封面保存结果待核对，请先核对再继续。</p>
          <button
            disabled={controller.pending}
            onClick={() => void controller.command('cover-reconcile')}
          >
            核对封面保存结果
          </button>
        </>
      )}
    </section>
  );
}
