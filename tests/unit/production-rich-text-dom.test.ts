import { describe, expect, it, vi } from 'vitest';
import type {
  RichParagraph,
  RichTextBlock,
  TextMark,
} from '../../src/contracts/rich-text-body';
import { appendRichTextBlock } from '../../src/infrastructure/platforms/judongche/production-rich-text';
import {
  createRichTextDomPort,
  type EditorBlockKind,
  type EditorDom,
  type EditorFocus,
  type EditorKey,
  type EditorSnapshot,
  type EditorTool,
  type EditorToolState,
} from '../../src/infrastructure/platforms/judongche/production-rich-text-dom';
import { JudongchePageError } from '../../src/infrastructure/platforms/judongche/production-state';

type Kind = Exclude<EditorBlockKind, 'unsupported'>;
interface FakeRun {
  text: string;
  marks: TextMark[];
}
interface FakeBlock {
  kind: Kind;
  leaves: FakeRun[][];
}
interface FakeSelection {
  blockIndex: number;
  leafIndex: number;
  start: number;
  end: number;
}
const markOrder: TextMark[] = ['bold', 'italic', 'underline'];

/** Deterministic stand-in for the publish editor. It reproduces the verified
 * platform semantics: binary per-block toolbar toggles, stored marks, a
 * trailing empty paragraph, Enter exits, and ArrowDown leaves a container. */
class FakeEditor implements EditorDom {
  blocks: FakeBlock[] = [{ kind: 'paragraph', leaves: [[]] }];
  caret = { blockIndex: 0, leafIndex: 0 };
  selection: FakeSelection | null = null;
  nodeSelection: { blockIndex: number; leafIndex: number } | null = null;
  stored = new Set<TextMark>();
  focusQueue: boolean[] = [];
  focusChecks = 0;
  clickEdges = 0;
  placeCarets = 0;
  toolClicks: EditorTool[] = [];
  softBreaks = 0;
  popupCloses = 0;
  ignoreBlockToggle = false;
  ignoreArrowDown = false;
  staleDisabled = new Set<TextMark>();
  ignoreMarkClick = new Set<TextMark>();
  lagChunks = 0;
  dropTyping = false;
  automaticTail = true;
  loseCaretOnLeafCreate = false;
  insertCalls: string[] = [];
  snapshotCalls = 0;
  private pending = '';

  private runs(blockIndex: number, leafIndex: number): FakeRun[] {
    return this.blocks[blockIndex]!.leaves[leafIndex]!;
  }

  private text(blockIndex: number, leafIndex: number): string {
    return this.runs(blockIndex, leafIndex)
      .map((run) => run.text)
      .join('');
  }

  private ensureTrailing(): void {
    const last = this.blocks.at(-1)!;
    if (
      last.kind === 'paragraph' &&
      last.leaves.length === 1 &&
      this.text(this.blocks.length - 1, 0) === ''
    )
      return;
    this.blocks.push({ kind: 'paragraph', leaves: [[]] });
  }

  private hasMark(selection: FakeSelection, mark: TextMark): boolean {
    let offset = 0;
    let seen = false;
    for (const run of this.runs(selection.blockIndex, selection.leafIndex)) {
      const start = offset;
      const end = offset + run.text.length;
      offset = end;
      if (end <= selection.start || start >= selection.end) continue;
      seen = true;
      if (!run.marks.includes(mark)) return false;
    }
    return seen;
  }

  private hasMarks(selection: FakeSelection): boolean {
    let offset = 0;
    for (const run of this.runs(selection.blockIndex, selection.leafIndex)) {
      const start = offset;
      const end = offset + run.text.length;
      offset = end;
      if (end <= selection.start || start >= selection.end) continue;
      if (run.marks.length) return true;
    }
    return false;
  }

