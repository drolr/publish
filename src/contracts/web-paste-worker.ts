import { z } from 'zod';
import { ConvertedPasteSchema, PasteErrorCodeSchema } from './web-paste';

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
