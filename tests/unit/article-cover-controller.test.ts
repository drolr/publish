import { CoverPickFailure } from '../../src/domain/cover-pick-error';
import { ImportFailure } from '../../src/domain/import-error';
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createArticleCoverController } from '../../src/application/article-cover';
import type {
  CoverEditReply,
  CoverSaveIntent,
  CoverOperation,
} from '../../src/contracts/article-cover';
export const id = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const digest = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const image = {
  bytes: new Uint8Array([1]),
  mime: 'image/png' as const,
  width: 1,
  height: 1,
  sha256: 'b'.repeat(64),
};
const open = (r: CoverEditReply) => {
  if (!('sessionId' in r)) throw Error('Expected open');
  return r;
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
export async function fixture() {
  let n = 10,
    gate: 'ready' | 'busy' | 'unavailable' = 'ready',
    revision = 1,
    exists = true;
  let config: import('../../src/contracts/article-cover').StoredCoverConfiguration =
    {
      articleKey: id(1),
      coverRevision: 0,
      mode: 'none' as 'none' | 'single' | 'triple',
      assets: [],
      configurationDigest: 'a'.repeat(64),
      saveOperationId: null,
      committedAt: null,
    };
  const ops = new Map<string, CoverOperation>();
  const results = new Map();
  const repository = {
    loadCover: ():
      | import('../../src/contracts/article-cover').StoredCoverConfiguration
      | undefined => (exists ? config : undefined),
    loadArchivedCoverVersion: () => config,
    loadEditableArticle: () =>
      exists ? { articleRevision: revision } : undefined,
    beginCoverSave: vi.fn((i: CoverSaveIntent) => {
      ops.set(i.operationId, {
        ...i,
        status: 'preparing',
        ownedFiles: [],
        cleanupComplete: false,
        committedCoverRevision: null,
        committedAt: null,
      });
      results.set(i.operationId, {
        status: 'pending',
        operationId: i.operationId,
      });
      return { status: 'not_started', operationId: i.operationId };
    }),
    readCoverOperation: (i: string) => ops.get(i),
    listCoverOperations: () => [],
    markCoverOperation: vi.fn(),
    isCoverAssetReferenced: () => false,
    commitCoverVersion: vi.fn((i: CoverSaveIntent) => {
      config = {
        ...config,
        coverRevision: config.coverRevision + 1,
        mode: i.mode,
        saveOperationId: i.operationId,
        committedAt: i.startedAt,
      };
      const r = {
        status: 'committed',
        receipt: {
          operationId: i.operationId,
          articleKey: id(1),
          coverRevision: config.coverRevision,
          configurationDigest: 'a'.repeat(64),
        },
      };
      results.set(i.operationId, r);
      return r;
    }),
    readCoverSaveResult: vi.fn(
      (i: string) =>
        results.get(i) ?? { status: 'not_started', operationId: i },
    ),
  };
  const assets = {
    prepareCoverFiles: vi.fn(async () => []),
    readCoverAsset: vi.fn(async (): Promise<Uint8Array> => new Uint8Array([1])),
    verifyCoverVersion: vi.fn(async () => {}),
    cleanupOwnedUnreferenced: vi.fn(async () => {}),
  };
  const picker = {
    pick: vi.fn(
      async (
        _count: number,
        _signal: AbortSignal,
      ): Promise<(typeof image)[] | undefined> => {
        void _count;
        void _signal;
        return [image];
      },
    ),
  };
  const c = createArticleCoverController({
    repository,
    assets,
    picker,
    gate: () => gate,
    newId: () => id(n++),
    now: () => '2026-10-09T00:00:00.000Z',
    digest,
  } as unknown as Parameters<typeof createArticleCoverController>[0]);
  await c.recover();
  const s = open(await c.beginCoverEdit(id(1)));
  return {
    c,
    s,
    repository,
    assets,
    picker,
    setGate: (g: typeof gate) => {
      gate = g;
    },
    setRevision: (r: number) => {
      revision = r;
    },
    remove: () => {
      exists = false;
    },
  };
}
const command = (s: ReturnType<typeof open>) => ({
  sessionId: s.sessionId,
  expectedDraftRevision: s.draftRevision,
});
it('runtime stop retains the local cover candidate and permits continued editing', async () => {
  const f = await fixture();
  const changed = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  f.c.requestStop();
  expect(f.c.hasSession()).toBe(true);
  const after = open(await f.c.getCoverEditState());
  expect(after.draft).toEqual(changed.draft);
  expect(after.dirty).toBe(true);
  expect(f.c.isBlocked()).toBe(false);
});
it.each([
  'operationId',
  'sessionId',
  'articleKey',
  'expectedArticleRevision',
  'expectedCoverRevision',
  'draftRevision',
  'payloadDigest',
  'cleanupComplete',
  'pending',
  'not_started',
  'global storage uncertainty',
])(
  'failed receipt cannot release unknown cover save with %s',
  async (fault) => {
    const f = await fixture();
    f.assets.prepareCoverFiles.mockRejectedValueOnce(
      Error('unknown prepare outcome'),
    );
    const operationId = id(991);
    expect(
      (await f.c.saveCoverEdit({ ...command(f.s), operationId })).status,
    ).toBe('needs_review');
    const op = f.repository.readCoverOperation(operationId)!;
    Object.assign(op, { status: 'failed', cleanupComplete: true });
    if (['operationId', 'sessionId', 'articleKey'].includes(fault))
      Object.assign(op, { [fault]: id(992) });
    if (
      [
        'expectedArticleRevision',
        'expectedCoverRevision',
        'draftRevision',
      ].includes(fault)
    )
      Object.assign(op, { [fault]: 999 });
    if (fault === 'payloadDigest') op.payloadDigest = 'f'.repeat(64);
    if (fault === 'cleanupComplete') op.cleanupComplete = false;
    if (fault === 'global storage uncertainty') {
      f.repository.readCoverSaveResult.mockImplementationOnce(() => {
        throw Error('unrelated storage read failure');
      });
      await f.c.getCoverSaveResult(id(993));
    }
    f.repository.readCoverSaveResult.mockReturnValue({
      status: fault === 'pending' || fault === 'not_started' ? fault : 'failed',
      operationId,
    });
    await f.c.getCoverSaveResult(operationId);
    expect(f.c.isBlocked()).toBe(true);
    expect(await f.c.closeCoverEdit(f.s.sessionId)).toMatchObject({
      notice: 'needs_review',
    });
    expect(f.repository.beginCoverSave).toHaveBeenCalledTimes(1);
    expect(f.assets.prepareCoverFiles).toHaveBeenCalledTimes(1);
    expect(f.repository.commitCoverVersion).not.toHaveBeenCalled();
  },
);

it('cached save rejects a changed draft revision even when the none payload returns to equal', async () => {
  const f = await fixture();
  const request = { ...command(f.s), operationId: id(996) };
  expect((await f.c.saveCoverEdit(request)).status).toBe('committed');
  let s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  s = open(
    await f.c.setCoverDraft(command(s), { mode: 'none', imageTokens: [] }),
  );
  expect(await f.c.saveCoverEdit(request)).toEqual({
    status: 'conflict',
    operationId: request.operationId,
  });
  expect(await f.c.getCoverEditState()).toEqual(s);
  expect(f.repository.beginCoverSave).toHaveBeenCalledTimes(1);
  expect(f.assets.prepareCoverFiles).toHaveBeenCalledTimes(1);
  expect(f.repository.commitCoverVersion).toHaveBeenCalledTimes(1);
});
it('old cached none attempt conflicts after a newer cover base is committed without more writes', async () => {
  const f = await fixture();
  const request = { ...command(f.s), operationId: id(994) };
  expect((await f.c.saveCoverEdit(request)).status).toBe('committed');
  expect(
    (await f.c.saveCoverEdit({ ...command(f.s), operationId: id(995) })).status,
  ).toBe('committed');
  expect(await f.c.saveCoverEdit(request)).toEqual({
    status: 'conflict',
    operationId: request.operationId,
  });
  expect(f.repository.beginCoverSave).toHaveBeenCalledTimes(2);
  expect(f.assets.prepareCoverFiles).toHaveBeenCalledTimes(2);
  expect(f.repository.commitCoverVersion).toHaveBeenCalledTimes(2);
});
it.each(['other article', 'reopened article'])(
  'cached save rejects operation reuse in %s with equal none payload',
  async (kind) => {
    const f = await fixture();
    const request = { ...command(f.s), operationId: id(990) };
    const receipt = await f.c.saveCoverEdit(request);
    expect(receipt.status).toBe('committed');
    expect(await f.c.saveCoverEdit(request)).toEqual(receipt);
    await f.c.closeCoverEdit(f.s.sessionId);
    const configuration = f.repository.loadCover()!;
    f.repository.loadCover = () => ({
      ...configuration,
      articleKey: kind === 'other article' ? id(2) : id(1),
    });
    const next = open(
      await f.c.beginCoverEdit(kind === 'other article' ? id(2) : id(1)),
    );
    expect(
      await f.c.saveCoverEdit({
        ...command(next),
        operationId: request.operationId,
      }),
    ).toEqual({ status: 'conflict', operationId: request.operationId });
    expect(await f.c.getCoverSaveResult(request.operationId)).toEqual(receipt);
    expect(f.repository.beginCoverSave).toHaveBeenCalledTimes(1);
    expect(f.assets.prepareCoverFiles).toHaveBeenCalledTimes(1);
    expect(f.repository.commitCoverVersion).toHaveBeenCalledTimes(1);
    expect(await f.c.getCoverEditState()).toEqual(next);
  },
);
it('pick_cancel_keeps_draft and forged token/path reject atomically', async () => {
  const f = await fixture();
  let s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  s = open(await f.c.pickCoverImages(command(s), [0]));
  const before = s;
  f.picker.pick.mockResolvedValueOnce(undefined!);
  expect(open(await f.c.pickCoverImages(command(s), [0]))).toMatchObject({
    draft: before.draft,
    draftRevision: before.draftRevision,
    notice: 'cancelled',
  });
  expect(
    open(
      await f.c.setCoverDraft(command(s), {
        mode: 'single',
        imageTokens: [id(99)],
      }),
    ),
  ).toMatchObject({ draft: before.draft, notice: 'conflict' });
  expect(
    await f.c.getCoverImage({
      kind: 'session',
      sessionId: s.sessionId,
      imageToken: id(99),
    }),
  ).toEqual({ status: 'not_found' });
  expect(
    await f.c.setCoverDraft(command(s), {
      mode: 'single',
      imageTokens: ['C:/private'],
    }),
  ).toMatchObject({ notice: 'conflict' });
});
it('atomic_multi_pick_failure preserves whole draft and rejects incompatible slots', async () => {
  const f = await fixture();
  const s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'triple', imageTokens: [] }),
  );
  f.picker.pick.mockRejectedValueOnce(Error('invalid second image'));
  expect(open(await f.c.pickCoverImages(command(s), [0, 1, 2]))).toMatchObject({
    draft: s.draft,
    draftRevision: s.draftRevision,
    notice: 'image_invalid',
  });
  f.picker.pick.mockResolvedValueOnce([image]);
  expect(open(await f.c.pickCoverImages(command(s), [0, 1, 2]))).toMatchObject({
    draft: s.draft,
    notice: 'image_invalid',
  });
  expect(open(await f.c.pickCoverImages(command(s), [2, 2]))).toMatchObject({
    notice: 'conflict',
  });
});
it('late_picker_response and close wait for settlement without replacing next session', async () => {
  const f = await fixture();
  const pending = deferred<(typeof image)[]>();
  let signal!: AbortSignal;
  f.picker.pick.mockImplementationOnce(
    async (_count: number, s: AbortSignal) => {
      signal = s;
      return pending.promise;
    },
  );
  const s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  const selecting = f.c.pickCoverImages(command(s), [0]);
  await Promise.resolve();
  const closing = f.c.closeCoverEdit(s.sessionId);
  await Promise.resolve();
  expect(signal.aborted).toBe(true);
  expect(f.c.isActive()).toBe(true);
  expect(await f.c.getCoverEditState()).toMatchObject({ status: 'closing' });
  pending.resolve([image]);
  await selecting;
  expect(await closing).toMatchObject({ status: 'idle' });
  expect(f.c.hasSession()).toBe(false);
  expect(open(await f.c.beginCoverEdit(id(1))).draft.imageTokens).toEqual([]);
});
it('lost_cover_save_reply only queries receipt; same_id_new_payload cannot start another write', async () => {
  const f = await fixture();
  const op = id(80);
  const first = await f.c.saveCoverEdit({ ...command(f.s), operationId: op });
  expect(first.status).toBe('committed');
  expect(await f.c.getCoverSaveResult(op)).toEqual(first);
  expect(await f.c.saveCoverEdit({ ...command(f.s), operationId: op })).toEqual(
    first,
  );
  expect(f.assets.prepareCoverFiles).toHaveBeenCalledTimes(1);
  expect(f.repository.commitCoverVersion).toHaveBeenCalledTimes(1);
  const s = open(await f.c.getCoverEditState());
  const changed = open(
    await f.c.setCoverDraft(command(s), { mode: 'single', imageTokens: [] }),
  );
  expect(
    await f.c.saveCoverEdit({ ...command(changed), operationId: op }),
  ).toEqual({ status: 'conflict', operationId: op });
  expect(f.repository.beginCoverSave).toHaveBeenCalledTimes(1);
});
it('pre/post awaiting deletion and body revision conflicts retain old head', async () => {
  const f = await fixture();
  f.setRevision(2);
  expect(
    await f.c.saveCoverEdit({ ...command(f.s), operationId: id(81) }),
  ).toEqual({ status: 'conflict', operationId: id(81) });
  expect(f.repository.beginCoverSave).not.toHaveBeenCalled();
});
it('one image transfer in flight and session close waits read capability settlement', async () => {
  const f = await fixture();
  let s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  s = open(await f.c.pickCoverImages(command(s), [0]));
  const req = {
    kind: 'session' as const,
    sessionId: s.sessionId,
    imageToken: s.draft.imageTokens[0],
  };
  expect((await f.c.getCoverImage(req)).status).toBe('ok');
  expect(await f.c.getCoverImage({ ...req, sessionId: id(90) })).toEqual({
    status: 'not_found',
  });
});
it('unknown save cannot discard session or reopen writes; committed lookup resolves lost exception', async () => {
  const f = await fixture();
  f.repository.commitCoverVersion.mockImplementationOnce(() => {
    throw Error('unknown commit reply');
  });
  expect(
    await f.c.saveCoverEdit({ ...command(f.s), operationId: id(82) }),
  ).toEqual({ status: 'needs_review', operationId: id(82) });
  expect(f.c.isBlocked()).toBe(true);
  expect(await f.c.closeCoverEdit(f.s.sessionId)).toMatchObject({
    status: 'open',
    notice: 'needs_review',
  });
  await expect(f.c.stopAndWait()).rejects.toThrow();
  expect(f.c.hasSession()).toBe(true);
});

