import { z } from 'zod';
import { IdentifierSchema } from './article-package';
import { PersistedEditorBodyV1Schema } from './editor-body-v1';
import {
  codePointLength,
  DraftSnapshotBudgetSchema,
  textWithin,
  webPasteLimits,
} from './web-paste';

export const TextMarkSchema = z.enum(['bold', 'italic', 'underline']);
export type TextMark = z.output<typeof TextMarkSchema>;
const markOrder: TextMark[] = ['bold', 'italic', 'underline'];
export const RichInlineSchema = z.strictObject({
  type: z.literal('text'),
  text: textWithin(webPasteLimits.paragraphCodePoints).refine(
    (text) => text.length > 0,
  ),
  marks: z.array(TextMarkSchema),
});
export type RichInline = z.output<typeof RichInlineSchema>;

// Shared, bounded child shapes intentionally contain no recursive node variant.
export const RichTextContentSchema = z
  .array(RichInlineSchema)
  .max(webPasteLimits.totalCodePoints)
  .superRefine((content, ctx) => {
    if (
      codePointLength(content.map((run) => run.text).join('')) >
      webPasteLimits.paragraphCodePoints
    )
      ctx.addIssue({ code: 'custom', message: '单段文字过多。' });
  });
export const RichParagraphSchema = z.strictObject({
  type: z.literal('paragraph'),
  content: RichTextContentSchema,
});
export type RichParagraph = z.output<typeof RichParagraphSchema>;
export const RichHeadingSchema = z.strictObject({
  type: z.literal('heading'),
  content: RichTextContentSchema,
});
const paragraphs = z
  .array(RichParagraphSchema)
  .min(1)
  .max(webPasteLimits.blocks);
export const RichOrderedListSchema = z
  .strictObject({
    type: z.literal('list'),
    kind: z.literal('ordered'),
    start: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    items: paragraphs,
  })
  .superRefine((list, ctx) => {
    if (list.start > Number.MAX_SAFE_INTEGER - (list.items.length - 1))
      ctx.addIssue({ code: 'custom', message: '列表编号超出支持范围。' });
  });
export const RichBulletListSchema = z.strictObject({
  type: z.literal('list'),
  kind: z.literal('bullet'),
  items: paragraphs,
});
export const RichListSchema = z.discriminatedUnion('kind', [
  RichOrderedListSchema,
  RichBulletListSchema,
]);
export const RichBlockquoteSchema = z.strictObject({
  type: z.literal('blockquote'),
  paragraphs,
});
export const RichTextBlockSchema = z.discriminatedUnion('type', [
  RichParagraphSchema,
  RichHeadingSchema,
  RichListSchema,
  RichBlockquoteSchema,
]);
export type RichTextBlock = z.output<typeof RichTextBlockSchema>;
export const RichImageSchema = z.strictObject({
  type: z.literal('image'),
  imageId: IdentifierSchema,
});
export const RichBlockSchema = z.discriminatedUnion('type', [
  RichTextBlockSchema,
  RichImageSchema,
]);
export type RichBlock = z.output<typeof RichBlockSchema>;
const RichBodyShape = z
  .strictObject({
    version: z.literal(2),
    blocks: z.array(RichBlockSchema).max(webPasteLimits.blocks),
  })
  .superRefine((body, ctx) => {
    let blocks = body.blocks.length;
    let inlineNodes = 0;
    let text = 0;
    for (const block of body.blocks) {
      if (block.type === 'image') continue;
      const leaves =
        block.type === 'list'
          ? block.items
          : block.type === 'blockquote'
            ? block.paragraphs
            : [block];
      if (block.type === 'list' || block.type === 'blockquote')
        blocks += leaves.length;
      for (const leaf of leaves) {
        inlineNodes += leaf.content.length;
        text += codePointLength(leaf.content.map((run) => run.text).join(''));
      }
    }
    if (
      blocks > webPasteLimits.blocks ||
      inlineNodes > webPasteLimits.totalCodePoints ||
      text > webPasteLimits.totalCodePoints
    )
      ctx.addIssue({ code: 'custom', message: '正文内容超出当前支持范围。' });
  });
function normalizeContent(content: RichInline[]): RichInline[] {
  const result: RichInline[] = [];
  for (const run of content) {
    const marks = markOrder.filter((mark) => run.marks.includes(mark));
    const previous = result.at(-1);
    if (
      previous &&
      previous.marks.length === marks.length &&
      previous.marks.every((mark, index) => mark === marks[index])
    )
      previous.text += run.text;
    else result.push({ type: 'text', text: run.text, marks });
  }
  return result;
}
function normalizeBlock(block: RichBlock): RichBlock {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return { type: block.type, content: normalizeContent(block.content) };
    case 'list':
      return {
        ...block,
        items: block.items.map((item) => ({
          type: 'paragraph',
          content: normalizeContent(item.content),
        })),
      };
    case 'blockquote':
      return {
        type: 'blockquote',
        paragraphs: block.paragraphs.map((paragraph) => ({
          type: 'paragraph',
          content: normalizeContent(paragraph.content),
        })),
      };
    case 'image':
      return { ...block };
  }
}
// Persisted layout preserves V1 repeated image positions. New paste/image admission
// enforces its separate 200-position limit using the existing compatibility proof.
// Check both representations: merging cannot admit an oversized untrusted input.
export const PersistedEditorBodyV2Schema = DraftSnapshotBudgetSchema.pipe(
  RichBodyShape,
)
  .transform((body) => ({
    version: body.version,
    blocks: body.blocks.map(normalizeBlock),
  }))
  .pipe(RichBodyShape)
  .superRefine((body, ctx) => {
    const budget = DraftSnapshotBudgetSchema.safeParse(body);
    if (!budget.success)
      for (const issue of budget.error.issues)
        ctx.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path,
        });
  });
export type PersistedEditorBodyV2 = z.output<
  typeof PersistedEditorBodyV2Schema
>;
export const PersistedEditorBodySchema = z.union([
  PersistedEditorBodyV1Schema,
  PersistedEditorBodyV2Schema,
]);
export type PersistedEditorBody = z.output<typeof PersistedEditorBodySchema>;
