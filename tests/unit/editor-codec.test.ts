import { expect, it, vi, afterEach } from 'vitest';
import type { ManualDraft } from '../../src/contracts/manual-article';
import {
  draftToEditor,
  editorToDraft,
  rangeFromSelection,
} from '../../src/renderer/editor/editor-codec';
import { TextSelection } from 'prosemirror-state';
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
    draft,
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
  core.change({ ...draft, title: 'latest' });
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
  core.change({ ...draft, title: ' raw ' });
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
  core.change({ ...draft, title: '未确认' });
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
  core.change({ ...draft, title: '保留' });
  expect(await core.flush()).toBe(false);
  expect(core.unknown).toBe(true);
  expect(core.draft?.title).toBe('保留');
  core.accept({
    ...session(),
    revision: 2,
    nextClientSequence: 20,
    nextEditCommandId: key,
    acknowledgedEdit: { commandId: imageKey, clientSequence: 19 },
    draft: { ...draft, title: '保留' },
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
    core.change({ ...draft, title: 'retained unsaved input' });
    const old = core.flush();
    await Promise.resolve();
    core.initializeAfterStop();
    expect(core.draft?.title).toBe('retained unsaved input');
    core.change({ ...draft, title: 'fresh explicit input' });
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
