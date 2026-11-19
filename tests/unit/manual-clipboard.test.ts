import { upgradeManualFragment } from '../../src/domain/manual-draft-version';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createManualClipboard,
  createClipboardFragmentPort,
} from '../../src/infrastructure/content/manual-clipboard';
import {
  encodeManualClipboardFragment,
  parseManualClipboardFragment,
} from '../../src/contracts/editor-close';
import type { ManualImageSource } from '../../src/domain/ports/manual-images';
import type { ManualImage } from '../../src/contracts/manual-article';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
afterEach(() => vi.useRealTimers());
function registry(byteSize = 1) {
  let n = 10;
  const owned = new Map<string, Map<string, ManualImage>>();
  const image = (imageToken: string): ManualImage => ({
    imageToken,
    byteSize,
    mime: 'image/png',
    width: 1,
    height: 1,
  });
  owned.set(id(1), new Map([[id(2), image(id(2))]]));
  const source = {
    async read(session: string, token: string) {
      if (!owned.get(session)?.has(token)) throw Error('Denied');
      return { mime: 'image/png', bytes: new Uint8Array([1]) };
    },
    async authorizeBytes(session: string) {
      const dto = image(id(++n));
      const entries = owned.get(session) ?? new Map();
      entries.set(dto.imageToken, dto);
      owned.set(session, entries);
      return dto;
    },
    async release(session: string) {
      owned.delete(session);
    },
    async retain(session: string, tokens: readonly string[]) {
      for (const token of owned.get(session)?.keys() ?? [])
        if (!tokens.includes(token)) owned.get(session)!.delete(token);
    },
  } as unknown as ManualImageSource;
  return { source, owned, image: image(id(2)) };
}
const blocks = [
  { type: 'paragraph' as const, blockKey: id(3), text: 'A<&' },
  { type: 'image' as const, blockKey: id(4), imageToken: id(2) },
];
it('cross_article_grant creates independent ownership that survives source close and never reuses tokens', async () => {
  const { source, owned, image } = registry();
  let grant = '';
  const store = createManualClipboard(source, {
    write: async (g, text) => {
      grant = g;
      expect(text).toBe('A<&\n[图片]');
    },
  });
  await store.copy(
    id(1),
    upgradeManualFragment(blocks),
    [image],
    new AbortController().signal,
  );
  await source.release(id(1));
  const copied = await store.paste(
    grant,
    id(5),
    new AbortController().signal,
    [],
  );
  expect(copied.images[0].imageToken).not.toBe(image.imageToken);
  expect(copied.fragment.blocks[1]).toMatchObject({
    imageToken: copied.images[0].imageToken,
  });
  expect(owned.has(id(1))).toBe(false);
  await expect(
    store.paste(id(99), id(5), new AbortController().signal, []),
  ).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  await store.drain();
  expect(owned.has(grant)).toBe(false);
});
it('failed replacement preserves the old valid grant and retires prepared ownership', async () => {
  const { source, owned, image } = registry();
  let grant = '',
    fail = false;
  const store = createManualClipboard(source, {
    write: async (g) => {
      if (fail) throw Error('Native contention');
      grant = g;
    },
  });
  await store.copy(
    id(1),
    upgradeManualFragment(blocks),
    [image],
    new AbortController().signal,
  );
  const before = grant;
  fail = true;
  await expect(
    store.copy(
      id(1),
      upgradeManualFragment(blocks),
      [image],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  expect(grant).toBe(before);
  expect(owned.size).toBe(2);
  expect(
    (await store.paste(before, id(5), new AbortController().signal, [])).images,
  ).toHaveLength(1);
  await store.drain();
});
it('reserves the old plus replacement image budget before preparing or writing', async () => {
  const { source, owned, image } = registry(10 * 1024 * 1024);
  const sourceImages = Array.from({ length: 12 }, (_, n) => ({
    ...image,
    imageToken: id(20 + n),
  }));
  owned.set(id(1), new Map(sourceImages.map((i) => [i.imageToken, i])));
  const manyBlocks = sourceImages.map((i, n) => ({
    type: 'image' as const,
    blockKey: id(40 + n),
    imageToken: i.imageToken,
  }));
  let writes = 0;
  const store = createManualClipboard(source, {
    write: async () => {
      writes++;
    },
  });
  await store.copy(
    id(1),
    upgradeManualFragment(manyBlocks),
    sourceImages,
    new AbortController().signal,
  );
  await expect(
    store.copy(
      id(1),
      upgradeManualFragment(manyBlocks),
      sourceImages,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'IMAGE_LIMIT' });
  expect(writes).toBe(1);
  await store.drain();
});
it('expiry waits for an owned read, then revokes the grant without dropping returned target ownership', async () => {
  vi.useFakeTimers();
  const { source, owned, image } = registry();
  let grant = '',
    releaseRead!: () => void;
  const store = createManualClipboard(source, {
    write: async (g) => {
      grant = g;
    },
  });
  await store.copy(
    id(1),
    upgradeManualFragment(blocks),
    [image],
    new AbortController().signal,
  );
  const original = source.read;
  source.read = async (...args) => {
    await new Promise<void>((r) => {
      releaseRead = r;
    });
    return original(...args);
  };
  const paste = store.paste(grant, id(5), new AbortController().signal, []);
  await vi.advanceTimersByTimeAsync(600_001);
  expect(owned.has(grant)).toBe(true);
  expect(store.isReady()).toBe(false);
  releaseRead();
  expect((await paste).images).toHaveLength(1);
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(owned.has(grant)).toBe(false);
  expect(store.isReady()).toBe(true);
  await expect(
    store.paste(grant, id(5), new AbortController().signal, []),
  ).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  await store.drain();
});
it('timer cleanup failure closes readiness immediately, even without another Copy', async () => {
  vi.useFakeTimers();
  const { source, image } = registry();
  const store = createManualClipboard(source, { write: async () => {} });
  await store.copy(
    id(1),
    upgradeManualFragment(blocks),
    [image],
    new AbortController().signal,
  );
  source.release = async () => {
    throw Error('Owned cleanup unknown');
  };
  await vi.advanceTimersByTimeAsync(600_001);
  expect(store.isReady()).toBe(false);
  await expect(store.drain()).rejects.toThrow();
});
it.each(['silent-write', 'text-mismatch', 'marker-mismatch', 'throw'] as const)(
  'native fragment port rejects %s before a cut can succeed',
  async (mode) => {
    let actual = { text: 'old', html: 'old' };
    const port = createClipboardFragmentPort({
      write: async (data) => {
        if (mode === 'throw') throw Error('Native unavailable');
        if (mode !== 'silent-write')
          actual = {
            ...data,
            ...(mode === 'text-mismatch'
              ? { text: 'foreign' }
              : mode === 'marker-mismatch'
                ? { html: 'foreign' }
                : {}),
          };
      },
      readBack: async () => actual,
    });
    await expect(port.write(id(10), 'new')).rejects.toThrow();
  },
);
it('native fragment port writes one escaped owned batch and accepts exact readback', async () => {
  let actual = { text: '', html: '' },
    writes = 0;
  const port = createClipboardFragmentPort({
    write: async (data) => {
      writes++;
      actual = data;
    },
    readBack: async () => actual,
  });
  await port.write(id(10), '<img src="private">');
  expect(writes).toBe(1);
  expect(actual.html).not.toContain('<img');
  expect(parseManualClipboardFragment(actual.html)).toBe(id(10));
  expect(
    parseManualClipboardFragment(
      encodeManualClipboardFragment(id(10), 'x') +
        encodeManualClipboardFragment(id(11), 'y'),
    ),
  ).toBeUndefined();
});

it('versioned rich grant retains open ends, actual list start, deep copies and rekeys nested leaves', async () => {
  const { source } = registry();
  let grant = '';
  let selectedText = '';
  const store = createManualClipboard(source, {
    write: async (g, text) => {
      grant = g;
      selectedText = text;
    },
  });
  const fragment = {
    version: 2 as const,
    openStart: true,
    openEnd: true,
    blocks: [
      {
        type: 'list' as const,
        kind: 'ordered' as const,
        start: 8,
        blockKey: id(70),
        items: [
          {
            type: 'paragraph' as const,
            blockKey: id(71),
            content: [
              {
                type: 'text' as const,
                text: '😀\nX',
                marks: ['bold' as const],
              },
            ],
          },
        ],
      },
    ],
  };
  await store.copy(id(1), fragment, [], new AbortController().signal);
  fragment.blocks[0].items[0].content[0].text = 'mutated';
  const pasted = await store.paste(
    grant,
    id(5),
    new AbortController().signal,
    [],
  );
  expect(pasted.fragment).toMatchObject({
    version: 2,
    openStart: true,
    openEnd: true,
    blocks: [
      {
        type: 'list',
        kind: 'ordered',
        start: 8,
        items: [{ content: [{ text: '😀\nX', marks: ['bold'] }] }],
      },
    ],
  });
  expect(selectedText).toBe('😀\nX');
  const list = pasted.fragment.blocks[0];
  expect(list.blockKey).not.toBe(id(70));
  if (list.type !== 'list') throw Error('Expected list');
  expect(list.items[0].blockKey).not.toBe(id(71));
  list.items[0].content[0].marks = [];
  const second = await store.paste(
    grant,
    id(6),
    new AbortController().signal,
    [],
  );
  expect(second.fragment.blocks[0]).toMatchObject({
    items: [{ content: [{ marks: ['bold'] }] }],
  });
  await store.drain();
});
it('versioned grant preserves closed whole paragraph boundaries', async () => {
  const { source } = registry();
  let grant = '';
  const store = createManualClipboard(source, {
    write: async (g) => {
      grant = g;
    },
  });
  const fragment = {
    version: 2 as const,
    openStart: false,
    openEnd: false,
    blocks: [
      {
        type: 'paragraph' as const,
        blockKey: id(50),
        content: [{ type: 'text' as const, text: 'whole', marks: [] }],
      },
    ],
  };
  await store.copy(id(1), fragment, [], new AbortController().signal);
  expect(
    (await store.paste(grant, id(5), new AbortController().signal, []))
      .fragment,
  ).toMatchObject({ openStart: false, openEnd: false });
  await store.drain();
});

it('cancelled late native copy cannot replace the active grant or authorize a later paste', async () => {
  const { source, image } = registry();
  let grant = '';
  let release!: () => void;
  let delay = false;
  const store = createManualClipboard(source, {
    write: async (g) => {
      if (delay)
        await new Promise<void>((r) => {
          release = r;
        });
      grant = g;
    },
  });
  await store.copy(
    id(1),
    upgradeManualFragment(blocks),
    [image],
    new AbortController().signal,
  );
  const previous = grant;
  delay = true;
  const abort = new AbortController();
  const copying = store.copy(
    id(1),
    upgradeManualFragment(blocks),
    [image],
    abort.signal,
  );
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  abort.abort();
  release();
  await expect(copying).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(
    store.paste(grant, id(5), new AbortController().signal, []),
  ).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  expect(
    (await store.paste(previous, id(5), new AbortController().signal, []))
      .fragment.blocks,
  ).toHaveLength(2);
  await store.drain();
});
it('aborted late image authorization is retained out of the destination and never returned', async () => {
  const { source, image, owned } = registry();
  let grant = '';
  const store = createManualClipboard(source, {
    write: async (g) => {
      grant = g;
    },
  });
  await store.copy(
    id(1),
    upgradeManualFragment(blocks),
    [image],
    new AbortController().signal,
  );
  const authorize = source.authorizeBytes;
  let release!: () => void;
  source.authorizeBytes = async (...args) => {
    const value = await authorize(...args);
    await new Promise<void>((r) => {
      release = r;
    });
    return value;
  };
  const abort = new AbortController();
  const pasting = store.paste(grant, id(5), abort.signal, []);
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  abort.abort();
  release();
  await expect(pasting).rejects.toThrow();
  expect(owned.get(id(5))?.size ?? 0).toBe(0);
  await store.drain();
});
