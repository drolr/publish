import { z } from 'zod';
import {
  PersistedEditorBodyV2Schema,
  RichTextBlockSchema,
} from './rich-text-body';
import { DraftSnapshotBudgetSchema, webPasteLimits } from './web-paste';

import { RichPasteWarningSchema } from './web-paste';
export { RichPasteWarningSchema, type RichPasteWarning } from './web-paste';
export const ConvertedRichBlockSchema = z.discriminatedUnion('type', [
  RichTextBlockSchema,
  z
    .strictObject({
      type: z.literal('image'),
      source: z.string().max(webPasteLimits.inputBytes).optional(),
    })
    .transform((image) => ({ type: image.type, source: image.source })),
]);
export type ConvertedRichBlock = z.output<typeof ConvertedRichBlockSchema>;
// Trusted worker/main boundary only. Source strings never belong in renderer DTOs.
// Reuse the authoritative body validator for format validity and aggregate budgets.
export const ConvertedRichPasteSchema = DraftSnapshotBudgetSchema.pipe(
  z
    .strictObject({
      version: z.literal(2),
      blocks: z
        .array(ConvertedRichBlockSchema)
        .min(1)
        .max(webPasteLimits.blocks),
      plainOnly: z.boolean(),
      warnings: z.array(RichPasteWarningSchema).max(3),
    })
    .superRefine((paste, ctx) => {
      if (
        new Set(paste.warnings).size !== paste.warnings.length ||
        paste.plainOnly !== paste.warnings.includes('PLAIN_ONLY') ||
        (paste.plainOnly &&
          (paste.warnings.length !== 1 ||
            paste.blocks.some(
              (block) =>
                block.type !== 'paragraph' ||
                block.content.some((run) => run.marks.length > 0),
            ))) ||
        paste.blocks.filter((block) => block.type === 'image').length >
          webPasteLimits.images
      )
        ctx.addIssue({ code: 'custom', message: '粘贴格式无法识别。' });
    }),
)
  .transform((paste, ctx) => {
    const body = PersistedEditorBodyV2Schema.safeParse({
      version: 2,
      blocks: paste.blocks.map((block, index) =>
        block.type === 'image'
          ? { type: 'image', imageId: `paste-image-${index}` }
          : block,
      ),
    });
    if (!body.success) {
      ctx.addIssue({ code: 'custom', message: '粘贴内容超出支持范围。' });
      return z.NEVER;
    }
    return {
      ...paste,
      blocks: body.data.blocks.map((block, index): ConvertedRichBlock =>
        block.type === 'image' ? paste.blocks[index] : block,
      ),
    };
  })
  .superRefine((paste, ctx) => {
    if (!DraftSnapshotBudgetSchema.safeParse(paste).success)
      ctx.addIssue({ code: 'custom', message: '粘贴内容超出支持范围。' });
  });
export type ConvertedRichPaste = z.output<typeof ConvertedRichPasteSchema>;