it('native returned candidate and draft cannot be mutated through replies', async () => {
  const f = await fixture();
  let s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  s = open(await f.c.pickCoverImages(command(s), [0]));
  const before = await f.c.getCoverEditState();
  s.draft.imageTokens[0] = id(99);
  expect(await f.c.getCoverEditState()).toEqual(before);
});
it('storage uncertainty after picker settlement closes admission instead of becoming invalid image', async () => {
  const f = await fixture();
  const s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  f.repository.loadCover = () => {
    throw Error('storage unknown');
  };
  await f.c.pickCoverImages(command(s), [0]);
  expect(f.c.isBlocked()).toBe(true);
  expect(await f.c.closeCoverEdit(s.sessionId)).toMatchObject({
    notice: 'needs_review',
  });
});
it('getCoverSaveResult invalid receipt cannot silently reopen unknown session', async () => {
  const f = await fixture();
  f.repository.commitCoverVersion.mockImplementationOnce(() => {
    throw Error('unknown');
  });
  await f.c.saveCoverEdit({ ...command(f.s), operationId: id(82) });
  f.repository.readCoverSaveResult.mockReturnValueOnce({
    status: 'committed',
    receipt: {
      operationId: id(82),
      articleKey: id(99),
      coverRevision: 0,
      configurationDigest: 'a'.repeat(64),
    },
  });
  expect(await f.c.getCoverSaveResult(id(82))).toEqual({
    status: 'needs_review',
    operationId: id(82),
  });
  expect(f.c.isBlocked()).toBe(true);
});
it('transfer concurrency excludes second read and close waits actual stored read', async () => {
  const f = await fixture();
  const a = {
    assetKey: id(70),
    mime: 'image/png' as const,
    width: 1,
    height: 1,
    byteSize: 1,
    sha256: 'b'.repeat(64),
    relativePath: id(1) + '/' + id(71) + '/' + id(70) + '.png',
  };
  await f.c.closeCoverEdit(f.s.sessionId);
  f.repository.loadCover = () => ({
    articleKey: id(1),
    coverRevision: 1,
    mode: 'single',
    assets: [a],
    configurationDigest: 'a'.repeat(64),
    saveOperationId: id(71),
    committedAt: '2026-10-09T00:00:00.000Z',
  });
  const s = open(await f.c.beginCoverEdit(id(1)));
  const pending = deferred<Uint8Array>();
  f.assets.readCoverAsset.mockImplementationOnce(() => pending.promise);
  const req = {
    kind: 'session' as const,
    sessionId: s.sessionId,
    imageToken: s.draft.imageTokens[0],
  };
  const reading = f.c.getCoverImage(req);
  expect(await f.c.getCoverImage(req)).toEqual({ status: 'busy' });
  let closed = false;
  const closing = f.c.closeCoverEdit(s.sessionId).then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.c.isActive()).toBe(true);
  pending.resolve(new Uint8Array([1]));
  expect(await reading).toEqual({ status: 'not_found' });
  await closing;
  expect(f.c.hasSession()).toBe(false);
});

