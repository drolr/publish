import { clickEditorLeafEnd } from './production-editor-position';
import type { Page, JSHandle } from 'playwright-core';
import type { TextMark } from '../../../contracts/rich-text-body';
import type { RichTextUiPort } from './production-rich-text';
import {
  JudongchePageError,
  type BlockEdgeCallsite,
  type BlockEdgeDiagnostic,
} from './production-state';

type ReasonCode = JudongchePageError['reason'];

/** production-state's fail is a const arrow, so TypeScript does not treat a
 * call as never-returning; this declaration restores control-flow narrowing. */
function halt(reason: ReasonCode, check: string): never {
  if (process.env.JUDONGCHE_DIAG)
    console.error('[jdc-dom] halt ' + reason + ' ' + check);
  throw new JudongchePageError(reason, check);
}

/** The publish editor's supported block vocabulary. 'unsupported' is a
 * fail-closed marker: the port never rewrites content it cannot classify. */
export type EditorBlockKind =
  | 'paragraph'
  | 'heading'
  | 'bullet_list'
  | 'ordered_list'
  | 'blockquote'
  | 'unsupported';

/** Allowlisted toolbar buttons (div.syl-toolbar-tool.<name>). */
export type EditorTool =
  | 'header'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'block_quote'
  | 'bullet_list'
  | 'ordered_list'
  | 'format_clear';

export type EditorKey =
  'Enter' | 'ArrowDown' | 'ArrowRight' | 'End' | 'Home' | 'Escape';

export interface EditorRun {
  text: string;
  marks: TextMark[];
}
export interface EditorLeaf {
  key?: string;
  text: string;
  runs: EditorRun[];
  /** Inline content the writer cannot prove (links, images, nested lists). */
  unsupported: boolean;
}
export interface EditorBlock {
  key?: string;
  kind: EditorBlockKind;
  leaves: EditorLeaf[];
}
export interface EditorCaret {
  blockIndex: number;
  leafIndex: number;
  /** Code-unit offset inside the leaf's normalized text. */
  offset: number;
}
export interface EditorSelection {
  collapsed: boolean;
  text: string;
  blockIndex: number;
  leafIndex: number;
}
export interface EditorToolState {
  active: boolean;
  disabled: boolean;
}
export interface EditorSnapshot {
  inputRevision?: number;
  blocks: EditorBlock[];
  caret: EditorCaret | null;
  selection: EditorSelection | null;
  tools: Partial<Record<EditorTool, EditorToolState>>;
}
export interface EditorFocus {
  activeIsEditor: boolean;
  selectionInEditor: boolean;
}

/** Narrow, page-facing contract. The append state machine depends on nothing
 * else, so unit tests drive it with a fake DOM instead of Playwright. */
export interface EditorDom {
  dispose?(): Promise<void>;
  /** Structural read of the publish editor; never derived from toolbar flags. */
  snapshot(): Promise<EditorSnapshot>;
  /** activeElement === .publish-editor .ProseMirror and the selection inside it. */
  focusState(): Promise<EditorFocus>;
  readTool(tool: EditorTool): Promise<EditorToolState>;
  clickTool(tool: EditorTool): Promise<void>;
  /** Hit-tested actionable click on the final visual line of one block/leaf. */
  clickBlockEdge(
    blockIndex: number,
    leafIndex: number,
    context?: { callsite: BlockEdgeCallsite },
  ): Promise<void>;
  /** Keyboard caret at the current line's start/end inside the seated block. */
  placeCaret(edge: 'start' | 'end'): Promise<void>;
  /** Insert the whole run in one native text-insert call (no per-key typing). */
  insertText(text: string): Promise<void>;
  press(key: EditorKey): Promise<void>;
  softBreak(): Promise<void>;
  /** Native selection over [start, end) of a leaf's normalized text. */
  selectLeafRange(
    blockIndex: number,
    leafIndex: number,
    start: number,
    end: number,
  ): Promise<void>;
  collapseToEnd(): Promise<void>;
  closeToolPopups(): Promise<void>;
}

