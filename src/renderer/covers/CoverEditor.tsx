import { useEffect, useRef, useState } from 'react';
import type { CoverMode } from '../../contracts/article-cover';
import { CoverImage } from './CoverImage';
import { coverSession, type ArticleCoverController } from './useArticleCover';
function CoverDialog({
  open,
  title,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    focus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      focus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      ref.current?.showModal();
    } else if (ref.current?.open) {
      ref.current.close();
      requestAnimationFrame(
        () => focus.current?.isConnected && focus.current.focus(),
      );
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = ref.current?.querySelectorAll<HTMLButtonElement>(
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
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
export function CoverEditor({
  controller: c,
  articleKey,
  beforeBegin,
  admissionBlocked = false,
  stopControl,
  stopRevision = 0,
}: {
  controller: ArticleCoverController;
  articleKey?: string;
  beforeBegin: () => Promise<boolean>;
  admissionBlocked?: boolean;
  stopControl?: React.ReactNode;
  stopRevision?: number;
}) {
  const [modeChoice, setModeChoice] = useState<CoverMode | null>(null);
  const s =
    coverSession(c.state) && c.state.articleKey === articleKey ? c.state : null;
  const config =
    c.configuration?.articleKey === articleKey ? c.configuration : null;
  useEffect(
    () => setModeChoice(null),
    [articleKey, s?.sessionId, stopRevision],
  );
  const mode = s?.draft.mode ?? config?.mode ?? 'none';
  const tokens = s?.draft.imageTokens ?? [];
  const expected = mode === 'none' ? 0 : mode === 'single' ? 1 : 3;
  const ready = !!s && !c.blocked;
  function changeMode(next: CoverMode) {
    if (!s || !ready || next === mode) return;
    if (tokens.length) {
      setModeChoice(next);
      return;
    }
    void c.update({ mode: next, imageTokens: [] });
  }
  function choose(next: CoverMode, retained: string[]) {
    setModeChoice(null);
    void c.update({ mode: next, imageTokens: retained });
  }
  function reorder(index: number, delta: number) {
    const ordered = [...tokens];
    [ordered[index], ordered[index + delta]] = [
      ordered[index + delta],
      ordered[index],
    ];
    void c.update({ mode, imageTokens: ordered });
  }
  return (
    <section className="cover-panel" aria-label="封面图片">
      <h2>封面图片</h2>
      <p>
        封面与正文图片独立。请先在本机保存文章，再配置封面；单图封面会在正文填写后、存草稿前上传。三图封面暂不支持自动存稿。
      </p>
      {!articleKey ? (
        <p>请先将文章保存到本机，再配置封面</p>
      ) : c.readStatus === 'loading' && !config ? (
        <p role="status">正在读取封面…</p>
      ) : c.readStatus === 'removed' ? (
        <p role="alert">文章已从本机移除，不能编辑封面。</p>
      ) : c.readStatus === 'unavailable' ? (
        <p role="alert">封面暂时无法读取，请保留当前内容后核对状态。</p>
      ) : !s && config?.mode === 'none' ? (
        <p>未配置封面，将尝试保存正文草稿；平台可能要求人工补充。</p>
      ) : !s && config ? (
        <p>
          {config.mode === 'single' ? '单图' : '三图'} · {config.images.length}
          张封面已保存到本机
        </p>
      ) : null}
      <div aria-live="polite" aria-atomic="true">
        {c.notice && (
          <p
            role={
              c.unknown ||
              c.state?.notice === 'image_invalid' ||
              c.state?.notice === 'blocked' ||
              c.state?.notice === 'conflict' ||
              c.state?.notice === 'needs_review'
                ? 'alert'
                : 'status'
            }
          >
            {c.notice}
          </p>
        )}
        {c.pending && <p role="status">正在处理封面，请等待…</p>}
      </div>
      {!s ? (
        <button
          disabled={
            !articleKey ||
            admissionBlocked ||
            c.blocked ||
            c.hasSession ||
            c.readStatus !== 'ok'
          }
          onClick={() => void c.begin(beforeBegin)}
        >
          编辑封面
        </button>
      ) : (
        <>
          <fieldset disabled={!ready}>
            <legend>封面模式</legend>
            {(['none', 'single', 'triple'] as const).map((m) => (
              <label key={m}>
                <input
                  type="radio"
                  name="cover-mode"
                  checked={mode === m}
                  onChange={() => changeMode(m)}
                />
                {m === 'none' ? '无封面' : m === 'single' ? '单图' : '三图'}
              </label>
            ))}
          </fieldset>
          {mode !== 'none' && (
            <>
              <p>
                {tokens.length === expected
                  ? '已选' + expected + '张，请核对图片顺序。'
                  : '还需选择' +
                    (expected - tokens.length) +
                    '张；' +
                    (mode === 'triple'
                      ? '三图须恰好3张才能保存。'
                      : '单图须恰好1张才能保存。')}
              </p>
              <button
                disabled={!ready}
                onClick={() =>
                  void c.pick(Array.from({ length: expected }, (_, i) => i))
                }
              >
                从本地选择封面
              </button>
            </>
          )}
        </>
      )}
      <ol className="cover-thumbnails">
        {s
          ? tokens.map((token, index) => (
              <li key={token}>
                <strong>第{index + 1}张</strong>
                <CoverImage
                  position={index + 1}
                  request={{
                    kind: 'session',
                    sessionId: s.sessionId,
                    imageToken: token,
                  }}
                />
                <div className="cover-actions">
                  <button
                    disabled={!ready}
                    onClick={() => void c.pick([index])}
                  >
                    替换第{index + 1}张封面
                  </button>
                  <button
                    disabled={!ready}
                    onClick={() =>
                      void c.update({
                        mode,
                        imageTokens: tokens.filter((t) => t !== token),
                      })
                    }
                  >
                    移除第{index + 1}张封面
                  </button>
                  <button
                    disabled={!ready || index === 0}
                    onClick={() => reorder(index, -1)}
                  >
                    第{index + 1}张封面前移
                  </button>
                  <button
                    disabled={!ready || index === tokens.length - 1}
                    onClick={() => reorder(index, 1)}
                  >
                    第{index + 1}张封面后移
                  </button>
                </div>
              </li>
            ))
          : config?.images.map((image, index) => (
              <li key={image.assetKey}>
                <strong>第{index + 1}张</strong>
                <CoverImage
                  position={index + 1}
                  request={{
                    kind: 'stored',
                    articleKey: config.articleKey,
                    coverRevision: config.coverRevision,
                    assetKey: image.assetKey,
                  }}
                />
              </li>
            ))}
        {s && mode !== 'none' && tokens.length < expected && (
          <li>
            <button
              disabled={!ready}
              onClick={() => void c.pick([tokens.length])}
            >
              补充第{tokens.length + 1}张封面
            </button>
          </li>
        )}
      </ol>
      {s && (
        <div className="cover-actions">
          <button
            className="primary"
            disabled={!ready || tokens.length !== expected || !s.dirty}
            onClick={() => void c.save()}
          >
            保存封面
          </button>
          <button disabled={!c.canLeave} onClick={() => void c.leave()}>
            完成封面编辑
          </button>
        </div>
      )}
      {(c.unknown || c.state?.notice === 'needs_review') && (
        <button onClick={() => void c.reconcile()}>核对封面保存结果</button>
      )}
      <CoverDialog
        open={modeChoice !== null}
        title={
          modeChoice === 'single'
            ? '选择要保留的封面'
            : modeChoice === 'none'
              ? '移除当前封面？'
              : '保留当前封面并补充？'
        }
        onCancel={() => setModeChoice(null)}
      >
        <p>
          {modeChoice === 'single'
            ? '请选择保留哪张，其余图片会从本次封面候选中移除。'
            : modeChoice === 'none'
              ? '切换为无封面会移除当前候选图片。正式配置仍需点击保存封面。'
              : '当前图片将保留原顺序，请再补充到3张。'}
        </p>
        <div className="cover-actions">
          <button autoFocus onClick={() => setModeChoice(null)}>
            继续编辑
          </button>
          {modeChoice === 'single' ? (
            tokens.map((t, i) => (
              <button key={t} onClick={() => choose('single', [t])}>
                保留第{i + 1}张封面
              </button>
            ))
          ) : modeChoice === 'none' ? (
            <button onClick={() => choose('none', [])}>确认移除封面</button>
          ) : (
            <button onClick={() => choose('triple', tokens)}>
              保留当前图片并补充
            </button>
          )}
        </div>
        {stopControl}
      </CoverDialog>
      <CoverDialog
        open={c.choice}
        title="离开封面编辑？"
        onCancel={() => c.answer('keep')}
      >
        <p>当前封面尚未保存，请选择如何继续。</p>
        <div className="cover-actions">
          <button autoFocus onClick={() => c.answer('keep')}>
            继续编辑
          </button>
          <button
            disabled={!ready || tokens.length !== expected}
            onClick={() => c.answer('save')}
          >
            保存并继续
          </button>
          <button onClick={() => c.answer('discard')}>放弃修改</button>
          {stopControl}
        </div>
      </CoverDialog>
    </section>
  );
}