it('persisted preparing result only queries and never replays an existing intent', async () => {
  const f = await fixture();
  const pending = deferred<never[]>();
  f.assets.prepareCoverFiles.mockImplementationOnce(() => pending.promise);
  const cmd = { ...command(f.s), operationId: id(83) };
  const saving = f.c.saveCoverEdit(cmd);
  await Promise.resolve();
  expect(await f.c.getCoverSaveResult(id(83))).toEqual({
    status: 'pending',
    operationId: id(83),
  });
  expect(await f.c.saveCoverEdit(cmd)).toEqual({
    status: 'pending',
    operationId: id(83),
  });
  expect(f.repository.beginCoverSave).toHaveBeenCalledTimes(1);
  expect(f.assets.prepareCoverFiles).toHaveBeenCalledTimes(1);
  pending.resolve([]);
  expect((await saving).status).toBe('committed');
});

it('triple save requires three images and native bytes stay within the per-image budget', async () => {
  const f = await fixture();
  let s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'triple', imageTokens: [] }),
  );
  s = open(await f.c.pickCoverImages(command(s), [0]));
  expect(
    await f.c.saveCoverEdit({ ...command(s), operationId: id(85) }),
  ).toEqual({ status: 'conflict', operationId: id(85) });
  expect(f.repository.beginCoverSave).not.toHaveBeenCalled();
  f.picker.pick.mockResolvedValueOnce([
    { ...image, bytes: new Uint8Array(10_000_001) },
  ]);
  expect(await f.c.pickCoverImages(command(s), [1])).toMatchObject({
    draft: s.draft,
    notice: 'image_invalid',
  });
});
it('post-prepare revision change must clean owned intent without committing the old head', async () => {
  const f = await fixture();
  f.assets.prepareCoverFiles.mockImplementationOnce(async () => {
    f.setRevision(2);
    return [];
  });
  expect(
    await f.c.saveCoverEdit({ ...command(f.s), operationId: id(86) }),
  ).toEqual({ status: 'conflict', operationId: id(86) });
  expect(f.repository.commitCoverVersion).not.toHaveBeenCalled();
  expect(f.assets.cleanupOwnedUnreferenced).toHaveBeenCalledTimes(1);
  expect(f.repository.markCoverOperation).toHaveBeenCalledWith(id(86), {
    status: 'failed',
    cleanupComplete: true,
  });
});
it('confirmed close during saving waits physical work and cleanup; failure retains unknown session', async () => {
  const f = await fixture();
  const pending = deferred<never[]>();
  f.assets.prepareCoverFiles.mockImplementationOnce(() => pending.promise);
  const saving = f.c.saveCoverEdit({ ...command(f.s), operationId: id(87) });
  await Promise.resolve();
  let closed = false;
  const closing = f.c.closeCoverEdit(f.s.sessionId).then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.c.isActive()).toBe(true);
  pending.resolve([]);
  expect((await saving).status).toBe('failed');
  await closing;
  expect(f.c.hasSession()).toBe(false);
  expect(f.assets.cleanupOwnedUnreferenced).toHaveBeenCalledTimes(1);
  const g = await fixture();
  const delayed = deferred<never[]>();
  g.assets.prepareCoverFiles.mockImplementationOnce(() => delayed.promise);
  g.assets.cleanupOwnedUnreferenced.mockRejectedValueOnce(
    Error('cleanup uncertain'),
  );
  const save = g.c.saveCoverEdit({ ...command(g.s), operationId: id(88) });
  await Promise.resolve();
  const close = g.c.closeCoverEdit(g.s.sessionId);
  delayed.resolve([]);
  expect((await save).status).toBe('needs_review');
  expect(await close).toMatchObject({ status: 'open', notice: 'needs_review' });
  expect(g.c.isBlocked()).toBe(true);
  expect(g.c.hasSession()).toBe(true);
});
import { EventEmitter } from 'node:events';
import { protectShutdown } from '../../src/desktop/main/shutdown';
it('native application shutdown drains late picker before closing storage and cancelling close preserves dirty input', async () => {
  const f = await fixture();
  const s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  const picker = deferred<(typeof image)[]>();
  let signal!: AbortSignal;
  f.picker.pick.mockImplementationOnce(async (_count, s) => {
    signal = s;
    return picker.promise;
  });
  const selecting = f.c.pickCoverImages(command(s), [0]);
  await Promise.resolve();
  const events: string[] = [];
  const app = Object.assign(new EventEmitter(), {
      quit: () => events.push('quit'),
    }),
    win = Object.assign(new EventEmitter(), {
      destroy: () => events.push('destroy'),
    });
  let confirmed = false;
  const closing = protectShutdown(
    app,
    win,
    f.c,
    () => events.push('database'),
    async () => confirmed,
  );
  win.emit('close', { preventDefault() {} });
  await Promise.resolve();
  await Promise.resolve();
  expect(closing()).toBe(false);
  expect(signal.aborted).toBe(false);
  expect(f.c.hasSession()).toBe(true);
  confirmed = true;
  win.emit('close', { preventDefault() {} });
  for (let n = 0; n < 5; n++) await Promise.resolve();
  expect(signal.aborted).toBe(true);
  expect(events).toEqual([]);
  picker.resolve([image]);
  await selecting;
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(events).toEqual(['database', 'destroy', 'quit']);
  expect(f.c.hasSession()).toBe(false);
});

