import { CoverImageResultSchema } from '../../contracts/article-cover';
import { useEffect, useState } from 'react';
import type {
  CoverImageRequest,
  CoverImageResult,
} from '../../contracts/article-cover';
// All cover thumbnails share one transfer lane, including StrictMode cleanup.
let imageTail: Promise<unknown> = Promise.resolve();
function readImage(
  request: CoverImageRequest,
  current: () => boolean,
): Promise<CoverImageResult | null> {
  const next = imageTail.then(() =>
    current()
      ? window.desktopApi
          .getCoverImage(request)
          .then((r) => CoverImageResultSchema.parse(r))
      : null,
  );
  imageTail = next.catch(() => null);
  return next;
}
export function CoverImage({
  request,
  position,
}: {
  request: CoverImageRequest;
  position: number;
}) {
  const identity = JSON.stringify(request);
  const [preview, setPreview] = useState<{
    identity: string;
    url?: string;
    failed?: boolean;
  }>();
  useEffect(() => {
    let disposed = false,
      url: string | undefined;
    void readImage(request, () => !disposed)
      .then((result) => {
        if (disposed || !result) return;
        if (result.status === 'ok') {
          url = URL.createObjectURL(
            new Blob([new Uint8Array(result.bytes)], { type: result.mime }),
          );
          setPreview({ identity, url });
        } else setPreview({ identity, failed: true });
      })
      .catch(() => {
        if (!disposed) setPreview({ identity, failed: true });
      });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [identity]);
  const value = preview?.identity === identity ? preview : undefined;
  return value?.url ? (
    <img
      src={value.url}
      alt={'第' + position + '张封面'}
      onError={() => setPreview({ identity, failed: true })}
    />
  ) : (
    <p role={value?.failed ? 'alert' : 'status'}>
      {value?.failed
        ? '第' + position + '张封面暂时无法读取，请核对本机图片。'
        : '正在读取第' + position + '张封面…'}
    </p>
  );
}
