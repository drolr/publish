import { parentPort } from 'node:worker_threads';
import { WebPasteInputSchema } from '../../contracts/web-paste';
import type { WebPasteWorkerReply } from '../../contracts/web-paste-worker';
import { WebPasteFailure } from '../../domain/web-paste-error';
import { convertWebPaste } from './web-paste-parser';

const port = parentPort;
if (port)
  port.once('message', (message: unknown) => {
    let reply: WebPasteWorkerReply;
    const input = WebPasteInputSchema.safeParse(message);
    if (!input.success) reply = { ok: false, code: 'INPUT_LIMIT' };
    else {
      try {
        reply = { ok: true, result: convertWebPaste(input.data) };
      } catch (error) {
        reply = {
          ok: false,
          code:
            error instanceof WebPasteFailure ? error.code : 'INVALID_FRAGMENT',
        };
      }
    }
    port.postMessage(reply);
    port.close();
  });