  private applyMark(
    selection: FakeSelection,
    mark: TextMark,
    active: boolean,
  ): void {
    const runs = this.runs(selection.blockIndex, selection.leafIndex);
    const out: FakeRun[] = [];
    let offset = 0;
    for (const run of runs) {
      const start = offset;
      const end = offset + run.text.length;
      offset = end;
      if (run.text === '' || end <= selection.start || start >= selection.end) {
        out.push({ text: run.text, marks: [...run.marks] });
        continue;
      }
      const from = Math.max(selection.start, start) - start;
      const to = Math.min(selection.end, end) - start;
      const pieces: [string, boolean][] = [
        [run.text.slice(0, from), false],
        [run.text.slice(from, to), true],
        [run.text.slice(to), false],
      ];
      for (const [text, hit] of pieces) {
        if (!text) continue;
        const marks = hit
          ? active
            ? [...run.marks.filter((value) => value !== mark), mark]
            : run.marks.filter((value) => value !== mark)
          : [...run.marks];
        out.push({ text, marks });
      }
    }
    this.blocks[selection.blockIndex]!.leaves[selection.leafIndex] = out;
  }

  snapshot(): Promise<EditorSnapshot> {
    this.snapshotCalls += 1;
    if (this.pending) {
      const size = Math.max(
        1,
        Math.ceil(this.pending.length / Math.max(this.lagChunks, 1)),
      );
      this.applyText(this.pending.slice(0, size));
      this.pending = this.pending.slice(size);
    }
    const blocks = this.blocks.map((block) => ({
      kind: block.kind as EditorBlockKind,
      leaves: block.leaves.map((runs) => ({
        text: runs.map((run) => run.text).join(''),
        runs: runs.map((run) => ({ text: run.text, marks: [...run.marks] })),
        unsupported: false,
      })),
    }));
    const caret = this.nodeSelection
      ? { ...this.nodeSelection, offset: 0 }
      : {
          blockIndex: this.caret.blockIndex,
          leafIndex: this.caret.leafIndex,
          offset: this.text(this.caret.blockIndex, this.caret.leafIndex).length,
        };
    const selection = this.nodeSelection
      ? {
          collapsed: false,
          text: '',
          blockIndex: this.nodeSelection.blockIndex,
          leafIndex: this.nodeSelection.leafIndex,
        }
      : this.selection
        ? {
            collapsed: this.selection.start === this.selection.end,
            text: this.text(
              this.selection.blockIndex,
              this.selection.leafIndex,
            ).slice(this.selection.start, this.selection.end),
            blockIndex: this.selection.blockIndex,
            leafIndex: this.selection.leafIndex,
          }
        : null;
    return Promise.resolve({ blocks, caret, selection, tools: this.tools() });
  }

  private tools(): Partial<Record<EditorTool, EditorToolState>> {
    const block = this.blocks[this.caret.blockIndex]!;
    const empty = this.text(this.caret.blockIndex, this.caret.leafIndex) === '';
    const selected =
      !!this.selection && this.selection.start !== this.selection.end;
    const state: Partial<Record<EditorTool, EditorToolState>> = {
      header: { active: block.kind === 'heading', disabled: false },
      bullet_list: { active: block.kind === 'bullet_list', disabled: false },
      ordered_list: { active: block.kind === 'ordered_list', disabled: false },
      block_quote: { active: block.kind === 'blockquote', disabled: false },
      format_clear: {
        active: false,
        disabled:
          !selected || !this.selection || !this.hasMarks(this.selection),
      },
    };
    for (const mark of markOrder)
      state[mark] = {
        active:
          selected && this.selection
            ? this.hasMark(this.selection, mark)
            : this.stored.has(mark),
        disabled: (empty && mark !== 'italic') || this.staleDisabled.has(mark),
      };
    return state;
  }

  focusState(): Promise<EditorFocus> {
    this.focusChecks += 1;
    const value = this.focusQueue.length ? this.focusQueue.shift()! : true;
    return Promise.resolve({
      activeIsEditor: value,
      selectionInEditor: value,
    });
  }

  readTool(tool: EditorTool): Promise<EditorToolState> {
    const state = this.tools()[tool];
    if (!state) return Promise.reject(new Error('missing tool ' + tool));
    return Promise.resolve({ ...state });
  }