it('begin returning pre-existing pending never prepares or commits and retains unknown session', async () => {
  const f = await fixture();
  const original = f.repository.beginCoverSave.getMockImplementation()!;
  f.repository.beginCoverSave.mockImplementationOnce((i) => {
    original(i);
    return { status: 'pending', operationId: i.operationId };
  });
  const r = await f.c.saveCoverEdit({ ...command(f.s), operationId: id(89) });
  expect(r).toEqual({ status: 'pending', operationId: id(89) });
  expect(f.assets.prepareCoverFiles).not.toHaveBeenCalled();
  expect(f.repository.commitCoverVersion).not.toHaveBeenCalled();
  expect(f.c.isBlocked()).toBe(true);
  expect(await f.c.closeCoverEdit(f.s.sessionId)).toMatchObject({
    notice: 'needs_review',
  });
});

it('ordinary cleanup-complete failed save cannot project a safe open state after an unrelated storage fault', async () => {
  const f = await fixture();
  f.assets.prepareCoverFiles.mockRejectedValueOnce(
    new ImportFailure('IMAGE_UNAVAILABLE'),
  );
  f.repository.markCoverOperation.mockImplementation(
    (operationId: string, patch: object) => {
      Object.assign(f.repository.readCoverOperation(operationId)!, patch);
    },
  );
  const operationId = id(986);
  // Main has a definite failure; a lost renderer transport would later query this receipt.
  expect(await f.c.saveCoverEdit({ ...command(f.s), operationId })).toEqual({
    status: 'failed',
    operationId,
  });
  expect(f.repository.readCoverOperation(operationId)).toMatchObject({
    status: 'failed',
    cleanupComplete: true,
  });
  expect(f.c.isBlocked()).toBe(false);
  const loadCover = f.repository.loadCover;
  f.repository.loadCover = () => {
    throw Error('unrelated subsequent storage read failure');
  };
  expect(await f.c.getArticleCover(f.s.articleKey)).toEqual({
    status: 'unavailable',
  });
  f.repository.loadCover = loadCover;
  f.repository.readCoverSaveResult.mockReturnValue({
    status: 'failed',
    operationId,
  });
  // A factual read-only failed receipt does not erase independent global uncertainty.
  expect(await f.c.getCoverSaveResult(operationId)).toEqual({
    status: 'failed',
    operationId,
  });
  expect(f.c.isBlocked()).toBe(true);
  expect(await f.c.getCoverEditState()).toEqual({
    ...f.s,
    notice: 'needs_review',
  });
  expect(await f.c.closeCoverEdit(f.s.sessionId)).toMatchObject({
    notice: 'needs_review',
  });
  expect(f.repository.beginCoverSave).toHaveBeenCalledTimes(1);
  expect(f.assets.prepareCoverFiles).toHaveBeenCalledTimes(1);
  expect(f.repository.commitCoverVersion).not.toHaveBeenCalled();
});

