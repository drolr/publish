import { expect, it } from 'vitest';
import {
  EditorState,
  TextSelection,
  AllSelection,
  NodeSelection,
} from 'prosemirror-state';
import { history, undo, redo } from 'prosemirror-history';
import type { ManualDraftV2 } from '../../src/contracts/manual-article';
import {
  draftV2ToEditor,
  editorToDraftV2,
} from '../../src/renderer/editor/editor-codec';
import {
  richEditorTransaction,
  readRichToolbarState,
  richEditorEnter,
  richEditorBackspace,
  richEditorSoftBreak,
} from '../../src/renderer/editor/editor-commands';
const key = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const p = (
  n: number,
  text: string,
  marks: ('bold' | 'italic' | 'underline')[] = [],
) => ({
  type: 'paragraph' as const,
  blockKey: key(n),
  content: text ? [{ type: 'text' as const, text, marks }] : [],
});
const base = (blocks: ManualDraftV2['blocks']): ManualDraftV2 => ({
  bodyVersion: 2,
  title: '',
  contentDeclaration: 'repost',
  blocks,
});
function setup(blocks: ManualDraftV2['blocks']) {
  const draft = base(blocks);
  let state = EditorState.create({
    doc: draftV2ToEditor(draft),
    plugins: [history()],
  });
  let id = 100;
  return {
    draft,
    get state() {
      return state;
    },
    select(a: number, b = a) {
      state = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, a, b)),
      );
    },
    apply(command: Parameters<typeof richEditorTransaction>[1]) {
      const tr = richEditorTransaction(state, command, () => key(id++));
      if (tr) state = state.apply(tr);
      return tr;
    },
    body() {
      return editorToDraftV2(state.doc, draft).blocks;
    },
    dispatch(tr: import('prosemirror-state').Transaction) {
      state = state.apply(tr);
    },
  };
}
it('toggles combined marks, exposes mixed state and each command undoes once', () => {
  const f = setup([p(1, 'abcd')]);
  f.select(1, 3);
  f.apply({ type: 'toggleMark', mark: 'bold' });
  f.apply({ type: 'toggleMark', mark: 'italic' });
  expect(f.body()).toEqual(
    [p(1, 'ab', ['bold', 'italic'])].map((b) => ({
      ...b,
      content: [...b.content, { type: 'text', text: 'cd', marks: [] }],
    })),
  );
  f.select(1, 5);
  expect(readRichToolbarState(f.state).marks.bold).toBe('mixed');
  expect(undo(f.state, f.dispatch)).toBe(true);
  expect((f.body()[0] as ReturnType<typeof p>).content[0].marks).toEqual([
    'bold',
  ]);
  expect(redo(f.state, f.dispatch)).toBe(true);
  expect((f.body()[0] as ReturnType<typeof p>).content[0].marks).toEqual([
    'bold',
    'italic',
  ]);
});
it('uses stored marks at a caret and clear does not unwrap its heading', () => {
  const f = setup([{ ...p(1, 'abc'), type: 'heading' }]);
  f.select(2);
  f.apply({ type: 'toggleMark', mark: 'underline' });
  expect(readRichToolbarState(f.state).marks.underline).toBe('on');
  f.apply({ type: 'clearFormatting' });
  expect(f.state.storedMarks).toEqual([]);
  expect(f.body()[0].type).toBe('heading');
});
it('unwraps only selected list items with original remaining numbering and one undo', () => {
  const f = setup([
    {
      type: 'list',
      kind: 'ordered',
      start: 7,
      blockKey: key(9),
      items: [p(1, 'one'), p(2, 'two'), p(3, 'three')],
    },
  ]);
  f.select(10);
  f.apply({ type: 'setBlock', block: 'heading' });
  expect(f.body()).toEqual([
    {
      type: 'list',
      kind: 'ordered',
      start: 7,
      blockKey: key(9),
      items: [p(1, 'one')],
    },
    { ...p(2, 'two'), type: 'heading' },
    {
      type: 'list',
      kind: 'ordered',
      start: 9,
      blockKey: key(100),
      items: [p(3, 'three')],
    },
  ]);
  expect(undo(f.state, f.dispatch)).toBe(true);
  expect(f.body()).toEqual(f.draft.blocks);
});
it('converts across adjacent containers without nesting and toggles the same format off', () => {
  const f = setup([
    { type: 'blockquote', blockKey: key(8), paragraphs: [p(1, 'a')] },
    {
      type: 'list',
      kind: 'ordered',
      start: 4,
      blockKey: key(9),
      items: [p(2, 'b')],
    },
  ]);
  f.select(2, 10);
  f.apply({ type: 'toggleList', kind: 'bullet' });
  expect(f.body()).toEqual([
    {
      type: 'list',
      kind: 'bullet',
      blockKey: key(100),
      items: [p(1, 'a'), p(2, 'b')],
    },
  ]);
  f.apply({ type: 'toggleList', kind: 'bullet' });
  expect(f.body()).toEqual([p(1, 'a'), p(2, 'b')]);
});
it('clear only removes selected marks and unwraps only fully selected leaves', () => {
  const f = setup([
    { ...p(1, 'abcd', ['bold']), type: 'heading' },
    {
      type: 'blockquote',
      blockKey: key(9),
      paragraphs: [p(2, 'xyz', ['italic']), p(3, 'last', ['underline'])],
    },
  ]);
  f.select(3, 11);
  f.apply({ type: 'clearFormatting' });
  expect(f.body()).toEqual([
    {
      ...p(1, 'ab', ['bold']),
      type: 'heading',
      content: [
        { type: 'text', text: 'ab', marks: ['bold'] },
        { type: 'text', text: 'cd', marks: [] },
      ],
    },
    p(2, 'xyz'),
    {
      type: 'blockquote',
      blockKey: key(9),
      paragraphs: [p(3, 'last', ['underline'])],
    },
  ]);
});
it('disables block and mark toggles across images but clears selected marks without moving images', () => {
  const f = setup([
    p(1, 'a', ['bold']),
    { type: 'image', blockKey: key(2), imageToken: key(2) },
    p(3, 'b', ['italic']),
  ]);
  f.select(1, 7);
  expect(f.apply({ type: 'toggleQuote' })).toBeUndefined();
  expect(f.apply({ type: 'toggleMark', mark: 'underline' })).toBeUndefined();
  expect(readRichToolbarState(f.state).blockDisabledReason).toBe(
    '选区包含图片',
  );
  f.apply({ type: 'clearFormatting' });
  expect(f.body()).toEqual([p(1, 'a'), f.draft.blocks[1], p(3, 'b')]);
});
it('does not treat touching the next paragraph start as selecting that paragraph', () => {
  const f = setup([p(1, 'a'), p(2, 'b')]);
  f.select(1, 4);
  f.apply({ type: 'setBlock', block: 'heading' });
  expect(f.body()).toEqual([{ ...p(1, 'a'), type: 'heading' }, p(2, 'b')]);
});
it('Enter splits list items with unique keys and an empty item exits without nesting; soft break keeps marks', () => {
  const f = setup([
    {
      type: 'list',
      kind: 'ordered',
      start: 4,
      blockKey: key(9),
      items: [p(1, 'ab', ['bold'])],
    },
  ]);
  f.select(4);
  expect(richEditorEnter(f.state, f.dispatch, () => key(100))).toBe(true);
  expect(f.body()).toEqual([
    {
      type: 'list',
      kind: 'ordered',
      start: 4,
      blockKey: key(9),
      items: [p(1, 'a', ['bold']), p(100, 'b', ['bold'])],
    },
  ]);
  expect(richEditorSoftBreak(f.state, f.dispatch)).toBe(true);
  expect(
    (f.body()[0] as Extract<ManualDraftV2['blocks'][number], { type: 'list' }>)
      .items[1].content[0].text,
  ).toBe('\nb');
  const e = setup([
    { type: 'list', kind: 'bullet', blockKey: key(9), items: [p(1, '')] },
  ]);
  e.select(3);
  expect(richEditorEnter(e.state, e.dispatch, () => key(100))).toBe(true);
  expect(e.body()).toEqual([p(1, '')]);
});
it('Backspace lifts first container paragraph, preserves next numbering and blocks illegal nesting at image boundaries', () => {
  const f = setup([
    {
      type: 'list',
      kind: 'ordered',
      start: 4,
      blockKey: key(9),
      items: [p(1, 'a'), p(2, 'b')],
    },
  ]);
  f.select(3);
  expect(richEditorBackspace(f.state, f.dispatch, () => key(100))).toBe(true);
  expect(f.body()).toEqual([
    p(1, 'a'),
    {
      type: 'list',
      kind: 'ordered',
      start: 5,
      blockKey: key(9),
      items: [p(2, 'b')],
    },
  ]);
});
it('image node selection and all selection obey disabled states', () => {
  const f = setup([
    p(1, 'a'),
    { type: 'image', blockKey: key(2), imageToken: key(2) },
  ]);
  f.dispatch(f.state.tr.setSelection(NodeSelection.create(f.state.doc, 3)));
  expect(f.apply({ type: 'setBlock', block: 'heading' })).toBeUndefined();
  f.dispatch(f.state.tr.setSelection(new AllSelection(f.state.doc)));
  expect(f.apply({ type: 'toggleList', kind: 'ordered' })).toBeUndefined();
});
it('keeps whole-document rich selection through unwrapping and clear, preserving backwards direction', () => {
  const f = setup([
    {
      type: 'blockquote',
      blockKey: key(9),
      paragraphs: [p(1, 'a', ['bold']), p(2, 'b', ['italic'])],
    },
  ]);
  f.dispatch(f.state.tr.setSelection(new AllSelection(f.state.doc)));
  expect(() => f.apply({ type: 'clearFormatting' })).not.toThrow();
  expect(f.body()).toEqual([p(1, 'a'), p(2, 'b')]);
  expect(f.state.selection.from).toBe(0);
  expect(f.state.selection.to).toBe(f.state.doc.content.size);
  const r = setup([
    {
      type: 'blockquote',
      blockKey: key(9),
      paragraphs: [p(1, 'a'), p(2, 'b')],
    },
  ]);
  r.select(6, 2);
  r.apply({ type: 'setBlock', block: 'heading' });
  expect(r.state.selection.anchor).toBeGreaterThan(r.state.selection.head);
  expect(r.body()).toEqual([
    { ...p(1, 'a'), type: 'heading' },
    { ...p(2, 'b'), type: 'heading' },
  ]);
});
it('isolates a formatting operation from the typing immediately before and after it', () => {
  const f = setup([p(1, 'a')]);
  f.select(2);
  f.dispatch(f.state.tr.insertText('b'));
  f.apply({ type: 'toggleQuote' });
  f.dispatch(f.state.tr.insertText('c'));
  expect(undo(f.state, f.dispatch)).toBe(true);
  expect(f.body()).toEqual([
    { type: 'blockquote', blockKey: key(100), paragraphs: [p(1, 'ab')] },
  ]);
  expect(undo(f.state, f.dispatch)).toBe(true);
  expect(f.body()).toEqual([p(1, 'ab')]);
  expect(undo(f.state, f.dispatch)).toBe(true);
  expect(f.body()).toEqual([p(1, 'a')]);
});
it('refuses list splitting when the next number would be unsafe', () => {
  const f = setup([
    {
      type: 'list',
      kind: 'ordered',
      blockKey: key(9),
      start: Number.MAX_SAFE_INTEGER,
      items: [p(1, 'a')],
    },
  ]);
  f.select(4);
  expect(richEditorEnter(f.state, f.dispatch)).toBe(false);
  expect(f.body()).toEqual(f.draft.blocks);
});
it('does not merge or delete intervening empty blocks in a format conversion', () => {
  const f = setup([
    p(1, 'a'),
    p(2, ''),
    { type: 'blockquote', blockKey: key(9), paragraphs: [p(3, 'b')] },
  ]);
  f.select(1, 9);
  f.apply({ type: 'toggleList', kind: 'ordered', start: 6 });
  expect(f.body()).toEqual([
    {
      type: 'list',
      kind: 'ordered',
      start: 6,
      blockKey: key(100),
      items: [p(1, 'a'), p(2, ''), p(3, 'b')],
    },
  ]);
});
it('carries explicit stored marks through Enter at the end of a list item and preserves blank items', () => {
  const f = setup([
    { type: 'list', kind: 'bullet', blockKey: key(9), items: [p(1, 'a')] },
  ]);
  f.select(4);
  f.apply({ type: 'toggleMark', mark: 'underline' });
  expect(richEditorEnter(f.state, f.dispatch, () => key(100))).toBe(true);
  expect(readRichToolbarState(f.state).marks.underline).toBe('on');
  f.dispatch(f.state.tr.insertText('b'));
  expect(f.body()).toEqual([
    {
      type: 'list',
      kind: 'bullet',
      blockKey: key(9),
      items: [p(1, 'a'), p(100, 'b', ['underline'])],
    },
  ]);
});
it('quote splitting and an empty middle list item exit preserve all remaining leaves and original numbering', () => {
  const f = setup([
    { type: 'blockquote', blockKey: key(9), paragraphs: [p(1, 'ab')] },
  ]);
  f.select(3);
  expect(richEditorEnter(f.state, f.dispatch, () => key(100))).toBe(true);
  expect(f.body()).toEqual([
    {
      type: 'blockquote',
      blockKey: key(9),
      paragraphs: [p(1, 'a'), p(100, 'b')],
    },
  ]);
  const e = setup([
    {
      type: 'list',
      kind: 'ordered',
      start: 8,
      blockKey: key(9),
      items: [p(1, 'a'), p(2, ''), p(3, 'c')],
    },
  ]);
  e.select(8);
  expect(richEditorEnter(e.state, e.dispatch, () => key(100))).toBe(true);
  expect(e.body()).toEqual([
    {
      type: 'list',
      kind: 'ordered',
      start: 8,
      blockKey: key(9),
      items: [p(1, 'a')],
    },
    p(2, ''),
    {
      type: 'list',
      kind: 'ordered',
      start: 10,
      blockKey: key(100),
      items: [p(3, 'c')],
    },
  ]);
});
it('mixed marks toggle on uniformly, repeat toggle off and clear preserve unrelated mark ranges', () => {
  const f = setup([
    {
      ...p(1, 'a', ['bold']),
      content: [
        { type: 'text', text: 'a', marks: ['bold'] },
        { type: 'text', text: 'b', marks: ['italic'] },
      ],
    },
  ]);
  f.select(1, 3);
  f.apply({ type: 'toggleMark', mark: 'bold' });
  expect((f.body()[0] as ReturnType<typeof p>).content).toEqual([
    { type: 'text', text: 'a', marks: ['bold'] },
    { type: 'text', text: 'b', marks: ['bold', 'italic'] },
  ]);
  f.apply({ type: 'toggleMark', mark: 'bold' });
  expect((f.body()[0] as ReturnType<typeof p>).content).toEqual([
    { type: 'text', text: 'a', marks: [] },
    { type: 'text', text: 'b', marks: ['italic'] },
  ]);
});
it('block conversion keeps unrelated image PM nodes outside the replacement step', () => {
  const f = setup([
    { type: 'image', blockKey: key(4), imageToken: key(4) },
    p(1, 'a'),
    p(2, 'b'),
    { type: 'image', blockKey: key(5), imageToken: key(5) },
  ]);
  f.select(2, 6);
  const tr = f.apply({ type: 'toggleQuote' })!;
  expect(tr.steps[0].toJSON()).toMatchObject({ from: 1, to: 7 });
  expect(f.body()[0]).toEqual(f.draft.blocks[0]);
  expect(f.body().at(-1)).toEqual(f.draft.blocks.at(-1));
});
it.each(
  (
    [
      [],
      ['bold'],
      ['italic'],
      ['underline'],
      ['bold', 'italic'],
      ['bold', 'underline'],
      ['italic', 'underline'],
      ['bold', 'italic', 'underline'],
    ] as Array<Array<'bold' | 'italic' | 'underline'>>
  ).map((marks) => ({ marks })),
)(
  'applies exact supported mark combinations %j and clears them in one undoable action',
  ({ marks }) => {
    const f = setup([p(1, 'xy')]);
    f.select(1, 3);
    for (const mark of marks) f.apply({ type: 'toggleMark', mark });
    expect(f.body()).toEqual([p(1, 'xy', marks)]);
    const before = f.state.doc;
    f.apply({ type: 'clearFormatting' });
    expect(f.body()).toEqual([p(1, 'xy')]);
    if (marks.length) {
      expect(undo(f.state, f.dispatch)).toBe(true);
      expect(f.state.doc.eq(before)).toBe(true);
    }
  },
);
it.each([
  'paragraph',
  'heading',
  'ordered_list',
  'bullet_list',
  'blockquote',
] as const)(
  'converts each supported source %s to all target structures without nesting',
  (source) => {
    const leaf = p(1, 'ab', ['bold', 'underline']);
    const sourceBlock: ManualDraftV2['blocks'][number] =
      source === 'paragraph'
        ? leaf
        : source === 'heading'
          ? { ...leaf, type: 'heading' }
          : source === 'blockquote'
            ? { type: 'blockquote', blockKey: key(9), paragraphs: [leaf] }
            : source === 'ordered_list'
              ? {
                  type: 'list',
                  kind: 'ordered',
                  start: 8,
                  blockKey: key(9),
                  items: [leaf],
                }
              : {
                  type: 'list',
                  kind: 'bullet',
                  blockKey: key(9),
                  items: [leaf],
                };
    for (const target of [
      'paragraph',
      'heading',
      'ordered_list',
      'bullet_list',
      'blockquote',
    ] as const) {
      const f = setup([sourceBlock]);
      let pos = 0;
      f.state.doc.descendants((node, p) => {
        if (node.isTextblock) pos = p + 1;
      });
      f.select(pos, pos + 2);
      f.apply(
        target === 'paragraph' || target === 'heading'
          ? { type: 'setBlock', block: target }
          : target === 'blockquote'
            ? { type: 'toggleQuote' }
            : {
                type: 'toggleList',
                kind: target === 'ordered_list' ? 'ordered' : 'bullet',
              },
      );
      const result = f.body()[0];
      const expected =
        source === target && target !== 'paragraph' ? 'paragraph' : target;
      expect(result.type).toBe(
        expected === 'ordered_list' || expected === 'bullet_list'
          ? 'list'
          : expected,
      );
      if (result.type === 'list') {
        expect(result.kind).toBe(
          target === 'ordered_list' ? 'ordered' : 'bullet',
        );
        expect(result.items).toEqual([leaf]);
        if (result.kind === 'ordered') expect(result.start).toBe(1);
      } else if (result.type === 'blockquote')
        expect(result.paragraphs).toEqual([leaf]);
      else if (result.type === 'paragraph' || result.type === 'heading')
        expect(result.content).toEqual(leaf.content);
    }
  },
);
it('does not include the next empty paragraph when the selection only touches its start', () => {
  const f = setup([p(1, 'a'), p(2, '')]);
  f.select(1, 4);
  f.apply({ type: 'toggleQuote' });
  expect(f.body()).toEqual([
    { type: 'blockquote', blockKey: key(100), paragraphs: [p(1, 'a')] },
    p(2, ''),
  ]);
});
const caretBlockCommands = [
  { type: 'setBlock', block: 'heading' },
  { type: 'toggleList', kind: 'ordered' },
  { type: 'toggleList', kind: 'bullet' },
  { type: 'toggleQuote' },
] as const;
it.each(caretBlockCommands)(
  'retains explicit caret underline through $type $block $kind before typing',
  (command) => {
    const f = setup([p(1, 'ab')]);
    f.select(2);
    f.apply({ type: 'toggleMark', mark: 'underline' });
    f.apply(command);
    expect(f.state.storedMarks?.map((mark) => mark.type.name)).toEqual([
      'underline',
    ]);
    expect(readRichToolbarState(f.state).marks.underline).toBe('on');
    f.dispatch(f.state.tr.insertText('X'));
    let leaf: import('prosemirror-model').Node | undefined;
    f.state.doc.descendants((node) => {
      if (node.isTextblock) leaf = node;
    });
    expect(leaf!.textContent).toBe('aXb');
    expect(leaf!.child(1).text).toBe('X');
    expect(leaf!.child(1).marks.map((mark) => mark.type.name)).toEqual([
      'underline',
    ]);
  },
);
it.each(['clearFormatting', 'toggleMark'] as const)(
  'preserves explicit empty caret marks after %s through conversion and typing',
  (method) => {
    for (const command of caretBlockCommands) {
      const f = setup([p(1, 'ab', ['underline'])]);
      f.select(2);
      f.apply(
        method === 'clearFormatting'
          ? { type: 'clearFormatting' }
          : { type: 'toggleMark', mark: 'underline' },
      );
      expect(f.state.storedMarks).toEqual([]);
      f.apply(command);
      expect(f.state.storedMarks).toEqual([]);
      expect(readRichToolbarState(f.state).marks.underline).toBe('off');
      f.dispatch(f.state.tr.insertText('X'));
      let leaf: import('prosemirror-model').Node | undefined;
      f.state.doc.descendants((node) => {
        if (node.isTextblock) leaf = node;
      });
      expect(leaf!.textContent).toBe('aXb');
      expect(leaf!.child(1).text).toBe('X');
      expect(leaf!.child(1).marks).toEqual([]);
      expect(leaf!.child(0).marks.map((mark) => mark.type.name)).toEqual([
        'underline',
      ]);
    }
  },
);
it.each(['ordered', 'bullet', 'quote'] as const)(
  'preserves on and explicit off caret marks when Enter exits empty %s',
  (kind) => {
    for (const marked of [true, false]) {
      const block: ManualDraftV2['blocks'][number] =
        kind === 'quote'
          ? { type: 'blockquote', blockKey: key(9), paragraphs: [p(1, '')] }
          : kind === 'ordered'
            ? {
                type: 'list',
                kind: 'ordered',
                start: 8,
                blockKey: key(9),
                items: [p(1, '')],
              }
            : {
                type: 'list',
                kind: 'bullet',
                blockKey: key(9),
                items: [p(1, '')],
              };
      const f = setup([block]);
      f.select(kind === 'quote' ? 2 : 3);
      f.apply({ type: 'toggleMark', mark: 'underline' });
      if (!marked) f.apply({ type: 'toggleMark', mark: 'underline' });
      expect(richEditorEnter(f.state, f.dispatch)).toBe(true);
      expect(f.body()).toEqual([p(1, '')]);
      expect(f.state.storedMarks?.map((mark) => mark.type.name)).toEqual(
        marked ? ['underline'] : [],
      );
      f.dispatch(f.state.tr.insertText('X'));
      expect(f.body()).toEqual([p(1, 'X', marked ? ['underline'] : [])]);
    }
  },
);
it('retains effective inherited caret marks when unwrapping, and does not create stored marks for a nonempty selection', () => {
  const f = setup([
    {
      type: 'blockquote',
      blockKey: key(9),
      paragraphs: [p(1, 'ab', ['bold'])],
    },
  ]);
  f.select(3);
  expect(f.state.storedMarks).toBeNull();
  f.apply({ type: 'setBlock', block: 'paragraph' });
  expect(f.state.storedMarks?.map((mark) => mark.type.name)).toEqual(['bold']);
  f.dispatch(f.state.tr.insertText('X'));
  expect(f.body()).toEqual([p(1, 'aXb', ['bold'])]);
  const selected = setup([p(1, 'ab', ['bold'])]);
  selected.select(1, 3);
  selected.apply({ type: 'toggleQuote' });
  expect(selected.state.selection.empty).toBe(false);
  expect(selected.state.storedMarks).toBeNull();
  selected.apply({ type: 'clearFormatting' });
  expect(selected.state.selection.empty).toBe(false);
  expect(selected.state.storedMarks).toBeNull();
  expect(selected.body()).toEqual([p(1, 'ab')]);
});

it('Enter replaces a selected range within one list paragraph as one undo step and refuses overflow atomically', () => {
  const list = (start: number) => ({
    type: 'list' as const,
    kind: 'ordered' as const,
    start,
    blockKey: key(2),
    items: [p(1, 'abcd', ['bold'])],
  });
  const f = setup([list(3)]);
  f.select(4, 6);
  expect(richEditorEnter(f.state, f.dispatch, () => key(100))).toBe(true);
  expect(f.body()).toMatchObject([
    {
      start: 3,
      items: [
        { content: [{ text: 'a', marks: ['bold'] }] },
        { content: [{ text: 'd', marks: ['bold'] }] },
      ],
    },
  ]);
  expect(undo(f.state, f.dispatch)).toBe(true);
  expect(f.body()).toEqual([list(3)]);
  const overflow = setup([list(Number.MAX_SAFE_INTEGER)]);
  overflow.select(4, 6);
  expect(richEditorEnter(overflow.state, overflow.dispatch)).toBe(false);
  expect(overflow.body()).toEqual([list(Number.MAX_SAFE_INTEGER)]);
});
