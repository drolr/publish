import { expect, it } from 'vitest';
import { createArticleCoverController } from '../../src/application/article-cover';
import { ImportFailure } from '../../src/domain/import-error';
it('recovery unknown retains unavailable admission with no save replay', async () => {
  let writes = 0;
  const c = createArticleCoverController({
    repository: {
      listCoverOperations: () => {
        throw Error('unknown storage');
      },
      beginCoverSave: () => {
        writes++;
      },
    },
    assets: {},
    picker: { pick: async () => undefined },
    gate: () => 'ready',
    newId: () => '',
    now: () => '',
    digest: () => '',
  } as unknown as Parameters<typeof createArticleCoverController>[0]);
  expect(await c.recover()).toBe(false);
  expect(
    await c.beginCoverEdit('00000000-0000-4000-8000-000000000001'),
  ).toEqual({ status: 'unavailable', notice: 'needs_review' });
  expect(writes).toBe(0);
});

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach } from 'vitest';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { createCoverAssetStore } from '../../src/infrastructure/assets/cover-asset-store';
import { createCoverFilePicker } from '../../src/desktop/main/article-cover-picker';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const digest = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
it('cleanup committed before lost acknowledgement settles only its durable failed cover operation', async () => {
  const base = resolve('.tmp/cover-controller');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'failed-receipt-'));
  roots.push(root);
  const repo = openArticleRepository(
    join(root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  try {
    const a = repo.reserve(randomUUID());
    repo.commit(a, {
      articleKey: a.articleKey,
      externalId: a.externalId,
      importId: a.importId,
      title: 'old cover retained',
      body: [{ type: 'paragraph', text: 'body' }],
      contentDeclaration: 'repost',
      createdAt: a.startedAt,
      assets: [],
    });
    const path = join(root, 'picked.png');
    writeFileSync(
      path,
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: 'red' },
      })
        .png()
        .toBuffer(),
    );
    const assets = createCoverAssetStore(root, repo);
    let fail = false,
      prepares = 0;
    const c = createArticleCoverController({
      repository: {
        ...repo,
        markCoverOperation: (op, patch) => {
          repo.markCoverOperation(op, patch);
          if (fail && patch.status === 'failed')
            throw Error('acknowledgement lost after cleanup DB commit');
        },
      },
      assets: {
        ...assets,
        prepareCoverFiles: async (...args) => {
          prepares++;
          const files = await assets.prepareCoverFiles(...args);
          if (fail) throw new ImportFailure('IMAGE_UNAVAILABLE');
          return files;
        },
      },
      picker: createCoverFilePicker(async () => [path]),
      gate: () => 'ready',
      newId: randomUUID,
      now: () => new Date().toISOString(),
      digest,
    });
    expect(await c.recover()).toBe(true);
    let s = await c.beginCoverEdit(a.articleKey);
    if (!('sessionId' in s)) throw Error('missing session');
    s = await c.setCoverDraft(
      { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
      { mode: 'single', imageTokens: [] },
    );
    if (!('sessionId' in s)) throw Error('missing session');
    s = await c.pickCoverImages(
      { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
      [0],
    );
    if (!('sessionId' in s)) throw Error('missing session');
    expect(
      (
        await c.saveCoverEdit({
          sessionId: s.sessionId,
          expectedDraftRevision: s.draftRevision,
          operationId: randomUUID(),
        })
      ).status,
    ).toBe('committed');
    const previous = repo.loadCover(a.articleKey)!;
    s = await c.pickCoverImages(
      { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
      [0],
    );
    if (!('sessionId' in s)) throw Error('missing session');
    const candidate = s;
    fail = true;
    const operationId = randomUUID();
    expect(
      await c.saveCoverEdit({
        sessionId: s.sessionId,
        expectedDraftRevision: s.draftRevision,
        operationId,
      }),
    ).toEqual({ status: 'needs_review', operationId });
    expect(c.isBlocked()).toBe(true);
    expect(repo.readCoverOperation(operationId)).toMatchObject({
      status: 'failed',
      cleanupComplete: true,
    });
    expect(await c.getCoverSaveResult(operationId)).toEqual({
      status: 'failed',
      operationId,
    });
    expect(c.isBlocked()).toBe(false);
    expect(await c.getCoverEditState()).toMatchObject({
      ...candidate,
      notice: null,
    });
    expect(repo.loadCover(a.articleKey)).toEqual(previous);
    await expect(
      assets.readCoverAsset(previous, previous.assets[0].assetKey),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(prepares).toBe(2);
    expect(repo.listCoverOperations()).toHaveLength(2);
    const failed = repo.readCoverOperation(operationId)!;
    for (const file of failed.ownedFiles)
      expect(existsSync(join(root, 'covers', file.relativePath))).toBe(false);
    expect(await c.closeCoverEdit(s.sessionId)).toMatchObject({
      status: 'idle',
    });
  } finally {
    repo.close();
  }
});

it('native exact/atomic validation; source removal, lost reply and fresh-controller recovery preserve saved bytes', async () => {
  const base = resolve('.tmp/cover-controller');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  roots.push(root);
  const path = join(root, 'one.png'),
    bad = join(root, 'bad.png');
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  writeFileSync(path, bytes);
  writeFileSync(bad, 'bad');
  let selection: string[] | undefined = [path];
  const picker = createCoverFilePicker(async () => selection);
  expect(
    (await picker.pick(1, new AbortController().signal))?.[0].bytes,
  ).toEqual(bytes);
  selection = [path, bad];
  await expect(
    picker.pick(2, new AbortController().signal),
  ).rejects.toMatchObject({ selectionIndex: 1, code: 'IMAGE_INVALID' });
  selection = [path];
  await expect(picker.pick(3, new AbortController().signal)).rejects.toThrow();
  selection = ['https://example.invalid/image.png'];
  await expect(picker.pick(1, new AbortController().signal)).rejects.toThrow();
  selection = [path];
  const db = join(root, 'app.sqlite'),
    migrations = resolve('src/infrastructure/persistence/migrations');
  let repo = openArticleRepository(db, migrations);
  try {
    const a = repo.reserve(randomUUID());
    repo.commit(a, {
      articleKey: a.articleKey,
      externalId: a.externalId,
      importId: a.importId,
      title: '文章',
      body: [{ type: 'paragraph', text: '正文' }],
      contentDeclaration: 'original',
      createdAt: a.startedAt,
      assets: [],
    });
    const options = () => ({
      repository: repo,
      assets: createCoverAssetStore(root, repo),
      picker,
      gate: () => 'ready' as const,
      newId: randomUUID,
      now: () => new Date().toISOString(),
      digest,
    });
    let c = createArticleCoverController(options());
    expect(await c.recover()).toBe(true);
    let s = await c.beginCoverEdit(a.articleKey);
    if (!('sessionId' in s)) throw Error('missing');
    s = await c.setCoverDraft(
      { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
      { mode: 'single', imageTokens: [] },
    );
    if (!('sessionId' in s)) throw Error('missing');
    s = await c.pickCoverImages(
      { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
      [0],
    );
    if (!('sessionId' in s)) throw Error('missing');
    const op = randomUUID(),
      cmd = {
        sessionId: s.sessionId,
        expectedDraftRevision: s.draftRevision,
        operationId: op,
      };
    const r = await c.saveCoverEdit(cmd);
    expect(r.status).toBe('committed');
    unlinkSync(path);
    expect(await c.getCoverSaveResult(op)).toEqual(r);
    await c.closeCoverEdit(s.sessionId);
    const configuration = repo.loadCover(a.articleKey)!;
    expect(repo.loadEditableArticle(a.articleKey)!.articleRevision).toBe(1);
    repo.close();
    repo = openArticleRepository(db, migrations);
    c = createArticleCoverController(options());
    expect(await c.recover()).toBe(true);
    expect(await c.getCoverSaveResult(op)).toEqual(r);
    expect(
      await c.getCoverImage({
        kind: 'stored',
        articleKey: a.articleKey,
        coverRevision: 1,
        assetKey: configuration.assets[0].assetKey,
      }),
    ).toEqual({
      status: 'ok',
      mime: 'image/png',
      bytes: new Uint8Array(bytes),
    });
    expect(repo.listCoverOperations()).toHaveLength(1);
    const clean = await c.beginCoverEdit(a.articleKey);
    if (!('sessionId' in clean)) throw Error('missing');
    selection = undefined;
    expect(
      await c.pickCoverImages(
        {
          sessionId: clean.sessionId,
          expectedDraftRevision: clean.draftRevision,
        },
        [0],
      ),
    ).toMatchObject({
      dirty: false,
      draftRevision: 0,
      notice: 'cancelled',
      draft: clean.draft,
    });
    selection = [bad];
    expect(
      await c.pickCoverImages(
        {
          sessionId: clean.sessionId,
          expectedDraftRevision: clean.draftRevision,
        },
        [0],
      ),
    ).toMatchObject({
      dirty: false,
      draftRevision: 0,
      notice: 'image_invalid',
      draft: clean.draft,
    });
    await c.closeCoverEdit(clean.sessionId);
  } finally {
    repo.close();
  }
});

it('native picker rejects WebP, too-large bytes and directory junctions; cancellation admits no candidate', async () => {
  const base = resolve('.tmp/cover-controller');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'picker-'));
  roots.push(root);
  const path = join(root, 'cover.webp'),
    large = join(root, 'too-large.png'),
    link = join(root, 'redirect');
  writeFileSync(
    path,
    await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'blue' },
    })
      .webp()
      .toBuffer(),
  );
  writeFileSync(large, Buffer.alloc(10_000_001));
  let selection: readonly string[] | undefined = [path];
  const picker = createCoverFilePicker(async () => selection);
  await expect(
    picker.pick(1, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED', selectionIndex: 0 });
  selection = [large];
  await expect(
    picker.pick(1, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'IMAGE_LIMIT_EXCEEDED', selectionIndex: 0 });
  symlinkSync(root, link, 'junction');
  selection = [join(link, 'cover.webp')];
  await expect(
    picker.pick(1, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
  selection = undefined;
  expect(await picker.pick(1, new AbortController().signal)).toBeUndefined();
  let finish!: (value: string[]) => void;
  const late = createCoverFilePicker(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const abort = new AbortController();
  const choosing = late.pick(1, abort.signal);
  abort.abort();
  finish([path]);
  await expect(choosing).rejects.toThrow();
});

it('fresh-connection pending intent recovery cleans only owned files without replay and keeps original article revision', async () => {
  const base = resolve('.tmp/cover-controller');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'pending-'));
  roots.push(root);
  const db = join(root, 'app.sqlite'),
    migrations = resolve('src/infrastructure/persistence/migrations');
  let repo = openArticleRepository(db, migrations);
  try {
    const a = repo.reserve(randomUUID());
    repo.commit(a, {
      articleKey: a.articleKey,
      externalId: a.externalId,
      importId: a.importId,
      title: '正文保持',
      body: [{ type: 'paragraph', text: '正文' }],
      contentDeclaration: 'repost',
      createdAt: a.startedAt,
      assets: [],
    });
    const intent = {
      operationId: randomUUID(),
      articleKey: a.articleKey,
      sessionId: randomUUID(),
      expectedArticleRevision: 1,
      expectedCoverRevision: 0,
      draftRevision: 2,
      mode: 'single' as const,
      payloadDigest: 'c'.repeat(64),
      startedAt: new Date().toISOString(),
    };
    expect(repo.beginCoverSave(intent)).toEqual({
      status: 'not_started',
      operationId: intent.operationId,
    });
    expect(repo.readCoverOperation(intent.operationId)).toMatchObject({
      ...intent,
      status: 'preparing',
      ownedFiles: [],
      cleanupComplete: false,
      committedCoverRevision: null,
    });
    expect(repo.readCoverSaveResult(intent.operationId)).toEqual({
      status: 'pending',
      operationId: intent.operationId,
    });
    const files = await createCoverAssetStore(root, repo).prepareCoverFiles(
      intent,
      [
        {
          bytes: await sharp({
            create: { width: 1, height: 1, channels: 3, background: 'red' },
          })
            .png()
            .toBuffer(),
        },
      ],
      new AbortController().signal,
    );
    repo.close();
    repo = openArticleRepository(db, migrations);
    let replayed = false;
    const assets = createCoverAssetStore(root, repo);
    const c = createArticleCoverController({
      repository: repo,
      assets: {
        ...assets,
        prepareCoverFiles: async () => {
          replayed = true;
          throw Error('must not replay');
        },
      },
      picker: { pick: async () => undefined },
      gate: () => 'ready',
      newId: randomUUID,
      now: () => new Date().toISOString(),
      digest,
    });
    expect(c.isBlocked()).toBe(true);
    expect(await c.getCoverSaveResult(intent.operationId)).toEqual({
      status: 'pending',
      operationId: intent.operationId,
    });
    expect(await c.recover()).toBe(true);
    expect(await c.getCoverSaveResult(intent.operationId)).toEqual({
      status: 'failed',
      operationId: intent.operationId,
    });
    expect(repo.loadCover(a.articleKey)?.coverRevision).toBe(0);
    expect(repo.loadEditableArticle(a.articleKey)?.articleRevision).toBe(1);
    expect(existsSync(join(root, 'covers', files[0].relativePath))).toBe(false);
    const s = await c.beginCoverEdit(a.articleKey);
    if (!('sessionId' in s)) throw Error('missing session');
    expect(
      await c.saveCoverEdit({
        sessionId: s.sessionId,
        expectedDraftRevision: s.draftRevision,
        operationId: intent.operationId,
      }),
    ).toEqual({ status: 'conflict', operationId: intent.operationId });
    expect(replayed).toBe(false);
    expect(repo.listCoverOperations()).toHaveLength(1);
  } finally {
    repo.close();
  }
});

it('native invalid second file reports its mapped slot and preserves the entire triple candidate', async () => {
  const base = resolve('.tmp/cover-controller');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'ordinal-'));
  roots.push(root);
  const path = join(root, 'valid.png'),
    bad = join(root, 'invalid.png');
  writeFileSync(
    path,
    await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer(),
  );
  writeFileSync(bad, 'invalid');
  let selection = [path, path, path];
  const picker = createCoverFilePicker(async () => selection);
  const repo = openArticleRepository(
    join(root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  try {
    const a = repo.reserve(randomUUID());
    repo.commit(a, {
      articleKey: a.articleKey,
      externalId: a.externalId,
      importId: a.importId,
      title: '文章',
      body: [{ type: 'paragraph', text: '正文' }],
      contentDeclaration: 'repost',
      createdAt: a.startedAt,
      assets: [],
    });
    const c = createArticleCoverController({
      repository: repo,
      assets: createCoverAssetStore(root, repo),
      picker,
      gate: () => 'ready',
      newId: randomUUID,
      now: () => new Date().toISOString(),
      digest,
    });
    await c.recover();
    let state = await c.beginCoverEdit(a.articleKey);
    if (!('sessionId' in state)) throw Error('missing');
    state = await c.setCoverDraft(
      {
        sessionId: state.sessionId,
        expectedDraftRevision: state.draftRevision,
      },
      { mode: 'triple', imageTokens: [] },
    );
    if (!('sessionId' in state)) throw Error('missing');
    state = await c.pickCoverImages(
      {
        sessionId: state.sessionId,
        expectedDraftRevision: state.draftRevision,
      },
      [0, 1, 2],
    );
    if (!('sessionId' in state)) throw Error('missing');
    const old = structuredClone(state);
    selection = [path, bad, path];
    const invalid = await c.pickCoverImages(
      { sessionId: old.sessionId, expectedDraftRevision: old.draftRevision },
      [0, 1, 2],
    );
    expect(invalid).toMatchObject({
      notice: 'image_invalid',
      imageFailure: { position: 1, reason: 'IMAGE_INVALID' },
      draft: old.draft,
      images: old.images,
      draftRevision: old.draftRevision,
    });
    selection = [path, bad];
    const mapped = await c.pickCoverImages(
      { sessionId: old.sessionId, expectedDraftRevision: old.draftRevision },
      [2, 0],
    );
    expect(mapped).toMatchObject({
      notice: 'image_invalid',
      imageFailure: { position: 0, reason: 'IMAGE_INVALID' },
      draft: old.draft,
    });
    selection = [path];
    const countFailure = await c.pickCoverImages(
      { sessionId: old.sessionId, expectedDraftRevision: old.draftRevision },
      [0, 1, 2],
    );
    expect(countFailure).toMatchObject({
      notice: 'image_invalid',
      draft: old.draft,
    });
    expect(countFailure).not.toHaveProperty('imageFailure');
    selection = [];
    await c.closeCoverEdit(old.sessionId);
    expect(repo.loadCover(a.articleKey)?.coverRevision).toBe(0);
  } finally {
    repo.close();
  }
});
