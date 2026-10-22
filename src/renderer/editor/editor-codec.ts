import { Fragment, type Node } from 'prosemirror-model';
import type { Selection } from 'prosemirror-state';
import type { ManualDraft } from '../../contracts/manual-article';
import type { DraftBoundary, DraftRange } from '../../contracts/manual-edit';
import { editorSchema } from './editor-schema';
// Used only for display of a genuinely empty document. Never crosses the bridge.
export const emptyEditorKey = '00000000-0000-4000-8000-000000000000';
export function draftToEditor(draft: ManualDraft): Node {
  return editorSchema.node(
    'doc',
    null,
    draft.blocks.length
      ? draft.blocks.map((block) => {
          if (block.type !== 'paragraph')
            return editorSchema.node('article_image', {
              blockKey: block.blockKey,
            });
          const lines = block.text.split('\n');
          const nodes = lines.flatMap((line, index) => [
            ...(index ? [editorSchema.node('hard_break')] : []),
            ...(line ? [editorSchema.text(line)] : []),
          ]);
          return editorSchema.node(
            'paragraph',
            { blockKey: block.blockKey },
            nodes,
          );
        })
      : [editorSchema.node('paragraph', { blockKey: emptyEditorKey })],
  );
}
export function editorToDraft(
  doc: Node,
  draft: ManualDraft,
  known = draft.blocks,
): ManualDraft {
  const blocks: ManualDraft['blocks'] = [];
  doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      if (
        node.attrs.blockKey === emptyEditorKey &&
        !node.content.size &&
        doc.childCount === 1 &&
        !draft.blocks.length
      )
        return;
      blocks.push({
        type: 'paragraph',
        blockKey: node.attrs.blockKey,
        text: node.textBetween(0, node.content.size, '', '\n'),
      });
    } else {
      const block = known.find(
        (b) => b.blockKey === node.attrs.blockKey && b.type !== 'paragraph',
      );
      if (!block) throw Error('Unknown image key');
      blocks.push(block);
    }
  });
  return { ...draft, blocks };
}
export function rangeFromSelection(
  doc: Node,
  selection: Pick<Selection, 'anchor' | 'head'>,
): DraftRange {
  const boundary = (pos: number): DraftBoundary => {
    const point = doc.resolve(pos);
    if (point.depth > 0 && point.parent.type.name === 'paragraph')
      return {
        blockKey: point.parent.attrs.blockKey,
        kind: 'text',
        offset: point.parentOffset,
      };
    if (point.nodeAfter)
      return {
        blockKey: point.nodeAfter.attrs.blockKey,
        kind: 'edge',
        side: 'before',
      };
    if (point.nodeBefore)
      return {
        blockKey: point.nodeBefore.attrs.blockKey,
        kind: 'edge',
        side: 'after',
      };
    return { blockKey: emptyEditorKey, kind: 'text', offset: 0 };
  };
  return { anchor: boundary(selection.anchor), head: boundary(selection.head) };
}
/** Key-aligned minimal replacement keeps unaffected nodes and selection mappings. */
export function documentPatch(
  before: Node,
  after: Node,
): { from: number; to: number; content: Fragment } | undefined {
  let first = 0,
    lastBefore = before.childCount,
    lastAfter = after.childCount;
  while (
    first < lastBefore &&
    first < lastAfter &&
    before.child(first).eq(after.child(first))
  )
    first++;
  if (first === lastBefore && first === lastAfter) return;
  while (
    lastBefore > first &&
    lastAfter > first &&
    before.child(lastBefore - 1).eq(after.child(lastAfter - 1))
  ) {
    lastBefore--;
    lastAfter--;
  }
  let from = 0,
    to = 0;
  const nodes: Node[] = [];
  before.forEach((node, pos, index) => {
    if (index === first) from = pos;
    if (index < lastBefore) to = pos + node.nodeSize;
  });
  if (first === before.childCount) from = before.content.size;
  if (lastBefore === first) to = from;
  if (lastBefore === first + 1 && lastAfter === first + 1) {
    const old = before.child(first),
      next = after.child(first);
    if (
      old.type.name === 'paragraph' &&
      next.type === old.type &&
      old.attrs.blockKey === next.attrs.blockKey
    ) {
      const start = old.content.findDiffStart(next.content),
        end = old.content.findDiffEnd(next.content);
      if (start !== null && end) {
        const overlap = Math.max(0, start - Math.min(end.a, end.b));
        return {
          from: from + 1 + start,
          to: from + 1 + end.a + overlap,
          content: next.content.cut(start, end.b + overlap),
        };
      }
    }
  }
  after.forEach((node, _pos, index) => {
    if (index >= first && index < lastAfter) nodes.push(node);
  });
  return { from, to, content: Fragment.fromArray(nodes) };
}
