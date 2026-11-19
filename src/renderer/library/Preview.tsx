import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RichInline, RichTextBlock } from '../../contracts/rich-text-body';
import type {
  ArticlePreview,
  ImageResult,
} from '../../contracts/article-library';

// Requests from a previous article must settle before the next article reads bytes.
let imageTail: Promise<unknown> = Promise.resolve();
function readImage(
  articleKey: string,
  assetKey: string,
  current: () => boolean,
): Promise<ImageResult | null> {
  const next = imageTail.then(() =>
    current() ? window.desktopApi.getArticleImage(articleKey, assetKey) : null,
  );
  imageTail = next.catch(() => null);
  return next;
}
export function Preview({
  article,
  focus,
}: {
  article: ArticlePreview;
  focus: boolean;
}) {
  const [expanded, setExpanded] = useState(() =>
    article.editorBody.blocks.findIndex((block) => block.type === 'image'),
  );
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  let number = 0;
  return (
    <article>
      <h2 tabIndex={-1} ref={heading}>
        {article.title}
      </h2>
      <p className="preview-meta">
        {article.imageCount} 张独立图片 · 正文共{' '}
        {
          article.editorBody.blocks.filter((block) => block.type === 'image')
            .length
        }{' '}
        个图片位置
      </p>
      {article.editorBody.blocks.map((block, index) => {
        if (block.type !== 'image')
          return <RichText key={index} block={block} />;
        const ordinal = ++number;
        const asset = article.assets.find(
          (item) => item.imageId === block.imageId,
        );
        return (
          <figure key={index}>
            <button
              aria-expanded={expanded === index}
              onClick={() => setExpanded(expanded === index ? -1 : index)}
            >
              {expanded === index
                ? `收起第 ${ordinal} 张图片`
                : `查看第 ${ordinal} 张图片`}
            </button>
            {expanded === index && asset && (
              <ArticleImage
                key={`${article.articleKey}:${index}`}
                articleKey={article.articleKey}
                assetKey={asset.assetKey}
                number={ordinal}
              />
            )}
          </figure>
        );
      })}
    </article>
  );
}
function inline(content: RichInline[]): ReactNode {
  if (!content.length) return <br />;
  return content.map((run, index) => {
    let node: ReactNode = run.text.split('\n').map((text, line) => (
      <Fragment key={line}>
        {line > 0 && <br />}
        {text}
      </Fragment>
    ));
    if (run.marks.includes('underline')) node = <u>{node}</u>;
    if (run.marks.includes('italic')) node = <em>{node}</em>;
    if (run.marks.includes('bold')) node = <strong>{node}</strong>;
    return <Fragment key={index}>{node}</Fragment>;
  });
}
function RichText({ block }: { block: RichTextBlock }) {
  switch (block.type) {
    case 'paragraph':
      return <p className="body-text">{inline(block.content)}</p>;
    case 'heading':
      return <h2 className="body-text">{inline(block.content)}</h2>;
    case 'blockquote':
      return (
        <blockquote>
          {block.paragraphs.map((p, i) => (
            <p className="body-text" key={i}>
              {inline(p.content)}
            </p>
          ))}
        </blockquote>
      );
    case 'list': {
      // Native HTML list numbering is a signed 32-bit long. Preserve larger
      // accepted ordinals as visible, accessible presentation text only.
      if (
        block.kind === 'ordered' &&
        block.start + (block.items.length - 1) > 2147483647
      ) {
        return (
          <ol
            role="list"
            style={{
              listStyleType: 'none',
              paddingInlineStart: 0,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {block.items.map((paragraph, index) => (
              <li
                key={index}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)',
                  columnGap: '0.5em',
                }}
              >
                <span>{String(block.start + index)}.</span>
                <div style={{ minWidth: 0 }}>{inline(paragraph.content)}</div>
              </li>
            ))}
          </ol>
        );
      }
      const items = block.items.map((p, i) => (
        <li key={i}>{inline(p.content)}</li>
      ));
      return block.kind === 'ordered' ? (
        <ol
          start={block.start}
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {items}
        </ol>
      ) : (
        <ul style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {items}
        </ul>
      );
    }
  }
}
function ArticleImage({
  articleKey,
  assetKey,
  number,
}: {
  articleKey: string;
  assetKey: string;
  number: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let owned: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setUrl(null);
    setFailed(false);
    async function load() {
      try {
        const result = await readImage(articleKey, assetKey, () => !disposed);
        if (disposed || !result) return;
        if (result.status === 'busy') {
          timer = setTimeout(() => void load(), 500);
          return;
        }
        if (result.status !== 'ok') {
          setFailed(true);
          return;
        }
        owned = URL.createObjectURL(
          new Blob([new Uint8Array(result.bytes)], { type: result.mime }),
        );
        setUrl(owned);
      } catch {
        if (!disposed) setFailed(true);
      }
    }
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [articleKey, assetKey, retry]);
  return failed ? (
    <div role="alert">
      <p>图片暂时无法读取，请检查本地存储。</p>
      <button onClick={() => setRetry((value) => value + 1)}>
        重新读取图片
      </button>
    </div>
  ) : url ? (
    <img
      src={url}
      alt={`第 ${number} 张图片`}
      onError={() => setFailed(true)}
    />
  ) : (
    <p>正在读取第 {number} 张图片…</p>
  );
}
