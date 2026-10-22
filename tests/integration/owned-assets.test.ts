import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));
import {
  authorizeLocalRoot,
  readLocalImage,
} from '../../src/infrastructure/assets/local-reader';
import { validateImage } from '../../src/infrastructure/assets/image-validator';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import type {
  ImportAttempt,
  StoredArticle,
} from '../../src/domain/ports/article-import';

const signal = () => new AbortController().signal;
const roots: string[] = [];
async function temp() {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(path.resolve('.tmp/assets-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const attempt = (): ImportAttempt => ({
  importId: randomUUID(),
  articleKey: randomUUID(),
  externalId: 'article-1',
  startedAt: new Date().toISOString(),
  status: 'preparing',
});
async function png() {
  return sharp({
    create: { width: 2, height: 3, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
}
describe('image decoder', () => {
  it('rejects an animated WebP container even when it contains only one frame', async () => {
    const frames = Buffer.concat([Buffer.alloc(12, 0), Buffer.alloc(12, 255)]);
    const animated = await sharp(frames, {
      raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    const chunks: Buffer[] = [animated.subarray(0, 12)];
    let framesKept = 0;
    for (let offset = 12; offset < animated.length;) {
      const size = animated.readUInt32LE(offset + 4);
      const end = offset + 8 + size + (size % 2);
      const type = animated.toString('ascii', offset, offset + 4);
      if (type !== 'ANMF' || framesKept++ === 0)
        chunks.push(animated.subarray(offset, end));
      offset = end;
    }
    const singleFrame = Buffer.concat(chunks);
    singleFrame.writeUInt32LE(singleFrame.length - 8, 4);
    expect(await sharp(singleFrame).metadata()).toMatchObject({
      pages: 1,
      loop: 0,
      delay: [100],
    });
    await expect(validateImage(singleFrame, signal())).rejects.toMatchObject({
      code: 'IMAGE_UNSUPPORTED',
    });
  });
  it('cancels an active native decode without an unhandled stream error', async () => {
    const bytes = await png();
    const controller = new AbortController();
    const decoding = validateImage(bytes, controller.signal);
    controller.abort();
    await expect(decoding).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects corrupt pixels even when metadata and the container are readable', async () => {
    const bytes = await png();
    const data = bytes.indexOf(Buffer.from('IDAT')) + 4;
    bytes[data] ^= 255;
    expect((await sharp(bytes).metadata()).width).toBe(2);
    await expect(validateImage(bytes, signal())).rejects.toMatchObject({
      code: 'IMAGE_INVALID',
    });
  });
  it('maps empty input to a safe invalid image error', async () => {
    await expect(
      validateImage(new Uint8Array(), signal()),
    ).rejects.toMatchObject({ code: 'IMAGE_INVALID' });
  });
  it.each(['jpeg', 'png', 'webp'] as const)(
    'fully decodes %s',
    async (format) => {
      const generated = sharp({
        create: { width: 2, height: 3, channels: 3, background: 'red' },
      });
      const bytes = await generated[format]().toBuffer();
      expect(await validateImage(bytes, signal())).toMatchObject({
        width: 2,
        height: 3,
        mime: `image/${format}`,
      });
    },
  );
  it('rejects unsupported real GIF and bogus bytes', async () => {
    const gif = await sharp({
      create: { width: 2, height: 3, channels: 3, background: 'red' },
    })
      .gif()
      .toBuffer();
    await expect(validateImage(gif, signal())).rejects.toMatchObject({
      code: 'IMAGE_UNSUPPORTED',
    });
    await expect(
      validateImage(Buffer.from('secret malformed'), signal()),
    ).rejects.toMatchObject({ code: 'IMAGE_INVALID' });
  });
  it('rejects truncated pixel data despite readable metadata', async () => {
    const bytes = await png();
    const truncated = bytes.subarray(0, bytes.length - 20);
    await expect(validateImage(truncated, signal())).rejects.toMatchObject({
      code: 'IMAGE_INVALID',
    });
  });
  it('rejects byte and dimension budgets', async () => {
    await expect(
      validateImage(new Uint8Array(20 * 1024 * 1024 + 1), signal()),
    ).rejects.toMatchObject({ code: 'IMAGE_LIMIT_EXCEEDED' });
    const wide = await sharp({
      create: { width: 10001, height: 1, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await expect(validateImage(wide, signal())).rejects.toMatchObject({
      code: 'IMAGE_LIMIT_EXCEEDED',
    });
  });
  it('honors an already cancelled signal', async () => {
    await expect(
      validateImage(await png(), AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects animated WebP and APNG rather than using their first frame', async () => {
    const frames = Buffer.concat([Buffer.alloc(12, 0), Buffer.alloc(12, 255)]);
    const animated = await sharp(frames, {
      raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    await expect(validateImage(animated, signal())).rejects.toMatchObject({
      code: 'IMAGE_UNSUPPORTED',
    });
    const base = await png();
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8, 0);
    chunk.write('acTL', 4);
    chunk.writeUInt32BE(2, 8);
    await expect(
      validateImage(
        Buffer.concat([base.subarray(0, 33), chunk, base.subarray(33)]),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED' });
  });
  it('rejects pixel budget above 25 million', async () => {
    const bytes = await sharp({
      create: { width: 5001, height: 5000, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await expect(validateImage(bytes, signal())).rejects.toMatchObject({
      code: 'IMAGE_LIMIT_EXCEEDED',
    });
  });
});
describe('local capability', () => {
  it('reads only authorized relative regular files', async () => {
    const root = await temp();
    const bytes = await png();
    await writeFile(path.join(root, 'image.png'), bytes);
    const cap = await authorizeLocalRoot(root);
    expect(await readLocalImage(cap, 'image.png', signal())).toEqual(bytes);
    await expect(
      readLocalImage({ kind: 'local-root' }, 'image.png', signal()),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    for (const name of [
      '../secret',
      '/etc/passwd',
      'C:\\secret',
      'image.png:stream',
    ])
      await expect(readLocalImage(cap, name, signal())).rejects.toMatchObject({
        code: 'SOURCE_NOT_ALLOWED',
      });
  });
  it('rejects directory junctions without reading or modifying their target', async () => {
    const root = await temp();
    const outside = await temp();
    await writeFile(path.join(outside, 'image.png'), 'outside');
    await symlink(outside, path.join(root, 'linked'), 'junction');
    const cap = await authorizeLocalRoot(root);
    await expect(
      readLocalImage(cap, 'linked/image.png', signal()),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    expect(await readFile(path.join(outside, 'image.png'), 'utf8')).toBe(
      'outside',
    );
  });
  it('rejects network and device root paths', async () => {
    for (const root of ['\\\\server\\share', '\\\\?\\C:\\Windows'])
      await expect(authorizeLocalRoot(root)).rejects.toMatchObject({
        code: 'SOURCE_NOT_ALLOWED',
      });
  });
  it('detects source identity change during the handle read', async () => {
    const root = await temp();
    const file = path.join(root, 'image.png');
    await writeFile(file, await png());
    const cap = await authorizeLocalRoot(root);
    const realOpen = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(
      async (...args: Parameters<typeof realOpen>) => {
        const handle = await realOpen(...args);
        const read = handle.read.bind(handle);
        let changed = false;
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          if (!changed) {
            changed = true;
            await writeFile(file, Buffer.from('changed'));
          }
          return result;
        }) as typeof handle.read;
        return handle;
      },
    );
    await expect(
      readLocalImage(cap, 'image.png', signal()),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    expect(await readFile(file, 'utf8')).toBe('changed');
  });
  it('stops a read and closes its opened handle when cancelled', async () => {
    const root = await temp();
    const file = path.join(root, 'image.png');
    await writeFile(file, await png());
    const cap = await authorizeLocalRoot(root);
    const controller = new AbortController();
    const realOpen = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(
      async (...args: Parameters<typeof realOpen>) => {
        const handle = await realOpen(...args);
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          controller.abort();
          return result;
        }) as typeof handle.read;
        return handle;
      },
    );
    await expect(
      readLocalImage(cap, 'image.png', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await rm(file);
    expect(await readdir(root)).toEqual([]);
  });
});
describe('owned asset store', () => {
  it('closes and cleans the partially written asset after cancellation', async () => {
    const root = await temp();
    const store = createAssetStore(root);
    const a = attempt();
    await store.prepare(a, signal());
    const controller = new AbortController();
    const realOpen = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(
      async (...args: Parameters<typeof realOpen>) => {
        const handle = await realOpen(...args);
        const write = handle.write.bind(handle);
        handle.write = (async (...writeArgs: Parameters<typeof write>) => {
          const result = await write(...writeArgs);
          controller.abort();
          return result;
        }) as typeof handle.write;
        return handle;
      },
    );
    await expect(
      store.put(a, 'front', await png(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await store.cleanup(a);
    expect(await readdir(path.join(root, '.staging'))).toEqual([]);
  });
  it('keeps exact bytes under UUID paths and detects later tampering', async () => {
    const root = await temp();
    const store = createAssetStore(root);
    const a = attempt();
    const bytes = await png();
    await store.prepare(a, signal());
    const asset = await store.put(a, 'front', bytes, signal());
    await store.finalize(a, signal());
    const article: StoredArticle = {
      articleKey: a.articleKey,
      externalId: a.externalId,
      importId: a.importId,
      title: 'Test',
      body: [
        { type: 'paragraph', text: 'text' },
        { type: 'image', image_id: 'front' },
      ],
      contentDeclaration: 'original',
      createdAt: a.startedAt,
      assets: [asset],
    };
    expect(await readFile(path.join(root, asset.relativePath))).toEqual(bytes);
    await store.verify(article);
    await writeFile(
      path.join(root, asset.relativePath),
      Buffer.alloc(bytes.length),
    );
    await expect(store.verify(article)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });
  it('cleans its own prepared and finalized directories', async () => {
    const root = await temp();
    const store = createAssetStore(root);
    const a = attempt();
    await store.prepare(a, signal());
    await store.put(a, 'front', await png(), signal());
    await store.finalize(a, signal());
    await store.cleanup(a);
    expect(await readdir(root)).toEqual(['.staging']);
  });
  it('preserves foreign ownership and unrelated files', async () => {
    const root = await temp();
    const store = createAssetStore(root);
    const a = attempt();
    await store.prepare(a, signal());
    await writeFile(
      path.join(root, '.staging', a.importId, '.owner.json'),
      'foreign',
    );
    await expect(store.cleanup(a)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(
      await readFile(
        path.join(root, '.staging', a.importId, '.owner.json'),
        'utf8',
      ),
    ).toBe('foreign');
  });
  it('recovers interruption immediately after an empty staging directory was created', async () => {
    const root = await temp();
    const a = attempt();
    await mkdir(path.join(root, '.staging', a.importId), { recursive: true });
    await createAssetStore(root).cleanup(a);
    expect(await readdir(path.join(root, '.staging'))).toEqual([]);
  });
  it('recovers a partial marker before any assets could be written', async () => {
    const root = await temp();
    const a = attempt();
    const stage = path.join(root, '.staging', a.importId);
    await mkdir(stage, { recursive: true });
    await writeFile(
      path.join(stage, '.owner.json'),
      JSON.stringify({ importId: a.importId, articleKey: a.articleKey }).slice(
        0,
        20,
      ),
    );
    await createAssetStore(root).cleanup(a);
    expect(await readdir(path.join(root, '.staging'))).toEqual([]);
  });
  it('will not clean a junction or a foreign member', async () => {
    const root = await temp();
    const outside = await temp();
    const a = attempt();
    await mkdir(path.join(root, '.staging'));
    await symlink(outside, path.join(root, '.staging', a.importId), 'junction');
    await expect(createAssetStore(root).cleanup(a)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    const b = attempt();
    const store = createAssetStore(root);
    await store.prepare(b, signal());
    await writeFile(
      path.join(root, '.staging', b.importId, 'unrelated.txt'),
      'keep',
    );
    await expect(store.cleanup(b)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(
      await readFile(
        path.join(root, '.staging', b.importId, 'unrelated.txt'),
        'utf8',
      ),
    ).toBe('keep');
  });
  it('refuses to overwrite an existing final directory', async () => {
    const root = await temp();
    const store = createAssetStore(root);
    const a = attempt();
    await store.prepare(a, signal());
    await mkdir(path.join(root, a.articleKey));
    await writeFile(path.join(root, a.articleKey, 'other'), 'keep');
    await expect(store.finalize(a, signal())).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(await readFile(path.join(root, a.articleKey, 'other'), 'utf8')).toBe(
      'keep',
    );
  });
});