export interface RichTextDomPortOptions {
  /** Historical option; normal writes always use local operation ownership. */
  stagedWriting?: boolean;
  stopped?: () => boolean;
  /** Focus recovery re-seats before failing closed (spike q3d: three retries). */
  focusAttempts?: number;
  settleAttempts?: number;
  settleDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const marks: TextMark[] = ['bold', 'italic', 'underline'];
const popupTools: EditorTool[] = ['header', 'block_quote'];

function toolFor(kind: EditorBlockKind): EditorTool {
  switch (kind) {
    case 'heading':
      return 'header';
    case 'bullet_list':
      return 'bullet_list';
    case 'ordered_list':
      return 'ordered_list';
    case 'blockquote':
      return 'block_quote';
    default:
      halt('PAGE_CHANGED', 'tool-for-kind');
  }
}

/** The whole run is inserted in one native call, so the read-back budget only
 * absorbs the platform's render latency; it must not scale with keystroke delay. */
const INSERT_SETTLE_MS_PER_CHAR = 4;
const MAX_INSERT_SETTLE_ATTEMPTS = 40;
/** Structural edits wait on the platform's own re-render, which is slower than
 * a keystroke read-back and occasionally exceeds the default settle window. */
const STRUCTURAL_SETTLE_ATTEMPTS = 25;

function diag(label: string, payload: unknown): void {
  if (process.env.JUDONGCHE_DIAG)
    console.error('[jdc-dom] ' + label + ' ' + JSON.stringify(payload));
}

/** A one-shot insert can land asynchronously, so read-back must allow render
 * latency while staying within a fixed upper bound. */
function settleAttemptsForInsert(
  length: number,
  attempts: number,
  delayMs: number,
): number {
  return Math.min(
    Math.ceil((length * INSERT_SETTLE_MS_PER_CHAR) / Math.max(delayMs, 1)) +
      attempts,
    MAX_INSERT_SETTLE_ATTEMPTS,
  );
}

/** Production RichTextUiPort over a narrow EditorDom. Every write is followed
 * by a read-back assertion; a mismatch fails closed instead of degrading. */
export function createRichTextDomPort(
  dom: EditorDom,
  options: RichTextDomPortOptions = {},
): RichTextUiPort {
  function checkStop() {
    if (options.stopped?.()) halt('STOP_REQUESTED', 'rich-write-stopped');
  }
  async function withStop<T>(work: () => Promise<T>): Promise<T> {
    checkStop();
    const value = await work();
    checkStop();
    return value;
  }
  const focusAttempts = options.focusAttempts ?? 3;
  const settleAttempts = options.settleAttempts ?? 8;
  const settleDelayMs = options.settleDelayMs ?? 120;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  let blockIndex = 0;
  let leafIndex = 0;
  const stored = new Set<TextMark>();
  let deferred: TextMark[] = [];
  const unverified = new Set<TextMark>();

  function adopt(snapshot: EditorSnapshot): EditorSnapshot {
    if (snapshot.caret) {
      blockIndex = snapshot.caret.blockIndex;
      leafIndex = snapshot.caret.leafIndex;
    }
    return snapshot;
  }

  function blockAt(snapshot: EditorSnapshot, index: number): EditorBlock {
    const block = snapshot.blocks[index];
    if (!block) halt('PAGE_CHANGED', 'block-missing');
    return block;
  }

  function leafAt(
    snapshot: EditorSnapshot,
    block: number,
    leaf: number,
  ): EditorLeaf {
    const value = blockAt(snapshot, block).leaves[leaf];
    if (!value) halt('PAGE_CHANGED', 'leaf-missing');
    if (value.unsupported) halt('PAGE_CHANGED', 'unsupported-inline-content');
    return value;
  }

  function blockText(block: EditorBlock): string {
    return block.leaves.map((leaf) => leaf.text).join('\n');
  }

  /** Everything after the caret block must be the trailing empty paragraph(s)
   * the platform keeps at the document tail; anything else fails closed. */
  function requireTrailingParagraphs(
    snapshot: EditorSnapshot,
    from: number,
  ): void {
    for (let index = from; index < snapshot.blocks.length; index += 1) {
      const block = blockAt(snapshot, index);
      if (
        block.kind !== 'paragraph' ||
        block.leaves.length !== 1 ||
        leafAt(snapshot, index, 0).text !== ''
      )
        halt('PAGE_CHANGED', 'unexpected-trailing-block');
    }
  }

  function requireOwnedCurrentBlock(
    before: EditorSnapshot,
    after: EditorSnapshot,
    index: number,
  ): void {
    const previous = blockAt(before, index);
    const current = blockAt(after, index);
    if (previous.key !== current.key)
      halt('PAGE_CHANGED', 'current-block-replaced');
  }

  /** ProseMirror can add or drop trailing paragraphs while a container grows,
   * so a grown container is located by kind and preserved leaves instead of the
   * block index captured before Enter. */
  function grownLeafIndex(
    snapshot: EditorSnapshot,
    kind: EditorBlockKind,
    previous: EditorBlock,
    caretBlock?: number,
  ): number {
    const matches = snapshot.blocks
      .map((block, index) => ({ block, index }))
      .filter(
        ({ block }) =>
          block.kind === kind &&
          block.key === previous.key &&
          block.leaves.length === previous.leaves.length + 1,
      )
      .map(({ index }) => index);
    if (caretBlock !== undefined && matches.includes(caretBlock))
      return caretBlock;
    return matches.length === 1 ? matches[0]! : -1;
  }

  async function settle<T>(
    readValue: () => Promise<T>,
    accept: (value: T) => boolean,
    attempts = settleAttempts,
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (options.stopped?.()) halt('STOP_REQUESTED', 'rich-write-stopped');
      const value = await readValue();
      checkStop();
      if (accept(value)) return value;
      if (attempt < attempts) await sleep(settleDelayMs);
    }
    return null;
  }

  async function guard(): Promise<void> {
    if (options.stopped?.()) halt('STOP_REQUESTED', 'rich-write-stopped');
    for (let attempt = 0; attempt < focusAttempts; attempt++) {
      const focus = await withStop(() => dom.focusState());
      if (focus.activeIsEditor && focus.selectionInEditor) return;
      if (process.env.JUDONGCHE_DIAG)
        console.error(
          '[jdc-dom] focus-recovery ' +
            JSON.stringify({ attempt, blockIndex, leafIndex, focus }),
        );
      try {
        await withStop(() =>
          dom.clickBlockEdge(blockIndex, leafIndex, {
            callsite: 'focus-recovery',
          }),
        );
        await withStop(() => dom.placeCaret('end'));
      } catch (error) {
        if (error instanceof JudongchePageError) throw error;
        halt('PAGE_CHANGED', 'focus-recovery-failed');
      }
    }
    halt('PAGE_CHANGED', 'editor-focus-lost');
  }

  /**
   * A node selection (the whole block selected) is how the platform reports
   * "this block is selected": it is an empty, non-collapsed selection. It is
   * not a caret, so the stored-mark and typing paths must collapse it first.
   */
  function nodeSelected(snapshot: EditorSnapshot): boolean {
    const selection = snapshot.selection;
    return selection !== null && !selection.collapsed && selection.text === '';
  }

  /** Guarded read; a missing caret or a node selection is re-seated once. */
  async function read(): Promise<EditorSnapshot> {
    await guard();
    let snapshot = adopt(await withStop(() => dom.snapshot()));
    if (!snapshot.caret || nodeSelected(snapshot)) {
      const target = Math.min(
        Math.max(blockIndex, 0),
        Math.max(snapshot.blocks.length - 1, 0),
      );
      await withStop(() =>
        dom.clickBlockEdge(target, 0, {
          callsite: nodeSelected(snapshot)
            ? 'block-selection'
            : 'missing-caret',
        }),
      );
      await withStop(() => dom.placeCaret('end'));
      snapshot = adopt(await withStop(() => dom.snapshot()));
      await guard();
      if (!snapshot.caret) halt('PAGE_CHANGED', 'caret-missing');
      if (nodeSelected(snapshot)) halt('PAGE_CHANGED', 'caret-not-collapsed');
    }
    return snapshot;
  }

