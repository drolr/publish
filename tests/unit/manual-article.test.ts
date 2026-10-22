import { expect, it, vi, afterEach } from 'vitest';
import {
  createManualArticleController,
  type ManualArticleControllerPorts,
} from '../../src/application/manual-article';
import type {
  ManualDraft,
  ManualImage,
  ManualState,
} from '../../src/contracts/manual-article';
import { manualResponses } from '../../src/contracts/manual-article';
import type { ImportResult } from '../../src/application/article-import';
import { ImportFailure } from '../../src/domain/import-error';
import { WebPasteFailure } from '../../src/domain/web-paste-error';
import { manualArticleInput } from '../../src/application/manual-article-mapper';
afterEach(() => vi.useRealTimers());

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const image: ManualImage = {
  imageToken: uuid(90),
  mime: 'image/png',
  width: 1,
  height: 1,
  byteSize: 10,
};
const draft: ManualDraft = {
  title: '人工文章',
  contentDeclaration: 'repost',
  blocks: [{ blockKey: uuid(80), type: 'paragraph', text: '正文' }],
};
const imported: ImportResult = {
  status: 'imported',
  article: {
    articleKey: uuid(70),
    importId: uuid(71),
    externalId: 'manual-' + uuid(2),
    title: '人工文章',
    body: [{ type: 'paragraph', text: '正文' }],
    assets: [],
    contentDeclaration: 'repost',
    createdAt: '2026-09-16T00:00:00.000Z',
  },
  warnings: [],
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function flush() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
}
function session(state: ManualState) {
  if (!('sessionId' in state)) throw new Error('Expected session');
  return state;
}
function setup(overrides: Partial<ManualArticleControllerPorts> = {}) {
  let next = 0;
  const ports: ManualArticleControllerPorts = {
    newId: () => uuid(++next),
    externalExists: () => false,
    gate: () => 'ready',
    chooseImage: async () => undefined,
    readImage: async () => ({ mime: 'image/png', bytes: new Uint8Array([1]) }),
    retainImages: vi.fn(async () => {}),
    releaseImages: vi.fn(async () => {}),
    save: vi.fn(async () => imported),
    converter: {
      convert: async () => ({
        blocks: [{ type: 'paragraph', text: '新正文' }],
        plainOnly: false,
      }),
    },
    pasteImages: { acquire: async () => image },
    fingerprint: (value) => JSON.stringify(value),
    ...overrides,
  };
  const controller = createManualArticleController(ports);
  const begin = async () =>
    session((await controller.beginManualArticle()).snapshot);
  const edit = async () => {
    const initial = await begin();
    return session(
      (
        await controller.updateManualDraft(
          initial.sessionId,
          initial.revision,
          draft,
        )
      ).snapshot,
    );
  };
  return { controller, ports, begin, edit };
}
const command = (state: ReturnType<typeof session>) => ({
  sessionId: state.sessionId,
  expectedRevision: state.revision,
  commandId: state.nextPasteCommandId,
});
const pasteInput = { html: '<p>新正文</p>', plain: '新正文' };
it('admits all once and replays only the original command identity, then appends a new command', async () => {
  const { controller, begin } = setup();
  const first = await begin();
  const original = command(first);
  const started = await controller.startManualPaste(original, pasteInput);
  const replay = await controller.startManualPaste(original, pasteInput);
  expect(replay.status).toBe('ok');
  expect(session(replay.snapshot).jobId).toBe(session(started.snapshot).jobId);
  await flush();
  const after = session(controller.getManualArticleState());
  expect(after.draft.blocks).toEqual([
    { blockKey: expect.any(String), type: 'paragraph', text: '新正文' },
  ]);
  expect(
    (
      await controller.startManualPaste(original, {
        ...pasteInput,
        plain: 'different',
      })
    ).status,
  ).toBe('conflict');
  expect(
    (
      await controller.startManualPaste(
        { ...original, expectedRevision: after.revision },
        pasteInput,
      )
    ).status,
  ).toBe('conflict');
  expect(
    (
      await controller.startManualPaste(
        { ...command(after), sessionId: uuid(999) },
        pasteInput,
      )
    ).status,
  ).toBe('conflict');
  await controller.startManualPaste(command(after), pasteInput);
  await flush();
  expect(session(controller.getManualArticleState()).draft.blocks).toHaveLength(
    2,
  );
  expect((await controller.startManualPaste(original, pasteInput)).status).toBe(
    'conflict',
  );
});
it('keeps old title/declaration/blocks and retries only a failed middle image in the same position', async () => {
  const sources: string[] = [];
  let middleFails = true;
  const { controller, edit } = setup({
    converter: {
      convert: async () => ({
        blocks: [
          { type: 'paragraph', text: 'new' },
          ...['a', 'b', 'c'].map((s) => ({
            type: 'image' as const,
            source: `https://example.com/${s}`,
          })),
        ],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async (_, source) => {
        sources.push(source);
        if (source.endsWith('/b') && middleFails)
          throw new WebPasteFailure('IMAGE_NETWORK');
        return { ...image, imageToken: uuid(100 + sources.length) };
      },
    },
  });
  const first = await edit();
  await controller.startManualPaste(command(first), pasteInput);
  for (let i = 0; i < 10; i++) await flush();
  const after = session(controller.getManualArticleState());
  expect(after.draft.blocks[0]).toEqual(draft.blocks[0]);
  expect(after.draft.title).toBe(draft.title);
  expect(after.draft.contentDeclaration).toBe('repost');
  expect(after.draft.blocks.map((b) => b.type)).toEqual([
    'paragraph',
    'paragraph',
    'image',
    'image-pending',
    'image',
  ]);
  expect(after.candidates).toHaveLength(1);
  expect(after.candidates[0]).toMatchObject({
    reason: 'IMAGE_NETWORK',
    retryable: true,
  });
  expect(
    controller.saveManualArticle(after.sessionId, after.revision).status,
  ).toBe('invalid');
  middleFails = false;
  await controller.retryManualPasteImage(
    command(after),
    after.candidates[0].candidateId,
  );
  for (let i = 0; i < 5; i++) await flush();
  const retried = session(controller.getManualArticleState());
  expect(retried.candidates).toEqual([]);
  expect(retried.draft.blocks.map((b) => b.blockKey)).toEqual(
    after.draft.blocks.map((b) => b.blockKey),
  );
  expect(sources.map((s) => s.at(-1))).toEqual(['a', 'b', 'c', 'b']);
  expect(JSON.stringify(retried)).not.toContain('https://');
});
it('cancellation before admission retains initial body; cancellation after admission awaits late ready cleanup', async () => {
  const converted = deferred<{
    blocks: { type: 'paragraph'; text: string }[];
    plainOnly: boolean;
  }>();
  const early = setup({ converter: { convert: () => converted.promise } });
  const initial = await early.begin();
  const started = session(
    (await early.controller.startManualPaste(command(initial), pasteInput))
      .snapshot,
  );
  early.controller.cancelManualOperation(initial.sessionId, started.jobId!);
  converted.resolve({
    blocks: [{ type: 'paragraph', text: 'new' }],
    plainOnly: false,
  });
  await flush();
  expect(session(early.controller.getManualArticleState()).draft).toEqual(
    initial.draft,
  );
  const acquired = deferred<ManualImage>();
  const retained = deferred<void>();
  let cleaning = false;
  const late = setup({
    converter: {
      convert: async () => ({
        blocks: [
          { type: 'paragraph', text: 'new' },
          { type: 'image', source: 'https://example.com/a' },
          { type: 'image', source: 'https://example.com/b' },
        ],
        plainOnly: false,
      }),
    },
    pasteImages: { acquire: () => acquired.promise },
    retainImages: async () => {
      cleaning = true;
      await retained.promise;
    },
  });
  const first = await late.begin();
  await late.controller.startManualPaste(command(first), pasteInput);
  await flush();
  const busy = session(late.controller.getManualArticleState());
  late.controller.cancelManualOperation(first.sessionId, busy.jobId!);
  acquired.resolve(image);
  await flush();
  expect(cleaning).toBe(true);
  expect(late.controller.isActive()).toBe(true);
  expect(session(late.controller.getManualArticleState()).images).toEqual([]);
  retained.resolve();
  for (let i = 0; i < 4; i++) await flush();
  const after = session(late.controller.getManualArticleState());
  expect(after.draft.blocks).toHaveLength(3);
  expect(after.candidates.map((c) => c.state)).toEqual([
    'cancelled',
    'cancelled',
  ]);
  expect(late.controller.isActive()).toBe(false);
});
it('counts failed candidates before opening a local picker and refuses meaningless retry', async () => {
  let picks = 0;
  const { controller, begin } = setup({
    converter: {
      convert: async () => ({
        blocks: Array.from({ length: 200 }, () => ({
          type: 'image' as const,
          source: undefined,
        })),
        plainOnly: false,
      }),
    },
    chooseImage: async () => {
      picks++;
      return image;
    },
  });
  const first = await begin();
  await controller.startManualPaste(command(first), pasteInput);
  for (let i = 0; i < 100; i++) await flush();
  const after = session(controller.getManualArticleState());
  expect(after.candidates).toHaveLength(200);
  expect(
    controller.pickManualImage(after.sessionId, after.revision).status,
  ).toBe('invalid');
  expect(picks).toBe(0);
  expect(
    (
      await controller.retryManualPasteImage(
        command(after),
        after.candidates[0].candidateId,
      )
    ).status,
  ).toBe('invalid');
});
it('does not replace an initial block that has ceased to be the pristine initial body', async () => {
  const { controller, begin } = setup();
  const initial = await begin();
  const changed = session(
    (
      await controller.updateManualDraft(initial.sessionId, initial.revision, {
        ...initial.draft,
        blocks: [
          ...initial.draft.blocks,
          { blockKey: uuid(900), type: 'paragraph', text: '曾有正文' },
        ],
      })
    ).snapshot,
  );
  const removed = session(
    (
      await controller.updateManualDraft(
        changed.sessionId,
        changed.revision,
        initial.draft,
      )
    ).snapshot,
  );
  await controller.startManualPaste(command(removed), pasteInput);
  await flush();
  const after = session(controller.getManualArticleState());
  expect(after.draft.blocks).toHaveLength(2);
  expect(after.draft.blocks[0]).toEqual(initial.draft.blocks[0]);
});
it.each(['blocks', 'text', 'images', 'paragraph'] as const)(
  'rejects the complete admission when combined %s budget overflows',
  async (limit) => {
    let acquisitions = 0;
    const { controller, begin } = setup({
      converter: {
        convert: async () => ({
          blocks:
            limit === 'images'
              ? Array.from({ length: 201 }, () => ({
                  type: 'image' as const,
                  source: 'https://example.com/a',
                }))
              : [
                  {
                    type: 'paragraph',
                    text: limit === 'paragraph' ? '😀'.repeat(20001) : 'x',
                  },
                  { type: 'image', source: 'https://example.com/a' },
                ],
          plainOnly: false,
        }),
      },
      pasteImages: {
        acquire: async () => {
          acquisitions++;
          return image;
        },
      },
    });
    const initial = await begin();
    const blocks: ManualDraft['blocks'] =
      limit === 'blocks'
        ? Array.from({ length: 1000 }, (_, i) => ({
            blockKey: uuid(1000 + i),
            type: 'paragraph',
            text: '',
          }))
        : limit === 'text'
          ? Array.from({ length: 10 }, (_, i) => ({
              blockKey: uuid(1000 + i),
              type: 'paragraph',
              text: '😀'.repeat(20000),
            }))
          : initial.draft.blocks;
    const before = session(
      (
        await controller.updateManualDraft(
          initial.sessionId,
          initial.revision,
          { ...initial.draft, blocks },
        )
      ).snapshot,
    );
    await controller.startManualPaste(command(before), pasteInput);
    await flush();
    const after = session(controller.getManualArticleState());
    expect(after.draft).toEqual(before.draft);
    expect(after.pasteSummary).toMatchObject({
      admitted: false,
      outcome: 'rejected',
      reason: 'INPUT_LIMIT',
    });
    expect(acquisitions).toBe(0);
  },
);
it('schema rejection does not consume its token, and plain-only admission reports its origin', async () => {
  const { controller, begin } = setup({
    converter: {
      convert: async () => ({
        blocks: [{ type: 'paragraph', text: 'plain' }],
        plainOnly: true,
      }),
    },
  });
  const initial = await begin();
  expect(
    (
      await controller.startManualPaste(command(initial), {
        html: '中'.repeat(750000),
        plain: '',
      })
    ).status,
  ).toBe('invalid');
  expect(controller.getManualArticleState()).toEqual(initial);
  await controller.startManualPaste(command(initial), {
    html: '',
    plain: 'plain',
  });
  await flush();
  expect(
    session(controller.getManualArticleState()).pasteSummary,
  ).toMatchObject({ outcome: 'completed', plainOnly: true });
});
it('parses the same input snapshot used by command identity even if the caller mutates its object', async () => {
  const { controller, begin } = setup({
    converter: {
      convert: async (input) => ({
        blocks: [{ type: 'paragraph', text: input.plain }],
        plainOnly: true,
      }),
    },
  });
  const initial = await begin();
  const input = { html: '', plain: 'original' };
  const request = controller.startManualPaste(command(initial), input);
  input.plain = 'changed';
  await request;
  await flush();
  expect(session(controller.getManualArticleState()).draft.blocks).toEqual([
    { blockKey: expect.any(String), type: 'paragraph', text: 'original' },
  ]);
});
it('an immediately cancelled retry retains exactly one unresolved cancelled position', async () => {
  const { controller, begin } = setup({
    converter: {
      convert: async () => ({
        blocks: [{ type: 'image', source: 'https://example.com/a' }],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async () => {
        throw new WebPasteFailure('IMAGE_NETWORK');
      },
    },
  });
  const first = await begin();
  await controller.startManualPaste(command(first), pasteInput);
  await flush();
  const failed = session(controller.getManualArticleState());
  const retry = controller.retryManualPasteImage(
    command(failed),
    failed.candidates[0].candidateId,
  );
  const active = session(controller.getManualArticleState());
  controller.cancelManualOperation(active.sessionId, active.jobId!);
  await retry;
  await flush();
  const after = session(controller.getManualArticleState());
  expect(after.candidates[0]).toMatchObject({
    state: 'cancelled',
    reason: 'CANCELLED',
    retryable: true,
  });
  expect(after.pasteSummary).toMatchObject({
    kind: 'retry',
    outcome: 'cancelled',
    admitted: true,
    unresolved: 1,
  });
});
it('a deadline leaves no late authorization and freezes writes until its delayed retain settles', async () => {
  vi.useFakeTimers();
  const acquired = deferred<ManualImage>();
  const retained = deferred<void>();
  let calls = 0;
  const { controller, begin } = setup({
    converter: {
      convert: async () => ({
        blocks: [
          { type: 'paragraph', text: 'text' },
          { type: 'image', source: 'https://example.com/a' },
          { type: 'image', source: 'https://example.com/b' },
        ],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async () => {
        calls++;
        return acquired.promise;
      },
    },
    retainImages: () => retained.promise,
  });
  const initial = await begin();
  await controller.startManualPaste(command(initial), pasteInput);
  await flush();
  await vi.advanceTimersByTimeAsync(600000);
  acquired.resolve(image);
  await flush();
  const busy = session(controller.getManualArticleState());
  expect(controller.isActive()).toBe(true);
  expect(controller.pickManualImage(busy.sessionId, busy.revision).status).toBe(
    'busy',
  );
  expect(
    (await controller.discardManualArticle(busy.sessionId, busy.revision))
      .status,
  ).toBe('busy');
  expect(busy.images).toEqual([]);
  expect(calls).toBe(1);
  retained.resolve();
  for (let i = 0; i < 5; i++) await flush();
  const after = session(controller.getManualArticleState());
  expect(after.candidates.map((c) => c.reason)).toEqual([
    'OPERATION_TIMEOUT',
    'OPERATION_TIMEOUT',
  ]);
  expect(after.pasteSummary).toMatchObject({
    outcome: 'partial',
    reason: 'OPERATION_TIMEOUT',
  });
  expect(controller.isActive()).toBe(false);
});
it('holds the writer when cancel arrives during successful ready retain and cleans before continuing', async () => {
  const retained = deferred<void>();
  const cleaned = deferred<void>();
  let retains = 0;
  let acquisitions = 0;
  const { controller, begin } = setup({
    converter: {
      convert: async () => ({
        blocks: [
          { type: 'image', source: 'https://example.com/a' },
          { type: 'image', source: 'https://example.com/b' },
        ],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async () => {
        acquisitions++;
        return image;
      },
    },
    retainImages: () => (++retains === 1 ? retained.promise : cleaned.promise),
  });
  const initial = await begin();
  await controller.startManualPaste(command(initial), pasteInput);
  await flush();
  const busy = session(controller.getManualArticleState());
  expect(busy.images).toEqual([]);
  controller.cancelManualOperation(busy.sessionId, busy.jobId!);
  retained.resolve();
  await flush();
  expect(controller.isActive()).toBe(true);
  expect(acquisitions).toBe(1);
  expect(session(controller.getManualArticleState()).images).toEqual([]);
  cleaned.resolve();
  for (let i = 0; i < 4; i++) await flush();
  expect(
    session(controller.getManualArticleState()).candidates.map((c) => c.state),
  ).toEqual(['cancelled', 'cancelled']);
  expect(controller.isActive()).toBe(false);
});
it('unknown resource settlement stops subsequent images and denies every new write', async () => {
  let acquired = 0;
  const { controller, begin } = setup({
    converter: {
      convert: async () => ({
        blocks: [
          { type: 'image', source: 'https://example.com/a' },
          { type: 'image', source: 'https://example.com/b' },
        ],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async () => {
        acquired++;
        return image;
      },
    },
    retainImages: async () => {
      throw new Error('secret');
    },
  });
  const first = await begin();
  const original = command(first);
  await controller.startManualPaste(original, pasteInput);
  for (let i = 0; i < 4; i++) await flush();
  const after = session(controller.getManualArticleState());
  expect(controller.isBlocked()).toBe(true);
  expect(after.images).toEqual([]);
  expect(acquired).toBe(1);
  expect((await controller.startManualPaste(original, pasteInput)).status).toBe(
    'ok',
  );
  expect(
    (await controller.startManualPaste(command(after), pasteInput)).status,
  ).toBe('unavailable');
  expect(after.pasteSummary?.reason).toBe('RECOVERY_REQUIRED');
  expect(JSON.stringify(after)).not.toContain('secret');
});
it('removing unresolved positions clears the save gate but preserves final content validation and rejects pending mapping', async () => {
  const { controller, begin, ports } = setup({
    converter: {
      convert: async () => ({
        blocks: [{ type: 'image', source: undefined }],
        plainOnly: false,
      }),
    },
  });
  const first = await begin();
  await controller.startManualPaste(command(first), pasteInput);
  await flush();
  const after = session(controller.getManualArticleState());
  expect(() => manualArticleInput(after)).toThrow();
  const candidate = after.candidates[0];
  expect(
    (
      await controller.updateManualDraft(after.sessionId, after.revision, {
        ...after.draft,
        blocks: [
          {
            type: 'image-pending',
            blockKey: uuid(900),
            candidateId: candidate.candidateId,
          },
        ],
      })
    ).status,
  ).toBe('invalid');
  const removed = session(
    (
      await controller.updateManualDraft(after.sessionId, after.revision, {
        ...after.draft,
        blocks: after.draft.blocks.filter((b) => b.type !== 'image-pending'),
      })
    ).snapshot,
  );
  expect(removed.candidates).toEqual([]);
  expect(
    (
      await controller.retryManualPasteImage(
        command(removed),
        candidate.candidateId,
      )
    ).status,
  ).toBe('invalid');
  controller.saveManualArticle(removed.sessionId, removed.revision);
  await flush();
  expect(session(controller.getManualArticleState()).result?.status).toBe(
    'invalid',
  );
  expect(ports.save).not.toHaveBeenCalled();
});
it('keeps repeated existing image tokens as one independent image while counting each new position', async () => {
  // Keep generated command/block IDs disjoint from the fixed 80/90/900 data IDs.
  let generated = 1000;
  const { controller, edit } = setup({
    newId: () => uuid(++generated),
    chooseImage: async () => image,
    converter: {
      convert: async () => ({
        blocks: Array.from({ length: 199 }, () => ({
          type: 'image' as const,
          source: undefined,
        })),
        plainOnly: false,
      }),
    },
  });
  const first = await edit();
  controller.pickManualImage(first.sessionId, first.revision);
  await flush();
  const picked = session(controller.getManualArticleState());
  const repeated = session(
    (
      await controller.updateManualDraft(picked.sessionId, picked.revision, {
        ...picked.draft,
        blocks: [
          ...picked.draft.blocks,
          { type: 'image', blockKey: uuid(900), imageToken: image.imageToken },
        ],
      })
    ).snapshot,
  );
  await controller.startManualPaste(command(repeated), pasteInput);
  for (let i = 0; i < 100; i++) await flush();
  const after = session(controller.getManualArticleState());
  expect(after.images).toHaveLength(1);
  expect(after.candidates).toHaveLength(199);
  expect(after.draft.blocks.filter((b) => b.type === 'image')).toHaveLength(2);
  expect(
    controller.pickManualImage(after.sessionId, after.revision).status,
  ).toBe('invalid');
});
it('image byte overflow preserves its position without stopping smaller following images', async () => {
  let n = 0;
  const { controller, begin } = setup({
    converter: {
      convert: async () => ({
        blocks: Array.from({ length: 13 }, (_, i) => ({
          type: 'image' as const,
          source: `https://example.com/${i}`,
        })),
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async () => ({
        ...image,
        imageToken: uuid(100 + ++n),
        byteSize: n === 13 ? 1 : n <= 10 ? 19 * 1024 * 1024 : 20 * 1024 * 1024,
      }),
    },
  });
  const first = await begin();
  await controller.startManualPaste(command(first), pasteInput);
  for (let i = 0; i < 30; i++) await flush();
  const after = session(controller.getManualArticleState());
  expect(after.images).toHaveLength(11);
  expect(after.candidates).toHaveLength(2);
  expect(
    after.candidates.every((c) => c.reason === 'IMAGE_LIMIT' && !c.retryable),
  ).toBe(true);
  expect(n).toBe(13);
});
it('starts with an empty paragraph ready for input without claiming unsaved edits', async () => {
  const { begin, controller } = setup();
  const state = await begin();
  expect(state.draft.blocks).toEqual([
    { blockKey: expect.any(String), type: 'paragraph', text: '' },
  ]);
  expect(controller.hasUnsavedChanges()).toBe(false);
});
it('reserves one session, recovers acknowledged input and isolates snapshot clones', async () => {
  const { controller, edit } = setup();
  const state = await edit();
  expect((await controller.beginManualArticle()).snapshot).toEqual(state);
  state.draft.title = 'changed';
  state.images.push(image);
  expect(session(controller.getManualArticleState()).draft.title).toBe(
    '人工文章',
  );
  expect(session(controller.getManualArticleState()).images).toEqual([]);
  expect(controller.hasSession()).toBe(true);
  expect(controller.hasUnsavedChanges()).toBe(true);
  expect(
    manualResponses.getManualArticleState.safeParse(
      controller.getManualArticleState(),
    ).success,
  ).toBe(true);
});
it('rejects stale and foreign updates without overwriting acknowledged content', async () => {
  const { controller, begin } = setup();
  const first = await begin();
  const edited = await controller.updateManualDraft(
    first.sessionId,
    first.revision,
    draft,
  );
  expect(
    (
      await controller.updateManualDraft(first.sessionId, first.revision, {
        ...draft,
        title: 'stale',
      })
    ).status,
  ).toBe('conflict');
  expect(
    (
      await controller.updateManualDraft(
        uuid(99),
        edited.snapshot.revision,
        draft,
      )
    ).status,
  ).toBe('unavailable');
  expect(controller.getManualArticleState()).toEqual(edited.snapshot);
});
it('allows empty temporary input but rejects foreign image tokens and privileged fields', async () => {
  const { controller, begin } = setup();
  const state = await begin();
  expect(
    (
      await controller.updateManualDraft(state.sessionId, state.revision, {
        ...draft,
        title: '',
        blocks: [],
      })
    ).status,
  ).toBe('ok');
  const now = controller.getManualArticleState();
  expect(
    (
      await controller.updateManualDraft(state.sessionId, now.revision, {
        ...draft,
        blocks: [{ blockKey: uuid(88), type: 'image', imageToken: uuid(99) }],
      })
    ).status,
  ).toBe('invalid');
  expect(
    (
      await controller.updateManualDraft(state.sessionId, now.revision, {
        ...draft,
        path: 'C:/secret',
      } as ManualDraft)
    ).status,
  ).toBe('invalid');
  expect(JSON.stringify(controller.getManualArticleState())).not.toContain(
    'secret',
  );
});
it('resolves external identifier collision before session creation and fails closed when lookup fails', async () => {
  const { begin } = setup({
    externalExists: (id) => id === 'manual-' + uuid(2),
  });
  expect((await begin()).externalId).toBe('manual-' + uuid(3));
  expect(
    (
      await setup({
        externalExists: () => {
          throw new Error('private');
        },
      }).controller.beginManualArticle()
    ).status,
  ).toBe('unavailable');
  expect(
    (
      await setup({
        externalExists: () => true,
      }).controller.beginManualArticle()
    ).status,
  ).toBe('unavailable');
});
it('checks external operation gates and keeps an existing session during a transient close prompt', async () => {
  let gate: 'ready' | 'busy' | 'unavailable' = 'busy';
  const { controller, begin } = setup({ gate: () => gate });
  expect((await controller.beginManualArticle()).status).toBe('busy');
  gate = 'ready';
  const state = await begin();
  gate = 'unavailable';
  expect(
    (await controller.updateManualDraft(state.sessionId, state.revision, draft))
      .status,
  ).toBe('unavailable');
  gate = 'ready';
  expect((await controller.beginManualArticle()).snapshot).toEqual(state);
  expect(
    (await controller.updateManualDraft(state.sessionId, state.revision, draft))
      .status,
  ).toBe('ok');
});
it('serializes selection and saving and appends only verified images atomically', async () => {
  const pick = deferred<ManualImage | undefined>();
  const { controller, edit } = setup({ chooseImage: () => pick.promise });
  const state = await edit();
  const started = controller.pickManualImage(state.sessionId, state.revision);
  expect(started.status).toBe('started');
  expect(
    controller.saveManualArticle(state.sessionId, started.snapshot.revision)
      .status,
  ).toBe('busy');
  expect(
    (
      await controller.updateManualDraft(
        state.sessionId,
        started.snapshot.revision,
        draft,
      )
    ).status,
  ).toBe('busy');
  expect(
    (
      await controller.discardManualArticle(
        state.sessionId,
        started.snapshot.revision,
      )
    ).status,
  ).toBe('busy');
  pick.resolve(image);
  await flush();
  const after = session(controller.getManualArticleState());
  expect(after.state).toBe('editing');
  expect(after.images).toEqual([image]);
  expect(after.draft.blocks[1]).toMatchObject({
    type: 'image',
    imageToken: image.imageToken,
  });
});
it('does not change draft after selection cancellation and revokes a late image authorization', async () => {
  const pick = deferred<ManualImage | undefined>();
  const retain = vi.fn(async () => {});
  const { controller, edit } = setup({
    chooseImage: () => pick.promise,
    retainImages: retain,
  });
  const state = await edit();
  const started = session(
    controller.pickManualImage(state.sessionId, state.revision).snapshot,
  );
  await flush();
  controller.cancelManualOperation(state.sessionId, started.jobId!);
  pick.resolve(image);
  await flush();
  expect(session(controller.getManualArticleState()).draft).toEqual(draft);
  expect(retain).toHaveBeenLastCalledWith(state.sessionId, []);
});
it('sanitizes image picker failures and leaves acknowledged text editable', async () => {
  const { controller, edit } = setup({
    chooseImage: async () => {
      throw new Error('C:/secret');
    },
  });
  const state = await edit();
  controller.pickManualImage(state.sessionId, state.revision);
  await flush();
  const after = session(controller.getManualArticleState());
  expect(after.state).toBe('editing');
  expect(after.draft).toEqual(draft);
  expect(after.issues?.length).toBeGreaterThan(0);
  expect(JSON.stringify(after)).not.toContain('secret');
});
it('retains repeated image references until the last one is removed and denies expired tokens', async () => {
  const { controller, edit, ports } = setup({ chooseImage: async () => image });
  const state = await edit();
  controller.pickManualImage(state.sessionId, state.revision);
  await flush();
  let now = session(controller.getManualArticleState());
  const imageBlock = now.draft.blocks[1];
  now = session(
    (
      await controller.updateManualDraft(now.sessionId, now.revision, {
        ...draft,
        blocks: [
          ...draft.blocks,
          imageBlock,
          { ...imageBlock, blockKey: uuid(81) },
        ],
      })
    ).snapshot,
  );
  now = session(
    (
      await controller.updateManualDraft(now.sessionId, now.revision, {
        ...draft,
        blocks: [...draft.blocks, imageBlock],
      })
    ).snapshot,
  );
  expect(ports.retainImages).toHaveBeenLastCalledWith(state.sessionId, [
    image.imageToken,
  ]);
  now = session(
    (await controller.updateManualDraft(now.sessionId, now.revision, draft))
      .snapshot,
  );
  expect(ports.retainImages).toHaveBeenLastCalledWith(state.sessionId, []);
  expect(now.images).toEqual([]);
  expect(
    await controller.getManualImage(state.sessionId, image.imageToken),
  ).toEqual({ status: 'not_found' });
  expect(
    (
      await controller.updateManualDraft(now.sessionId, now.revision, {
        ...draft,
        blocks: [...draft.blocks, imageBlock],
      })
    ).status,
  ).toBe('invalid');
});
it('maps ordered blocks to one source per token and never persists editor metadata', async () => {
  const { controller, edit, ports } = setup({ chooseImage: async () => image });
  const state = await edit();
  controller.pickManualImage(state.sessionId, state.revision);
  await flush();
  let now = session(controller.getManualArticleState());
  const imageBlock = now.draft.blocks[1];
  now = session(
    (
      await controller.updateManualDraft(now.sessionId, now.revision, {
        ...draft,
        blocks: [
          imageBlock,
          ...draft.blocks,
          { ...imageBlock, blockKey: uuid(81) },
        ],
      })
    ).snapshot,
  );
  controller.saveManualArticle(now.sessionId, now.revision);
  await flush();
  expect(ports.save).toHaveBeenCalledWith(
    {
      schema_version: 1,
      article_id: state.externalId,
      title: '人工文章',
      content_declaration: 'repost',
      body: [
        { type: 'image', image_id: image.imageToken },
        { type: 'paragraph', text: '正文' },
        { type: 'image', image_id: image.imageToken },
      ],
      images: [
        {
          image_id: image.imageToken,
          source: { type: 'local', path: image.imageToken + '.image' },
        },
      ],
    },
    state.sessionId,
    expect.any(AbortSignal),
  );
});
it('returns same job for duplicate save and the same success after completion', async () => {
  const save = deferred<ImportResult>();
  const { controller, edit, ports } = setup({
    save: vi.fn(() => save.promise),
  });
  const state = await edit();
  const start = controller.saveManualArticle(state.sessionId, state.revision);
  expect(start.status).toBe('started');
  const duplicate = controller.saveManualArticle(
    state.sessionId,
    state.revision,
  );
  expect(duplicate.status).toBe('busy');
  expect(session(duplicate.snapshot).jobId).toBe(session(start.snapshot).jobId);
  await flush();
  save.resolve(imported);
  await flush();
  const after = controller.getManualArticleState();
  expect(after).toMatchObject({
    state: 'finished',
    dirty: false,
    result: { status: 'imported', articleKey: uuid(70) },
  });
  expect(controller.saveManualArticle(state.sessionId, state.revision)).toEqual(
    { status: 'ok', snapshot: after },
  );
  expect(ports.save).toHaveBeenCalledTimes(1);
  expect(controller.hasSession()).toBe(false);
});

it('replays committed save results while another write owns the gate or shutdown has begun', async () => {
  let gate: 'ready' | 'busy' | 'unavailable' = 'ready';
  const { controller, edit, ports } = setup({ gate: () => gate });
  const state = await edit();
  controller.saveManualArticle(state.sessionId, state.revision);
  await flush();
  const saved = controller.getManualArticleState();
  expect(saved.state).toBe('finished');
  for (const next of ['busy', 'unavailable'] as const) {
    gate = next;
    expect(
      controller.saveManualArticle(state.sessionId, state.revision),
    ).toEqual({ status: 'ok', snapshot: saved });
    expect(
      controller.saveManualArticle(state.sessionId, saved.revision),
    ).toEqual({ status: 'ok', snapshot: saved });
    expect(controller.saveManualArticle(uuid(999), saved.revision).status).toBe(
      next,
    );
    expect(
      controller.saveManualArticle(state.sessionId, saved.revision + 1).status,
    ).toBe(next);
  }
  gate = 'ready';
  await controller.stopAndWait();
  expect(controller.saveManualArticle(state.sessionId, state.revision)).toEqual(
    { status: 'ok', snapshot: saved },
  );
  expect(controller.saveManualArticle(state.sessionId, saved.revision)).toEqual(
    { status: 'ok', snapshot: saved },
  );
  expect(ports.save).toHaveBeenCalledTimes(1);
});
it('preserves generated ID across a failed attempt and safe retry', async () => {
  let calls = 0;
  const ids: string[] = [];
  const { controller, edit } = setup({
    save: async (input) => {
      ids.push((input as { article_id: string }).article_id);
      return ++calls === 1
        ? { status: 'failed', code: 'STORAGE_UNAVAILABLE', message: 'secret' }
        : imported;
    },
  });
  const state = await edit();
  controller.saveManualArticle(state.sessionId, state.revision);
  await flush();
  const failed = session(controller.getManualArticleState());
  expect(failed.state).toBe('editing');
  expect(failed.draft).toEqual(draft);
  expect(JSON.stringify(failed)).not.toContain('secret');
  controller.saveManualArticle(state.sessionId, failed.revision);
  await flush();
  expect(ids).toEqual([state.externalId, state.externalId]);
});
it('uses the shared final article validator with safe title and block positions', async () => {
  const { controller, begin, ports } = setup();
  const state = await begin();
  const now = session(
    (
      await controller.updateManualDraft(state.sessionId, state.revision, {
        ...draft,
        title: '',
        blocks: [{ blockKey: uuid(80), type: 'paragraph', text: '' }],
      })
    ).snapshot,
  );
  controller.saveManualArticle(state.sessionId, now.revision);
  await flush();
  const failed = session(controller.getManualArticleState());
  expect(failed.state).toBe('editing');
  expect(failed.result?.status).toBe('invalid');
  expect(failed.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ position: '标题' }),
      expect.objectContaining({ position: '第 1 个内容块' }),
    ]),
  );
  expect(ports.save).not.toHaveBeenCalled();
});
it.each(['already_exists', 'already_deleted'] as const)(
  'does not accept %s foreign content as manual save success',
  async (status) => {
    if (imported.status !== 'imported') throw new Error('fixture');
    const { controller, edit } = setup({
      save: async () => ({ status, article: imported.article }),
    });
    const state = await edit();
    controller.saveManualArticle(state.sessionId, state.revision);
    await flush();
    const after = session(controller.getManualArticleState());
    expect(after.state).toBe('editing');
    expect(after.result).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(after.result)).not.toContain(uuid(70));
  },
);
it.each(['recovery', 'throw'] as const)(
  'blocks every new write after uncertain %s',
  async (mode) => {
    const { controller, edit } = setup({
      save: async () => {
        if (mode === 'throw') throw new Error('C:/secret');
        return {
          status: 'failed',
          code: 'RECOVERY_REQUIRED',
          message: 'C:/secret',
        };
      },
    });
    const state = await edit();
    controller.saveManualArticle(state.sessionId, state.revision);
    await flush();
    const rev = controller.getManualArticleState().revision;
    expect(controller.isBlocked()).toBe(true);
    expect((await controller.beginManualArticle()).status).toBe('unavailable');
    expect(
      (await controller.updateManualDraft(state.sessionId, rev, draft)).status,
    ).toBe('unavailable');
    expect(controller.saveManualArticle(state.sessionId, rev).status).toBe(
      'unavailable',
    );
    expect(controller.pickManualImage(state.sessionId, rev).status).toBe(
      'unavailable',
    );
    expect(
      (await controller.discardManualArticle(state.sessionId, rev)).status,
    ).toBe('unavailable');
    expect(JSON.stringify(controller.getManualArticleState())).not.toContain(
      'secret',
    );
  },
);
it('runtime stop preserves dirty text and allows later explicit local save', async () => {
  const { controller, edit } = setup();
  await edit();
  const before = controller.getManualArticleState();
  controller.requestStop();
  expect(controller.getManualArticleState()).toEqual(before);
  const current = session(before);
  controller.saveManualArticle(current.sessionId, current.revision);
  await flush();
  expect(session(controller.getManualArticleState()).result?.status).toBe(
    'imported',
  );
});
it('runtime stop retains a successful local commit that settles after cancellation', async () => {
  const result = deferred<ImportResult>();
  const { controller, edit } = setup({ save: () => result.promise });
  const current = await edit();
  controller.saveManualArticle(current.sessionId, current.revision);
  await flush();
  controller.requestStop();
  expect(controller.isActive()).toBe(true);
  result.resolve(imported);
  await flush();
  expect(session(controller.getManualArticleState()).result?.status).toBe(
    'imported',
  );
});
it('honors early cancellation without starting save but retains success committed before late cancellation', async () => {
  const early = setup();
  const state = await early.edit();
  const start = session(
    early.controller.saveManualArticle(state.sessionId, state.revision)
      .snapshot,
  );
  early.controller.cancelManualOperation(state.sessionId, start.jobId!);
  await flush();
  expect(early.ports.save).not.toHaveBeenCalled();
  expect(session(early.controller.getManualArticleState()).result).toEqual({
    status: 'cancelled',
  });
  const result = deferred<ImportResult>();
  const late = setup({ save: () => result.promise });
  const current = await late.edit();
  const job = session(
    late.controller.saveManualArticle(current.sessionId, current.revision)
      .snapshot,
  );
  await flush();
  const unchanged = late.controller.getManualArticleState();
  expect(
    late.controller.cancelManualOperation(current.sessionId, uuid(999))
      .snapshot,
  ).toEqual(unchanged);
  const stopping = late.controller.cancelManualOperation(
    current.sessionId,
    job.jobId!,
  );
  expect(
    late.controller.cancelManualOperation(current.sessionId, job.jobId!),
  ).toEqual(stopping);
  result.resolve(imported);
  await flush();
  expect(session(late.controller.getManualArticleState()).result?.status).toBe(
    'imported',
  );
});
it('one image read is in flight and revocation prevents late bytes returning', async () => {
  const read = deferred<{ mime: string; bytes: Uint8Array }>();
  const { controller, edit } = setup({
    chooseImage: async () => image,
    readImage: () => read.promise,
  });
  const state = await edit();
  controller.pickManualImage(state.sessionId, state.revision);
  await flush();
  const now = session(controller.getManualArticleState());
  expect(await controller.getManualImage(uuid(999), image.imageToken)).toEqual({
    status: 'not_found',
  });
  const pending = controller.getManualImage(state.sessionId, image.imageToken);
  expect(
    await controller.getManualImage(state.sessionId, image.imageToken),
  ).toEqual({ status: 'busy' });
  await controller.updateManualDraft(state.sessionId, now.revision, draft);
  read.resolve({ mime: 'image/png', bytes: new Uint8Array([1]) });
  expect(await pending).toEqual({ status: 'not_found' });
});
it('discard revokes all images and a new session cannot use previous tokens', async () => {
  const { controller, edit, ports } = setup({ chooseImage: async () => image });
  const state = await edit();
  controller.pickManualImage(state.sessionId, state.revision);
  await flush();
  const now = controller.getManualArticleState();
  expect(
    (await controller.discardManualArticle(state.sessionId, now.revision))
      .status,
  ).toBe('ok');
  expect(controller.hasSession()).toBe(false);
  expect(ports.releaseImages).toHaveBeenCalledWith(state.sessionId);
  const next = session((await controller.beginManualArticle()).snapshot);
  expect(next.sessionId).not.toBe(state.sessionId);
  expect(
    await controller.getManualImage(next.sessionId, image.imageToken),
  ).toEqual({ status: 'not_found' });
});
it('shutdown stops new writes, waits for operation and read settlement, and revokes capabilities', async () => {
  const saved = deferred<ImportResult>();
  const { controller, edit, ports } = setup({ save: () => saved.promise });
  const state = await edit();
  controller.saveManualArticle(state.sessionId, state.revision);
  await flush();
  let settled = false;
  const stopped = controller.stopAndWait().then(() => {
    settled = true;
  });
  await flush();
  expect(settled).toBe(false);
  expect((await controller.beginManualArticle()).status).toBe('unavailable');
  saved.resolve({ status: 'cancelled' });
  await stopped;
  expect(controller.isActive()).toBe(false);
  expect(ports.releaseImages).toHaveBeenCalledWith(state.sessionId);
  expect((await controller.beginManualArticle()).status).toBe('unavailable');
});
it('rejects unsupported image bytes returned by a reader and sanitizes source changes', async () => {
  const { controller, edit } = setup({
    chooseImage: async () => image,
    readImage: async () => {
      throw new ImportFailure('IMAGE_UNAVAILABLE');
    },
  });
  const state = await edit();
  controller.pickManualImage(state.sessionId, state.revision);
  await flush();
  expect(
    await controller.getManualImage(state.sessionId, image.imageToken),
  ).toEqual({ status: 'unavailable' });
});

it('settles an active preview before starting privileged save or image selection', async () => {
  for (const kind of ['save', 'pick'] as const) {
    const bytes = deferred<{ mime: string; bytes: Uint8Array }>();
    const chooseImage = vi.fn(async () => image);
    const { controller, edit, ports } = setup({
      chooseImage,
      readImage: () => bytes.promise,
    });
    const state = await edit();
    controller.pickManualImage(state.sessionId, state.revision);
    await flush();
    const now = session(controller.getManualArticleState());
    const preview = controller.getManualImage(now.sessionId, image.imageToken);
    await flush();
    if (kind === 'save')
      controller.saveManualArticle(now.sessionId, now.revision);
    else controller.pickManualImage(now.sessionId, now.revision);
    expect(
      await controller.getManualImage(now.sessionId, image.imageToken),
    ).toEqual({ status: 'busy' });
    await flush();
    expect(ports.save).not.toHaveBeenCalled();
    expect(chooseImage).toHaveBeenCalledTimes(1);
    bytes.resolve({ mime: 'image/png', bytes: new Uint8Array([1]) });
    expect(await preview).toEqual({ status: 'not_found' });
    await flush();
    if (kind === 'save') expect(ports.save).toHaveBeenCalledTimes(1);
    else expect(chooseImage).toHaveBeenCalledTimes(2);
  }
});

it.each(
  (['paste', 'retry', 'select', 'save'] as const).flatMap((kind) =>
    [false, true].map((cancel) => ({ kind, cancel })),
  ),
)(
  'stops reserved $kind after delayed preview recovery, even with cancellation=$cancel',
  async ({ kind, cancel }) => {
    const previewFailure = deferred<void>();
    let conversions = 0;
    let acquisitions = 0;
    let picks = 0;
    let saves = 0;
    const { controller, edit } = setup({
      chooseImage: async () => {
        picks++;
        return image;
      },
      readImage: async () => {
        await previewFailure.promise;
        throw new WebPasteFailure('RECOVERY_REQUIRED');
      },
      converter: {
        convert: async () => {
          conversions++;
          return {
            blocks: [
              { type: 'paragraph', text: 'admitted text' },
              { type: 'image', source: 'https://example.com/a' },
            ],
            plainOnly: false,
          };
        },
      },
      pasteImages: {
        acquire: async () => {
          acquisitions++;
          throw new WebPasteFailure('IMAGE_NETWORK');
        },
      },
      save: async () => {
        saves++;
        return imported;
      },
    });
    const initial = await edit();
    controller.pickManualImage(initial.sessionId, initial.revision);
    await flush();
    if (kind === 'retry') {
      const picked = session(controller.getManualArticleState());
      await controller.startManualPaste(command(picked), pasteInput);
      await flush();
    }
    const before = session(controller.getManualArticleState());
    const counts = { conversions, acquisitions, picks, saves };
    const preview = controller.getManualImage(
      before.sessionId,
      image.imageToken,
    );
    await flush();
    const start =
      kind === 'paste'
        ? await controller.startManualPaste(command(before), pasteInput)
        : kind === 'retry'
          ? await controller.retryManualPasteImage(
              command(before),
              before.candidates[0].candidateId,
            )
          : kind === 'select'
            ? controller.pickManualImage(before.sessionId, before.revision)
            : controller.saveManualArticle(before.sessionId, before.revision);
    expect(start.status).toBe('started');
    if (cancel)
      controller.cancelManualOperation(
        before.sessionId,
        session(start.snapshot).jobId!,
      );
    expect(controller.isActive()).toBe(true);
    expect({ conversions, acquisitions, picks, saves }).toEqual(counts);
    previewFailure.resolve();
    expect(await preview).toEqual({ status: 'unavailable' });
    for (let n = 0; n < 4; n++) await flush();
    const after = session(controller.getManualArticleState());
    expect({ conversions, acquisitions, picks, saves }).toEqual(counts);
    expect(after.draft).toEqual(before.draft);
    expect(after.images).toEqual(before.images);
    expect(after.candidates).toEqual(before.candidates);
    expect(controller.isActive()).toBe(false);
    expect(controller.isBlocked()).toBe(true);
    expect(after.result).toMatchObject({
      status: 'failed',
      code: 'RECOVERY_REQUIRED',
    });
    if (kind === 'paste' || kind === 'retry') {
      expect(after.pasteSummary).toMatchObject({
        outcome: kind === 'paste' ? 'rejected' : 'partial',
        admitted: kind === 'retry',
        unresolved: kind === 'retry' ? 1 : 0,
        reason: 'RECOVERY_REQUIRED',
      });
    }
    expect((await controller.beginManualArticle()).status).toBe('unavailable');
  },
);

it('refuses new preview reads during a save that owns the image reader', async () => {
  const saved = deferred<ImportResult>();
  const { controller, edit } = setup({
    chooseImage: async () => image,
    save: () => saved.promise,
  });
  const first = await edit();
  controller.pickManualImage(first.sessionId, first.revision);
  await flush();
  const now = session(controller.getManualArticleState());
  controller.saveManualArticle(now.sessionId, now.revision);
  await flush();
  expect(
    await controller.getManualImage(now.sessionId, image.imageToken),
  ).toEqual({ status: 'busy' });
  saved.resolve(imported);
  await flush();
});

it('guards every conflicting write and shutdown while retain awaits, acknowledging only confirmed state', async () => {
  const retained = deferred<void>();
  const { controller } = setup({ retainImages: () => retained.promise });
  const initial = session((await controller.beginManualArticle()).snapshot);
  const update = controller.updateManualDraft(
    initial.sessionId,
    initial.revision,
    draft,
  );
  expect(controller.isActive()).toBe(true);
  expect(controller.getManualArticleState()).toEqual(initial);
  expect((await controller.beginManualArticle()).status).toBe('busy');
  expect(
    (
      await controller.updateManualDraft(
        initial.sessionId,
        initial.revision,
        draft,
      )
    ).status,
  ).toBe('busy');
  expect(
    controller.saveManualArticle(initial.sessionId, initial.revision).status,
  ).toBe('busy');
  expect(
    controller.pickManualImage(initial.sessionId, initial.revision).status,
  ).toBe('busy');
  expect(
    (await controller.discardManualArticle(initial.sessionId, initial.revision))
      .status,
  ).toBe('busy');
  let stopped = false;
  const shutdown = controller.stopAndWait().then(() => {
    stopped = true;
  });
  await flush();
  expect(stopped).toBe(false);
  retained.resolve();
  expect((await update).status).toBe('ok');
  await shutdown;
  expect(stopped).toBe(true);
});
it('holds discard ownership until release settles and preserves the confirmed snapshot during cleanup', async () => {
  const released = deferred<void>();
  const { controller } = setup({ releaseImages: () => released.promise });
  const initial = session((await controller.beginManualArticle()).snapshot);
  const discard = controller.discardManualArticle(
    initial.sessionId,
    initial.revision,
  );
  expect(controller.isActive()).toBe(true);
  expect(controller.getManualArticleState()).toEqual(initial);
  expect((await controller.beginManualArticle()).status).toBe('busy');
  released.resolve();
  expect((await discard).status).toBe('ok');
  expect(controller.getManualArticleState().state).toBe('idle');
});
it('fails closed on async retain rejection without acknowledging replacement draft', async () => {
  const { controller } = setup({
    retainImages: async () => {
      throw new Error('C:/private');
    },
  });
  const initial = session((await controller.beginManualArticle()).snapshot);
  expect(
    (
      await controller.updateManualDraft(
        initial.sessionId,
        initial.revision,
        draft,
      )
    ).status,
  ).toBe('unavailable');
  const after = session(controller.getManualArticleState());
  expect(after.draft).toEqual(initial.draft);
  expect(after.revision).toBe(initial.revision);
  expect(controller.isBlocked()).toBe(true);
  expect(JSON.stringify(after)).not.toContain('private');
});

it('rejects invented pending ownership without changing acknowledged content', async () => {
  const { controller } = setup();
  const initial = session((await controller.beginManualArticle()).snapshot);
  const forged: ManualDraft = {
    ...draft,
    blocks: [
      { blockKey: uuid(80), type: 'image-pending', candidateId: uuid(81) },
    ],
  };
  expect(
    (
      await controller.updateManualDraft(
        initial.sessionId,
        initial.revision,
        forged,
      )
    ).status,
  ).toBe('invalid');
  expect(controller.getManualArticleState()).toEqual(initial);
});

it('does not admit a selected image when cancellation arrives during async retain', async () => {
  const retained = deferred<void>();
  let calls = 0;
  const { controller, edit } = setup({
    chooseImage: async () => image,
    retainImages: () => (++calls === 2 ? retained.promise : Promise.resolve()),
  });
  const state = await edit();
  const started = session(
    controller.pickManualImage(state.sessionId, state.revision).snapshot,
  );
  await flush();
  expect(session(controller.getManualArticleState()).draft).toEqual(draft);
  controller.cancelManualOperation(state.sessionId, started.jobId!);
  retained.resolve();
  await flush();
  const after = session(controller.getManualArticleState());
  expect(after.draft).toEqual(draft);
  expect(after.images).toEqual([]);
  expect(controller.isActive()).toBe(false);
});

it('retains confirmed import evidence while deferring finished presentation through successful-save cleanup', async () => {
  const released = deferred<void>();
  const { controller, edit, ports } = setup({
    releaseImages: () => released.promise,
  });
  const state = await edit();
  const started = controller.saveManualArticle(state.sessionId, state.revision);
  await flush();
  const committed = session(controller.getManualArticleState());
  expect(committed.result).toMatchObject({
    status: 'imported',
    articleKey: uuid(70),
  });
  expect(committed.state).toBe('saving');
  expect(committed.dirty).toBe(false);
  expect(controller.isActive()).toBe(true);
  const replay = controller.saveManualArticle(state.sessionId, state.revision);
  expect(replay.status).toBe('ok');
  expect(session(replay.snapshot).jobId).toBe(session(started.snapshot).jobId);
  expect(ports.save).toHaveBeenCalledTimes(1);
  released.resolve();
  await flush();
  expect(controller.getManualArticleState().state).toBe('finished');
  expect(controller.isActive()).toBe(false);
  expect(
    controller.saveManualArticle(state.sessionId, state.revision).status,
  ).toBe('ok');
  expect(ports.save).toHaveBeenCalledTimes(1);
});
it('preserves committed success and denies fresh writes after successful-save cleanup rejects', async () => {
  const released = deferred<void>();
  const { controller, edit, ports } = setup({
    releaseImages: async () => {
      await released.promise;
      throw new Error('C:/private-cleanup');
    },
  });
  const state = await edit();
  controller.saveManualArticle(state.sessionId, state.revision);
  await flush();
  expect(session(controller.getManualArticleState()).result?.status).toBe(
    'imported',
  );
  expect(
    controller.saveManualArticle(state.sessionId, state.revision).status,
  ).toBe('ok');
  released.resolve();
  await flush();
  const after = session(controller.getManualArticleState());
  expect(after.result).toMatchObject({
    status: 'imported',
    articleKey: uuid(70),
  });
  expect(after.state).toBe('finished');
  expect(after.dirty).toBe(false);
  expect(controller.isBlocked()).toBe(true);
  expect(after.issues).toEqual([
    { message: '上次导入尚未安全恢复，请关闭应用后重试。' },
  ]);
  expect((await controller.beginManualArticle()).status).toBe('unavailable');
  expect(
    (await controller.updateManualDraft(after.sessionId, after.revision, draft))
      .status,
  ).toBe('unavailable');
  expect(
    (await controller.discardManualArticle(after.sessionId, after.revision))
      .status,
  ).toBe('unavailable');
  expect(
    controller.pickManualImage(after.sessionId, after.revision).status,
  ).toBe('unavailable');
  expect(
    controller.saveManualArticle(after.sessionId, after.revision + 1).status,
  ).toBe('unavailable');
  expect(
    controller.saveManualArticle(state.sessionId, state.revision).status,
  ).toBe('ok');
  expect(ports.save).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(after)).not.toContain('private-cleanup');
});

it('restart stop releases a clean session and permits a new article', async () => {
  const f = setup();
  await f.begin();
  await f.controller.stopForRestart();
  expect(f.controller.hasSession()).toBe(false);
  expect(f.controller.getManualArticleState().state).toBe('idle');
  expect(f.ports.releaseImages).toHaveBeenCalledTimes(1);
  expect((await f.controller.beginManualArticle()).status).toBe('ok');
});
it('restart stop retains dirty content and leaves save resolution available', async () => {
  const f = setup();
  const edited = await f.edit();
  await expect(f.controller.stopForRestart()).rejects.toThrow();
  expect(f.controller.hasSession()).toBe(true);
  expect(session(f.controller.getManualArticleState()).draft).toEqual(
    edited.draft,
  );
  expect(f.ports.releaseImages).not.toHaveBeenCalled();
  const current = session(f.controller.getManualArticleState());
  expect(
    f.controller.saveManualArticle(current.sessionId, current.revision).status,
  ).toBe('started');
  await f.controller.waitForSettlement();
});
it('restart stop drains a late native picker without admitting its result', async () => {
  const picked = deferred<ManualImage | undefined>();
  const f = setup({ chooseImage: () => picked.promise });
  const s = await f.begin();
  f.controller.pickManualImage(s.sessionId, s.revision);
  await flush();
  let settled = false;
  const stopping = f.controller.stopForRestart().then(() => {
    settled = true;
  });
  await flush();
  expect(settled).toBe(false);
  expect((await f.controller.beginManualArticle()).status).not.toBe('ok');
  picked.resolve(image);
  await stopping;
  expect(f.controller.hasSession()).toBe(false);
  const next = session((await f.controller.beginManualArticle()).snapshot);
  expect(next.images).toEqual([]);
});
it('restart flush proves renderer-only edits before deciding whether to release', async () => {
  const f: ReturnType<typeof setup> = setup({
    flushForRestart: async () => {
      const s = session(f.controller.getManualArticleState());
      // A flush may synchronize text only; other commands remain closed.
      expect((await f.controller.beginManualArticle()).status).not.toBe('ok');
      return (
        (
          await f.controller.applyManualEdit(
            {
              sessionId: s.sessionId,
              expectedDocumentRevision: s.documentRevision,
              commandId: s.nextEditCommandId,
              clientSequence: s.nextClientSequence,
            },
            { ...s.draft, title: draft.title },
          )
        ).status === 'ok'
      );
    },
  });
  await f.begin();
  await expect(f.controller.stopForRestart()).rejects.toThrow();
  expect(session(f.controller.getManualArticleState()).draft.title).toBe(
    draft.title,
  );
  expect(f.ports.releaseImages).not.toHaveBeenCalled();
});

it('restart stop retains the session when renderer flush cannot be proved', async () => {
  const f = setup({ flushForRestart: async () => false });
  await f.begin();
  await expect(f.controller.stopForRestart()).rejects.toThrow();
  expect(f.controller.hasSession()).toBe(true);
  expect(f.ports.releaseImages).not.toHaveBeenCalled();
});

it('restart stop drains persistence without discarding cancelled dirty input', async () => {
  const saved = deferred<ImportResult>();
  const f = setup({ save: () => saved.promise });
  const s = await f.edit();
  f.controller.saveManualArticle(s.sessionId, s.revision);
  await flush();
  const stopping = f.controller.stopForRestart();
  const rejection = expect(stopping).rejects.toThrow();
  await flush();
  expect(f.controller.isActive()).toBe(true);
  expect(f.controller.pickManualImage(s.sessionId, s.revision).status).not.toBe(
    'started',
  );
  expect(f.ports.releaseImages).not.toHaveBeenCalled();
  saved.resolve({ status: 'cancelled' });
  await rejection;
  expect(f.controller.hasSession()).toBe(true);
  expect(session(f.controller.getManualArticleState()).draft).toEqual(draft);
});
it('restart stop retains unknown ownership after release failure', async () => {
  const f = setup({
    releaseImages: async () => {
      throw new WebPasteFailure('RECOVERY_REQUIRED');
    },
  });
  await f.begin();
  await expect(f.controller.stopForRestart()).rejects.toThrow();
  expect(f.controller.hasSession()).toBe(true);
  expect(f.controller.isBlocked()).toBe(true);
});

it('dirty manual image capability survives restart stop until an explicit operator decision', async () => {
  const f = setup({ chooseImage: async () => image });
  const s = await f.edit();
  f.controller.pickManualImage(s.sessionId, s.revision);
  await f.controller.waitForSettlement();
  await expect(f.controller.stopForRestart()).rejects.toThrow();
  const retained = session(f.controller.getManualArticleState());
  expect(retained.images).toEqual([image]);
  expect(
    await f.controller.getManualImage(retained.sessionId, image.imageToken),
  ).toMatchObject({ status: 'ok' });
  expect(f.ports.releaseImages).not.toHaveBeenCalled();
});

it('restart stop drains in-flight paste image acquisition without reviving its late result', async () => {
  const acquired = deferred<ManualImage>();
  const f = setup({
    converter: {
      convert: async () => ({
        blocks: [{ type: 'image', source: 'https://example.com/a.png' }],
        plainOnly: false,
      }),
    },
    pasteImages: { acquire: () => acquired.promise },
  });
  const s = await f.begin();
  await f.controller.startManualPaste(command(s), pasteInput);
  await flush();
  const stopping = f.controller.stopForRestart();
  const rejected = expect(stopping).rejects.toThrow();
  await flush();
  expect(f.controller.isActive()).toBe(true);
  expect(f.ports.releaseImages).not.toHaveBeenCalled();
  expect((await f.controller.beginManualArticle()).status).not.toBe('ok');
  acquired.resolve(image);
  await rejected;
  const retained = session(f.controller.getManualArticleState());
  expect(retained.images).toEqual([]);
  expect(retained.candidates[0].state).toBe('cancelled');
  expect(f.controller.hasSession()).toBe(true);
});
