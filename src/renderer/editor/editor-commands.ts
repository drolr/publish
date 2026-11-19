import { type Node } from 'prosemirror-model';
import {
  TextSelection,
  AllSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { closeHistory, undo, redo } from 'prosemirror-history';
import type { TextMark } from '../../contracts/rich-text-body';
import { editorSchema } from './editor-schema';
import {
  rangeFromSelection,
  textSelectionFromRange,
  documentPatch,
} from './editor-codec';
import type { DraftBoundary } from '../../contracts/manual-edit';

export type RichEditorCommand =
  | { type: 'toggleMark'; mark: TextMark }
  | { type: 'setBlock'; block: 'paragraph' | 'heading' }
  | { type: 'toggleList'; kind: 'ordered' | 'bullet'; start?: number }
  | { type: 'toggleQuote' }
  | { type: 'clearFormatting' }
  | { type: 'undo' }
  | { type: 'redo' };
export type FormatState = 'on' | 'off' | 'mixed';
type KeyFactory = () => string;
type Leaf = {
  node: Node;
  pos: number;
  parent: Node;
  index: number;
  start: number;
  end: number;
};
const newKey: KeyFactory = () => crypto.randomUUID();
function leaves(doc: Node): Leaf[] {
  const result: Leaf[] = [];
  doc.descendants((node, pos, parent, index) => {
    if (node.isTextblock)
      result.push({
        node,
        pos,
        parent: parent!,
        index,
        start: pos + 1,
        end: pos + node.nodeSize - 1,
      });
  });
  return result;
}
function selected(state: EditorState, leaf: Leaf): boolean {
  const { from, to, empty, $from } = state.selection;
  return empty
    ? $from.parent === leaf.node
    : (from < leaf.end && to > leaf.start) ||
        (leaf.start === leaf.end && from <= leaf.start && to > leaf.end);
}
function imageSelected(state: EditorState): boolean {
  let result = false;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (node.type.name === 'article_image') result = true;
  });
  return result;
}
function format(leaf: Leaf, doc: Node): string {
  if (leaf.node.type.name === 'heading') return 'heading';
  const point = doc.resolve(leaf.start);
  for (let depth = point.depth - 1; depth > 0; depth--) {
    const name = point.node(depth).type.name;
    if (['ordered_list', 'bullet_list', 'blockquote'].includes(name))
      return name;
  }
  return 'paragraph';
}
function status(values: boolean[]): FormatState {
  return values.length && values.every(Boolean)
    ? 'on'
    : values.some(Boolean)
      ? 'mixed'
      : 'off';
}
export function readRichToolbarState(state: EditorState) {
  const active = leaves(state.doc).filter((leaf) => selected(state, leaf));
  const selectedMarks: import('prosemirror-model').Mark[][] = [];
  const marks: Record<TextMark, FormatState> = {
    bold: 'off',
    italic: 'off',
    underline: 'off',
  };
  if (state.selection.empty)
    selectedMarks.push([
      ...(state.storedMarks ?? state.selection.$from.marks()),
    ]);
  else
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
      if (node.isInline) selectedMarks.push([...node.marks]);
    });
  for (const mark of Object.keys(marks) as TextMark[])
    marks[mark] = status(
      selectedMarks.map((set) => set.some((m) => m.type.name === mark)),
    );
  const blockStates = Object.fromEntries(
    ['paragraph', 'heading', 'ordered_list', 'bullet_list', 'blockquote'].map(
      (name) => [
        name,
        status(active.map((leaf) => format(leaf, state.doc) === name)),
      ],
    ),
  ) as Record<
    'paragraph' | 'heading' | 'ordered_list' | 'bullet_list' | 'blockquote',
    FormatState
  >;
  return {
    marks,
    blocks: blockStates,
    blockDisabledReason: imageSelected(state)
      ? '选区包含图片'
      : active.length
        ? undefined
        : '请选择文字段落',
  };
}
type Target =
  'paragraph' | 'heading' | 'ordered_list' | 'bullet_list' | 'blockquote';
