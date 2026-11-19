import { HelpTip } from '../HelpTip';
import { readArticlePreview } from '../library/readArticlePreview';
import { useEffect, useRef, useState } from 'react';
import {
  PreviewResultSchema,
  type ArticlePreview,
} from '../../contracts/article-library';
import {
  CoverReadResultSchema,
  CoverEditReplySchema,
  CoverSaveResultSchema,
  type CoverReadResult,
  type CoverEditReply,
} from '../../contracts/article-cover';
import { CoverImage } from './CoverImage';
type Config = Extract<CoverReadResult, { status: 'ok' }>['configuration'];
type Card = { article: ArticlePreview; cover: Config };
type Session = Extract<CoverEditReply, { sessionId: string }>;
const command = (s: Session) => ({
  sessionId: s.sessionId,
  expectedDraftRevision: s.draftRevision,
});
function opened(value: unknown, key: string, id?: string): Session {
  const s = CoverEditReplySchema.parse(value);
  if (
    !('sessionId' in s) ||
    s.articleKey !== key ||
    (id && s.sessionId !== id) ||
    s.status !== 'open' ||
    s.notice !== null
  )
    throw Error('Cover not ready');
  return s;
}
export function BatchCoverPanel({
  articleKeys,
  blocked = false,
  contentEpoch = 0,
  operationGeneration,
  beforeWrite,
  onBusyChange,
  onChanged,
  onEdit,
}: {
  articleKeys: string[];
  blocked?: boolean;
  contentEpoch?: number;
  operationGeneration?: () => number;
  beforeWrite: () => Promise<boolean>;
  onBusyChange?: (busy: boolean) => void;
  onChanged?: () => void;
  onEdit?: (key: string) => void;
}) {
  const [cards, setCards] = useState<Card[]>([]),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<{
    session: Session;
    cards: Card[];
    selection: string;
    generation: number | undefined;
    actionId: number;
  } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const selection = JSON.stringify(articleKeys),
    latest = useRef({
      selection,
      generation: operationGeneration?.(),
      blocked,
    });
  latest.current = { selection, generation: operationGeneration?.(), blocked };
  const actions = useRef(0);
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange?.(busy || !!preview);
  }, [busy, preview, onBusyChange]);
  useEffect(() => {
    let active = true;
    setCards([]);
    setError(false);
    setPreview(null);
    void (async () => {
      const rows: Card[] = [];
      for (const key of articleKeys) {
        const a = PreviewResultSchema.parse(
          await readArticlePreview(key, () => active),
        );
        const c = CoverReadResultSchema.parse(
          await window.desktopApi.getArticleCover(key),
        );
        if (
          a.status !== 'ok' ||
          c.status !== 'ok' ||
          a.article.articleKey !== key ||
          c.configuration.articleKey !== key
        )
          throw Error('Read failed');
        rows.push({ article: a.article, cover: c.configuration });
      }
      if (active) setCards(rows);
    })().catch(() => {
      if (active) setError(true);
    });
    return () => {
      active = false;
    };
  }, [selection, contentEpoch, epoch]);
  useEffect(() => {
    actions.current++;
    lock.current = false;
    setBusy(false);
    setPreview(null);
    setEpoch((v) => v + 1);
    if (latest.current.generation)
      setNotice('封面操作已停止，已保存的本地配置保留，请核对后继续。');
  }, [latest.current.generation, selection]);
  const valid = (ticket: {
    selection: string;
    generation: number | undefined;
    actionId: number;
  }) =>
    alive.current &&
    ticket.actionId === actions.current &&
    ticket.selection === latest.current.selection &&
    ticket.generation === latest.current.generation &&
    ticket.generation === operationGeneration?.();
  async function choose() {
    if (
      lock.current ||
      blocked ||
      !cards.length ||
      cards.length !== articleKeys.length
    )
      return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    const ticket = {
      selection,
      generation: operationGeneration?.(),
      actionId: ++actions.current,
    };
    let owned: Session | undefined;
    try {
      if (!(await beforeWrite()) || !valid(ticket)) return;
      const first = cards[0];
      owned = opened(
        await window.desktopApi.beginCoverEdit(first.article.articleKey),
        first.article.articleKey,
      );
      if (!valid(ticket)) return;
      if (
        owned.baseArticleRevision !== first.article.articleRevision ||
        owned.baseCoverRevision !== first.cover.coverRevision
      )
        throw Error('Changed');
      owned = opened(
        await window.desktopApi.setCoverDraft(command(owned), {
          mode: 'single',
          imageTokens: [],
        }),
        owned.articleKey,
        owned.sessionId,
      );
      if (!valid(ticket)) return;
      const chosen = CoverEditReplySchema.parse(
        await window.desktopApi.pickCoverImages(command(owned), [0]),
      );
      if (!valid(ticket)) return;
      if (chosen.notice === 'cancelled') {
        await window.desktopApi.closeCoverEdit(owned.sessionId);
        if (valid(ticket)) setNotice('已取消选择，原封面保持。');
        return;
      }
      owned = opened(chosen, owned.articleKey, owned.sessionId);
      if (owned.draft.mode !== 'single' || owned.draft.imageTokens.length !== 1)
        throw Error('No image');
      setPreview({ session: owned, cards: [...cards], ...ticket });
    } catch {
      if (valid(ticket)) {
        setNotice('封面选择未完成，原配置未被统一替换，请核对后继续。');
        if (owned)
          await window.desktopApi
            .closeCoverEdit(owned.sessionId)
            .catch(() => undefined);
      }
    } finally {
      if (ticket.actionId === actions.current) {
        lock.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  async function cancel() {
    if (lock.current || !preview) return;
    lock.current = true;
    setBusy(true);
    const ticket = { ...preview, actionId: ++actions.current };
    try {
      const r = CoverEditReplySchema.parse(
        await window.desktopApi.closeCoverEdit(preview.session.sessionId),
      );
      if (!valid(ticket)) return;
      if (r.status !== 'idle') throw Error('Not closed');
      setPreview(null);
      setNotice('已取消统一封面，原配置保持。');
    } catch {
      if (valid(ticket)) setNotice('封面操作尚未结束，请停止或核对后继续。');
    } finally {
      if (ticket.actionId === actions.current) {
        lock.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  async function apply() {
    if (lock.current || !preview || blocked || !valid(preview)) return;
    lock.current = true;
    setBusy(true);
    setPreview(null);
    setNotice('正在保存本地封面…');
    const intent = { ...preview, actionId: ++actions.current };
    let completed = 0;
    const assertCurrent = () => {
      if (!valid(intent)) throw Error('Stopped or changed');
    };
    let s = intent.session;
    try {
      for (const row of intent.cards) {
        assertCurrent();
        const a = PreviewResultSchema.parse(
          await readArticlePreview(row.article.articleKey, () => valid(intent)),
        );
        assertCurrent();
        const c = CoverReadResultSchema.parse(
          await window.desktopApi.getArticleCover(row.article.articleKey),
        );
        assertCurrent();
        if (
          a.status !== 'ok' ||
          c.status !== 'ok' ||
          a.article.articleRevision !== row.article.articleRevision ||
          c.configuration.coverRevision !== row.cover.coverRevision
        )
          throw Error('Changed');
      }
      let source:
        | Extract<
            import('../../contracts/article-cover').CoverImageRequest,
            { kind: 'stored' }
          >
        | undefined;
      for (const row of intent.cards) {
        assertCurrent();
        if (completed > 0) {
          s = opened(
            await window.desktopApi.beginCoverEdit(row.article.articleKey),
            row.article.articleKey,
          );
          assertCurrent();
          if (
            s.baseArticleRevision !== row.article.articleRevision ||
            s.baseCoverRevision !== row.cover.coverRevision
          )
            throw Error('Changed');
          s = opened(
            await window.desktopApi.copyCoverImage(command(s), source!),
            row.article.articleKey,
            s.sessionId,
          );
          assertCurrent();
        } else {
          const current = opened(
            await window.desktopApi.getCoverEditState(),
            s.articleKey,
            s.sessionId,
          );
          assertCurrent();
          if (current.draftRevision !== s.draftRevision) throw Error('Changed');
        }
        const operationId = crypto.randomUUID();
        const r = CoverSaveResultSchema.parse(
          await window.desktopApi.saveCoverEdit({ ...command(s), operationId }),
        );
        if (
          r.status !== 'committed' ||
          r.receipt.operationId !== operationId ||
          r.receipt.articleKey !== row.article.articleKey ||
          r.receipt.coverRevision !== row.cover.coverRevision + 1
        )
          throw Error('Save unknown');
        completed++;
        assertCurrent();
        const c = CoverReadResultSchema.parse(
          await window.desktopApi.getArticleCover(row.article.articleKey),
        );
        assertCurrent();
        if (
          c.status !== 'ok' ||
          c.configuration.mode !== 'single' ||
          c.configuration.coverRevision !== r.receipt.coverRevision ||
          c.configuration.images.length !== 1
        )
          throw Error('Read mismatch');
        if (!source)
          source = {
            kind: 'stored',
            articleKey: row.article.articleKey,
            coverRevision: c.configuration.coverRevision,
            assetKey: c.configuration.images[0].assetKey,
          };
        const closed = CoverEditReplySchema.parse(
          await window.desktopApi.closeCoverEdit(s.sessionId),
        );
        assertCurrent();
        if (closed.status !== 'idle') throw Error('Close unknown');
      }
      setNotice(
        '已为所选 ' + completed + ' 篇文章保存同一张本地封面，仍可逐篇调整。',
      );
    } catch {
      if (valid(intent))
        setNotice(
          '已确认更新 ' +
            completed +
            '/' +
            intent.cards.length +
            ' 篇封面；其余未继续。请核对当前封面状态，不会自动重试。',
        );
    } finally {
      if (intent.actionId === actions.current) {
        lock.current = false;
        if (alive.current) {
          setBusy(false);
          setEpoch((v) => v + 1);
        }
        if (completed && valid(intent)) onChanged?.();
      }
    }
  }
  return (
    <section className="batch-cover-panel" aria-label="所选文章与封面">
      <div className="heading-with-help">
        <h3>所选文章与封面</h3>
        <HelpTip label="批量封面帮助">
          封面先保存到本机，存草稿时按各篇配置上传。仅影响本次所选文章。
        </HelpTip>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error ? (
        <p role="alert">所选文章或封面暂时无法读取，请重新检查。</p>
      ) : articleKeys.length > 0 && cards.length !== articleKeys.length ? (
        <p role="status">正在读取所选文章…</p>
      ) : null}
      <button
        disabled={
          blocked ||
          busy ||
          !!preview ||
          error ||
          !cards.length ||
          cards.length !== articleKeys.length
        }
        onClick={() => void choose()}
      >
        为所选文章选择同一张封面
      </button>
      {preview && (
        <div
          className="shared-cover-preview"
          role="group"
          aria-label="统一封面确认"
        >
          <h3>确认应用同一张封面</h3>
          <CoverImage
            position={1}
            request={{
              kind: 'session',
              sessionId: preview.session.sessionId,
              imageToken: preview.session.draft.imageTokens[0],
            }}
          />
          <p>
            应用到所选 {preview.cards.length} 篇，其中{' '}
            {preview.cards.filter((c) => c.cover.mode !== 'none').length}{' '}
            篇已有封面将被替换。未选文章不变。
          </p>
          <p>范围：{preview.cards.map((c) => c.article.title).join('；')}</p>
          <button
            className="primary"
            disabled={busy || blocked}
            onClick={() => void apply()}
          >
            确认应用到所选文章
          </button>{' '}
          <button disabled={busy} onClick={() => void cancel()}>
            取消统一封面
          </button>
        </div>
      )}
      <ol className="batch-cover-list">
        {cards.map(({ article, cover }) => (
          <li key={article.articleKey}>
            <div className="batch-cover-thumbnail">
              {cover.images[0] ? (
                <CoverImage
                  position={1}
                  request={{
                    kind: 'stored',
                    articleKey: cover.articleKey,
                    coverRevision: cover.coverRevision,
                    assetKey: cover.images[0].assetKey,
                  }}
                />
              ) : (
                <span>无封面</span>
              )}
            </div>
            <div>
              <strong>{article.title}</strong>
              <p>
                {article.imageCount} 张正文图 ·{' '}
                {cover.mode === 'none'
                  ? '未配置封面'
                  : cover.mode === 'single'
                    ? '本机单图封面'
                    : '三图封面（暂不支持自动上传）'}
              </p>
              <button
                disabled={blocked || busy || !!preview || !onEdit}
                onClick={() => onEdit?.(article.articleKey)}
                aria-label={'配置封面：' + article.title}
              >
                配置封面
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