it.each(['busy', 'unavailable'] as const)(
  'durable failed receipt remains held while gate is %s then settles when ready without storage poisoning',
  async (gate) => {
    const f = await fixture();
    f.assets.prepareCoverFiles.mockRejectedValueOnce(
      Error('unknown prepare result'),
    );
    const operationId = id(987);
    expect(
      (await f.c.saveCoverEdit({ ...command(f.s), operationId })).status,
    ).toBe('needs_review');
    const previous = f.repository.loadCover();
    Object.assign(f.repository.readCoverOperation(operationId)!, {
      status: 'failed',
      cleanupComplete: true,
    });
    f.repository.readCoverSaveResult.mockReturnValue({
      status: 'failed',
      operationId,
    });
    f.setGate(gate);
    expect(await f.c.getCoverSaveResult(operationId)).toEqual({
      status: 'failed',
      operationId,
    });
    expect(f.c.isBlocked()).toBe(true);
    expect(await f.c.closeCoverEdit(f.s.sessionId)).toMatchObject({
      notice: 'needs_review',
    });
    f.setGate('ready');
    expect(await f.c.getCoverSaveResult(operationId)).toEqual({
      status: 'failed',
      operationId,
    });
    expect(f.c.isBlocked()).toBe(false);
    expect(await f.c.getCoverEditState()).toEqual(f.s);
    expect(f.repository.loadCover()).toEqual(previous);
    expect(f.repository.beginCoverSave).toHaveBeenCalledTimes(1);
    expect(f.assets.prepareCoverFiles).toHaveBeenCalledTimes(1);
    expect(f.repository.commitCoverVersion).not.toHaveBeenCalled();
  },
);

