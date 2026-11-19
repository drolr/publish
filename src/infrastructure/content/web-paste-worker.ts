import { parentPort } from 'node:worker_threads';
import { WebPasteInputSchema } from '../../contracts/web-paste';
import {
  RichWebPasteWorkerRequestSchema,
  type RichWebPasteWorkerReply,
  type WebPasteWorkerReply,
} from '../../contracts/web-paste-worker';
import { WebPasteFailure } from '../../domain/web-paste-error';
import { convertRichWebPaste, convertWebPaste } from './web-paste-parser';

const port = parentPort;
if (port)
  port.once('message', (message: unknown) => {
    let reply: WebPasteWorkerReply | RichWebPasteWorkerReply;
    const rich = RichWebPasteWorkerRequestSchema.safeParse(message);
    const legacy = WebPasteInputSchema.safeParse(message);
    if (!rich.success && !legacy.success)
      reply = { ok: false, code: 'INPUT_LIMIT' };
    else {
      try {
        if (rich.success)
          reply = { ok: true, result: convertRichWebPaste(rich.data.input) };
        else if (legacy.success)
          reply = { ok: true, result: convertWebPaste(legacy.data) };
        else reply = { ok: false, code: 'INPUT_LIMIT' };
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
