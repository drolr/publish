import { Worker } from 'node:worker_threads';
import {
  WebPasteInputSchema,
  webPasteLimits,
  type ConvertedPaste,
  type WebPasteInput,
} from '../../contracts/web-paste';
import { WebPasteWorkerReplySchema } from '../../contracts/web-paste-worker';
import type { WebPasteConverter } from '../../domain/ports/web-paste';
import { WebPasteFailure } from '../../domain/web-paste-error';

/** Path is injected by main from fixed app resources, never accepted over IPC. */
export function createWebPasteConverter(workerPath: string): WebPasteConverter {
  return {
    async convert(
      input: WebPasteInput,
      signal: AbortSignal,
    ): Promise<ConvertedPaste> {
      if (signal.aborted) throw new WebPasteFailure('CANCELLED');
      const validated = WebPasteInputSchema.safeParse(input);
      if (!validated.success) throw new WebPasteFailure('INPUT_LIMIT');
      return new Promise((resolve, reject) => {
        let worker: Worker;
        let settling = false;
        // Start the deadline before Worker construction/online: startup is included.
        const timer = setTimeout(() => {
          void finish(undefined, new WebPasteFailure('PARSE_TIMEOUT'));
        }, webPasteLimits.parseMs);
        const onAbort = () => {
          void finish(undefined, new WebPasteFailure('CANCELLED'));
        };
        const finish = async (
          result?: ConvertedPaste,
          failure?: WebPasteFailure,
        ) => {
          if (settling) return;
          settling = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          // Keep the error handler until the worker is dead, including error/exit races.
          try {
            if (worker) await worker.terminate();
          } catch {
            failure = new WebPasteFailure('RECOVERY_REQUIRED');
          }
          if (worker) worker.removeAllListeners();
          if (failure) reject(failure);
          else resolve(result!);
        };
        try {
          worker = new Worker(workerPath);
          worker.on('message', (message: unknown) => {
            const reply = WebPasteWorkerReplySchema.safeParse(message);
            if (!reply.success)
              void finish(undefined, new WebPasteFailure('INVALID_FRAGMENT'));
            else if (!reply.data.ok)
              void finish(undefined, new WebPasteFailure(reply.data.code));
            else void finish(reply.data.result);
          });
          worker.on('error', () => {
            void finish(undefined, new WebPasteFailure('INVALID_FRAGMENT'));
          });
          worker.on('exit', () => {
            void finish(undefined, new WebPasteFailure('INVALID_FRAGMENT'));
          });
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
          else worker.postMessage(validated.data);
        } catch {
          void finish(undefined, new WebPasteFailure('INVALID_FRAGMENT'));
        }
      });
    },
  };
}