it('known committed settlement retires its storage uncertainty marker before a later failed attempt', async () => {
  const f = await fixture();
  const original = f.repository.commitCoverVersion.getMockImplementation()!;
  f.repository.commitCoverVersion.mockImplementationOnce((i) => {
    original(i);
    throw Error('lost committed acknowledgement');
  });
  f.repository.readCoverSaveResult.mockReturnValueOnce({
    status: 'pending',
    operationId: id(997),
  });
  expect(
    (await f.c.saveCoverEdit({ ...command(f.s), operationId: id(997) })).status,
  ).toBe('needs_review');
  f.repository.readCoverSaveResult.mockImplementationOnce(() => {
    throw Error('storage/read uncertainty');
  });
  expect((await f.c.getCoverSaveResult(id(999))).status).toBe('needs_review');
  expect((await f.c.getCoverSaveResult(id(997))).status).toBe('committed');
  expect(f.c.isBlocked()).toBe(false);
  f.assets.prepareCoverFiles.mockRejectedValueOnce(
    Error('later unknown preparation'),
  );
  const next = open(await f.c.getCoverEditState());
  expect(
    (await f.c.saveCoverEdit({ ...command(next), operationId: id(998) }))
      .status,
  ).toBe('needs_review');
  Object.assign(f.repository.readCoverOperation(id(998))!, {
    status: 'failed',
    cleanupComplete: true,
  });
  f.repository.readCoverSaveResult.mockReturnValueOnce({
    status: 'failed',
    operationId: id(998),
  });
  expect(await f.c.getCoverSaveResult(id(998))).toEqual({
    status: 'failed',
    operationId: id(998),
  });
  expect(f.c.isBlocked()).toBe(false);
  expect(f.repository.loadCover()?.coverRevision).toBe(1);
  expect(f.repository.beginCoverSave).toHaveBeenCalledTimes(2);
  expect(f.assets.prepareCoverFiles).toHaveBeenCalledTimes(2);
  expect(f.repository.commitCoverVersion).toHaveBeenCalledTimes(1);
});