  async function caretOf(snapshot: EditorSnapshot): Promise<EditorCaret> {
    if (!snapshot.caret) halt('PAGE_CHANGED', 'caret-missing');
    return snapshot.caret;
  }

  async function seatAtLeafEnd(
    block: number,
    leaf: number,
    snapshot: EditorSnapshot,
    callsite: BlockEdgeCallsite = 'seat-at-leaf-end',
  ): Promise<EditorSnapshot> {
    const caret = await caretOf(snapshot);
    const text = leafAt(snapshot, block, leaf).text;
    if (caret.blockIndex === block && caret.leafIndex === leaf) {
      if (caret.offset === text.length) return snapshot;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await withStop(() => dom.clickBlockEdge(block, leaf, { callsite }));
      await withStop(() => dom.placeCaret('end'));
      const seated = adopt(await withStop(() => dom.snapshot()));
      const next = seated.caret;
      if (
        next &&
        next.blockIndex === block &&
        next.leafIndex === leaf &&
        next.offset === leafAt(seated, block, leaf).text.length
      )
        return seated;
    }
    halt('PAGE_CHANGED', 'caret-not-at-leaf-end');
  }

  async function toggleTool(tool: EditorTool, active: boolean): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await withStop(() => dom.clickTool(tool));
      if (popupTools.includes(tool))
        await withStop(() => dom.closeToolPopups());
      const settled = await settle(
        () => dom.readTool(tool),
        (state) => state.active === active,
      );
      if (settled) return;
    }
    halt('PAGE_CHANGED', `tool-toggle-${tool}`);
  }

  function setStored(mark: TextMark, active: boolean): void {
    if (active) stored.add(mark);
    else {
      stored.delete(mark);
      unverified.delete(mark);
    }
    deferred = deferred.filter((value) => value !== mark);
  }

  async function applyDeferredMarks(
    block: number,
    leaf: number,
    start: number,
    end: number,
  ): Promise<void> {
    await guard();
    await withStop(() => dom.selectLeafRange(block, leaf, start, end));
    const selected = adopt(await withStop(() => dom.snapshot()));
    if (
      !selected.selection ||
      selected.selection.collapsed ||
      selected.selection.blockIndex !== block ||
      selected.selection.leafIndex !== leaf ||
      selected.selection.text.length !== end - start
    )
      halt('PAGE_CHANGED', 'mark-range-not-selected');
    for (const mark of deferred) {
      let state = await withStop(() => dom.readTool(mark));
      if (!state.active) {
        await withStop(() => dom.clickTool(mark));
        const settled = await settle(
          () => dom.readTool(mark),
          (value) => value.active,
        );
        if (!settled) halt('PAGE_CHANGED', `mark-${mark}-not-applied`);
        state = settled;
      }
      if (state.disabled) halt('PAGE_CHANGED', `mark-${mark}-disabled`);
    }
    await withStop(() => dom.collapseToEnd());
    const collapsed = adopt(await withStop(() => dom.snapshot()));
    const caret = await caretOf(collapsed);
    if (collapsed.selection && !collapsed.selection.collapsed)
      halt('PAGE_CHANGED', 'mark-selection-not-collapsed');
    if (caret.blockIndex !== block || caret.leafIndex !== leaf)
      halt('PAGE_CHANGED', 'caret-left-target-leaf');
  }

  async function selectBlock(
    kind:
      'paragraph' | 'heading' | 'ordered_list' | 'bullet_list' | 'blockquote',
    start?: number,
  ): Promise<void> {
    if (kind === 'ordered_list' && start !== undefined && start !== 1)
      halt('FORMAT_UNSUPPORTED', 'ordered-list-start');
    let snapshot = await read();
    let caret = await caretOf(snapshot);
    const moved =
      caret.blockIndex !== blockIndex ||
      caret.leafIndex !== leafIndex ||
      leafAt(snapshot, caret.blockIndex, caret.leafIndex).text !== '';
    if (moved) {
      // The platform restores a stale selection after block-level toolbar
      // actions, so the tracked empty paragraph may no longer hold the caret.
      // Re-seat onto it once; a failed re-seat still fails closed below.
      if (process.env.JUDONGCHE_DIAG)
        console.error(
          '[jdc-dom] select-block-reseat ' +
            JSON.stringify({
              kind,
              caret,
              tracked: { blockIndex, leafIndex },
              blocks: describe(snapshot),
            }),
        );
      try {
        await withStop(() =>
          dom.clickBlockEdge(blockIndex, leafIndex, {
            callsite: 'select-block-reseat',
          }),
        );
        await withStop(() => dom.placeCaret('end'));
      } catch (error) {
        if (error instanceof JudongchePageError) throw error;
      }
      snapshot = adopt(await withStop(() => dom.snapshot()));
      caret = await caretOf(snapshot);
    }
    const current = blockAt(snapshot, caret.blockIndex);
    if (kind === 'paragraph' && current.kind === 'paragraph') {
      if (leafAt(snapshot, caret.blockIndex, caret.leafIndex).text !== '')
        halt('PAGE_CHANGED', 'target-block-not-empty');
      blockIndex = caret.blockIndex;
      leafIndex = caret.leafIndex;
      return;
    }
    if (current.kind !== 'paragraph') {
      if (process.env.JUDONGCHE_DIAG)
        console.error(
          '[jdc-dom] select-block-kind ' +
            JSON.stringify({ kind, caret, blocks: describe(snapshot) }),
        );
      halt('PAGE_CHANGED', 'unexpected-block-kind');
    }
    if (leafAt(snapshot, caret.blockIndex, 0).text !== '') {
      if (process.env.JUDONGCHE_DIAG)
        console.error(
          '[jdc-dom] select-block-caret ' +
            JSON.stringify({
              kind,
              caret,
              selection: describeSelection(snapshot.selection),
              blocks: describe(snapshot),
            }),
        );
      halt('PAGE_CHANGED', 'current-paragraph-not-empty');
    }
    const index = caret.blockIndex;
    requireTrailingParagraphs(snapshot, index + 1);
    const tool = toolFor(kind);
    for (let attempt = 0; attempt < 2; attempt++) {
      await guard();
      await withStop(() => dom.clickTool(tool));
      if (popupTools.includes(tool))
        await withStop(() => dom.closeToolPopups());
      const applied = await settle(
        () => dom.snapshot(),
        (value) => {
          const block = value.blocks[index];
          return (
            block?.kind === kind &&
            block.leaves.length === 1 &&
            block.leaves[0]!.text === ''
          );
        },
      );
      if (!applied) continue;
      const created = blockAt(applied, index);
      if (
        created.kind !== kind ||
        created.leaves.length !== 1 ||
        created.leaves[0]!.text !== ''
      )
        halt('PAGE_CHANGED', 'created-block-not-empty');
      requireTrailingParagraphs(applied, index + 1);
      let seated = adopt(applied);
      if (
        !seated.caret ||
        seated.caret.blockIndex !== index ||
        seated.caret.leafIndex !== 0 ||
        nodeSelected(seated)
      ) {
        await withStop(() =>
          dom.clickBlockEdge(index, 0, {
            callsite: 'created-block-selection',
          }),
        );
        await withStop(() => dom.placeCaret('end'));
        seated = adopt(await withStop(() => dom.snapshot()));
      }
      if (
        !seated.caret ||
        seated.caret.blockIndex !== index ||
        seated.caret.leafIndex !== 0
      )
        halt('PAGE_CHANGED', 'created-block-not-selected');
      if (seated.selection && !seated.selection.collapsed)
        halt('PAGE_CHANGED', 'created-block-not-collapsed');
      if (leafAt(seated, index, 0).text !== '')
        halt('PAGE_CHANGED', 'created-block-not-empty');
      blockIndex = index;
      leafIndex = 0;
      return;
    }
    halt('PAGE_CHANGED', 'block-toggle-not-applied');
  }

  function describe(snapshot: EditorSnapshot) {
    return snapshot.blocks.map((block, index) => ({
      index,
      kind: block.kind,
      leafCount: block.leaves.length,
      codeUnits: block.leaves.reduce(
        (count, leaf) => count + leaf.text.length,
        0,
      ),
    }));
  }

  function describeSelection(selection: EditorSelection | null) {
    return selection
      ? {
          collapsed: selection.collapsed,
          blockIndex: selection.blockIndex,
          leafIndex: selection.leafIndex,
          codeUnits: selection.text.length,
        }
      : null;
  }

  async function resetFormat(): Promise<void> {
    const snapshot = await read();
    if (process.env.JUDONGCHE_DIAG)
      console.error(
        '[jdc-dom] reset-format ' +
          JSON.stringify({
            caret: snapshot.caret,
            selection: describeSelection(snapshot.selection),
            tools: snapshot.tools,
            stored: [...stored],
            blocks: describe(snapshot),
          }),
      );
    if (snapshot.selection && !snapshot.selection.collapsed) {
      await withStop(() => dom.clickTool('format_clear'));
      const cleared = await settle(
        () => dom.readTool('format_clear'),
        (state) => state.disabled,
      );
      if (!cleared) halt('PAGE_CHANGED', 'format-clear-not-applied');
      stored.clear();
      deferred = [];
      return;
    }
    for (const mark of marks) {
      const state = snapshot.tools[mark];
      if (!state) halt('PAGE_CHANGED', `tool-${mark}-missing`);
      if (!state.active) continue;
      await toggleTool(mark, false);
    }
    stored.clear();
    deferred = [];
  }

  async function setMark(mark: TextMark, active: boolean): Promise<void> {
    const snapshot = await read();
    if (snapshot.selection && !snapshot.selection.collapsed)
      halt('PAGE_CHANGED', 'set-mark-requires-collapsed-caret');
    const caret = await caretOf(snapshot);
    const leaf = leafAt(snapshot, caret.blockIndex, caret.leafIndex);
    const state = snapshot.tools[mark];
    if (!state) halt('PAGE_CHANGED', `tool-${mark}-missing`);
    if (state.active === active) {
      setStored(mark, active);
      return;
    }
    if (active && state.disabled) {
      // The platform disables bold/underline on an empty paragraph, so the
      // stored mark can only be applied to the range after it is typed.
      if (leaf.text === '') {
        deferred = deferred.includes(mark) ? deferred : [...deferred, mark];
        return;
      }
      // The toolbar flags lag behind the editor after block switches, so a
      // disabled flag is not proof; such a click only refreshes the flags
      // before it can toggle, so click until the toolbar reports the mark
      // and let the typed range read-back decide the final verdict.
      unverified.add(mark);
      for (let attempt = 0; attempt < 2; attempt++) {
        await withStop(() => dom.clickTool(mark));
        const refreshed = await withStop(() => dom.readTool(mark));
        if (!refreshed.active) continue;
        unverified.delete(mark);
        break;
      }
      if (unverified.has(mark))
        halt('FORMAT_UNSUPPORTED', `mark-${mark}-unavailable`);
      setStored(mark, true);
      return;
    }
    await toggleTool(mark, active);
    setStored(mark, active);
  }

  async function typeText(text: string): Promise<void> {
    if (!text) return;
    let snapshot = await read();
    const caret = await caretOf(snapshot);
    let leaf = leafAt(snapshot, caret.blockIndex, caret.leafIndex);
    const block = caret.blockIndex;
    const index = caret.leafIndex;
    if (caret.offset !== leaf.text.length) {
      snapshot = await seatAtLeafEnd(block, index, snapshot);
      leaf = leafAt(snapshot, block, index);
    }
    const start = (await caretOf(snapshot)).offset;
    await withStop(() => dom.insertText(text));
    let lastOffset = -1;
    let stableReads = 0;
    const applied = await settle(
      () => dom.snapshot(),
      (value) => {
        const owned =
          value.blocks[block]?.key === snapshot.blocks[block]?.key &&
          value.blocks[block]?.leaves[index]?.key === leaf.key &&
          value.caret?.blockIndex === block &&
          value.caret.leafIndex === index &&
          ((value.inputRevision !== undefined &&
            snapshot.inputRevision !== undefined &&
            value.inputRevision > snapshot.inputRevision) ||
            value.caret.offset > start);
        if (!owned) return false;
        const offset = value.caret!.offset;
        stableReads = offset === lastOffset ? stableReads + 1 : 0;
        lastOffset = offset;
        return stableReads >= 2;
      },
      settleAttemptsForInsert(text.length, settleAttempts, settleDelayMs),
    );
    if (!applied) {
      halt('PAGE_CHANGED', 'typed-text-not-applied');
    }
    let after = await read();
    let afterCaret = await caretOf(after);
    if (afterCaret.blockIndex !== block || afterCaret.leafIndex !== index)
      halt('PAGE_CHANGED', 'caret-left-target-leaf');
    requireOwnedCurrentBlock(snapshot, after, block);
    const end = afterCaret.offset;
    if (deferred.length) {
      await applyDeferredMarks(block, index, start, end);
      after = await read();
      afterCaret = await caretOf(after);
      if (afterCaret.blockIndex !== block || afterCaret.leafIndex !== index)
        halt('PAGE_CHANGED', 'caret-left-target-leaf');
      requireOwnedCurrentBlock(snapshot, after, block);
      stored.clear();
      for (const mark of deferred) stored.add(mark);
      deferred = [];
    }
    unverified.clear();
  }

  async function softBreak(): Promise<void> {
    let snapshot = await read();
    const caret = await caretOf(snapshot);
    const block = caret.blockIndex;
    const index = caret.leafIndex;
    if (caret.offset !== leafAt(snapshot, block, index).text.length) {
      snapshot = await seatAtLeafEnd(block, index, snapshot);
    }
    const before = await caretOf(snapshot);
    await withStop(() => dom.softBreak());
    const applied = await settle(
      () => dom.snapshot(),
      (value) =>
        value.blocks[block]?.key === snapshot.blocks[block]?.key &&
        value.blocks[block]?.leaves[index]?.key ===
          snapshot.blocks[block]?.leaves[index]?.key &&
        value.caret?.blockIndex === block &&
        value.caret.leafIndex === index &&
        value.caret.offset > before.offset,
    );
    if (!applied) halt('PAGE_CHANGED', 'soft-break-not-applied');
    adopt(applied);
  }

  async function nextTextLeaf(): Promise<void> {
    const snapshot = await read();
    const caret = await caretOf(snapshot);
    const index = caret.blockIndex;
    const block = blockAt(snapshot, index);
    if (
      block.kind !== 'bullet_list' &&
      block.kind !== 'ordered_list' &&
      block.kind !== 'blockquote'
    )
      halt('PAGE_CHANGED', 'next-leaf-outside-container');
    if (caret.leafIndex !== block.leaves.length - 1)
      halt('PAGE_CHANGED', 'next-leaf-not-last');
    if (caret.offset !== leafAt(snapshot, index, caret.leafIndex).text.length) {
      await seatAtLeafEnd(index, caret.leafIndex, snapshot);
    }
    const count = block.leaves.length;
    diag('next-leaf-start', { index, count, caret });
    const grownAt = (value: EditorSnapshot): number =>
      grownLeafIndex(value, block.kind, block, value.caret?.blockIndex);
    await withStop(() => dom.press('Enter'));
    let grown = await settle(
      () => dom.snapshot(),
      (value) => grownAt(value) >= 0,
      Math.max(settleAttempts, STRUCTURAL_SETTLE_ATTEMPTS),
    );
    if (!grown) halt('PAGE_CHANGED', 'next-leaf-not-created');
    let position = grownAt(grown);
    if (position < 0) halt('PAGE_CHANGED', 'next-leaf-not-created');
    diag('next-leaf-grown', {
      position,
      caret: grown.caret,
      blocks: grown.blocks.length,
    });
    const atNewLeaf = (value: EditorSnapshot, at: number): boolean =>
      value.caret?.blockIndex === at && value.caret.leafIndex === count;
    // The platform sometimes reports the new leaf and then moves the selection
    // back, so the caret is only trusted after it survives a confirmation read.
    for (let attempt = 0; ; attempt += 1) {
      if (atNewLeaf(grown, position)) {
        const confirmed = await settle(
          () => dom.snapshot(),
          (value) => atNewLeaf(value, position),
          1,
        );
        if (confirmed) {
          grown = confirmed;
          break;
        }
      }
      if (attempt >= 2) halt('PAGE_CHANGED', 'next-leaf-caret-lost');
      diag('next-leaf-reseat', { attempt, position, from: grown.caret });
      await withStop(() =>
        dom.clickBlockEdge(position, count, {
          callsite: 'list-leaf-recovery',
        }),
      );
      await withStop(() => dom.placeCaret('end'));
      const seated = await settle(
        () => dom.snapshot(),
        (value) => atNewLeaf(value, position),
      );
      if (!seated) halt('PAGE_CHANGED', 'next-leaf-caret-lost');
      grown = seated;
      position = grownAt(grown);
      if (position < 0) halt('PAGE_CHANGED', 'next-leaf-not-created');
    }
    diag('next-leaf-seated', { position, caret: grown.caret });
    if (leafAt(grown, position, count).text !== '')
      halt('CONTENT_MISMATCH', 'new-leaf-not-empty');
    adopt(grown);
  }

  async function exitBlock(): Promise<void> {
    let snapshot = await read();
    const caret = await caretOf(snapshot);
    const index = caret.blockIndex;
    const block = blockAt(snapshot, index);
    diag('exit-block-start', {
      index,
      caret,
      leafCount: block.leaves.length,
    });
    if (block.kind === 'paragraph' || block.kind === 'heading') {
      // Text insertion can already supply the next caret paragraph. Enter
      // would create another empty paragraph which becomes source content as
      // soon as appendImage writes after it. Reuse the verified tail; an
      // explicitly empty source block still needs Enter to preserve that block.
      if (blockText(block) !== '' && snapshot.blocks[index + 1]) {
        requireTrailingParagraphs(snapshot, index + 1);
        const seated = await seatAtLeafEnd(
          index + 1,
          0,
          snapshot,
          'paragraph-tail-reuse',
        );
        if (seated.selection && !seated.selection.collapsed)
          halt('PAGE_CHANGED', 'paragraph-tail-changed');
        requireOwnedCurrentBlock(snapshot, seated, index);
        requireTrailingParagraphs(seated, index + 1);
        blockIndex = index + 1;
        leafIndex = 0;
        return;
      }
      await withStop(() => dom.press('Enter'));
      const next = await settle(
        () => dom.snapshot(),
        (value) =>
          value.caret?.blockIndex === index + 1 &&
          value.blocks[index + 1]?.kind === 'paragraph' &&
          value.blocks[index + 1]?.leaves.length === 1 &&
          value.blocks[index + 1]?.leaves[0]?.text === '' &&
          !value.blocks[index + 1]?.leaves[0]?.unsupported,
      );
      if (!next) halt('PAGE_CHANGED', 'paragraph-exit-failed');
      requireOwnedCurrentBlock(snapshot, next, index);
      requireTrailingParagraphs(next, index + 2);
      blockIndex = index + 1;
      leafIndex = 0;
      return;
    }
    if (
      block.kind !== 'bullet_list' &&
      block.kind !== 'ordered_list' &&
      block.kind !== 'blockquote'
    )
      halt('PAGE_CHANGED', 'exit-block-unsupported');
    if (caret.leafIndex !== block.leaves.length - 1)
      halt('PAGE_CHANGED', 'exit-not-last-leaf');
    if (caret.offset !== leafAt(snapshot, index, caret.leafIndex).text.length) {
      snapshot = await seatAtLeafEnd(index, caret.leafIndex, snapshot);
    }
    await withStop(() => dom.press('End'));
    let next: EditorSnapshot | null = null;
    for (let attempt = 0; attempt < 2 && !next; attempt++) {
      await withStop(() => dom.press('ArrowDown'));
      next = await settle(
        () => dom.snapshot(),
        (value) =>
          value.caret?.blockIndex === index + 1 &&
          value.blocks[index + 1]?.kind === 'paragraph',
      );
    }
    if (!next) halt('PAGE_CHANGED', 'container-exit-failed');
    requireOwnedCurrentBlock(snapshot, next, index);
    if (leafAt(next, index + 1, 0).text !== '')
      halt('CONTENT_MISMATCH', 'container-exit-target-not-empty');
    requireTrailingParagraphs(next, index + 2);
    adopt(next);
  }

  return {
    guard,
    resetFormat,
    selectBlock,
    setMark,
    typeText,
    softBreak,
    nextTextLeaf,
    exitBlock,
  };
}

