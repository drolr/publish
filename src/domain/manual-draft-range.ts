import {
  ManualDraftSchema,
  type ManualDraft,
} from '../contracts/manual-article';
import {
  DraftRangeSchema,
  type DraftBoundary,
  type DraftRange,
} from '../contracts/manual-edit';
import { WebPasteFailure } from './web-paste-error';
type Block = ManualDraft['blocks'][number];
type Point = {
  index: number;
  offset?: number;
  after?: boolean;
  position: number;
};
function point(blocks: Block[], boundary: DraftBoundary): Point {
  const index = blocks.findIndex((b) => b.blockKey === boundary.blockKey);
  if (index < 0) throw new WebPasteFailure('INPUT_LIMIT');
  const block = blocks[index];
  const base = blocks
    .slice(0, index)
    .reduce((n, b) => n + (b.type === 'paragraph' ? b.text.length : 0) + 2, 0);
  if (boundary.kind === 'edge') {
    const after = boundary.side === 'after';
    return {
      index,
      after,
      position:
        base +
        (after ? (block.type === 'paragraph' ? block.text.length : 0) + 2 : 0),
    };
  }
  if (block.type !== 'paragraph' || boundary.offset > block.text.length)
    throw new WebPasteFailure('INPUT_LIMIT');
  const offset = boundary.offset;
  if (
    offset > 0 &&
    offset < block.text.length &&
    /[\uD800-\uDBFF]/.test(block.text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(block.text[offset])
  )
    throw new WebPasteFailure('INPUT_LIMIT');
  return { index, offset, position: base + 1 + offset };
}
function bounds(draft: ManualDraft, range: DraftRange) {
  const parsed = DraftRangeSchema.safeParse(range);
  if (!parsed.success) throw new WebPasteFailure('INPUT_LIMIT');
  const a = point(draft.blocks, parsed.data.anchor),
    b = point(draft.blocks, parsed.data.head);
  return a.position <= b.position ? [a, b] : [b, a];
}
export function selectManualRange(
  draft: ManualDraft,
  range: DraftRange,
): Block[] {
  const [start, end] = bounds(draft, range);
  if (start.position === end.position) return [];
  const result: Block[] = [];
  for (let n = start.index; n <= end.index; n++) {
    if (
      (n === start.index && start.after) ||
      (n === end.index && end.after === false)
    )
      continue;
    const block = draft.blocks[n];
    if (block.type === 'paragraph') {
      const from = n === start.index ? (start.offset ?? 0) : 0;
      const to =
        n === end.index ? (end.offset ?? block.text.length) : block.text.length;
      result.push({ ...block, text: block.text.slice(from, to) });
    } else result.push({ ...block });
  }
  return result;
}
/** Confirms the entire merged proposal; no caller should delete the range first. */
export function spliceManualRange(
  draft: ManualDraft,
  range: DraftRange,
  inserted: Block[],
  newId: () => string,
): ManualDraft {
  const [start, end] = bounds(draft, range);
  const prefix = draft.blocks.slice(0, start.index + (start.after ? 1 : 0));
  const suffix = draft.blocks.slice(end.index + (end.after === false ? 0 : 1));
  let left: Block | undefined, right: Block | undefined;
  if (start.offset !== undefined) {
    const block = draft.blocks[start.index];
    if (block.type !== 'paragraph') throw new WebPasteFailure('INPUT_LIMIT');
    left = { ...block, text: block.text.slice(0, start.offset) };
  }
  if (end.offset !== undefined) {
    const block = draft.blocks[end.index];
    if (block.type !== 'paragraph') throw new WebPasteFailure('INPUT_LIMIT');
    right = {
      ...block,
      blockKey: left?.blockKey === block.blockKey ? newId() : block.blockKey,
      text: block.text.slice(end.offset),
    };
  }
  const middle = inserted.map((b) => ({ ...b }));
  if (left?.type === 'paragraph') {
    if (middle[0]?.type === 'paragraph') {
      middle[0] = {
        ...middle[0],
        blockKey: left.blockKey,
        text: left.text + middle[0].text,
      };
      left = undefined;
    } else if (!middle.length && right?.type === 'paragraph') {
      left = { ...left, text: left.text + right.text };
      right = undefined;
    }
  }
  const last = middle.length - 1;
  if (right?.type === 'paragraph' && middle[last]?.type === 'paragraph') {
    const b = middle[last];
    if (b.type === 'paragraph')
      middle[last] = { ...b, text: b.text + right.text };
    right = undefined;
  }
  const parsed = ManualDraftSchema.safeParse({
    ...draft,
    blocks: [
      ...prefix,
      ...(left ? [left] : []),
      ...middle,
      ...(right ? [right] : []),
      ...suffix,
    ],
  });
  if (!parsed.success) throw new WebPasteFailure('INPUT_LIMIT');
  return parsed.data;
}
