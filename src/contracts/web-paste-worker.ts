import { z } from 'zod';
import { ConvertedRichPasteSchema } from './rich-web-paste';
import {
  ConvertedPasteSchema,
  PasteErrorCodeSchema,
  WebPasteInputSchema,
} from './web-paste';

export const WebPasteWorkerReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    result: ConvertedPasteSchema.refine(
      (paste) =>
        paste.blocks.length > 0 &&
        paste.blocks.every(
          (block) => block.type !== 'paragraph' || block.text.trim().length > 0,
        ),
    ),
  }),
  z.strictObject({ ok: z.literal(false), code: PasteErrorCodeSchema }),
]);
export type WebPasteWorkerReply = z.infer<typeof WebPasteWorkerReplySchema>;

// Explicit versioned opt-in; old raw WebPasteInput requests keep their V1 reply.
export const RichWebPasteWorkerRequestSchema = z.strictObject({
  version: z.literal(2),
  input: WebPasteInputSchema,
});
export const RichWebPasteWorkerReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: ConvertedRichPasteSchema }),
  z.strictObject({ ok: z.literal(false), code: PasteErrorCodeSchema }),
]);
export type RichWebPasteWorkerReply = z.output<
  typeof RichWebPasteWorkerReplySchema
>;
