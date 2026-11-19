import { submissionContentEquivalent } from '../../src/domain/draft-content';
import { makeDraftTask } from '../fixtures/draft-task';
import {
  verifyDraftSnapshotIntegrity,
  createDraftSnapshotDigest,
} from '../../src/infrastructure/draft-snapshot-integrity';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { createDraftSnapshotPort } from '../../src/infrastructure/assets/draft-snapshot';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import type {
  AssetStore,
  ImportAttempt,
  StoredArticle,
} from '../../src/domain/ports/article-import';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const editable = (article: StoredArticle) => ({
  article,
  articleRevision: 1,
  editorBody: null,
});
const signal = () => new AbortController().signal;
async function bytes(format: 'png' | 'jpeg' | 'webp') {
  const image = sharp({
    create: { width: 2, height: 2, channels: 3, background: '#123456' },
  });
  if (format === 'png') return new Uint8Array(await image.png().toBuffer());
  if (format === 'jpeg') return new Uint8Array(await image.jpeg().toBuffer());
  return new Uint8Array(await image.webp().toBuffer());
}
async function seed(format: 'png' | 'jpeg' | 'webp' = 'png') {
  const root = await mkdtemp(join(tmpdir(), 'draft-snapshot-'));
  roots.push(root);
  const store = createAssetStore(root);
  const attempt: ImportAttempt = {
    importId: randomUUID(),
    articleKey: randomUUID(),
    externalId: 'fixture',
    startedAt: '2026-09-23T00:00:00.000Z',
    status: 'preparing',
  };
  await store.prepare(attempt, signal());
  const asset = await store.put(
    attempt,
    'image',
    await bytes(format),
    signal(),
  );
  await store.finalize(attempt, signal());
  const article: StoredArticle = {
    articleKey: attempt.articleKey,
    importId: attempt.importId,
    externalId: attempt.externalId,
    title: '这是合格标题',
    body: [
      { type: 'paragraph', text: 'body' },
      { type: 'image', image_id: 'image' },
    ],
    contentDeclaration: 'repost',
    createdAt: attempt.startedAt,
    assets: [asset],
  };
  return { root, store, asset, article };
}

it('captures PNG/JPEG exact bytes, rejects WebP and oversize metadata before reads, and never accesses a platform', async () => {
  const png = await seed('png');
  const jpeg = await seed('jpeg');
  const webp = await seed('webp');
  expect(
    await createDraftSnapshotPort(png.store).capture(editable(png.article)),
  ).toMatchObject({ article: png.article });
  await expect(
    createDraftSnapshotPort(jpeg.store).capture(editable(jpeg.article)),
  ).resolves.toMatchObject({ article: jpeg.article });
  await expect(
    createDraftSnapshotPort(webp.store).capture(editable(webp.article)),
  ).rejects.toMatchObject({ code: 'IMAGE_FORMAT_UNSUPPORTED' });
  const readImage = vi.fn(async () => new Uint8Array([1]));
  const controlled = {
    verify: vi.fn(async () => {}),
    readImage,
  } as unknown as AssetStore;
  const oversized = {
    ...png.article,
    assets: [{ ...png.asset, byteSize: 10_000_001 }],
  };
  await expect(
    createDraftSnapshotPort(controlled).capture(editable(oversized)),
  ).rejects.toMatchObject({ code: 'IMAGE_SIZE_UNSUPPORTED' });
  expect(readImage).not.toHaveBeenCalled();
});

it('accepts the 10,000,000-byte boundary and calls trusted read once per distinct asset', async () => {
  const seeded = await seed();
  const readImage = vi.fn(async () => new Uint8Array(10_000_000));
  const asset = {
    ...seeded.asset,
    byteSize: 10_000_000,
    sha256: createHash('sha256')
      .update(new Uint8Array(10_000_000))
      .digest('hex'),
  };
  const article = {
    ...seeded.article,
    body: [
      ...seeded.article.body,
      { type: 'image' as const, image_id: 'image' },
    ],
    assets: [asset],
  };
  const port = createDraftSnapshotPort({
    verify: vi.fn(async () => {}),
    readImage,
  } as unknown as AssetStore);
  const snapshot = await port.capture(editable(article));
  expect(readImage).toHaveBeenCalledTimes(1);
  expect((await port.readImage(snapshot, asset.assetKey)).byteLength).toBe(
    10_000_000,
  );
});

it('deep-copies and canonically hashes sorted assets while retaining body order', async () => {
  const seeded = await seed();
  const second = {
    ...seeded.asset,
    assetKey: randomUUID(),
    imageId: 'second',
    relativePath: `${seeded.article.articleKey}/${randomUUID()}.png`,
  };
  second.relativePath = `${seeded.article.articleKey}/${second.assetKey}.png`;
  const article = {
    ...seeded.article,
    body: [
      { type: 'paragraph' as const, text: 'first' },
      { type: 'image' as const, image_id: 'second' },
      { type: 'image' as const, image_id: 'image' },
    ],
    assets: [second, seeded.asset],
  };
  const store = {
    verify: vi.fn(async () => {}),
    readImage: vi.fn(async () => await bytes('png')),
  } as unknown as AssetStore;
  const snapshot = await createDraftSnapshotPort(store).capture(
    editable(article),
  );
  article.body[0] = { type: 'paragraph', text: 'mutated' };
  expect(snapshot.article.body[0]).toEqual({
    type: 'paragraph',
    text: 'first',
  });
  expect(snapshot.article.assets.map((asset) => asset.assetKey)).toEqual(
    [...snapshot.article.assets.map((asset) => asset.assetKey)].sort(),
  );
});

