import type { ManualImage } from '../contracts/manual-article';
import { webPasteLimits } from '../contracts/web-paste';
import type { PasteImageEvent, PasteRunItem } from '../domain/ports/web-paste';
import { WebPasteFailure } from '../domain/web-paste-error';
export type { PasteImageEvent, PasteRunItem } from '../domain/ports/web-paste';

// Only syntax is checked here. The infrastructure reader owns DNS, redirects,
// public-address policy and byte validation before issuing an authorization.
export function isPasteSource(source: string | undefined): source is string {
  if (!source || !/^https?:\/\/[^/\\?#]/i.test(source) || /[\s\\]/.test(source))
    return false;
  try {
    const url = new URL(source);
    return !url.username && !url.password && !url.hash && !url.port;
  } catch {
    return false;
  }
}

/** Owns sequencing and the whole image-stage deadline, never canonical content.
 * A late ready is emitted for awaited authorization cleanup before its terminal
 * cancellation/timeout event. Consumers inspect the acquire signal to discard it.
 */
export async function runManualPasteImages(
  items: readonly PasteRunItem[],
  signal: AbortSignal,
  acquire: (source: string, signal: AbortSignal) => Promise<ManualImage>,
  onEvent: (event: PasteImageEvent) => Promise<void>,
): Promise<void> {
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, webPasteLimits.operationMs);
  const combined = AbortSignal.any([signal, deadline.signal]);
  const terminated = (candidateId: string): PasteImageEvent =>
    timedOut
      ? {
          candidateId,
          type: 'failed',
          reason: 'OPERATION_TIMEOUT',
          retryable: true,
        }
      : { candidateId, type: 'cancelled' };
  try {
    for (const item of items) {
      const { candidateId, source } = item;
      if (!isPasteSource(source)) {
        await onEvent({
          candidateId,
          type: 'failed',
          reason: 'SOURCE_UNSUPPORTED',
          retryable: false,
        });
        continue;
      }
      if (combined.aborted) {
        await onEvent(terminated(candidateId));
        continue;
      }
      await onEvent({ candidateId, type: 'fetching' });
      if (combined.aborted) {
        await onEvent(terminated(candidateId));
        continue;
      }
      let image: ManualImage;
      try {
        image = await acquire(source, combined);
      } catch (error) {
        const reason =
          error instanceof WebPasteFailure ? error.code : 'RECOVERY_REQUIRED';
        if (reason === 'RECOVERY_REQUIRED') throw new WebPasteFailure(reason);
        const retryable = [
          'IMAGE_NETWORK',
          'IMAGE_TIMEOUT',
          'CANCELLED',
          'OPERATION_TIMEOUT',
        ].includes(reason);
        await onEvent(
          combined.aborted && retryable
            ? terminated(candidateId)
            : {
                candidateId,
                type: 'failed',
                reason,
                retryable,
              },
        );
        continue;
      }
      await onEvent({ candidateId, type: 'ready', image });
      if (combined.aborted) await onEvent(terminated(candidateId));
    }
  } finally {
    clearTimeout(timer);
  }
}
