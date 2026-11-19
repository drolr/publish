import { z } from 'zod';
import { IdentifierSchema } from './article-package';
import {
  DraftSnapshotBudgetSchema,
  codePointLength,
  textWithin,
  webPasteLimits,
} from './web-paste';
const EditorBodyShape = z
  .strictObject({
    version: z.literal(1),
    blocks: z
      .array(
        z.discriminatedUnion('type', [
          z.strictObject({
            type: z.literal('paragraph'),
            text: textWithin(webPasteLimits.paragraphCodePoints),
          }),
          z.strictObject({
            type: z.literal('image'),
            imageId: IdentifierSchema,
          }),
        ]),
      )
      .max(webPasteLimits.blocks),
  })
  .superRefine((body, ctx) => {
    if (
      body.blocks.reduce(
        (sum, b) =>
          sum + (b.type === 'paragraph' ? codePointLength(b.text) : 0),
        0,
      ) > webPasteLimits.totalCodePoints
    )
      ctx.addIssue({ code: 'custom', message: '正文文字过多。' });
  });
// Persisted layout deliberately permits legacy repeated positions above the new-paste limit.
export const PersistedEditorBodyV1Schema =
  DraftSnapshotBudgetSchema.pipe(EditorBodyShape);
export type PersistedEditorBodyV1 = z.output<
  typeof PersistedEditorBodyV1Schema
>;
