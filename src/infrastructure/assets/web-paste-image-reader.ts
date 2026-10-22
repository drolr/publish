import type { ManualImageSource } from '../../domain/ports/manual-images';
import type { WebPasteImageReader } from '../../domain/ports/web-paste';
import { ImportFailure } from '../../domain/import-error';
import { WebPasteFailure } from '../../domain/web-paste-error';
import { readRemoteImage } from './remote-reader';
export function imagePasteFailure(error: unknown): WebPasteFailure {
  if (error instanceof WebPasteFailure) return error;
  if (error instanceof ImportFailure) {
    switch (error.code) {
      case 'SOURCE_NOT_ALLOWED':
        return new WebPasteFailure('SOURCE_UNSUPPORTED');
      case 'IMAGE_LIMIT_EXCEEDED':
        return new WebPasteFailure('IMAGE_LIMIT');
      case 'IMAGE_UNSUPPORTED':
        return new WebPasteFailure('IMAGE_UNSUPPORTED');
      case 'IMAGE_INVALID':
        return new WebPasteFailure('IMAGE_INVALID');
      case 'IMAGE_UNAVAILABLE':
        return new WebPasteFailure('IMAGE_NETWORK');
    }
  }
  return new WebPasteFailure('RECOVERY_REQUIRED');
}
export function createWebPasteImageReader(
  source: ManualImageSource,
): WebPasteImageReader {
  return {
    async acquire(sessionId, raw, signal) {
      let timeout = false;
      const deadline = new AbortController();
      const timer = setTimeout(() => {
        timeout = true;
        deadline.abort();
      }, 30000);
      const combined = AbortSignal.any([signal, deadline.signal]);
      try {
        if (signal.aborted) throw new WebPasteFailure('CANCELLED');
        if (!/^https?:\/\/[^/\\?#]/i.test(raw) || /[\s\\]/.test(raw))
          throw new WebPasteFailure('SOURCE_UNSUPPORTED');
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          throw new WebPasteFailure('SOURCE_UNSUPPORTED');
        }
        if (url.username || url.password || url.hash || url.port)
          throw new WebPasteFailure('SOURCE_UNSUPPORTED');
        const bytes = await readRemoteImage(raw, combined);
        if (timeout) throw new WebPasteFailure('IMAGE_TIMEOUT');
        clearTimeout(timer);
        if (signal.aborted) throw new WebPasteFailure('CANCELLED');
        return await source.authorizeBytes(sessionId, bytes, signal);
      } catch (error) {
        if (
          error instanceof WebPasteFailure &&
          error.code === 'RECOVERY_REQUIRED'
        )
          throw error;
        if (signal.aborted) throw new WebPasteFailure('CANCELLED');
        if (timeout) throw new WebPasteFailure('IMAGE_TIMEOUT');
        throw imagePasteFailure(error);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
