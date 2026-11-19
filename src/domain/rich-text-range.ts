import {
  ManualDraftV2Schema,
  ManualFragmentV2Schema,
  isManualImageBlock,
  type ManualDraftV2,
  type ManualFragmentV2,
  type ManualRichBlock as Block,
  type ManualRichParagraph as Paragraph,
} from '../contracts/manual-rich-draft';
import {
  DraftRangeSchema,
  type DraftBoundary,
  type DraftRange,
} from '../contracts/manual-edit';
import type { RichInline } from '../contracts/rich-text-body';
import { richPlainText } from './rich-text-body';
import { WebPasteFailure } from './web-paste-error';

type Span = {
  block: Block;
  before: number;
  after: number;
  parent?: Span;
  children: Span[];
};
type Point = { position: number; boundary: DraftBoundary; span: Span };
function indexTree(blocks: Block[]) {
  const byKey = new Map<string, Span>();
  let position = 0;
  function walk(block: Block, parent?: Span): Span {
    const span: Span = {
      block,
      before: position++,
      after: 0,
      parent,
      children: [],
    };
    if (byKey.has(block.blockKey)) throw new WebPasteFailure('INPUT_LIMIT');
    byKey.set(block.blockKey, span);
    if (block.type === 'list' || block.type === 'blockquote')
      span.children = (
        block.type === 'list' ? block.items : block.paragraphs
      ).map((p) => walk(p, span));
    else if (block.type === 'paragraph' || block.type === 'heading')
      position += richPlainText(block.content).length;
    span.after = ++position;
    return span;
  }
  const roots = blocks.map((block) => walk(block));
  return { roots, byKey };
}
function point(byKey: Map<string, Span>, boundary: DraftBoundary): Point {
  const span = byKey.get(boundary.blockKey);
  if (!span) throw new WebPasteFailure('INPUT_LIMIT');
  if (boundary.kind === 'edge')
    return {
      span,
      boundary,
      position: boundary.side === 'before' ? span.before : span.after,
    };
  if (span.block.type !== 'paragraph' && span.block.type !== 'heading')
    throw new WebPasteFailure('INPUT_LIMIT');
  const text = richPlainText(span.block.content),
    offset = boundary.offset;
  if (
    offset > text.length ||
    (offset > 0 &&
      offset < text.length &&
      /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
      /[\uDC00-\uDFFF]/.test(text[offset]))
  )
    throw new WebPasteFailure('INPUT_LIMIT');
  return { span, boundary, position: span.before + 1 + offset };
}
function prepare(draft: ManualDraftV2, range: DraftRange) {
  const checked = ManualDraftV2Schema.safeParse(draft),
    r = DraftRangeSchema.safeParse(range);
  if (!checked.success || !r.success) throw new WebPasteFailure('INPUT_LIMIT');
  const tree = indexTree(checked.data.blocks),
    a = point(tree.byKey, r.data.anchor),
    b = point(tree.byKey, r.data.head);
  return {
    ...tree,
    draft: checked.data,
    start: a.position <= b.position ? a : b,
    end: a.position <= b.position ? b : a,
  };
}
function sliceRuns(
  content: RichInline[],
  from: number,
  to: number,
): RichInline[] {
  let offset = 0;
  const result: RichInline[] = [];
  for (const run of content) {
    const text = run.text.slice(
      Math.max(0, from - offset),
      Math.min(run.text.length, to - offset),
    );
    if (to > offset && from < offset + run.text.length && text)
      result.push({ ...run, text, marks: [...run.marks] });
    offset += run.text.length;
  }
  return result;
}
/** Boundaries order by node enter/text/leave events, independent of any renderer positions. */
function slice(
  roots: Span[],
  from: number,
  to: number,
  omitBoundary?: Span,
): Block[] {
  if (from >= to) return [];
  function cut(span: Span): Block | undefined {
    if (span === omitBoundary || span.after <= from || span.before >= to)
      return undefined;
    const block = span.block;
    if (block.type === 'paragraph' || block.type === 'heading')
      return {
        ...block,
        content: sliceRuns(
          block.content,
          Math.max(0, from - span.before - 1),
          Math.max(0, to - span.before - 1),
        ),
      };
    if (isManualImageBlock(block)) return { ...block };
    const selected = span.children.flatMap((child, index) => {
      const part = cut(child);
      return part ? [{ part: part as Paragraph, index }] : [];
    });
    if (!selected.length) return undefined;
    if (block.type === 'blockquote')
      return { ...block, paragraphs: selected.map((s) => s.part) };
    if (block.type === 'list')
      return {
        ...block,
        ...(block.kind === 'ordered'
          ? { start: block.start + selected[0].index }
          : {}),
        items: selected.map((s) => s.part),
      };
    return undefined;
  }
  return roots.flatMap((root) => {
    const block = cut(root);
    return block ? [block] : [];
  });
}
export function selectRichManualRange(
  draft: ManualDraftV2,
  range: DraftRange,
): ManualFragmentV2 {
  const { roots, start, end } = prepare(draft, range);
  const blocks = slice(roots, start.position, end.position);
  return ManualFragmentV2Schema.parse({
    version: 2,
    blocks,
    openStart: blocks.length > 0 && start.boundary.kind === 'text',
    openEnd: blocks.length > 0 && end.boundary.kind === 'text',
  });
}
function rekey(block: Block, newId: () => string): Block {
  if (block.type === 'list')
    return {
      ...block,
      blockKey: newId(),
      items: block.items.map((p) => ({
        ...p,
        blockKey: newId(),
        content: p.content.map((r) => ({ ...r, marks: [...r.marks] })),
      })),
    };
  if (block.type === 'blockquote')
    return {
      ...block,
      blockKey: newId(),
      paragraphs: block.paragraphs.map((p) => ({
        ...p,
        blockKey: newId(),
        content: p.content.map((r) => ({ ...r, marks: [...r.marks] })),
      })),
    };
  return { ...block, blockKey: newId() };
}
/** Joins only matching open text paths. Ordered item numbers cannot silently change. */
function join(left: Block, right: Block): Block | undefined {
  if (
    (left.type === 'paragraph' || left.type === 'heading') &&
    right.type === left.type
  )
    return { ...left, content: [...left.content, ...right.content] };
  if (left.type === 'blockquote' && right.type === 'blockquote') {
    const merged = join(left.paragraphs.at(-1)!, right.paragraphs[0]);
    if (merged?.type !== 'paragraph') return undefined;
    return {
      ...left,
      paragraphs: [
        ...left.paragraphs.slice(0, -1),
        merged,
        ...right.paragraphs.slice(1),
      ],
    };
  }
  if (
    left.type === 'list' &&
    right.type === 'list' &&
    left.kind === right.kind
  ) {
    if (
      left.kind === 'ordered' &&
      right.kind === 'ordered' &&
      left.start + left.items.length - 1 !== right.start
    )
      return undefined;
    const merged = join(left.items.at(-1)!, right.items[0]);
    if (merged?.type !== 'paragraph') return undefined;
    return {
      ...left,
      items: [...left.items.slice(0, -1), merged, ...right.items.slice(1)],
    };
  }
  return undefined;
}
function append(left: Block[], right: Block[], open: boolean): Block[] {
  if (open && left.length && right.length) {
    const merged = join(left.at(-1)!, right[0]);
    if (merged) return [...left.slice(0, -1), merged, ...right.slice(1)];
  }
  return [...left, ...right];
}
export function spliceRichManualRange(
  draft: ManualDraftV2,
  range: DraftRange,
  fragment: ManualFragmentV2,
  newId: () => string,
): ManualDraftV2 {
  const { roots, start, end, draft: source } = prepare(draft, range);
  const checked = ManualFragmentV2Schema.safeParse(fragment);
  if (!checked.success) throw new WebPasteFailure('INPUT_LIMIT');
  const inserted = checked.data;
  if (
    inserted.blocks.some(isManualImageBlock) &&
    (start.span.parent || end.span.parent)
  )
    throw new WebPasteFailure('UNSUPPORTED_STRUCTURE');
  let left = slice(roots, -Infinity, start.position),
    right = slice(roots, end.position, Infinity);
  const middle = inserted.blocks.map((b) => rekey(b, newId));
  const openStart = inserted.openStart && start.boundary.kind === 'text',
    openEnd = inserted.openEnd && end.boundary.kind === 'text';
  // A text-edge cut includes its structural wrapper even when no original text
  // remains. Only omit that boundary fragment when insertion cannot join it;
  // untouched empty siblings and explicit empty blocks in the fragment survive.
  if (
    middle.length &&
    start.boundary.kind === 'text' &&
    start.boundary.offset === 0 &&
    !(openStart && left.length && join(left.at(-1)!, middle[0]))
  )
    left = slice(roots, -Infinity, start.position, start.span);
  const leading = middle.length ? append(left, middle, openStart) : left;
  const endBlock = end.span.block;
  if (
    middle.length &&
    end.boundary.kind === 'text' &&
    (endBlock.type === 'paragraph' || endBlock.type === 'heading') &&
    end.boundary.offset === richPlainText(endBlock.content).length &&
    !(
      openEnd &&
      leading.length &&
      right.length &&
      join(leading.at(-1)!, right[0])
    )
  )
    right = slice(roots, end.position, Infinity, end.span);
  let blocks = middle.length
    ? append(leading, right, openEnd)
    : append(
        left,
        right,
        start.boundary.kind === 'text' && end.boundary.kind === 'text',
      );
  // Splitting a leaf/container preserves the first identity and issues fresh identities for the rest.
  const seen = new Set<string>();
  const key = (old: string) => {
    const result = seen.has(old) ? newId() : old;
    seen.add(result);
    return result;
  };
  blocks = blocks.map((block) => {
    const copy = { ...block, blockKey: key(block.blockKey) };
    if (copy.type === 'list')
      return {
        ...copy,
        items: copy.items.map((p) => ({ ...p, blockKey: key(p.blockKey) })),
      };
    if (copy.type === 'blockquote')
      return {
        ...copy,
        paragraphs: copy.paragraphs.map((p) => ({
          ...p,
          blockKey: key(p.blockKey),
        })),
      };
    return copy;
  });
  const result = ManualDraftV2Schema.safeParse({ ...source, blocks });
  if (!result.success) throw new WebPasteFailure('INPUT_LIMIT');
  return result.data;
}