  clickTool(tool: EditorTool): Promise<void> {
    this.toolClicks.push(tool);
    if (tool === 'bold' || tool === 'italic' || tool === 'underline') {
      if (this.ignoreMarkClick.has(tool)) return Promise.resolve();
      if (this.selection && this.selection.start !== this.selection.end) {
        this.applyMark(
          this.selection,
          tool,
          !this.hasMark(this.selection, tool),
        );
      } else if (this.stored.has(tool)) this.stored.delete(tool);
      else this.stored.add(tool);
      return Promise.resolve();
    }
    if (tool === 'format_clear') {
      if (this.selection)
        for (const mark of markOrder)
          this.applyMark(this.selection, mark, false);
      return Promise.resolve();
    }
    if (this.ignoreBlockToggle) return Promise.resolve();
    const kind: Kind =
      tool === 'header'
        ? 'heading'
        : tool === 'bullet_list'
          ? 'bullet_list'
          : tool === 'ordered_list'
            ? 'ordered_list'
            : 'blockquote';
    this.blocks[this.caret.blockIndex] = { kind, leaves: [[]] };
    this.caret = { blockIndex: this.caret.blockIndex, leafIndex: 0 };
    this.ensureTrailing();
    return Promise.resolve();
  }

  clickBlockEdge(blockIndex: number, leafIndex: number): Promise<void> {
    this.clickEdges += 1;
    this.caret = { blockIndex, leafIndex };
    this.selection = null;
    this.nodeSelection = null;
    return Promise.resolve();
  }

  placeCaret(): Promise<void> {
    this.placeCarets += 1;
    return Promise.resolve();
  }

  insertText(text: string): Promise<void> {
    this.insertCalls.push(text);
    if (this.dropTyping) return Promise.resolve();
    if (this.lagChunks > 0) {
      this.pending += text;
      return Promise.resolve();
    }
    this.applyText(text);
    return Promise.resolve();
  }

  private applyText(text: string): void {
    const runs = this.runs(this.caret.blockIndex, this.caret.leafIndex);
    const marks = markOrder.filter((mark) => this.stored.has(mark));
    const last = runs.at(-1);
    if (
      last &&
      last.marks.length === marks.length &&
      last.marks.every((mark, index) => mark === marks[index])
    )
      last.text += text;
    else runs.push({ text, marks });
    if (this.automaticTail) this.ensureTrailing();
  }

  press(key: EditorKey): Promise<void> {
    if (key === 'Enter') {
      const block = this.blocks[this.caret.blockIndex]!;
      if (
        block.kind === 'bullet_list' ||
        block.kind === 'ordered_list' ||
        block.kind === 'blockquote'
      ) {
        const container = this.caret.blockIndex;
        block.leaves.push([]);
        this.caret =
          this.loseCaretOnLeafCreate && this.blocks[container + 1]
            ? { blockIndex: container + 1, leafIndex: 0 }
            : { blockIndex: container, leafIndex: block.leaves.length - 1 };
        return Promise.resolve();
      }
      this.blocks.splice(this.caret.blockIndex + 1, 0, {
        kind: 'paragraph',
        leaves: [[]],
      });
      this.caret = { blockIndex: this.caret.blockIndex + 1, leafIndex: 0 };
      this.ensureTrailing();
      return Promise.resolve();
    }
    if (key === 'ArrowDown' && !this.ignoreArrowDown) {
      if (this.caret.blockIndex + 1 < this.blocks.length)
        this.caret = { blockIndex: this.caret.blockIndex + 1, leafIndex: 0 };
    }
    return Promise.resolve();
  }

  softBreak(): Promise<void> {
    this.softBreaks += 1;
    const runs = this.runs(this.caret.blockIndex, this.caret.leafIndex);
    runs.push({ text: '\n', marks: [...this.stored] });
    return Promise.resolve();
  }

  selectLeafRange(
    blockIndex: number,
    leafIndex: number,
    start: number,
    end: number,
  ): Promise<void> {
    this.selection = { blockIndex, leafIndex, start, end };
    this.caret = { blockIndex, leafIndex };
    return Promise.resolve();
  }

  collapseToEnd(): Promise<void> {
    this.selection = null;
    return Promise.resolve();
  }

  closeToolPopups(): Promise<void> {
    this.popupCloses += 1;
    return Promise.resolve();
  }
}

