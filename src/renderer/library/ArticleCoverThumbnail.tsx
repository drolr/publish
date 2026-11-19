import { useEffect, useState } from 'react';
import {
  CoverReadResultSchema,
  type CoverReadResult,
} from '../../contracts/article-cover';
import { CoverImage } from '../covers/CoverImage';
let configurationTail: Promise<unknown> = Promise.resolve();
export function ArticleCoverThumbnail({
  articleKey,
  epoch = '',
}: {
  articleKey: string;
  epoch?: string;
}) {
  const identity = articleKey + ':' + epoch;
  const [view, setView] = useState<{
    identity: string;
    result?: CoverReadResult;
  }>();
  useEffect(() => {
    let disposed = false;
    const reading = configurationTail.then(async () => {
      if (disposed) return;
      const result = CoverReadResultSchema.parse(
        await window.desktopApi.getArticleCover(articleKey),
      );
      if (
        result.status === 'ok' &&
        result.configuration.articleKey !== articleKey
      )
        throw Error('Cover identity mismatch');
      if (!disposed) setView({ identity, result });
    });
    configurationTail = reading.catch(() => {
      if (!disposed) setView({ identity, result: { status: 'unavailable' } });
    });
    return () => {
      disposed = true;
    };
  }, [identity, articleKey]);
  const result = view?.identity === identity ? view.result : undefined;
  const configuration =
    result?.status === 'ok' ? result.configuration : undefined;
  const image = configuration?.images[0];
  return (
    <div
      className="article-cover-thumbnail"
      data-cover-revision={configuration?.coverRevision}
      aria-label="已保存封面"
    >
      {!result ? (
        <span role="status">读取封面…</span>
      ) : result.status !== 'ok' ? (
        <span>封面读取失败</span>
      ) : !image ? (
        <span>未设封面</span>
      ) : (
        <CoverImage
          key={identity}
          position={1}
          request={{
            kind: 'stored',
            articleKey,
            coverRevision: configuration!.coverRevision,
            assetKey: image.assetKey,
          }}
        />
      )}
    </div>
  );
}
