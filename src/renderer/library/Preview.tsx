import { useEffect, useRef, useState } from 'react';
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
    article.body.findIndex((block) => block.type === 'image'),
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
        {article.contentDeclaration === 'original' ? '原创' : '转载'} ·{' '}
        {article.imageCount} 张独立图片 · 正文共{' '}
        {article.body.filter((block) => block.type === 'image').length}{' '}
        个图片位置
      </p>
      {article.body.map((block, index) => {
        if (block.type === 'paragraph')
          return (
            <p className="body-text" key={index}>
              {block.text}
            </p>
          );
        const ordinal = ++number;
        const asset = article.assets.find(
          (item) => item.imageId === block.image_id,
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
