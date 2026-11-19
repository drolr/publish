import { upgradeManualDraft } from '../../src/domain/manual-draft-version';
import { expect, it, vi, afterEach } from 'vitest';
import type { ManualDraftV1 as ManualDraft } from '../../src/contracts/manual-article';
import {
  draftToEditor,
  editorToDraft,
  rangeFromSelection,
  emptyEditorKey,
} from '../../src/renderer/editor/editor-codec';
import { TextSelection, EditorState } from 'prosemirror-state';
import { InlinePreviewPool } from '../../src/renderer/editor/InlineArticleImage';
import {
  EditorSession,
  type EditorSessionState,
} from '../../src/renderer/editor/editor-session';
const key = '11111111-1111-4111-8111-111111111111';
const imageKey = '22222222-2222-4222-8222-222222222222';
const draft: ManualDraft = {
  title: '标题',
  contentDeclaration: 'repost',
  blocks: [
    { type: 'paragraph', blockKey: key, text: '校对😀中文\n第二行' },
    { type: 'image', blockKey: imageKey, imageToken: key },
    {
      type: 'paragraph',
      blockKey: '33333333-3333-4333-8333-333333333333',
      text: '',
    },
  ],
};
it('roundtrips emoji, soft breaks, empty paragraphs and authorized image positions without tokens in editor nodes', () => {
  const doc = draftToEditor(draft);
  expect(editorToDraft(doc, draft)).toEqual(draft);
  expect(JSON.stringify(doc.toJSON())).not.toContain('imageToken');
  expect(doc.child(0).child(1).type.name).toBe('hard_break');
});
it('maps UTF16 selections across images without moving the range', () => {
  const doc = draftToEditor(draft);
  const range = rangeFromSelection(
    doc,
    TextSelection.create(doc, 5, doc.content.size - 1),
  );
  expect(range.anchor).toEqual({ blockKey: key, kind: 'text', offset: 4 });
  expect(range.head).toEqual({
    blockKey: draft.blocks[2].blockKey,
    kind: 'text',
    offset: 0,
  });
});
it('rejects unknown image keys rather than inventing authorization', () => {
  const doc = draftToEditor({
    ...draft,
    blocks: [{ type: 'image', blockKey: imageKey, imageToken: key }],
  });
  expect(() => editorToDraft(doc, { ...draft, blocks: [] })).toThrow();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function session(): EditorSessionState {
  return {
    state: 'editing',
    revision: 1,
    sessionId: key,
    nextPasteCommandId: key,
    nextEditCommandId: imageKey,
    nextClientSequence: 19,
    nextSaveOperationId: key,
    candidates: [],
    externalId: 'manual',
    target: { kind: 'new' },
    documentRevision: 0,
    acknowledgedEdit: null,
    draft: upgradeManualDraft(draft),
    images: [],
    dirty: false,
  };
}
it('keeps one in-flight exact-floor edit and freezes lost ACK until main confirms it', async () => {
  const main = session();
  let calls = 0;
  let release: () => void = () => {};
  const core = new EditorSession(
    {
      applyManualEdit: async (command, value) => {
        calls++;
        expect(command.clientSequence).toBe(19);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        main.draft = value;
        main.documentRevision++;
        main.revision++;
        main.nextClientSequence = 20;
        main.nextEditCommandId = key;
        main.acknowledgedEdit = {
          commandId: command.commandId,
          clientSequence: command.clientSequence,
        };
        throw Error('lost');
      },
    },
    () => {},
  );
  core.accept(main);
  core.change({ ...upgradeManualDraft(draft), title: 'latest' });
  const first = core.flush();
  expect(core.flush()).toBe(first);
  await Promise.resolve();
  release();
  expect(await first).toBe(false);
  expect(core.unknown).toBe(true);
  expect(calls).toBe(1);
  core.accept(main);
  expect(core.unknown).toBe(false);
  expect(core.unsynced).toBe(false);
  expect(core.draft?.title).toBe('latest');
  core.dispose();
});
it('waits for title and body compositions before flushing and preserves rejected input', async () => {
  const core = new EditorSession(
    {
      applyManualEdit: async () => ({
        status: 'invalid',
        snapshot: {
          ...session(),
          nextClientSequence: 20,
          nextEditCommandId: key,
        },
      }),
    },
    () => {},
  );
  core.accept(session());
  core.composition('body', true);
  core.composition('title', true);
  core.change({ ...upgradeManualDraft(draft), title: ' raw ' });
  let done = false;
  const task = core.flush().then((value) => {
    done = true;
    return value;
  });
  core.composition('body', false);
  await Promise.resolve();
  expect(done).toBe(false);
  core.composition('title', false);
  expect(await task).toBe(false);
  expect(core.draft?.title).toBe(' raw ');
  expect(core.unsynced).toBe(true);
  core.dispose();
});
function previewFixture() {
  vi.useFakeTimers();
  const observers: Array<(items: IntersectionObserverEntry[]) => void> = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (items: IntersectionObserverEntry[]) => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const root = { getBoundingClientRect: () => ({ top: 0 }) } as HTMLElement;
  const element = { getBoundingClientRect: () => ({ top: 0 }) } as HTMLElement;
  let active = 0,
    max = 0,
    totalBytes = 0,
    maxBytes = 0,
    created = 0;
  const owned = new Map<string, number>();
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => {
      const id = String(++created);
      active++;
      max = Math.max(max, active);
      totalBytes += blob.size;
      maxBytes = Math.max(maxBytes, totalBytes);
      owned.set(id, blob.size);
      return id;
    },
    revokeObjectURL: (id: string) => {
      active--;
      totalBytes -= owned.get(id)!;
      owned.delete(id);
    },
  });
  const pool = new InlinePreviewPool(root);
  return {
    pool,
    element,
    visible: (i: number, value = true) =>
      observers[i]([{ isIntersecting: value } as IntersectionObserverEntry]),
    stats: () => ({ active, max, totalBytes, maxBytes, created }),
  };
}
it('preview leases obey eight/40MiB/50M pixels, rotate queued visible items, and release on disposal', async () => {
  const f = previewFixture();
  let reads = 0;
  vi.stubGlobal('window', {
    desktopApi: {
      getManualImage: async () => {
        reads++;
        return { status: 'ok', mime: 'image/png', bytes: new Uint8Array(1) };
      },
    },
  });
  for (let i = 0; i < 12; i++) {
    f.pool.register(
      String(i),
      key,
      { imageToken: key, mime: 'image/png', width: 1, height: 1, byteSize: 1 },
      f.element,
      () => {},
    );
    f.visible(i);
  }
  await vi.advanceTimersByTimeAsync(4500);
  expect(reads).toBeGreaterThanOrEqual(12);
  expect(f.stats().max).toBe(8);
  f.pool.dispose();
  expect(f.stats().active).toBe(0);
});
it('preview reserves bytes before reads, keeps pixel ceiling, and cannot create a late obsolete Blob', async () => {
  const f = previewFixture();
  let release: (r: unknown) => void = () => {};
  let reads = 0;
  vi.stubGlobal('window', {
    desktopApi: {
      getManualImage: () => {
        reads++;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const notify = vi.fn();
  const remove = f.pool.register(
    key,
    key,
    {
      imageToken: key,
      mime: 'image/png',
      width: 5000,
      height: 5000,
      byteSize: 20 * 1024 * 1024,
    },
    f.element,
    notify,
  );
  f.visible(0);
  f.pool.register(
    imageKey,
    key,
    {
      imageToken: key,
      mime: 'image/png',
      width: 5000,
      height: 5000,
      byteSize: 20 * 1024 * 1024,
    },
    f.element,
    () => {},
  );
  f.visible(1);
  f.pool.register(
    'third',
    key,
    { imageToken: key, mime: 'image/png', width: 1, height: 1, byteSize: 1 },
    f.element,
    () => {},
  );
  f.visible(2);
  await Promise.resolve();
  expect(reads).toBe(1);
  remove();
  release({
    status: 'ok',
    mime: 'image/png',
    bytes: new Uint8Array(20 * 1024 * 1024),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stats().created).toBe(0);
  expect(notify).not.toHaveBeenCalled();
  expect(reads).toBe(2);
  f.pool.dispose();
  release({ status: 'busy' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stats().active).toBe(0);
});
it('preserves ahead input and session on an unavailable main read until healthy query recovers', () => {
  const core = new EditorSession(
    { applyManualEdit: async () => ({ status: 'ok', snapshot: session() }) },
    () => {},
  );
  core.accept(session());
  core.change({ ...upgradeManualDraft(draft), title: '未确认' });
  core.accept({ state: 'unavailable', revision: 2 });
  expect(core.draft?.title).toBe('未确认');
  expect(core.snapshot && 'sessionId' in core.snapshot).toBe(true);
  expect(core.unknown).toBe(true);
  core.accept({ ...session(), revision: 3 });
  expect(core.unknown).toBe(false);
  expect(core.draft?.title).toBe('未确认');
  core.dispose();
});
it('freezes an unmatched ok ACK and only a matching query can acknowledge the frozen input', async () => {
  const core = new EditorSession(
    { applyManualEdit: async () => ({ status: 'ok', snapshot: session() }) },
    () => {},
  );
  core.accept(session());
  core.change({ ...upgradeManualDraft(draft), title: '保留' });
  expect(await core.flush()).toBe(false);
  expect(core.unknown).toBe(true);
  expect(core.draft?.title).toBe('保留');
  core.accept({
    ...session(),
    revision: 2,
    nextClientSequence: 20,
    nextEditCommandId: key,
    acknowledgedEdit: { commandId: imageKey, clientSequence: 19 },
    draft: { ...upgradeManualDraft(draft), title: '保留' },
  });
  expect(core.unknown).toBe(false);
  expect(core.unsynced).toBe(false);
  core.dispose();
});
it('already seen visible budget placeholders eventually rotate back without clicks', async () => {
  const f = previewFixture();
  vi.stubGlobal('window', {
    desktopApi: {
      getManualImage: async () => ({
        status: 'ok',
        mime: 'image/png',
        bytes: new Uint8Array(1),
      }),
    },
  });
  const shown = new Map<number, number>(),
    current = new Set<number>();
  for (let i = 0; i < 12; i++) {
    f.pool.register(
      String(i),
      key,
      { imageToken: key, mime: 'image/png', width: 1, height: 1, byteSize: 1 },
      f.element,
      (url) => {
        if (url) {
          shown.set(i, (shown.get(i) ?? 0) + 1);
          current.add(i);
        } else current.delete(i);
      },
    );
    f.visible(i);
  }
  await vi.advanceTimersByTimeAsync(4500);
  const waiting = [...shown.keys()].filter((i) => !current.has(i));
  const before = waiting.map((i) => shown.get(i)!);
  expect(waiting.length).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(10000);
  expect(waiting.every((key, index) => shown.get(key)! > before[index])).toBe(
    true,
  );
  expect(f.stats().max).toBe(8);
  f.pool.dispose();
});

it('completed stop retires a hung local edit while preserving input and ignores its late failure', async () => {
  vi.useFakeTimers();
  let rejectOld!: (e: Error) => void;
  let calls = 0;
  const main = session();
  const core = new EditorSession(
    {
      applyManualEdit: async (command, value) => {
        calls++;
        if (calls === 1)
          return new Promise((_, reject) => {
            rejectOld = reject;
          });
        return {
          status: 'ok',
          snapshot: {
            ...main,
            revision: 2,
            documentRevision: 1,
            draft: value,
            nextClientSequence: command.clientSequence + 1,
            nextEditCommandId: key,
            acknowledgedEdit: {
              commandId: command.commandId,
              clientSequence: command.clientSequence,
            },
          },
        };
      },
    },
    () => {},
  );
  try {
    core.accept(main);
    core.change({
      ...upgradeManualDraft(draft),
      title: 'retained unsaved input',
    });
    const old = core.flush();
    await Promise.resolve();
    core.initializeAfterStop();
    expect(core.draft?.title).toBe('retained unsaved input');
    core.change({
      ...upgradeManualDraft(draft),
      title: 'fresh explicit input',
    });
    const fresh = core.flush();
    expect(fresh).not.toBe(old);
    expect(await fresh).toBe(true);
    rejectOld(Error('retired local edit'));
    await old;
    expect(core.unknown).toBe(false);
    expect(core.draft?.title).toBe('fresh explicit input');
    expect(calls).toBe(2);
  } finally {
    core.dispose();
  }
});

import type { ManualDraftV2 } from '../../src/contracts/manual-article';
import {
  draftV2ToEditor,
  editorToDraftV2,
  selectionFromRange,
  documentPatch,
} from '../../src/renderer/editor/editor-codec';
const richDraft: ManualDraftV2 = {
  bodyVersion: 2,
  title: 'rich',
  contentDeclaration: 'original',
  blocks: [
    {
      type: 'heading',
      blockKey: key,
      content: [{ type: 'text', text: 'A\n\n😀', marks: ['bold', 'italic'] }],
    },
    {
      type: 'list',
      kind: 'ordered',
      start: 6,
      blockKey: '44444444-4444-4444-8444-444444444444',
      items: [
        {
          type: 'paragraph',
          blockKey: '55555555-5555-4555-8555-555555555555',
          content: [{ type: 'text', text: 'B\nC', marks: ['underline'] }],
        },
      ],
    },
    {
      type: 'blockquote',
      blockKey: '66666666-6666-4666-8666-666666666666',
      paragraphs: [
        {
          type: 'paragraph',
          blockKey: '77777777-7777-4777-8777-777777777777',
          content: [],
        },
      ],
    },
    { type: 'image', blockKey: imageKey, imageToken: key },
  ],
};
it('roundtrips keyed rich structures and LF marks without image grants in PM', () => {
  const doc = draftV2ToEditor(richDraft);
  expect(editorToDraftV2(doc, richDraft)).toEqual(richDraft);
  expect(
    doc
      .child(0)
      .child(1)
      .marks.map((m) => m.type.name),
  ).toEqual(['bold', 'italic']);
  expect(JSON.stringify(doc.toJSON())).not.toContain('imageToken');
  expect(() => editorToDraft(doc, draft)).toThrow();
});
it('maps nested leaf UTF16 and container/image edges bidirectionally; rejects surrogate and unknown boundaries', () => {
  const doc = draftV2ToEditor(richDraft);
  const range = {
    anchor: {
      kind: 'text' as const,
      blockKey:
        richDraft.blocks[1].type === 'list'
          ? richDraft.blocks[1].items[0].blockKey
          : '',
      offset: 2,
    },
    head: { kind: 'edge' as const, blockKey: imageKey, side: 'after' as const },
  };
  expect(rangeFromSelection(doc, selectionFromRange(doc, range))).toEqual(
    range,
  );
  expect(() =>
    selectionFromRange(doc, {
      anchor: { kind: 'text', blockKey: key, offset: 4 },
      head: range.head,
    }),
  ).toThrow();
  expect(() =>
    selectionFromRange(doc, {
      anchor: {
        kind: 'text',
        blockKey: richDraft.blocks[1].blockKey,
        offset: 0,
      },
      head: range.head,
    }),
  ).toThrow();
  expect(() =>
    selectionFromRange(doc, {
      anchor: { kind: 'edge', blockKey: 'missing', side: 'before' },
      head: range.head,
    }),
  ).toThrow();
});
it('patches a deep leaf without replacing unaffected list and sibling keys', () => {
  const before = draftV2ToEditor(richDraft);
  const changed = structuredClone(richDraft);
  if (changed.blocks[1].type === 'list')
    changed.blocks[1].items[0].content[0].text = 'B\nD';
  const after = draftV2ToEditor(changed);
  const patch = documentPatch(before, after)!;
  expect(patch.to - patch.from).toBe(1);
  const state = EditorState.create({ doc: before });
  expect(
    state.tr.replaceWith(patch.from, patch.to, patch.content).doc.eq(after),
  ).toBe(true);
});
it('roundtrips valid historical LF volume in compact runs', () => {
  const value: ManualDraftV2 = {
    ...richDraft,
    blocks: Array.from({ length: 10 }, (_, index) => ({
      type: 'paragraph' as const,
      blockKey: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      content: [
        {
          type: 'text' as const,
          text: '\n'.repeat(19000),
          marks: ['underline' as const],
        },
      ],
    })),
  };
  expect(editorToDraftV2(draftV2ToEditor(value), value)).toEqual(value);
});
it('does not serialize the display-only placeholder after edits or formatting', () => {
  const empty: ManualDraftV2 = { ...richDraft, blocks: [] };
  const doc = draftV2ToEditor(empty);
  expect(editorToDraftV2(doc, empty)).toEqual(empty);
  const changed = EditorState.create({ doc }).tr.insertText('new', 1).doc;
  expect(() => editorToDraftV2(changed, empty)).toThrow();
});
it('schema rejects nested containers, headings or images inside list and quote', () => {
  const doc = draftV2ToEditor(richDraft);
  const schema = doc.type.schema;
  for (const node of [
    schema.nodes.heading.create({ blockKey: key }),
    schema.nodes.article_image.create({ blockKey: imageKey }),
    schema.nodes.blockquote.create(
      { blockKey: key },
      schema.nodes.paragraph.create({ blockKey: imageKey }),
    ),
  ]) {
    expect(() => schema.node('blockquote', { blockKey: key }, node)).toThrow();
    expect(() => schema.node('list_item', null, node)).toThrow();
  }
});
it('preserves independent marks on LF-only runs and pending image identity', () => {
  const value: ManualDraftV2 = {
    ...richDraft,
    blocks: [
      {
        type: 'paragraph',
        blockKey: key,
        content: [
          { type: 'text', text: 'A', marks: ['bold'] },
          { type: 'text', text: '\n\n', marks: ['italic'] },
          { type: 'text', text: 'B\n', marks: ['underline'] },
        ],
      },
      {
        type: 'image-pending',
        blockKey: imageKey,
        candidateId: '33333333-3333-4333-8333-333333333333',
      },
    ],
  };
  expect(editorToDraftV2(draftV2ToEditor(value), value)).toEqual(value);
});
it('unknown or colliding rich image grants are rejected and keys cannot come from a heading', () => {
  const doc = draftV2ToEditor(richDraft);
  expect(() => editorToDraftV2(doc, { ...richDraft, blocks: [] })).toThrow(
    'Unknown image key',
  );
  expect(() =>
    editorToDraftV2(doc, richDraft, [
      { type: 'heading', blockKey: imageKey, content: [] },
    ]),
  ).toThrow('Unknown image key');
});
it('V1 input conversion rejects a V2 payload instead of interpreting rich containers as images', () => {
  expect(() => draftToEditor(richDraft as unknown as ManualDraft)).toThrow(
    'V2',
  );
});
it('rejects PM positions on unkeyed list-item wrappers instead of drifting to a paragraph edge', () => {
  const doc = draftV2ToEditor(richDraft);
  let listPos = 0;
  doc.forEach((node, pos) => {
    if (node.type.name === 'ordered_list') listPos = pos;
  });
  expect(() =>
    rangeFromSelection(doc, { anchor: listPos + 1, head: listPos + 1 }),
  ).toThrow();
  expect(() => rangeFromSelection(doc, { anchor: 0.5, head: 0.5 })).toThrow();
});

it('production key repair assigns every nested container/leaf key before V2 serialization', async () => {
  const { keyedEditorBlocks } =
    await import('../../src/renderer/editor/ContinuousBodyEditor');
  const rich = {
    bodyVersion: 2 as const,
    title: '',
    contentDeclaration: 'repost' as const,
    blocks: [
      {
        type: 'list' as const,
        kind: 'ordered' as const,
        start: 7,
        blockKey: key,
        items: [
          {
            type: 'paragraph' as const,
            blockKey: imageKey,
            content: [
              {
                type: 'text' as const,
                text: 'item😀\nnext',
                marks: ['bold' as const, 'italic' as const],
              },
            ],
          },
        ],
      },
      {
        type: 'blockquote' as const,
        blockKey: '33333333-3333-4333-8333-333333333333',
        paragraphs: [
          {
            type: 'paragraph' as const,
            blockKey: '44444444-4444-4444-8444-444444444444',
            content: [
              {
                type: 'text' as const,
                text: 'quoted',
                marks: ['underline' as const],
              },
            ],
          },
        ],
      },
    ],
  };
  const state = EditorState.create({
    doc: draftV2ToEditor(rich),
    plugins: [keyedEditorBlocks],
  });
  const result = state.applyTransaction(
    state.tr.insert(state.doc.content.size, state.doc.content),
  );
  const decoded = editorToDraftV2(result.state.doc, rich);
  const keys = decoded.blocks.flatMap((b) => [
    b.blockKey,
    ...(b.type === 'list'
      ? b.items
      : b.type === 'blockquote'
        ? b.paragraphs
        : []
    ).map((p) => p.blockKey),
  ]);
  expect(keys).toHaveLength(8);
  expect(new Set(keys).size).toBe(8);
  expect(
    decoded.blocks
      .filter((b) => b.type === 'list' && b.kind === 'ordered')
      .map((b) => b.start),
  ).toEqual([7, 7]);
  const contentOnly = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (name, value) =>
        name === 'blockKey' ? undefined : value,
      ),
    );
  expect(contentOnly(decoded)).toEqual(
    contentOnly({ ...rich, blocks: [...rich.blocks, ...rich.blocks] }),
  );
  const empty = { ...rich, blocks: [] };
  const blank = EditorState.create({
    doc: draftV2ToEditor(empty),
    plugins: [keyedEditorBlocks],
  });
  const typed = blank.applyTransaction(blank.tr.insertText('字', 1)).state;
  const value = editorToDraftV2(typed.doc, empty);
  expect(value.blocks[0]).toMatchObject({
    type: 'paragraph',
    content: [{ text: '字', marks: [] }],
  });
  expect(JSON.stringify(value)).not.toContain(emptyEditorKey);
});
