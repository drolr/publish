import { Fragment, type Node } from 'prosemirror-model';
import { TextSelection, type Selection } from 'prosemirror-state';
import type {
  ManualDraftV1,
  ManualDraftV2,
  ManualRichBlock,
} from '../../contracts/manual-article';
import { isManualImageBlock } from '../../contracts/manual-rich-draft';
import type { RichInline, TextMark } from '../../contracts/rich-text-body';
import type { DraftBoundary, DraftRange } from '../../contracts/manual-edit';
import { editorSchema } from './editor-schema';
// Display-only empty document sentinel. Never returned across the bridge.
export const emptyEditorKey = '00000000-0000-4000-8000-000000000000';
function inlineToEditor(content: RichInline[]): Node[] {
  return content.flatMap((run) => {
    const marks = run.marks.map((mark) => editorSchema.marks[mark].create());
    return run.text
      .split('\n')
      .flatMap((line, index) => [
        ...(index
          ? [editorSchema.node('hard_break', null, undefined, marks)]
          : []),
        ...(line ? [editorSchema.text(line, marks)] : []),
      ]);
  });
}
export function draftToEditor(draft: ManualDraftV1): Node {
  if ('bodyVersion' in draft) throw Error('Use V2 codec');
  return editorSchema.node(
    'doc',
    null,
    draft.blocks.length
      ? draft.blocks.map((block) =>
          block.type === 'paragraph'
            ? editorSchema.node(
                'paragraph',
                { blockKey: block.blockKey },
                inlineToEditor(
                  block.text
                    ? [{ type: 'text', text: block.text, marks: [] }]
                    : [],
                ),
              )
            : block.type === 'image' || block.type === 'image-pending'
              ? editorSchema.node('article_image', { blockKey: block.blockKey })
              : (() => {
                  throw Error('Unsupported V1 block');
                })(),
        )
      : [editorSchema.node('paragraph', { blockKey: emptyEditorKey })],
  );
}
export function draftV2ToEditor(draft: ManualDraftV2): Node {
  // Local projections may exceed a budget while the operator corrects input.
  // EditorSession blocks IPC/save; trusted main boundaries still validate.
  const value = draft;
  const leaf = (block: {
    type: 'paragraph' | 'heading';
    blockKey: string;
    content: RichInline[];
  }) =>
    editorSchema.node(
      block.type,
      { blockKey: block.blockKey },
      inlineToEditor(block.content),
    );
  return editorSchema.node(
    'doc',
    null,
    value.blocks.length
      ? value.blocks.map((block) => {
          switch (block.type) {
            case 'paragraph':
            case 'heading':
              return leaf(block);
            case 'list':
              return editorSchema.node(
                block.kind === 'ordered' ? 'ordered_list' : 'bullet_list',
                {
                  blockKey: block.blockKey,
                  ...(block.kind === 'ordered' ? { start: block.start } : {}),
                },
                block.items.map((item) =>
                  editorSchema.node('list_item', null, leaf(item)),
                ),
              );
            case 'blockquote':
              return editorSchema.node(
                'blockquote',
                { blockKey: block.blockKey },
                block.paragraphs.map(leaf),
              );
            case 'image':
            case 'image-pending':
              return editorSchema.node('article_image', {
                blockKey: block.blockKey,
              });
          }
        })
      : [editorSchema.node('paragraph', { blockKey: emptyEditorKey })],
  );
}
function editorInline(node: Node): RichInline[] {
  const result: RichInline[] = [];
  node.forEach((child) => {
    if (!child.isText && child.type.name !== 'hard_break')
      throw Error('Unsupported inline node');
    const marks = child.marks.map((mark) => mark.type.name as TextMark);
    if (marks.some((mark) => !['bold', 'italic', 'underline'].includes(mark)))
      throw Error('Unsupported mark');
    const text = child.isText ? child.text! : '\n';
    const previous = result.at(-1);
    if (previous && previous.marks.join() === marks.join())
      previous.text += text;
    else result.push({ type: 'text', text, marks });
  });
  return result;
}
function placeholder(node: Node, doc: Node, empty: boolean) {
  return (
    empty &&
    doc.childCount === 1 &&
    node.type.name === 'paragraph' &&
    node.attrs.blockKey === emptyEditorKey &&
    !node.content.size
  );
}
function assertAssignedKeys(doc: Node, empty: boolean) {
  doc.descendants((node) => {
    if (
      node.attrs.blockKey === emptyEditorKey &&
      !placeholder(node, doc, empty)
    )
      throw Error('Unassigned display key');
  });
}
export function editorToDraft(
  doc: Node,
  draft: ManualDraftV1,
  known = draft.blocks,
): ManualDraftV1 {
  doc.check();
  assertAssignedKeys(doc, !draft.blocks.length);
  const blocks: ManualDraftV1['blocks'] = [];
  doc.forEach((node) => {
    if (placeholder(node, doc, !draft.blocks.length)) return;
    if (node.type.name === 'paragraph') {
      const content = editorInline(node);
      if (content.some((run) => run.marks.length))
        throw Error('Rich content requires V2');
      blocks.push({
        type: 'paragraph',
        blockKey: node.attrs.blockKey,
        text: content.map((run) => run.text).join(''),
      });
    } else if (node.type.name === 'article_image') {
      const block = known.find(
        (b) =>
          b.blockKey === node.attrs.blockKey &&
          (b.type === 'image' || b.type === 'image-pending'),
      );
      if (!block) throw Error('Unknown image key');
      blocks.push(block);
    } else throw Error('Rich content requires V2');
  });
  return { ...draft, blocks };
}
export function editorToDraftV2(
  doc: Node,
  draft: ManualDraftV2,
  known = draft.blocks,
): ManualDraftV2 {
  doc.check();
  assertAssignedKeys(doc, !draft.blocks.length);
  const leaf = (node: Node) => ({
    type: 'paragraph' as const,
    blockKey: node.attrs.blockKey as string,
    content: editorInline(node),
  });
  const blocks: ManualRichBlock[] = [];
  doc.forEach((node) => {
    if (placeholder(node, doc, !draft.blocks.length)) return;
    switch (node.type.name) {
      case 'paragraph':
        blocks.push(leaf(node));
        break;
      case 'heading':
        blocks.push({ ...leaf(node), type: 'heading' });
        break;
      case 'ordered_list':
      case 'bullet_list': {
        const items: ReturnType<typeof leaf>[] = [];
        node.forEach((item) => items.push(leaf(item.child(0))));
        blocks.push({
          ...(node.type.name === 'ordered_list'
            ? {
                type: 'list' as const,
                kind: 'ordered' as const,
                start: node.attrs.start as number,
              }
            : { type: 'list' as const, kind: 'bullet' as const }),
          blockKey: node.attrs.blockKey as string,
          items,
        });
        break;
      }
      case 'blockquote': {
        const paragraphs: ReturnType<typeof leaf>[] = [];
        node.forEach((p) => paragraphs.push(leaf(p)));
        blocks.push({
          type: 'blockquote',
          blockKey: node.attrs.blockKey as string,
          paragraphs,
        });
        break;
      }
      case 'article_image': {
        const block = known.find(
          (b) => b.blockKey === node.attrs.blockKey && isManualImageBlock(b),
        );
        if (!block) throw Error('Unknown image key');
        blocks.push(block);
        break;
      }
      default:
        throw Error('Unsupported block');
    }
  });
  return { ...draft, blocks };
}
function validOffset(node: Node, offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset > node.content.size)
    throw Error('Invalid text offset');
  const text = node.textBetween(0, node.content.size, '', '\n');
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  )
    throw Error('Split surrogate boundary');
}
export function positionFromBoundary(
  doc: Node,
  boundary: DraftBoundary,
): number {
  let result: number | undefined;
  doc.descendants((node, pos) => {
    if (node.attrs.blockKey !== boundary.blockKey) return;
    if (result !== undefined) throw Error('Duplicate block key');
    if (boundary.kind === 'text') {
      if (!node.isTextblock) throw Error('Text boundary on container');
      validOffset(node, boundary.offset);
      result = pos + 1 + boundary.offset;
    } else result = boundary.side === 'before' ? pos : pos + node.nodeSize;
  });
  if (result === undefined) throw Error('Unknown block key');
  return result;
}
/** Positions, including closed container edges, are preserved without text-selection coercion. */
export function selectionFromRange(
  doc: Node,
  range: DraftRange,
): Pick<Selection, 'anchor' | 'head'> {
  return {
    anchor: positionFromBoundary(doc, range.anchor),
    head: positionFromBoundary(doc, range.head),
  };
}
export function rangeFromSelection(
  doc: Node,
  selection: Pick<Selection, 'anchor' | 'head'>,
): DraftRange {
  const boundary = (pos: number): DraftBoundary => {
    if (!Number.isSafeInteger(pos) || pos < 0 || pos > doc.content.size)
      throw Error('Invalid editor position');
    const point = doc.resolve(pos);
    if (point.parent.isTextblock) {
      validOffset(point.parent, point.parentOffset);
      return {
        blockKey: point.parent.attrs.blockKey,
        kind: 'text',
        offset: point.parentOffset,
      };
    }
    const after = point.nodeAfter,
      before = point.nodeBefore;
    if (after?.attrs.blockKey)
      return { blockKey: after.attrs.blockKey, kind: 'edge', side: 'before' };
    if (before?.attrs.blockKey)
      return { blockKey: before.attrs.blockKey, kind: 'edge', side: 'after' };
    if (!doc.content.size)
      return { blockKey: emptyEditorKey, kind: 'text', offset: 0 };
    throw Error('Unrepresentable boundary');
  };
  return { anchor: boundary(selection.anchor), head: boundary(selection.head) };
}
/** Recurse through keyed containers, replacing only the deepest changed sibling span. */
export function documentPatch(
  before: Node,
  after: Node,
): { from: number; to: number; content: Fragment } | undefined {
  const diff = (
    old: Node,
    next: Node,
    offset: number,
  ): ReturnType<typeof documentPatch> => {
    if (old.eq(next)) return;
    if (old.isTextblock && next.isTextblock && old.sameMarkup(next)) {
      const start = old.content.findDiffStart(next.content),
        end = old.content.findDiffEnd(next.content);
      if (start !== null && end) {
        const overlap = Math.max(0, start - Math.min(end.a, end.b));
        return {
          from: offset + start,
          to: offset + end.a + overlap,
          content: next.content.cut(start, end.b + overlap),
        };
      }
    }
    let first = 0,
      a = old.childCount,
      b = next.childCount;
    while (first < a && first < b && old.child(first).eq(next.child(first)))
      first++;
    while (a > first && b > first && old.child(a - 1).eq(next.child(b - 1))) {
      a--;
      b--;
    }
    let from = offset;
    for (let i = 0; i < first; i++) from += old.child(i).nodeSize;
    if (a === first + 1 && b === first + 1) {
      const left = old.child(first),
        right = next.child(first);
      if (!left.isLeaf && !right.isLeaf && left.sameMarkup(right))
        return diff(left, right, from + 1);
    }
    let to = from;
    for (let i = first; i < a; i++) to += old.child(i).nodeSize;
    const nodes: Node[] = [];
    for (let i = first; i < b; i++) nodes.push(next.child(i));
    return { from, to, content: Fragment.fromArray(nodes) };
  };
  return diff(before, after, 0);
}
/** Restore a keyed text selection after wrapper-only structural edits. */
export function textSelectionFromRange(
  doc: Node,
  range: DraftRange,
): Selection {
  const { anchor, head } = selectionFromRange(doc, range);
  return TextSelection.between(doc.resolve(anchor), doc.resolve(head));
}
