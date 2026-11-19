import { z } from 'zod';
import { StorageIdSchema } from './stored-article';
import {
  DraftSnapshotBudgetSchema,
  PendingBlockSchema,
  textWithin,
  webPasteLimits,
} from './web-paste';
import {
  PersistedEditorBodyV2Schema,
  RichParagraphSchema,
  RichHeadingSchema,
  RichOrderedListSchema,
  RichBulletListSchema,
  RichBlockquoteSchema,
} from './rich-text-body';

const paragraph = RichParagraphSchema.extend({ blockKey: StorageIdSchema });
const paragraphs = z.array(paragraph).min(1).max(webPasteLimits.blocks);
const blockSchema = z.discriminatedUnion('type', [
  paragraph,
  RichHeadingSchema.extend({ blockKey: StorageIdSchema }),
  z.discriminatedUnion('kind', [
    RichOrderedListSchema.safeExtend({
      blockKey: StorageIdSchema,
      items: paragraphs,
    }),
    RichBulletListSchema.extend({
      blockKey: StorageIdSchema,
      items: paragraphs,
    }),
  ]),
  RichBlockquoteSchema.extend({ blockKey: StorageIdSchema, paragraphs }),
  z.strictObject({
    type: z.literal('image'),
    blockKey: StorageIdSchema,
    imageToken: StorageIdSchema,
  }),
  PendingBlockSchema,
]);
const blocksSchema = z.array(blockSchema).max(webPasteLimits.blocks);
type Block = z.output<typeof blockSchema>;

/** All format validity and aggregate text budgets remain owned by rich-text-body. */
const canonicalBlocks = blocksSchema.transform((blocks, ctx) => {
  const keys = blocks.flatMap((block) => [
    block.blockKey,
    ...(block.type === 'list'
      ? block.items
      : block.type === 'blockquote'
        ? block.paragraphs
        : []
    ).map((p) => p.blockKey),
  ]);
  const candidates = blocks.flatMap((b) =>
    b.type === 'image-pending' ? [b.candidateId] : [],
  );
  const tokens = new Set(
    blocks.flatMap((b) => (b.type === 'image' ? [b.imageToken] : [])),
  );
  if (
    new Set(keys).size !== keys.length ||
    new Set(candidates).size !== candidates.length ||
    tokens.size + candidates.length > webPasteLimits.images
  ) {
    ctx.addIssue({ code: 'custom', message: '内容或图片标识无效。' });
    return z.NEVER;
  }
  const body = PersistedEditorBodyV2Schema.safeParse({
    version: 2,
    blocks: blocks.map((block) => {
      switch (block.type) {
        case 'image':
        case 'image-pending':
          return { type: 'image', imageId: block.blockKey };
        case 'paragraph':
        case 'heading':
          return { type: block.type, content: block.content };
        case 'list':
          return {
            ...(block.kind === 'ordered'
              ? { type: 'list', kind: 'ordered', start: block.start }
              : { type: 'list', kind: 'bullet' }),
            items: block.items.map((p) => ({
              type: 'paragraph',
              content: p.content,
            })),
          };
        case 'blockquote':
          return {
            type: 'blockquote',
            paragraphs: block.paragraphs.map((p) => ({
              type: 'paragraph',
              content: p.content,
            })),
          };
      }
    }),
  });
  if (!body.success) {
    for (const issue of body.error.issues)
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
    return z.NEVER;
  }
  return blocks.map((block, index): Block => {
    const canonical = body.data.blocks[index];
    if (block.type === 'paragraph' || block.type === 'heading') {
      if (canonical.type !== block.type) throw Error('Invalid rich shape');
      return { ...block, content: canonical.content };
    }
    if (block.type === 'list' && canonical.type === 'list')
      return {
        ...block,
        items: block.items.map((p, i) => ({
          ...p,
          content: canonical.items[i].content,
        })),
      };
    if (block.type === 'blockquote' && canonical.type === 'blockquote')
      return {
        ...block,
        paragraphs: block.paragraphs.map((p, i) => ({
          ...p,
          content: canonical.paragraphs[i].content,
        })),
      };
    return block;
  });
});
export const ManualDraftV2Schema = DraftSnapshotBudgetSchema.pipe(
  z.strictObject({
    bodyVersion: z.literal(2),
    title: textWithin(webPasteLimits.titleCodePoints),
    contentDeclaration: z.enum(['original', 'repost']),
    blocks: canonicalBlocks,
  }),
).superRefine((value, ctx) => {
  if (!DraftSnapshotBudgetSchema.safeParse(value).success)
    ctx.addIssue({ code: 'custom', message: '正文内容过多。' });
});
export type ManualDraftV2 = z.output<typeof ManualDraftV2Schema>;
export const ManualFragmentV2Schema = DraftSnapshotBudgetSchema.pipe(
  z.strictObject({
    version: z.literal(2),
    blocks: canonicalBlocks,
    openStart: z.boolean(),
    openEnd: z.boolean(),
  }),
).superRefine((fragment, ctx) => {
  const first = fragment.blocks[0],
    last = fragment.blocks.at(-1);
  if (
    (fragment.openStart && (!first || isManualImageBlock(first))) ||
    (fragment.openEnd && (!last || isManualImageBlock(last)))
  )
    ctx.addIssue({ code: 'custom', message: '片段开放边界无效。' });
  if (!DraftSnapshotBudgetSchema.safeParse(fragment).success)
    ctx.addIssue({ code: 'custom', message: '正文内容过多。' });
});
export type ManualFragmentV2 = z.output<typeof ManualFragmentV2Schema>;
export type ManualRichBlock = ManualDraftV2['blocks'][number];
export type ManualRichParagraph = Extract<
  ManualRichBlock,
  { type: 'paragraph' }
>;
/** Images are always top-level; callers must never infer image identity from non-paragraph. */
export function isManualImageBlock<T extends { type: string }>(
  block: T,
): block is Extract<T, { type: 'image' | 'image-pending' }> {
  return block.type === 'image' || block.type === 'image-pending';
}