it('unknown commit reply requires matching operation identity before clearing session', async () => {
  const f = await fixture();
  const original = f.repository.commitCoverVersion.getMockImplementation()!;
  f.repository.commitCoverVersion.mockImplementationOnce((i) => {
    original(i);
    throw Error('lost reply');
  });
  f.repository.readCoverSaveResult.mockReturnValueOnce({
    status: 'pending',
    operationId: id(91),
  });
  expect(
    await f.c.saveCoverEdit({ ...command(f.s), operationId: id(91) }),
  ).toEqual({ status: 'needs_review', operationId: id(91) });
  f.repository.readCoverSaveResult.mockReturnValueOnce({
    status: 'committed',
    receipt: {
      operationId: id(92),
      articleKey: id(1),
      coverRevision: 1,
      configurationDigest: 'a'.repeat(64),
    },
  });
  expect(await f.c.getCoverSaveResult(id(91))).toEqual({
    status: 'needs_review',
    operationId: id(91),
  });
  expect(f.c.isBlocked()).toBe(true);
  expect(await f.c.getCoverSaveResult(id(91))).toMatchObject({
    status: 'committed',
    receipt: { operationId: id(91) },
  });
  expect(f.c.isBlocked()).toBe(false);
  expect(f.repository.commitCoverVersion).toHaveBeenCalledTimes(1);
});

it('revoked session token cannot deliver a late stored-image preview after draft removal', async () => {
  const f = await fixture();
  await f.c.closeCoverEdit(f.s.sessionId);
  const asset = {
    assetKey: id(70),
    mime: 'image/png' as const,
    width: 1,
    height: 1,
    byteSize: 1,
    sha256: 'b'.repeat(64),
    relativePath: id(1) + '/' + id(71) + '/' + id(70) + '.png',
  };
  f.repository.loadCover = () => ({
    articleKey: id(1),
    coverRevision: 1,
    mode: 'single' as const,
    assets: [{ ...asset, mime: 'image/png' as const }],
    configurationDigest: 'a'.repeat(64),
    saveOperationId: id(71),
    committedAt: '2026-10-09T00:00:00.000Z',
  });
  const s = open(await f.c.beginCoverEdit(id(1))),
    pending = deferred<Uint8Array>();
  f.assets.readCoverAsset.mockImplementationOnce(() => pending.promise);
  const reading = f.c.getCoverImage({
    kind: 'session',
    sessionId: s.sessionId,
    imageToken: s.draft.imageTokens[0],
  });
  await f.c.setCoverDraft(command(s), { mode: 'none', imageTokens: [] });
  pending.resolve(new Uint8Array([1]));
  expect(await reading).toEqual({ status: 'not_found' });
});

it('stop closes stored-image admission before drain and does not reopen it after settlement', async () => {
  const f = await fixture();
  await f.c.closeCoverEdit(f.s.sessionId);
  const config = {
    articleKey: id(1),
    coverRevision: 1,
    mode: 'single' as const,
    assets: [
      {
        assetKey: id(70),
        mime: 'image/png' as const,
        width: 1,
        height: 1,
        byteSize: 1,
        sha256: 'b'.repeat(64),
        relativePath: id(1) + '/' + id(71) + '/' + id(70) + '.png',
      },
    ],
    configurationDigest: 'a'.repeat(64),
    saveOperationId: id(71),
    committedAt: '2026-10-09T00:00:00.000Z',
  };
  f.repository.loadCover = () => config;
  f.repository.loadArchivedCoverVersion = () => config;
  const admitted = deferred<Uint8Array>();
  f.assets.readCoverAsset.mockImplementationOnce(() => admitted.promise);
  const request = {
    kind: 'stored' as const,
    articleKey: id(1),
    coverRevision: 1,
    assetKey: id(70),
  };
  const reading = f.c.getCoverImage(request);
  let finished = false;
  const stopping = f.c.stopAndWait().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(await f.c.getCoverImage(request)).toEqual({ status: 'unavailable' });
  expect(f.assets.readCoverAsset).toHaveBeenCalledTimes(1);
  admitted.resolve(new Uint8Array([1]));
  expect(await reading).toMatchObject({ status: 'ok' });
  await stopping;
  expect(finished).toBe(true);
  expect(f.c.isActive()).toBe(false);
  expect(await f.c.getCoverImage(request)).toEqual({ status: 'unavailable' });
  expect(f.assets.readCoverAsset).toHaveBeenCalledTimes(1);
  expect(await f.c.getCoverSaveResult(id(72))).toEqual({
    status: 'not_started',
    operationId: id(72),
  });
  expect(await f.c.getCoverEditState()).toMatchObject({
    status: 'unavailable',
  });
});

it('a new save clears stale safe picker failure before the formal asset await', async () => {
  const f = await fixture();
  let s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  s = open(await f.c.pickCoverImages(command(s), [0]));
  f.picker.pick.mockRejectedValueOnce(new CoverPickFailure(0, 'IMAGE_INVALID'));
  s = open(await f.c.pickCoverImages(command(s), [0]));
  expect(s).toMatchObject({
    imageFailure: { position: 0, reason: 'IMAGE_INVALID' },
  });
  const pending = deferred<[]>();
  f.assets.prepareCoverFiles.mockImplementationOnce(() => pending.promise);
  const save = f.c.saveCoverEdit({ ...command(s), operationId: id(99) });
  expect(await f.c.getCoverEditState()).not.toHaveProperty('imageFailure');
  pending.resolve([]);
  await save;
  expect(await f.c.getCoverEditState()).not.toHaveProperty('imageFailure');
});