it('re-reads on verify and upload, rejecting byte tampering, missing read capability, and foreign links', async () => {
  const seeded = await seed();
  const port = createDraftSnapshotPort(seeded.store);
  const snapshot = await port.capture(editable(seeded.article));
  await expect(port.verify(snapshot)).resolves.toBeUndefined();
  const reread = await port.readImage(snapshot, seeded.asset.assetKey);
  expect(reread.byteLength).toBe(seeded.asset.byteSize);
  expect(createHash('sha256').update(reread).digest('hex')).toBe(
    seeded.asset.sha256,
  );
  await expect(
    port.verify({
      ...snapshot,
      article: {
        ...snapshot.article,
        contentDeclaration:
          snapshot.article.contentDeclaration === 'original'
            ? 'repost'
            : 'original',
      },
    }),
  ).rejects.toMatchObject({ code: 'INPUT_UNSUPPORTED' });
  await writeFile(
    join(seeded.root, seeded.asset.relativePath),
    Buffer.alloc(seeded.asset.byteSize),
  );
  await expect(port.verify(snapshot)).rejects.toMatchObject({
    code: 'ASSET_UNAVAILABLE',
  });
  await expect(
    createDraftSnapshotPort({
      verify: async () => {},
    } as unknown as AssetStore).capture(editable(seeded.article)),
  ).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' });
  const linked = await seed();
  const outside = await mkdtemp(join(tmpdir(), 'draft-outside-'));
  roots.push(outside);
  const articleDirectory = join(linked.root, linked.article.articleKey);
  await rm(articleDirectory, { recursive: true });
  await symlink(outside, articleDirectory, 'junction');
  await expect(
    createDraftSnapshotPort(linked.store).capture(editable(linked.article)),
  ).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' });
});

it('rejects a committed image missing before capture or removed before verification', async () => {
  const missingAtCapture = await seed();
  await rm(join(missingAtCapture.root, missingAtCapture.asset.relativePath));
  await expect(
    createDraftSnapshotPort(missingAtCapture.store).capture(
      editable(missingAtCapture.article),
    ),
  ).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' });

  const missingAtVerify = await seed();
  const port = createDraftSnapshotPort(missingAtVerify.store);
  const snapshot = await port.capture(editable(missingAtVerify.article));
  await rm(join(missingAtVerify.root, missingAtVerify.asset.relativePath));
  await expect(port.verify(snapshot)).rejects.toMatchObject({
    code: 'ASSET_UNAVAILABLE',
  });
});

it('freezes V2 exact formatting and empty layout, rejects mark tampering and projection mismatch', async () => {
  const { article, store } = await seed();
  const port = createDraftSnapshotPort(store);
  const body = {
    version: 2 as const,
    blocks: [
      { type: 'paragraph' as const, content: [] },
      {
        type: 'paragraph' as const,
        content: [
          { type: 'text' as const, text: 'body', marks: ['bold' as const] },
        ],
      },
      { type: 'image' as const, imageId: 'image' },
    ],
  };
  const snapshot = await port.capture({
    ...editable(article),
    editorBody: body,
  });
  expect(snapshot).toMatchObject({ version: 2, editorBody: body });
  if (snapshot.version !== 2) throw Error('expected V2');
  const changed = structuredClone(snapshot);
  changed.editorBody.blocks[1] = {
    type: 'paragraph',
    content: [{ type: 'text', text: 'body', marks: [] }],
  };
  await expect(port.verify(changed)).rejects.toMatchObject({
    code: 'INPUT_UNSUPPORTED',
  });
  await expect(
    port.capture({
      ...editable(article),
      editorBody: {
        version: 2,
        blocks: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'different', marks: [] }],
          },
        ],
      },
    }),
  ).rejects.toMatchObject({ code: 'INPUT_UNSUPPORTED' });
  body.blocks[1] = { type: 'paragraph', content: [] };
  expect(snapshot.editorBody.blocks[1]).toMatchObject({
    content: [{ text: 'body', marks: ['bold'] }],
  });
});

it('preserves the historical V1 byte hash golden fixture without upgrading its body first', () => {
  const snapshot = makeDraftTask().snapshot;
  expect(createDraftSnapshotDigest(snapshot.article)).toBe(
    '969beecdc737c33128d150497398f9100706a4796e1a8974ed7ac6432525162e',
  );
  expect(() => verifyDraftSnapshotIntegrity(snapshot)).not.toThrow();
});

it.each(['null', 'V1'] as const)(
  'keeps 10 legacy paragraphs of 19999 LF plus one character compact under 2MiB when capturing %s layout',
  async (source) => {
    const article = makeDraftTask().snapshot.article;
    article.body = Array.from({ length: 10 }, () => ({
      type: 'paragraph' as const,
      text: '\n'.repeat(19999) + '字',
    }));
    const editorBody =
      source === 'null'
        ? null
        : {
            version: 1 as const,
            blocks: article.body.map((block) => {
              if (block.type !== 'paragraph') throw Error('paragraph fixture');
              return block;
            }),
          };
    const port = createDraftSnapshotPort({} as AssetStore);
    const snapshot = await port.capture({
      article,
      articleRevision: 1,
      editorBody,
    });
    expect(snapshot.version).toBe(2);
    if (snapshot.version !== 2) throw Error('V2 required');
    expect(snapshot.editorBody.blocks).toHaveLength(10);
    expect(snapshot.editorBody.blocks[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '\n'.repeat(19999) + '字', marks: [] }],
    });
    expect(
      Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
    ).toBeLessThanOrEqual(2 * 1024 * 1024);
    await expect(port.verify(snapshot)).resolves.toBeUndefined();
    const old = {
      version: 1 as const,
      article,
      digest: createDraftSnapshotDigest(article),
    };
    expect(submissionContentEquivalent(old, snapshot)).toBe('equal');
  },
);