const editorSelector = '.publish-editor .ProseMirror';
const allowedTools: EditorTool[] = [
  'header',
  'bold',
  'italic',
  'underline',
  'block_quote',
  'bullet_list',
  'ordered_list',
  'format_clear',
];

/** Playwright edge for the publish editor. Every click is hit-tested so it can
 * never land in the header/blockquote helper popup or on label.byte-radio. */
export function createPlaywrightEditorDom(
  page: Page,
  diagnostic?: (value: BlockEdgeDiagnostic) => void,
  stopped?: () => boolean,
  clickTimeout?: number,
): EditorDom {
  function checkStop() {
    if (stopped?.()) halt('STOP_REQUESTED', 'rich-write-stopped');
  }
  async function withStop<T>(work: () => Promise<T>): Promise<T> {
    checkStop();
    const value = await work();
    checkStop();
    return value;
  }
  type Owner = {
    root: Element | null;
    ids: WeakMap<Element, string>;
    next: number;
    inputRevision: number;
    onInput: (event: Event) => void;
  };
  let owner: Promise<JSHandle<Owner>> | undefined;
  const ownership = () =>
    (owner ??= page.evaluateHandle((selector) => {
      const value: Owner = {
        root: document.querySelector(selector),
        ids: new WeakMap<Element, string>(),
        next: 0,
        inputRevision: 0,
        onInput: () => {},
      };
      value.onInput = (event: Event) => {
        if (event.target instanceof Node && value.root?.contains(event.target))
          value.inputRevision++;
      };
      value.root?.addEventListener('input', value.onInput);
      return value;
    }, editorSelector));
  return {
    async dispose() {
      if (!owner) return;
      const value = await owner;
      await value
        .evaluate((current) =>
          current.root?.removeEventListener('input', current.onInput),
        )
        .catch(() => {});
      await value.dispose();
    },
    async snapshot() {
      const value = await page.evaluate(
        ({ selector, owner }) => {
          const pm = document.querySelector(selector);
          if (
            !pm ||
            pm !== owner.root ||
            document.querySelectorAll(selector).length !== 1
          )
            return null;
          const key = (node: Element) => {
            let value = owner.ids.get(node);
            if (!value) {
              value = String(++owner.next);
              owner.ids.set(node, value);
            }
            return value;
          };
          const noise =
            '.syl-placeholder, img.ProseMirror-separator, br.ProseMirror-trailingBreak';
          const inlineMark = (tag: string): string | null =>
            tag === 'STRONG' || tag === 'B'
              ? 'bold'
              : tag === 'EM' || tag === 'I'
                ? 'italic'
                : tag === 'U'
                  ? 'underline'
                  : null;
          const kindOf = (element: Element): string => {
            switch (element.tagName) {
              case 'P':
                return 'paragraph';
              case 'H1':
              case 'H2':
              case 'H3':
              case 'H4':
              case 'H5':
              case 'H6':
                return 'heading';
              case 'UL':
                return 'bullet_list';
              case 'OL':
                return 'ordered_list';
              case 'BLOCKQUOTE':
                return 'blockquote';
              default:
                return 'unsupported';
            }
          };
          const readLeaf = (root: Element) => {
            const clone = root.cloneNode(true) as Element;
            clone.querySelectorAll(noise).forEach((node) => node.remove());
            const runs: { text: string; marks: string[] }[] = [];
            let text = '';
            let unsupported = false;
            const push = (value: string, marks: string[]) => {
              if (!value) return;
              text += value;
              const last = runs[runs.length - 1];
              if (last && last.marks.join('|') === marks.join('|'))
                last.text += value;
              else runs.push({ text: value, marks: marks.slice() });
            };
            const walk = (node: Node, marks: string[]) => {
              node.childNodes.forEach((child) => {
                if (child.nodeType === Node.TEXT_NODE)
                  push(child.nodeValue ?? '', marks);
                else if (child.nodeType === Node.ELEMENT_NODE) {
                  const element = child as Element;
                  // Every wrapper, including marks and spans, must be inert
                  // before a later leaf-end click can act on its descendants.
                  if (
                    element.matches(
                      'a,button,label,input,select,textarea,iframe,img,video,audio,canvas,object,embed,[contenteditable],[role],[tabindex]',
                    )
                  )
                    unsupported = true;
                  if (element.tagName === 'BR') {
                    push('\n', marks);
                    return;
                  }
                  const mark = inlineMark(element.tagName);
                  if (mark)
                    walk(
                      element,
                      marks.includes(mark) ? marks : marks.concat(mark),
                    );
                  else if (element.tagName === 'SPAN') walk(element, marks);
                  else walk(element, marks);
                }
              });
            };
            walk(clone, []);
            if (root.querySelector('ul,ol,blockquote')) unsupported = true;
            return { key: key(root), text, runs, unsupported };
          };
          const leavesOf = (element: Element, kind: string) => {
            if (kind === 'bullet_list' || kind === 'ordered_list')
              return Array.from(element.children).map((child) => {
                const leaf = readLeaf(child);
                if (child.tagName !== 'LI') leaf.unsupported = true;
                return leaf;
              });
            if (kind === 'blockquote')
              return Array.from(element.children).map((child) => {
                const leaf = readLeaf(child);
                if (child.tagName !== 'P') leaf.unsupported = true;
                return leaf;
              });
            return [readLeaf(element)];
          };
          const blocks = Array.from(pm.children).map((element) => {
            const kind = kindOf(element);
            return { key: key(element), kind, leaves: leavesOf(element, kind) };
          });
          const selection = window.getSelection();
          let caret: {
            blockIndex: number;
            leafIndex: number;
            offset: number;
          } | null = null;
          let selected: {
            collapsed: boolean;
            text: string;
            blockIndex: number;
            leafIndex: number;
          } | null = null;
          if (
            selection &&
            selection.rangeCount > 0 &&
            selection.anchorNode &&
            pm.contains(selection.anchorNode)
          ) {
            let top: Element | null =
              selection.anchorNode.nodeType === Node.TEXT_NODE
                ? selection.anchorNode.parentElement
                : (selection.anchorNode as Element);
            while (top && top.parentElement !== pm) top = top.parentElement;
            if (top) {
              const blockIndex = Array.prototype.indexOf.call(pm.children, top);
              const kind = kindOf(top);
              const container =
                kind === 'bullet_list' ||
                kind === 'ordered_list' ||
                kind === 'blockquote';
              let leafIndex = 0;
              let leaf: Element = top;
              if (container) {
                let inner: Element | null =
                  selection.anchorNode.nodeType === Node.TEXT_NODE
                    ? selection.anchorNode.parentElement
                    : (selection.anchorNode as Element);
                while (inner && inner.parentElement !== top)
                  inner = inner.parentElement;
                if (inner) {
                  leafIndex = Array.prototype.indexOf.call(top.children, inner);
                  leaf = inner;
                }
              }
              let offset = 0;
              try {
                const range = document.createRange();
                range.setStart(leaf, 0);
                if (leaf.contains(selection.anchorNode)) {
                  range.setEnd(selection.anchorNode, selection.anchorOffset);
                  const holder = document.createElement('div');
                  holder.appendChild(range.cloneContents());
                  holder
                    .querySelectorAll(noise)
                    .forEach((node) => node.remove());
                  const walker = document.createTreeWalker(
                    holder,
                    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
                  );
                  let node = walker.nextNode();
                  while (node) {
                    if (node.nodeType === Node.TEXT_NODE)
                      offset += (node.nodeValue ?? '').length;
                    else if ((node as Element).tagName === 'BR') offset += 1;
                    node = walker.nextNode();
                  }
                }
              } catch {
                offset = 0;
              }
              caret = { blockIndex, leafIndex, offset };
              selected = {
                collapsed: selection.isCollapsed,
                text: selection.isCollapsed ? '' : selection.toString(),
                blockIndex,
                leafIndex,
              };
            }
          }
          const tools: Record<string, { active: boolean; disabled: boolean }> =
            {};
          document
            .querySelectorAll('div.syl-toolbar-tool')
            .forEach((element) => {
              const name = Array.from(element.classList).find(
                (value) => value !== 'syl-toolbar-tool',
              );
              if (!name) return;
              tools[name] = {
                active: element.classList.contains('active'),
                disabled:
                  element.classList.contains('disable') ||
                  element.classList.contains('disabled'),
              };
            });
          return {
            blocks,
            caret,
            selection: selected,
            tools,
            inputRevision: owner.inputRevision,
          };
        },
        { selector: editorSelector, owner: await ownership() },
      );
      if (!value) halt('PAGE_CHANGED', 'editor-missing');
      return value as EditorSnapshot;
    },

    async focusState() {
      return page.evaluate((selector) => {
        const pm = document.querySelector(selector);
        const active = document.activeElement;
        const selection = window.getSelection();
        return {
          activeIsEditor: !!pm && active === pm,
          selectionInEditor:
            !!pm &&
            !!selection &&
            selection.rangeCount > 0 &&
            !!selection.anchorNode &&
            pm.contains(selection.anchorNode),
        };
      }, editorSelector);
    },

    async readTool(tool) {
      const value = await page.evaluate((name) => {
        const element = document.querySelector('div.syl-toolbar-tool.' + name);
        if (!element) return null;
        return {
          active: element.classList.contains('active'),
          disabled:
            element.classList.contains('disable') ||
            element.classList.contains('disabled'),
        };
      }, tool);
      if (!value) halt('PAGE_CHANGED', 'tool-missing');
      return value;
    },

    async clickTool(tool) {
      if (!allowedTools.includes(tool)) halt('FORMAT_UNSUPPORTED', 'tool');
      const hit = await withStop(() =>
        page.evaluate((name) => {
          const element = document.querySelector(
            'div.syl-toolbar-tool.' + name,
          );
          const button = element?.querySelector('button.syl-toolbar-button');
          if (!element || !button) return null;
          const rect = button.getBoundingClientRect();
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          const target = document.elementFromPoint(x, y);
          const popup = document.querySelector('div.plugin-helper');
          return {
            x,
            y,
            inside: !!target && element.contains(target),
            blocked:
              (!!popup && !!target && popup.contains(target)) ||
              !!target?.closest('label.byte-radio'),
          };
        }, tool),
      );
      if (!hit) halt('PAGE_CHANGED', 'tool-missing');
      if (hit.blocked || !hit.inside) halt('PAGE_CHANGED', 'tool-blocked');
      await withStop(() => page.mouse.click(hit.x, hit.y));
      await withStop(() => page.waitForTimeout(300));
    },

    async clickBlockEdge(blockIndex, leafIndex, context) {
      if (stopped?.()) halt('STOP_REQUESTED', 'rich-write-stopped');
      await withStop(() =>
        clickEditorLeafEnd(page, editorSelector, blockIndex, leafIndex, {
          clickTimeout,
          callsite: context?.callsite ?? 'unspecified',
          diagnostic,
          stop: () => {
            if (stopped?.()) halt('STOP_REQUESTED', 'rich-write-stopped');
          },
        }),
      );
    },

    async placeCaret(edge) {
      await withStop(() =>
        page.keyboard.press(edge === 'end' ? 'End' : 'Home'),
      );
      await withStop(() => page.waitForTimeout(120));
      if (edge !== 'end') return;
      const seated = await withStop(() => this.snapshot());
      const caret = seated.caret;
      if (!caret || !seated.selection?.collapsed) return;
      const text =
        seated.blocks[caret.blockIndex]?.leaves[caret.leafIndex]?.text;
      // Under white-space:normal Chromium cannot seat a caret after literal
      // collapsed terminal spaces. ArrowRight skips them into the next leaf.
      // Stop before any write instead of moving outside the requested leaf.
      if (text !== undefined && /^[\t ]+$/.test(text.slice(caret.offset)))
        halt('PAGE_CHANGED', 'caret-not-at-leaf-end');
    },

    async insertText(text) {
      await withStop(() => page.keyboard.insertText(text));
    },

    async press(key) {
      await withStop(() => page.keyboard.press(key));
      await withStop(() => page.waitForTimeout(160));
    },

    async softBreak() {
      await withStop(() => page.keyboard.press('Shift+Enter'));
      await withStop(() => page.waitForTimeout(160));
    },

    async selectLeafRange(blockIndex, leafIndex, start, end) {
      const selected = await withStop(() =>
        page.evaluate(
          ({ selector, blockIndex, leafIndex, start, end }) => {
            const noise =
              '.syl-placeholder, img.ProseMirror-separator, br.ProseMirror-trailingBreak';
            const pm = document.querySelector(selector);
            const block = pm?.children[blockIndex];
            if (!block) return null;
            const container =
              block.tagName === 'UL' ||
              block.tagName === 'OL' ||
              block.tagName === 'BLOCKQUOTE';
            const leaf = container ? block.children[leafIndex] : block;
            if (!leaf) return null;
            const locate = (offset: number): [Node, number] => {
              let remaining = offset;
              let found: [Node, number] | null = null;
              const visit = (node: Node): void => {
                if (found) return;
                if (node.nodeType === Node.TEXT_NODE) {
                  const value = node.nodeValue ?? '';
                  if (remaining <= value.length) {
                    found = [node, remaining];
                    return;
                  }
                  remaining -= value.length;
                  return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                const element = node as Element;
                if (element.matches(noise)) return;
                if (element.tagName === 'BR') {
                  const parent = element.parentNode;
                  if (!parent) return;
                  const index = Array.prototype.indexOf.call(
                    parent.childNodes,
                    element,
                  );
                  if (remaining === 0) found = [parent, index];
                  else if (remaining === 1) found = [parent, index + 1];
                  else remaining -= 1;
                  return;
                }
                element.childNodes.forEach(visit);
              };
              visit(leaf);
              return found ?? [leaf, leaf.childNodes.length];
            };
            const from = locate(start);
            const to = locate(end);
            if (pm instanceof HTMLElement) pm.focus();
            const range = document.createRange();
            range.setStart(from[0], from[1]);
            range.setEnd(to[0], to[1]);
            const selection = window.getSelection();
            if (!selection) return null;
            selection.removeAllRanges();
            selection.addRange(range);
            return selection.toString();
          },
          { selector: editorSelector, blockIndex, leafIndex, start, end },
        ),
      );
      if (selected === null) halt('PAGE_CHANGED', 'range-not-selectable');
      await withStop(() => page.waitForTimeout(120));
    },

    async collapseToEnd() {
      await withStop(() =>
        page.evaluate((selector) => {
          const pm = document.querySelector(selector);
          if (pm instanceof HTMLElement) pm.focus();
          const selection = window.getSelection();
          if (selection && selection.focusNode)
            selection.collapse(selection.focusNode, selection.focusOffset);
        }, editorSelector),
      );
      await withStop(() => page.waitForTimeout(120));
    },

    async closeToolPopups() {
      await withStop(() => page.keyboard.press('Escape'));
      await withStop(() => page.waitForTimeout(120));
    },
  };
}