it('first explicit none after the single default remains an unsaved canonical configuration intent', async () => {
  const f = await fixture();
  expect(f.s).toMatchObject({ dirty: false, draftRevision: 0 });
  expect(
    await f.c.setCoverDraft(
      { ...command(f.s), expectedDraftRevision: 1 },
      { mode: 'none', imageTokens: [] },
    ),
  ).toMatchObject({ dirty: false, draftRevision: 0 });
  let s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  s = open(
    await f.c.setCoverDraft(command(s), { mode: 'none', imageTokens: [] }),
  );
  expect(s).toMatchObject({
    baseCoverRevision: 0,
    draftRevision: 2,
    dirty: true,
    draft: { mode: 'none', imageTokens: [] },
  });
  expect(
    await f.c.saveCoverEdit({ ...command(s), operationId: id(98) }),
  ).toMatchObject({ status: 'committed', receipt: { coverRevision: 1 } });
  await f.c.closeCoverEdit(s.sessionId);
  expect(await f.c.beginCoverEdit(id(1))).toMatchObject({
    baseCoverRevision: 1,
    draftRevision: 0,
    dirty: false,
    draft: { mode: 'none', imageTokens: [] },
  });
});

it('copies only an exact active stored single cover into the current session without a file picker or save', async () => {
  const f = await fixture();
  const asset = {
    assetKey: id(81),
    mime: 'image/png',
    width: 1,
    height: 1,
    sha256: 'b'.repeat(64),
    byteSize: 1,
    relativePath: id(2) + '/' + id(80) + '/' + id(81) + '.png',
  };
  const original = f.repository.loadCover();
  const source: import('../../src/contracts/article-cover').StoredCoverConfiguration =
    {
      ...original!,
      articleKey: id(2),
      coverRevision: 4,
      mode: 'single',
      assets: [{ ...asset, mime: 'image/png' }],
    };
  f.repository.loadCover = (key?: string) =>
    key === id(2) ? source : original;
  const changed = open(
    await f.c.copyCoverImage(command(f.s), {
      kind: 'stored',
      articleKey: id(2),
      coverRevision: 4,
      assetKey: id(81),
    }),
  );
  expect(changed.draft.mode).toBe('single');
  expect(changed.draft.imageTokens).toHaveLength(1);
  expect(changed.dirty).toBe(true);
  expect(f.picker.pick).not.toHaveBeenCalled();
  expect(f.repository.beginCoverSave).not.toHaveBeenCalled();
  const stale = await f.c.copyCoverImage(command(changed), {
    kind: 'stored',
    articleKey: id(2),
    coverRevision: 3,
    assetKey: id(81),
  });
  expect(stale.notice).toBe('conflict');
  expect(open(stale).draftRevision).toBe(changed.draftRevision);
});

it('restart stop releases clean cover state and admits another session', async () => {
  const f = await fixture();
  await f.c.stopForRestart();
  expect(f.c.hasSession()).toBe(false);
  expect((await f.c.beginCoverEdit(id(1))).status).toBe('open');
});
it('restart stop preserves dirty cover candidates for an operator decision', async () => {
  const f = await fixture();
  const changed = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  const selected = open(await f.c.pickCoverImages(command(changed), [0]));
  await expect(f.c.stopForRestart()).rejects.toThrow();
  expect(f.c.hasSession()).toBe(true);
  expect(open(await f.c.getCoverEditState()).draft).toEqual(selected.draft);
  expect(
    (await f.c.setCoverDraft(command(selected), selected.draft)).status,
  ).toBe('open');
});
it('restart stop waits for the native cover picker and ignores its late image', async () => {
  const f = await fixture();
  const changed = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'single', imageTokens: [] }),
  );
  const picked = deferred<(typeof image)[] | undefined>();
  f.picker.pick.mockImplementationOnce(() => picked.promise);
  const pick = f.c.pickCoverImages(command(changed), [0]);
  await Promise.resolve();
  let settled = false;
  const stopping = f.c.stopForRestart().catch(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.c.isActive()).toBe(true);
  expect((await f.c.beginCoverEdit(id(1))).notice).toBe('busy');
  picked.resolve([image]);
  await pick;
  await stopping;
  const retained = open(await f.c.getCoverEditState());
  expect(retained.draft.imageTokens).toEqual([]);
  await f.c.closeCoverEdit(retained.sessionId);
  expect(open(await f.c.beginCoverEdit(id(1))).images).toEqual([]);
});
it('a retained cover can save before a second restart stop releases it', async () => {
  const f = await fixture();
  const s = open(
    await f.c.setCoverDraft(command(f.s), { mode: 'none', imageTokens: [] }),
  );
  await expect(f.c.stopForRestart()).rejects.toThrow();
  expect(
    (await f.c.saveCoverEdit({ ...command(s), operationId: id(993) })).status,
  ).toBe('committed');
  await f.c.stopForRestart();
  expect(f.c.hasSession()).toBe(false);
  expect(f.repository.loadCover()?.coverRevision).toBe(1);
});