/** Rebuild only wrapper structure; leaves and all untouched images retain their identities. */
function restructure(
  doc: Node,
  chosen: Set<string>,
  target: Target,
  key: KeyFactory,
  start = 1,
): Node {
  const entries: (
    { node: Node; selected: false } | { node: Node; selected: true }
  )[] = [];
  doc.forEach((top) => {
    const name = top.type.name;
    if (top.isTextblock) {
      entries.push({ node: top, selected: chosen.has(top.attrs.blockKey) });
      return;
    }
    if (!['ordered_list', 'bullet_list', 'blockquote'].includes(name)) {
      entries.push({ node: top, selected: false });
      return;
    }
    const children: Node[] = [];
    top.forEach((child) =>
      children.push(name === 'blockquote' ? child : child.child(0)),
    );
    if (!children.some((p) => chosen.has(p.attrs.blockKey))) {
      entries.push({ node: top, selected: false });
      return;
    }
    let retainedKey = false;
    for (let index = 0; index < children.length;) {
      if (chosen.has(children[index].attrs.blockKey)) {
        entries.push({ node: children[index++], selected: true });
        continue;
      }
      const begin = index,
        group: Node[] = [];
      while (
        index < children.length &&
        !chosen.has(children[index].attrs.blockKey)
      )
        group.push(children[index++]);
      entries.push({
        selected: false,
        node: top.type.create(
          {
            ...top.attrs,
            blockKey: retainedKey ? key() : top.attrs.blockKey,
            ...(name === 'ordered_list'
              ? { start: top.attrs.start + begin }
              : {}),
          },
          name === 'blockquote'
            ? group
            : group.map((p) => editorSchema.node('list_item', null, p)),
        ),
      });
      retainedKey = true;
    }
  });
  const output: Node[] = [];
  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (!entry.selected) {
      output.push(entry.node);
      index++;
      continue;
    }
    const group: Node[] = [];
    while (index < entries.length && entries[index].selected) {
      const node = entries[index++].node;
      group.push(
        editorSchema.node(
          target === 'heading' ? 'heading' : 'paragraph',
          { blockKey: node.attrs.blockKey },
          node.content,
        ),
      );
    }
    if (target === 'paragraph' || target === 'heading') output.push(...group);
    else
      output.push(
        editorSchema.node(
          target,
          { blockKey: key(), ...(target === 'ordered_list' ? { start } : {}) },
          target === 'blockquote'
            ? group
            : group.map((p) => editorSchema.node('list_item', null, p)),
        ),
      );
  }
  const next = editorSchema.node('doc', null, output);
  next.check();
  return next;
}
function structuralTransaction(
  state: EditorState,
  chosen: Set<string>,
  target: Target,
  key: KeyFactory,
  start = 1,
  tr = state.tr,
): Transaction | undefined {
  if (!chosen.size) return;
  const range = rangeFromSelection(tr.doc, tr.selection),
    next = restructure(tr.doc, chosen, target, key, start);
  if (next.eq(tr.doc)) return tr.docChanged ? tr : undefined;
  const oldLeaves = leaves(tr.doc),
    keptKeys = new Set<string>();
  next.descendants((node) => {
    if (node.attrs.blockKey) keptKeys.add(node.attrs.blockKey as string);
  });
  const retainedBoundary = (
    boundary: DraftBoundary,
    pos: number,
    lower: boolean,
  ): DraftBoundary => {
    if (keptKeys.has(boundary.blockKey)) return boundary;
    const candidates = oldLeaves.filter((leaf) =>
      lower ? leaf.end >= pos : leaf.start <= pos,
    );
    const leaf = lower
      ? (candidates[0] ?? oldLeaves.at(-1)!)
      : (candidates.at(-1) ?? oldLeaves[0]);
    return {
      kind: 'text',
      blockKey: leaf.node.attrs.blockKey as string,
      offset: Math.max(0, Math.min(leaf.end - leaf.start, pos - leaf.start)),
    };
  };
  const backwards = tr.selection.anchor > tr.selection.head;
  const retainedRange = {
    anchor: retainedBoundary(range.anchor, tr.selection.anchor, !backwards),
    head: retainedBoundary(range.head, tr.selection.head, backwards),
  };
  const all = tr.selection instanceof AllSelection;
  // Wrapper changes must preserve the caret's input intent, including an explicit [].
  const caretMarks = tr.selection.empty
    ? (tr.storedMarks ?? tr.selection.$from.marks())
    : undefined;
  const patch = documentPatch(tr.doc, next)!;
  tr.replaceWith(patch.from, patch.to, patch.content);
  tr.setSelection(
    all
      ? new AllSelection(tr.doc)
      : textSelectionFromRange(tr.doc, retainedRange),
  );
  if (caretMarks !== undefined) tr.setStoredMarks(caretMarks);
  return tr;
}
/** One transaction per user action. No view, clipboard, IPC, or mutable session state. */
export function richEditorTransaction(
  state: EditorState,
  command: RichEditorCommand,
  key: KeyFactory = newKey,
): Transaction | undefined {
  if (command.type === 'undo' || command.type === 'redo') {
    let result: Transaction | undefined;
    (command.type === 'undo' ? undo : redo)(state, (tr) => {
      result = tr;
    });
    return result;
  }
  const { selection } = state;
  if (command.type === 'toggleMark') {
    if (
      imageSelected(state) ||
      !leaves(state.doc).some((leaf) => selected(state, leaf))
    )
      return;
    const mark = editorSchema.marks[command.mark];
    const active = readRichToolbarState(state).marks[command.mark] === 'on';
    const tr = state.tr;
    if (selection.empty) {
      if (active) tr.removeStoredMark(mark);
      else tr.addStoredMark(mark.create());
    } else if (active) tr.removeMark(selection.from, selection.to, mark);
    else tr.addMark(selection.from, selection.to, mark.create());
    return isolatedHistory(tr);
  }
  const active = leaves(state.doc).filter((leaf) => selected(state, leaf));
  if (command.type === 'clearFormatting') {
    const tr = state.tr;
    if (selection.empty) return tr.setStoredMarks([]);
    tr.removeMark(selection.from, selection.to);
    const full = new Set(
      active
        .filter(
          (leaf) => selection.from <= leaf.start && selection.to >= leaf.end,
        )
        .map((leaf) => leaf.node.attrs.blockKey as string),
    );
    return isolatedHistory(
      structuralTransaction(state, full, 'paragraph', key, 1, tr) ?? tr,
    );
  }
  if (imageSelected(state) || !active.length) return;
  let target: Target =
    command.type === 'setBlock'
      ? command.block
      : command.type === 'toggleQuote'
        ? 'blockquote'
        : command.kind === 'ordered'
          ? 'ordered_list'
          : 'bullet_list';
  if (
    target !== 'paragraph' &&
    active.every((leaf) => format(leaf, state.doc) === target)
  )
    target = 'paragraph';
  const start =
    command.type === 'toggleList' && command.kind === 'ordered'
      ? (command.start ?? 1)
      : 1;
  if (
    !Number.isSafeInteger(start) ||
    start < 1 ||
    start > Number.MAX_SAFE_INTEGER - (active.length - 1)
  )
    return;
  const tr = structuralTransaction(
    state,
    new Set(active.map((leaf) => leaf.node.attrs.blockKey as string)),
    target,
    key,
    start,
  );
  return tr ? isolatedHistory(tr) : undefined;
}
export function applyRichEditorCommand(
  view: Pick<EditorView, 'state' | 'dispatch'>,
  command: RichEditorCommand,
): boolean {
  const tr = richEditorTransaction(view.state, command);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}