it('inserts each multiline source segment once and preserves soft breaks', async () => {
  const editor = new FakeEditor();
  const port = createRichTextDomPort(editor, { sleep: async () => {} });
  await appendRichTextBlock(
    port,
    {
      type: 'paragraph',
      content: [{ type: 'text', text: '第一行\n第二行\n末行', marks: [] }],
    },
    () => false,
  );
  expect(editor.insertCalls).toEqual(['第一行', '第二行', '末行']);
  expect(editor.softBreaks).toBe(2);
  expect(editor.blocks[0]!.leaves[0]!.map((run) => run.text).join('')).toBe(
    '第一行\n第二行\n末行',
  );
  expect(
    editor.blocks[0]!.leaves[0]!.every((run) => run.marks.length === 0),
  ).toBe(true);
});

it('rich operation diagnostics never print source body or selected text', async () => {
  const previous = process.env.JUDONGCHE_DIAG;
  process.env.JUDONGCHE_DIAG = '1';
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await appendRichTextBlock(
      makePort(new FakeEditor()),
      paragraph('PRIVATE_BODY_SENTINEL'),
      () => false,
    );
    expect(
      output.mock.calls.map((call) => call.join(' ')).join('\n'),
    ).not.toContain('PRIVATE_BODY_SENTINEL');
  } finally {
    if (previous === undefined) delete process.env.JUDONGCHE_DIAG;
    else process.env.JUDONGCHE_DIAG = previous;
    output.mockRestore();
  }
});

function makePort(editor: FakeEditor, stagedWriting = false) {
  return createRichTextDomPort(editor, {
    stagedWriting,
    focusAttempts: 3,
    settleAttempts: 3,
    settleDelayMs: 0,
    sleep: async () => {},
  });
}

function bodyOf(editor: FakeEditor) {
  const blocks = editor.blocks.map((block) => ({
    kind: block.kind,
    leaves: block.leaves.map((runs) =>
      runs.map((run) => ({ text: run.text, marks: [...run.marks].sort() })),
    ),
  }));
  while (
    blocks.length &&
    blocks.at(-1)!.kind === 'paragraph' &&
    blocks.at(-1)!.leaves.length === 1 &&
    blocks.at(-1)!.leaves[0]!.length === 0
  )
    blocks.pop();
  return blocks;
}

const paragraph = (text: string, marks: TextMark[] = []): RichParagraph => ({
  type: 'paragraph',
  content: [{ type: 'text', text, marks }],
});

const sample: RichTextBlock[] = [
  paragraph('段一'),
  {
    type: 'list',
    kind: 'bullet',
    items: [paragraph('项目一'), paragraph('项目二')],
  },
  paragraph('段二'),
  {
    type: 'list',
    kind: 'ordered',
    start: 1,
    items: [paragraph('有序一'), paragraph('有序二')],
  },
  {
    type: 'blockquote',
    paragraphs: [paragraph('引用一'), paragraph('引用二')],
  },
  paragraph('段三'),
  { type: 'heading', content: [{ type: 'text', text: '标题一', marks: [] }] },
  paragraph('段四'),
];

const expectedSample = [
  { kind: 'paragraph', leaves: [[{ text: '段一', marks: [] }]] },
  {
    kind: 'bullet_list',
    leaves: [[{ text: '项目一', marks: [] }], [{ text: '项目二', marks: [] }]],
  },
  { kind: 'paragraph', leaves: [[{ text: '段二', marks: [] }]] },
  {
    kind: 'ordered_list',
    leaves: [[{ text: '有序一', marks: [] }], [{ text: '有序二', marks: [] }]],
  },
  {
    kind: 'blockquote',
    leaves: [[{ text: '引用一', marks: [] }], [{ text: '引用二', marks: [] }]],
  },
  { kind: 'paragraph', leaves: [[{ text: '段三', marks: [] }]] },
  { kind: 'heading', leaves: [[{ text: '标题一', marks: [] }]] },
  { kind: 'paragraph', leaves: [[{ text: '段四', marks: [] }]] },
];

