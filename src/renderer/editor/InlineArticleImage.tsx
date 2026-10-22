import { useEffect, useRef, useState } from 'react';
import {
  ManualImageSchema,
  type ManualImage,
} from '../../contracts/manual-article';
import type { CandidateView } from '../../contracts/web-paste';
import { PendingImage } from '../manual/PendingImage';
export type ImageProjection = {
  blockKey: string;
  image?: ManualImage;
  candidate?: CandidateView;
  disabled: boolean;
  retry?: () => void;
};
type Entry = {
  key: string;
  sessionId: string;
  image: ManualImage;
  element: HTMLElement;
  notify: (url?: string, failed?: boolean) => void;
  visible: boolean;
  distance: number;
  served: boolean;
  url?: string;
  reserved: boolean;
  disposed: boolean;
  failed: boolean;
  cooling: boolean;
  lastShown: number;
};
export const previewLimits = {
  count: 8,
  bytes: 40 * 1024 * 1024,
  pixels: 50_000_000,
  margin: 250,
} as const;
let previewReadTail: Promise<void> = Promise.resolve();
/** A session/view-owned pool. Reservations include in-flight requests; every read settles. */
export class InlinePreviewPool {
  private entries = new Set<Entry>();
  private count = 0;
  private bytes = 0;
  private pixels = 0;
  private shownOrder = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(private root: HTMLElement) {}
  register(
    key: string,
    sessionId: string,
    image: ManualImage,
    element: HTMLElement,
    notify: Entry['notify'],
  ) {
    const entry: Entry = {
      key,
      sessionId,
      image,
      element,
      notify,
      visible: false,
      distance: 0,
      served: false,
      reserved: false,
      disposed: false,
      failed: false,
      cooling: false,
      lastShown: 0,
    };
    this.entries.add(entry);
    const observer = new IntersectionObserver(
      ([observation]) => {
        if (observation.isIntersecting && !entry.visible) entry.served = false;
        entry.visible = observation.isIntersecting;
        entry.distance = Math.abs(
          element.getBoundingClientRect().top -
            this.root.getBoundingClientRect().top,
        );
        if (!entry.visible) this.release(entry);
        this.schedule();
      },
      { root: this.root, rootMargin: `${previewLimits.margin}px` },
    );
    observer.observe(element);
    return () => {
      entry.disposed = true;
      observer.disconnect();
      this.release(entry);
      this.entries.delete(entry);
      this.schedule();
    };
  }
  private release(entry: Entry) {
    if (entry.url) {
      URL.revokeObjectURL(entry.url);
      entry.url = undefined;
      entry.notify();
    }
    // In-flight reservations belong to their awaited reader, not observer cleanup.
    if (entry.reserved && entry.served) {
      this.count--;
      this.bytes -= entry.image.byteSize;
      this.pixels -= entry.image.width * entry.image.height;
      entry.reserved = false;
    }
  }
  private schedule() {
    if (this.disposed) return;
    const candidates = [...this.entries].filter(
      (e) => e.visible && !e.disposed && !e.failed && !e.reserved && !e.cooling,
    );
    candidates.sort(
      (a, b) =>
        Number(a.served) - Number(b.served) ||
        a.lastShown - b.lastShown ||
        a.distance - b.distance,
    );
    for (const entry of candidates) {
      if (!ManualImageSchema.safeParse(entry.image).success) {
        entry.failed = true;
        entry.notify(undefined, true);
        continue;
      }
      const pixels = entry.image.width * entry.image.height;
      if (
        this.count >= previewLimits.count ||
        this.bytes + entry.image.byteSize > previewLimits.bytes ||
        this.pixels + pixels > previewLimits.pixels
      ) {
        // Eventually display all lightweight visible items, without per-image clicks.
        if (!this.timer)
          this.timer = setTimeout(() => {
            this.timer = undefined;
            const victims = [...this.entries]
              .filter((e) => e.url && e.served)
              .sort((a, b) => b.distance - a.distance);
            if (
              entry.visible &&
              !entry.disposed &&
              !entry.reserved &&
              victims[0]
            ) {
              this.release(victims[0]);
              entry.served = false;
            }
            this.schedule();
          }, 1000);
        continue;
      }
      entry.reserved = true;
      entry.served = false;
      this.count++;
      this.bytes += entry.image.byteSize;
      this.pixels += pixels;
      previewReadTail = previewReadTail.then(async () => {
        let busy = false;
        try {
          if (!this.disposed && !entry.disposed && entry.visible) {
            const result = await window.desktopApi.getManualImage(
              entry.sessionId,
              entry.image.imageToken,
            );
            if (result.status === 'busy') busy = true;
            else if (!this.disposed && !entry.disposed && entry.visible) {
              if (
                result.status !== 'ok' ||
                result.mime !== entry.image.mime ||
                result.bytes.byteLength !== entry.image.byteSize
              ) {
                entry.failed = true;
                entry.notify(undefined, true);
              } else {
                entry.url = URL.createObjectURL(
                  new Blob([new Uint8Array(result.bytes)], {
                    type: result.mime,
                  }),
                );
                entry.lastShown = ++this.shownOrder;
                entry.notify(entry.url);
              }
            }
          }
        } catch {
          if (!entry.disposed) {
            entry.failed = true;
            entry.notify(undefined, true);
          }
        } finally {
          entry.served = true;
          entry.cooling = busy;
          if (!entry.url) this.release(entry);
          if (busy && !this.disposed && !entry.disposed)
            setTimeout(() => {
              entry.served = false;
              entry.cooling = false;
              this.schedule();
            }, 500);
          else this.schedule();
        }
      });
    }
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const entry of this.entries) {
      entry.disposed = true;
      this.release(entry);
    }
    this.entries.clear();
  }
}
export function InlineArticleImage({
  sessionId,
  projection,
  pool,
}: {
  sessionId: string;
  projection: ImageProjection;
  pool: InlinePreviewPool;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | undefined>(undefined),
    [failed, setFailed] = useState(false);
  const image = projection.image;
  useEffect(() => {
    setUrl(undefined);
    setFailed(false);
    if (!image || !element.current) return;
    return pool.register(
      projection.blockKey,
      sessionId,
      image,
      element.current,
      (value, error) => {
        setUrl(value);
        setFailed(!!error);
      },
    );
  }, [
    pool,
    sessionId,
    projection.blockKey,
    image?.imageToken,
    image?.byteSize,
    image?.width,
    image?.height,
    image?.mime,
  ]);
  return (
    <div
      ref={element}
      className="inline-article-image"
      style={{
        aspectRatio: image ? `${image.width} / ${image.height}` : undefined,
      }}
    >
      {projection.candidate ? (
        <PendingImage
          candidate={projection.candidate}
          disabled={projection.disabled}
          onRetry={() => projection.retry?.()}
        />
      ) : failed ? (
        <p role="alert">图片暂时无法读取，请检查后重新打开文章。</p>
      ) : url ? (
        <img src={url} alt="正文图片" />
      ) : (
        <p role="status">
          {image ? '图片按可见区域加载' : '图片状态暂时无法确认'}
        </p>
      )}
    </div>
  );
}