/** Public transaction time plus closeHistory separate the action from adjacent typing on both sides. */
function isolatedHistory(tr: Transaction): Transaction {
  return closeHistory(tr).setTime(0);
}

type Dispatch = (tr: Transaction) => void;
/** Shift+Enter retains active marks on the hard break, including an empty marked run. */
export function richEditorSoftBreak(
  state: EditorState,
  dispatch?: Dispatch,
): boolean {
  if (!state.selection.$from.parent.isTextblock || imageSelected(state))
    return false;
  if (dispatch)
    dispatch(
      state.tr.replaceSelectionWith(
        editorSchema.node(
          'hard_break',
          null,
          undefined,
          state.storedMarks ?? state.selection.$from.marks(),
        ),
        false,
      ),
    );
  return true;
}
export function richEditorEnter(
  state: EditorState,
  dispatch?: Dispatch,
  key: KeyFactory = newKey,
): boolean {
  const { $from, $to, empty } = state.selection;
  if (!$from.parent.isTextblock) return false;
  if (!empty) {
    // Delete and split one text leaf atomically. Refuse unsupported spanning
    // selections before any dispatch, and preserve overflow refusal unchanged.
    if (!$from.sameParent($to)) return false;
    const tr = state.tr
      .deleteSelection()
      .setStoredMarks(state.storedMarks ?? $from.marks());
    return richEditorEnter(
      state.apply(tr),
      dispatch
        ? (split) => {
            for (const step of split.steps) tr.step(step);
            tr.setSelection(
              TextSelection.create(
                tr.doc,
                split.selection.anchor,
                split.selection.head,
              ),
            );
            if (split.storedMarks !== null)
              tr.setStoredMarks(split.storedMarks);
            dispatch(isolatedHistory(tr));
          }
        : undefined,
      key,
    );
  }
  const leaf = leaves(state.doc).find((p) => p.node === $from.parent)!;
  const kind = format(leaf, state.doc);
  if (!['ordered_list', 'bullet_list', 'blockquote'].includes(kind))
    return false;
  if (!$from.parent.content.size) {
    const tr = structuralTransaction(
      state,
      new Set([$from.parent.attrs.blockKey as string]),
      'paragraph',
      key,
    );
    if (tr && dispatch) dispatch(isolatedHistory(tr));
    return !!tr;
  }
  if (kind === 'ordered_list') {
    const list = $from.node($from.depth - 2);
    if (list.attrs.start > Number.MAX_SAFE_INTEGER - list.childCount)
      return false;
  }
  // list_item and paragraph split together; quotes split just their paragraph.
  const depth = kind === 'blockquote' ? 1 : 2;
  if (dispatch) {
    const types =
      depth === 1
        ? [{ type: editorSchema.nodes.paragraph, attrs: { blockKey: key() } }]
        : [
            { type: editorSchema.nodes.list_item },
            { type: editorSchema.nodes.paragraph, attrs: { blockKey: key() } },
          ];
    const tr = state.tr.split($from.pos, depth, types);
    tr.setSelection(
      TextSelection.create(tr.doc, $from.pos + (depth === 1 ? 2 : 4)),
    );
    tr.ensureMarks(state.storedMarks ?? $from.marks());
    dispatch(isolatedHistory(tr));
  }
  return true;
}
/** At a container boundary unwrap the current leaf before ordinary paragraph joining. */
export function richEditorBackspace(
  state: EditorState,
  dispatch?: Dispatch,
  key: KeyFactory = newKey,
): boolean {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parentOffset !== 0)
    return false;
  const leaf = leaves(state.doc).find((p) => p.node === $from.parent)!;
  if (
    format(leaf, state.doc) === 'paragraph' ||
    format(leaf, state.doc) === 'heading'
  )
    return false;
  const tr = structuralTransaction(
    state,
    new Set([$from.parent.attrs.blockKey as string]),
    'paragraph',
    key,
  );
  if (tr && dispatch) dispatch(isolatedHistory(tr));
  return !!tr;
}
