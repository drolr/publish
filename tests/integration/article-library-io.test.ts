import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));
import { readArticleFile } from '../../src/infrastructure/assets/article-file';
import { readLocalImage } from '../../src/infrastructure/assets/local-reader';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { executeImportSql } from '../../src/infrastructure/persistence/testing/article-fixtures';
import type {
  ArticleRepository,
  ImportAttempt,
  StoredArticle,
} from '../../src/domain/ports/article-import';

const base = path.resolve('.tmp/library-io');
const roots: string[] = [];
const stores: ArticleRepository[] = [];
const signal = () => new AbortController().signal;
async function temp() {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + path.sep)) throw new Error('Unsafe cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('reads UTF8 BOM JSON and grants only its parent directory for images', async () => {
  const root = await temp();
  const file = path.join(root, 'article.data');
  await fs.writeFile(file, '\uFEFF{"title":"汽车"}');
  await fs.writeFile(path.join(root, 'image.png'), 'bytes');
  const result = await readArticleFile(file, signal());
  expect(result.input).toEqual({ title: '汽车' });
  expect(
    Buffer.from(
      await readLocalImage(result.capability, 'image.png', signal()),
    ).toString(),
  ).toBe('bytes');
  await expect(
    readLocalImage(result.capability, '../private.png', signal()),
  ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
});
it.each([
  '',
  '{',
  '[]',
  'null',
  '42',
  '\uFEFF\uFEFF{}',
  Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
])('rejects invalid file content %s with a safe error', async (content) => {
  const file = path.join(await temp(), 'article.json');
  await fs.writeFile(file, content);
  await expect(readArticleFile(file, signal())).rejects.toMatchObject({
    code: 'FILE_INVALID',
  });
});
it('enforces the inclusive 2 MiB limit', async () => {
  const file = path.join(await temp(), 'article.json');
  await fs.writeFile(file, '{}'.padEnd(2 * 1024 * 1024));
  expect((await readArticleFile(file, signal())).input).toEqual({});
  await fs.appendFile(file, ' ');
  await expect(readArticleFile(file, signal())).rejects.toMatchObject({
    code: 'FILE_TOO_LARGE',
  });
});
it('rejects linked directories, hardlinks and nonfiles', async () => {
  const root = await temp();
  const outside = await temp();
  await fs.writeFile(path.join(outside, 'article.json'), '{}');
  await fs.symlink(outside, path.join(root, 'linked'), 'junction');
  await expect(
    readArticleFile(path.join(root, 'linked/article.json'), signal()),
  ).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
  await fs.link(
    path.join(outside, 'article.json'),
    path.join(root, 'hard.json'),
  );
  await expect(
    readArticleFile(path.join(root, 'hard.json'), signal()),
  ).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
  await expect(readArticleFile(root, signal())).rejects.toMatchObject({
    code: 'FILE_UNAVAILABLE',
  });
});
it('rejects modification during handle reading and releases the handle', async () => {
  const file = path.join(await temp(), 'article.json');
  await fs.writeFile(file, '{}');
  const realOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      const read = handle.read.bind(handle);
      let changed = false;
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        if (!changed) {
          changed = true;
          await fs.appendFile(file, ' ');
        }
        return result;
      }) as typeof handle.read;
      return handle;
    },
  );
  await expect(readArticleFile(file, signal())).rejects.toMatchObject({
    code: 'FILE_UNAVAILABLE',
  });
  await fs.unlink(file);
});
it('honors cancellation before opening the file', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    readArticleFile(path.join(await temp(), 'missing.json'), controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
});
it.each(['growth', 'cancel'] as const)(
  'stops %s during actual handle reads',
  async (mode) => {
    const file = path.join(await temp(), 'article.json');
    await fs.writeFile(file, '{}');
    const controller = new AbortController();
    const realOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(
      async (...args: Parameters<typeof realOpen>) => {
        const handle = await realOpen(...args);
        const read = handle.read.bind(handle);
        let changed = false;
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          if (!changed) {
            changed = true;
            if (mode === 'cancel') controller.abort();
            else await fs.appendFile(file, Buffer.alloc(2 * 1024 * 1024));
          }
          return result;
        }) as typeof handle.read;
        return handle;
      },
    );
    await expect(
      readArticleFile(file, controller.signal),
    ).rejects.toMatchObject(
      mode === 'cancel' ? { name: 'AbortError' } : { code: 'FILE_TOO_LARGE' },
    );
    await fs.unlink(file);
  },
);
function article(a: ImportAttempt): StoredArticle {
  return {
    articleKey: a.articleKey,
    importId: a.importId,
    externalId: a.externalId,
    title: '汽车',
    body: [{ type: 'paragraph', text: '正文' }],
    contentDeclaration: 'original',
    createdAt: '2026-09-16T00:00:00.000Z',
    assets: [],
  };
}
it('paginates 11 committed articles stably at tied dates without loading bodies', async () => {
  const db = path.join(await temp(), 'app.sqlite');
  const store = openArticleRepository(
    db,
    path.resolve('src/infrastructure/persistence/migrations'),
  );
  stores.push(store);
  const keys: string[] = [];
  for (let i = 0; i < 11; i++) {
    const a = store.reserve(`article-${i}`);
    store.commit(a, article(a));
    keys.push(a.articleKey);
  }
  executeImportSql(db, "UPDATE articles SET body_json = '[{}]'");
  const firstResult = store.list!();
  if (firstResult.status !== 'ok') throw new Error('Library unavailable');
  const first = firstResult.page;
  expect(first.items).toHaveLength(10);
  expect(first.items.map((item) => item.articleKey)).toEqual(
    keys.sort().reverse().slice(0, 10),
  );
  const lastResult = store.list!(first.nextCursor);
  if (lastResult.status !== 'ok') throw new Error('Library unavailable');
  const last = lastResult.page;
  expect(last.items.map((item) => item.articleKey)).toEqual(keys.slice(10));
  expect(last.nextCursor).toBeUndefined();
  expect(first.items[0]).not.toHaveProperty('body');
  expect(first.items[0].imageCount).toBe(0);
  expect(() =>
    store.list!({
      articleKey: "' OR 1=1",
      createdAt: 'invalid',
      membershipRevision: 11,
      pageNumber: 2,
    }),
  ).toThrow();
  executeImportSql(db, "UPDATE articles SET title = ''");
  expect(() => store.list!()).toThrow();
});
it('reads exact owned image bytes and rejects foreign IDs, paths, metadata and tampering', async () => {
  const root = await temp();
  const store = createAssetStore(root);
  const a: ImportAttempt = {
    importId: randomUUID(),
    articleKey: randomUUID(),
    externalId: 'image',
    startedAt: new Date().toISOString(),
    status: 'preparing',
  };
  const bytes = await sharp({
    create: { width: 2, height: 3, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  await store.prepare(a, signal());
  const asset = await store.put(a, 'front', bytes, signal());
  await store.finalize(a, signal());
  const value = article(a);
  value.assets = [asset];
  value.body.push({ type: 'image', image_id: 'front' });
  expect(await store.readImage!(value, asset.assetKey)).toEqual(bytes);
  await expect(store.readImage!(value, randomUUID())).rejects.toThrow();
  await expect(
    store.readImage!(
      { ...value, assets: [{ ...asset, relativePath: '../secret.png' }] },
      asset.assetKey,
    ),
  ).rejects.toThrow();
  await expect(
    store.readImage!(
      { ...value, assets: [{ ...asset, width: 4 }] },
      asset.assetKey,
    ),
  ).rejects.toThrow();
  const marker = path.join(root, a.articleKey, '.owner.json');
  const owner = await fs.readFile(marker);
  await fs.writeFile(marker, '{}');
  await expect(store.readImage!(value, asset.assetKey)).rejects.toThrow();
  await fs.writeFile(marker, owner);
  await fs.writeFile(
    path.join(root, asset.relativePath),
    Buffer.alloc(bytes.length),
  );
  await expect(store.readImage!(value, asset.assetKey)).rejects.toThrow();
  await fs.unlink(path.join(root, asset.relativePath));
  await expect(store.readImage!(value, asset.assetKey)).rejects.toThrow();
});
