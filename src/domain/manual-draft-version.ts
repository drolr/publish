import {
  ManualDraftV2Schema,
  ManualFragmentV2Schema,
  type ManualDraftV2,
  type ManualFragmentV2,
  type ManualRichBlock,
} from '../contracts/manual-rich-draft';
import type { ManualDraftV1 } from '../contracts/manual-article';
import { ManualDraftV1Schema } from '../contracts/manual-article';
import { WebPasteFailure } from './web-paste-error';
import { richPlainText } from './rich-text-body';

/** Explicit historical V1 upgrade; production sessions already use V2. */
export function upgradeManualDraft(draft: ManualDraftV1): ManualDraftV2 {
  const legacy = ManualDraftV1Schema.parse(draft);
  return ManualDraftV2Schema.parse({
    ...legacy,
    bodyVersion: 2,
    blocks: legacy.blocks.map((block) =>
      block.type === 'paragraph'
        ? {
            type: 'paragraph',
            blockKey: block.blockKey,
            content: block.text.length
              ? [{ type: 'text', text: block.text, marks: [] }]
              : [],
          }
        : block,
    ),
  });
}
/** Lossless-only legacy fallback; supported rich semantics are never flattened. */
export function requireLegacyManualDraft(draft: ManualDraftV2): ManualDraftV1 {
  const checked = ManualDraftV2Schema.parse(draft);
  const blocks = checked.blocks.map((block) => {
    if (block.type === 'image' || block.type === 'image-pending')
      return { ...block };
    if (
      block.type !== 'paragraph' ||
      block.content.some((run) => run.marks.length)
    )
      throw new WebPasteFailure('UNSUPPORTED_STRUCTURE');
    return {
      type: 'paragraph' as const,
      blockKey: block.blockKey,
      text: richPlainText(block.content),
    };
  });
  return ManualDraftV1Schema.parse({
    title: checked.title,
    contentDeclaration: checked.contentDeclaration,
    blocks,
  });
}
export function upgradeManualFragment(
  blocks: ManualDraftV1['blocks'],
  openStart = false,
  openEnd = false,
): ManualFragmentV2 {
  const upgraded = upgradeManualDraft({
    title: '',
    contentDeclaration: 'repost',
    blocks,
  });
  return ManualFragmentV2Schema.parse({
    version: 2,
    blocks: upgraded.blocks,
    openStart,
    openEnd,
  });
}
export function manualFragmentText(fragment: ManualFragmentV2): string {
  return fragment.blocks
    .flatMap((block) => {
      if (block.type === 'image' || block.type === 'image-pending')
        return ['[图片]'];
      const leaves =
        block.type === 'list'
          ? block.items
          : block.type === 'blockquote'
            ? block.paragraphs
            : [block];
      return leaves.map((leaf) => richPlainText(leaf.content));
    })
    .join('\n');
}
/** The validated parser deep copies all inline marks, leaves and containers. */
export function cloneManualFragment(
  fragment: ManualFragmentV2,
  newId?: () => string,
  mapImage?: (token: string) => string,
): ManualFragmentV2 {
  const parsed = ManualFragmentV2Schema.parse(fragment);
  function copy(block: ManualRichBlock): ManualRichBlock {
    const blockKey = newId ? newId() : block.blockKey;
    switch (block.type) {
      case 'image':
        return {
          ...block,
          blockKey,
          imageToken: mapImage ? mapImage(block.imageToken) : block.imageToken,
        };
      case 'image-pending':
        return { ...block, blockKey };
      case 'list':
        return {
          ...block,
          blockKey,
          items: block.items.map((p) => ({
            ...p,
            blockKey: newId ? newId() : p.blockKey,
          })),
        };
      case 'blockquote':
        return {
          ...block,
          blockKey,
          paragraphs: block.paragraphs.map((p) => ({
            ...p,
            blockKey: newId ? newId() : p.blockKey,
          })),
        };
      default:
        return { ...block, blockKey };
    }
  }
  return { ...parsed, blocks: parsed.blocks.map(copy) };
}