describe('production rich text DOM port', () => {
  for (const window of [
    'deferred-read',
    'deferred-collapse',
    'toggle-retry',
    'disabled-retry',
  ] as const)
    it(`R1 stop at ${window} prevents every later DOM action`, async () => {
      const editor = new FakeEditor();
      let stopped = false;
      const late: string[] = [];
      const click = editor.clickTool.bind(editor);
      editor.clickTool = async (tool) => {
        if (stopped) late.push('click');
        await click(tool);
      };
      const collapse = editor.collapseToEnd.bind(editor);
      editor.collapseToEnd = async () => {
        if (stopped) late.push('collapse');
        await collapse();
      };
      if (window === 'disabled-retry') {
        await makePort(editor).typeText('prefix');
        editor.staleDisabled.add('bold');
        editor.ignoreMarkClick.add('bold');
      }
      if (window === 'toggle-retry') editor.ignoreMarkClick.add('italic');
      const read = editor.readTool.bind(editor);
      editor.readTool = async (tool) => {
        const state = await read(tool);
        if (
          (window === 'deferred-read' && editor.selection && tool === 'bold') ||
          (window === 'deferred-collapse' &&
            editor.selection &&
            tool === 'bold' &&
            state.active) ||
          ((window === 'toggle-retry' || window === 'disabled-retry') &&
            editor.toolClicks.length)
        )
          stopped = true;
        return state;
      };
      const port = createRichTextDomPort(editor, {
        sleep: async () => {},
        stopped: () => stopped,
        ...(window.endsWith('retry') ? { settleAttempts: 0 } : {}),
      });
      if (window.startsWith('deferred')) {
        await port.setMark('bold', true);
        await expect(port.typeText('text')).rejects.toMatchObject({
          reason: 'STOP_REQUESTED',
        });
      } else
        await expect(
          port.setMark(window === 'toggle-retry' ? 'italic' : 'bold', true),
        ).rejects.toMatchObject({ reason: 'STOP_REQUESTED' });
      expect(late).toEqual([]);
    });
  for (const automaticTail of [true, false])
    it(`writing permits current-block normalization on exit, automatic tail=${automaticTail}`, async () => {
      const editor = new FakeEditor();
      editor.automaticTail = automaticTail;
      if (automaticTail) {
        const click = editor.clickBlockEdge.bind(editor);
        editor.clickBlockEdge = async (block, leaf) => {
          await click(block, leaf);
          if (block === 1) editor.blocks[0]!.leaves[0]![0]!.text = 'changed';
        };
      } else {
        const press = editor.press.bind(editor);
        editor.press = async (key) => {
          await press(key);
          if (key === 'Enter')
            editor.blocks[0]!.leaves[0]![0]!.text = 'changed';
        };
      }
      await appendRichTextBlock(
        makePort(editor, true),
        paragraph('current'),
        () => false,
      );
      expect(editor.blocks[0]!.leaves[0]![0]!.text).toBe('changed');
    });

  for (const phase of [
    'select-block',
    'existing-tail-exit',
    'new-tail-exit',
  ] as const)
    for (const staged of [true, false])
      it(`${phase} staged=${staged} permits previous-block normalization`, async () => {
        const editor = new FakeEditor();
        await appendRichTextBlock(
          makePort(editor, staged),
          paragraph('前文'),
          () => false,
        );
        const drift = () => {
          editor.blocks[0]!.leaves[0]![0]!.text = '前文被修改';
        };
        if (phase === 'select-block') {
          const click = editor.clickTool.bind(editor);
          editor.clickTool = async (tool) => {
            await click(tool);
            if (tool === 'header') drift();
          };
        } else if (phase === 'existing-tail-exit') {
          const click = editor.clickBlockEdge.bind(editor);
          editor.clickBlockEdge = async (block, leaf) => {
            await click(block, leaf);
            if (block === 2) drift();
          };
        } else {
          editor.automaticTail = false;
          const press = editor.press.bind(editor);
          editor.press = async (key) => {
            await press(key);
            if (key === 'Enter') drift();
          };
        }
        const writing = appendRichTextBlock(
          makePort(editor, staged),
          {
            ...paragraph('后文'),
            type: phase === 'select-block' ? 'heading' : 'paragraph',
          },
          () => false,
        );
        await writing;
        expect(editor.blocks[0]!.leaves[0]![0]!.text).toBe('前文被修改');
        expect(editor.blocks[1]!.leaves[0]![0]!.text).toBe('后文');
      });

  for (const type of ['paragraph', 'heading'] as const)
    for (const automaticTail of [true, false])
      it(`leaves one insertion tail after a ${type}, automatic tail=${automaticTail}`, async () => {
        const editor = new FakeEditor();
        editor.automaticTail = automaticTail;
        const text = '正文'.repeat(129) + '末';
        await appendRichTextBlock(
          makePort(editor),
          { type, content: [{ type: 'text', text, marks: [] }] },
          () => false,
        );
        expect(editor.blocks).toEqual([
          { kind: type, leaves: [[{ text, marks: [] }]] },
          { kind: 'paragraph', leaves: [[]] },
        ]);
      });

  it('preserves an explicit empty source paragraph between text blocks', async () => {
    const editor = new FakeEditor();
    for (const block of [
      paragraph('前文'),
      { type: 'paragraph', content: [] } as RichParagraph,
      paragraph('后文'),
    ])
      await appendRichTextBlock(makePort(editor), block, () => false);
    expect(editor.blocks).toEqual([
      { kind: 'paragraph', leaves: [[{ text: '前文', marks: [] }]] },
      { kind: 'paragraph', leaves: [[]] },
      { kind: 'paragraph', leaves: [[{ text: '后文', marks: [] }]] },
      { kind: 'paragraph', leaves: [[]] },
    ]);
  });

  it('does not delete or merge multiple existing empty tail paragraphs', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.typeText('前文');
    editor.blocks.push({ kind: 'paragraph', leaves: [[]] });
    await port.exitBlock();
    expect(editor.blocks).toHaveLength(3);
    expect(editor.caret).toEqual({ blockIndex: 1, leafIndex: 0 });
  });

  it('refuses nonempty content after the paragraph instead of reusing it as a tail', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.typeText('前文');
    editor.blocks[1] = {
      kind: 'paragraph',
      leaves: [[{ text: 'unexpected', marks: [] }]],
    };
    await expect(port.exitBlock()).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'unexpected-trailing-block',
    });
  });

  it('refuses unrecognized inline content in an otherwise empty tail', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.typeText('前文');
    const snapshot = editor.snapshot.bind(editor);
    editor.snapshot = async () => {
      const value = await snapshot();
      value.blocks[1]!.leaves[0]!.unsupported = true;
      return value;
    };
    await expect(port.exitBlock()).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'unsupported-inline-content',
    });
  });

  it('builds the verified eight-block sample and keeps one empty tail', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    for (const block of sample)
      await appendRichTextBlock(port, block, () => false);
    expect(bodyOf(editor)).toEqual(expectedSample);
    expect(editor.blocks.at(-1)).toEqual({
      kind: 'paragraph',
      leaves: [[]],
    });
    expect(editor.blocks).toHaveLength(sample.length + 1);
    expect(editor.stored.size).toBe(0);
  });

  it('applies a stored mark to exactly the typed range', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await appendRichTextBlock(
      port,
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '甲乙', marks: [] },
          { type: 'text', text: '丙丁', marks: ['bold'] },
          { type: 'text', text: '戊己', marks: [] },
        ],
      },
      () => false,
    );
    expect(editor.blocks[0]).toEqual({
      kind: 'paragraph',
      leaves: [
        [
          { text: '甲乙', marks: [] },
          { text: '丙丁', marks: ['bold'] },
          { text: '戊己', marks: [] },
        ],
      ],
    });
    expect(editor.stored.size).toBe(0);
  });

  it('defers a mark the platform disables on an empty paragraph', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await appendRichTextBlock(
      port,
      paragraph('甲乙', ['underline']),
      () => false,
    );
    expect(editor.blocks[0]!.leaves[0]).toEqual([
      { text: '甲乙', marks: ['underline'] },
    ]);
    expect(editor.selection).toBeNull();
  });

  it('recovers a stolen focus by re-seating the caret', async () => {
    const editor = new FakeEditor();
    editor.focusQueue = [false, true];
    const port = makePort(editor);
    await port.guard();
    expect(editor.clickEdges).toBe(1);
    expect(editor.focusChecks).toBe(2);
    expect(editor.placeCarets).toBe(1);
  });

  it('fails closed when focus cannot be recovered', async () => {
    const editor = new FakeEditor();
    editor.focusQueue = [false, false, false];
    const port = makePort(editor);
    await expect(port.guard()).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'editor-focus-lost',
    });
    expect(editor.clickEdges).toBe(3);
  });

  it('refuses an ordered list start other than one', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await expect(port.selectBlock('ordered_list', 3)).rejects.toBeInstanceOf(
      JudongchePageError,
    );
    await expect(port.selectBlock('ordered_list', 3)).rejects.toMatchObject({
      reason: 'FORMAT_UNSUPPORTED',
    });
    expect(editor.toolClicks).toEqual([]);
  });

  it('fails closed when a block toggle is ignored', async () => {
    const editor = new FakeEditor();
    editor.ignoreBlockToggle = true;
    const port = makePort(editor);
    await expect(port.selectBlock('bullet_list')).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'block-toggle-not-applied',
    });
    expect(editor.toolClicks.filter((tool) => tool === 'bullet_list')).toEqual([
      'bullet_list',
      'bullet_list',
    ]);
  });

  it('fails closed when a list exit does not leave the list', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.selectBlock('bullet_list');
    await port.typeText('一');
    editor.ignoreArrowDown = true;
    await expect(port.exitBlock()).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'container-exit-failed',
    });
    expect(editor.blocks[0]!.kind).toBe('bullet_list');
  });

  it('exits a list with End+ArrowDown without touching it', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.selectBlock('bullet_list');
    await port.typeText('一');
    const list = editor.blocks[0];
    await port.exitBlock();
    expect(editor.blocks[0]).toEqual(list);
    expect(editor.caret).toEqual({ blockIndex: 1, leafIndex: 0 });
    expect(editor.blocks[1]).toEqual({ kind: 'paragraph', leaves: [[]] });
  });

  it('exits a heading into a new empty paragraph', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.selectBlock('heading');
    await port.typeText('标题');
    await port.exitBlock();
    expect(editor.blocks[0]).toEqual({
      kind: 'heading',
      leaves: [[{ text: '标题', marks: [] }]],
    });
    expect(editor.caret).toEqual({ blockIndex: 1, leafIndex: 0 });
    expect(editor.blocks[1]).toEqual({ kind: 'paragraph', leaves: [[]] });
  });

  it('fails closed on an unexpected block after the caret', async () => {
    const editor = new FakeEditor();
    editor.blocks = [
      { kind: 'paragraph', leaves: [[]] },
      { kind: 'paragraph', leaves: [[{ text: '正文', marks: [] }]] },
    ];
    editor.caret = { blockIndex: 0, leafIndex: 0 };
    const port = makePort(editor);
    await expect(port.selectBlock('bullet_list')).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'unexpected-trailing-block',
    });
  });

  it('records a soft break without splitting the leaf', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.typeText('第一行');
    await port.softBreak();
    await port.typeText('第二行');
    const runs = editor.blocks[0]!.leaves[0]!;
    expect(editor.blocks[0]!.leaves.length).toBe(1);
    expect(runs.map((run) => run.text).join('')).toBe('第一行\n第二行');
    expect(runs.every((run) => run.marks.length === 0)).toBe(true);
    expect(editor.softBreaks).toBe(1);
  });

  it('collapses a node selection before it types', async () => {
    const editor = new FakeEditor();
    editor.nodeSelection = { blockIndex: 0, leafIndex: 0 };
    const port = makePort(editor);
    await port.typeText('甲');
    expect(editor.blocks[0]!.leaves[0]!.map((run) => run.text).join('')).toBe(
      '甲',
    );
    expect(editor.nodeSelection).toBeNull();
    expect(editor.clickEdges).toBe(1);
  });

  it('refuses a text range where a stored mark is expected', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.typeText('甲乙');
    editor.selection = { blockIndex: 0, leafIndex: 0, start: 0, end: 2 };
    await expect(port.setMark('bold', true)).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'set-mark-requires-collapsed-caret',
    });
  });

  it('applies a mark the toolbar reported disabled', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.typeText('甲乙');
    editor.staleDisabled.add('bold');
    await port.setMark('bold', true);
    await port.typeText('丙丁');
    await port.setMark('bold', false);
    await port.typeText('戊己');
    expect(bodyOf(editor)).toEqual([
      {
        kind: 'paragraph',
        leaves: [
          [
            { text: '甲乙', marks: [] },
            { text: '丙丁', marks: ['bold'] },
            { text: '戊己', marks: [] },
          ],
        ],
      },
    ]);
    expect(editor.toolClicks.filter((tool) => tool === 'bold')).toHaveLength(2);
  });

  it('reseats the caret when a new leaf lands but the selection moves away', async () => {
    const editor = new FakeEditor();
    editor.loseCaretOnLeafCreate = true;
    const port = makePort(editor);
    await appendRichTextBlock(
      port,
      {
        type: 'list',
        kind: 'bullet',
        items: [paragraph('项目一'), paragraph('项目二')],
      },
      () => false,
    );
    expect(editor.blocks[0]).toEqual({
      kind: 'bullet_list',
      leaves: [
        [{ text: '项目一', marks: [] }],
        [{ text: '项目二', marks: [] }],
      ],
    });
    expect(editor.clickEdges).toBeGreaterThan(0);
  });

  it('waits for an insert the platform applies late instead of retyping it', async () => {
    const editor = new FakeEditor();
    editor.lagChunks = 4;
    const port = makePort(editor);
    const text = '甲'.repeat(160);
    await port.typeText(text);
    expect(editor.blocks[0]!.leaves[0]!.map((run) => run.text).join('')).toBe(
      text,
    );
  });

  it('inserts a whole paragraph in one call instead of key by key', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    const text = '甲'.repeat(300);
    await port.typeText(text);
    expect(editor.insertCalls).toEqual([text]);
    expect(editor.blocks[0]!.leaves[0]!.map((run) => run.text).join('')).toBe(
      text,
    );
  });

  it('fails closed when the inserted text never reaches the editor', async () => {
    const editor = new FakeEditor();
    editor.dropTyping = true;
    const port = makePort(editor);
    await expect(port.typeText('甲'.repeat(10_000))).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
      check: 'typed-text-not-applied',
    });
    expect(editor.snapshotCalls).toBeLessThan(60);
  });

  for (const drop of [true, false])
    it(`uses the reseated offset for deferred marks when input is ${drop ? 'dropped' : 'applied'}`, async () => {
      const editor = new FakeEditor();
      const port = makePort(editor);
      await port.setMark('bold', true);
      // Platform content appeared after the empty-leaf toolbar deferred bold.
      editor.blocks[0]!.leaves[0] = [{ text: 'Alpha', marks: [] }];
      const middle = await editor.snapshot();
      middle.caret!.offset = 1;
      vi.spyOn(editor, 'snapshot').mockResolvedValueOnce(middle);
      const ranges = vi.spyOn(editor, 'selectLeafRange');
      const exit = vi.spyOn(port, 'exitBlock');
      editor.dropTyping = drop;
      const action = async () => {
        await port.typeText('Beta');
        if (drop) await port.exitBlock();
      };
      if (drop)
        await expect(action()).rejects.toMatchObject({
          reason: 'PAGE_CHANGED',
          check: 'typed-text-not-applied',
        });
      else await action();
      expect(editor.insertCalls).toEqual(['Beta']);
      expect(editor.clickEdges).toBe(1);
      expect(exit).not.toHaveBeenCalled();
      if (drop) {
        expect(ranges).not.toHaveBeenCalled();
        expect(editor.blocks[0]!.leaves[0]).toEqual([
          { text: 'Alpha', marks: [] },
        ]);
      } else {
        expect(ranges.mock.calls).toEqual([[0, 0, 5, 9]]);
        expect(editor.blocks[0]!.leaves[0]).toEqual([
          { text: 'Alpha', marks: [] },
          { text: 'Beta', marks: ['bold'] },
        ]);
      }
    });

  it('reports a flagged mark that never lands as unsupported', async () => {
    const editor = new FakeEditor();
    const port = makePort(editor);
    await port.typeText('甲乙');
    editor.staleDisabled.add('bold');
    editor.ignoreMarkClick.add('bold');
    await expect(port.setMark('bold', true)).rejects.toMatchObject({
      reason: 'FORMAT_UNSUPPORTED',
      check: 'mark-bold-unavailable',
    });
    expect(editor.insertCalls).toEqual(['甲乙']);
  });
});
