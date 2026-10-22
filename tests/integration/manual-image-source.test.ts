import { createHash, randomUUID } from 'node:crypto';
import type { StoredArticle } from '../../src/contracts/stored-article';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
import { createManualTempStore } from '../../src/infrastructure/assets/manual-temp-store';
import { createManualImageSource } from '../../src/infrastructure/assets/manual-image-source';

const base = path.resolve('.tmp/manual-images');
const roots: string[] = [];
const signal = () => new AbortController().signal;
async function sourceForTest() {
  const store = createManualTempStore(await temp());
  expect(await store.recover()).toBe(true);
  return createManualImageSource(store);
}
async function temp() {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  roots.push(root);
  return root;
}
async function image(format: 'png' | 'jpeg' | 'webp' = 'png') {
  const bytes = await sharp({
    create: { width: 2, height: 3, channels: 3, background: 'white' },
  })
    .toFormat(format)
    .toBuffer();
  const file = path.join(await temp(), `private.${format}`);
  await fs.writeFile(file, bytes);
  return { file, bytes };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + path.sep)) throw new Error('Unsafe cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each(['png', 'jpeg', 'webp'] as const)(
  'authorizes real %s bytes without exposing paths or hashes',
  async (format) => {
    const { file, bytes } = await image(format);
    const source = await sourceForTest();
    const session = randomUUID();
    const dto = await source.authorize(session, file, signal());
    expect(dto).toEqual({
      imageToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      mime: `image/${format}`,
      width: 2,
      height: 3,
      byteSize: bytes.length,
    });
    expect(await source.read(session, dto.imageToken, signal())).toEqual({
      mime: `image/${format}`,
      bytes,
    });
    expect(
      await source.readCapability(
        source.capability(session),
        `${dto.imageToken}.image`,
        signal(),
      ),
    ).toEqual(bytes);
    dto.width = 99;
    expect(
      (await source.read(session, dto.imageToken, signal())).bytes,
    ).toEqual(bytes);
  },
);

it.each(['changed', 'deleted', 'replaced', 'hardlinked'] as const)(
  'rejects an authorized source that is %s',
  async (mode) => {
    const { file, bytes } = await image();
    const source = await sourceForTest();
    const session = randomUUID();
    const dto = await source.authorize(session, file, signal());
    if (mode === 'changed')
      await fs.writeFile(file, Buffer.alloc(bytes.length));
    if (mode === 'deleted') await fs.unlink(file);
    if (mode === 'replaced') {
      await fs.rename(file, `${file}.original`);
      await fs.writeFile(file, bytes);
    }
    if (mode === 'hardlinked') await fs.link(file, `${file}.link`);
    await expect(
      source.read(session, dto.imageToken, signal()),
    ).rejects.toThrow();
  },
);

it('rejects hardlinks, directory junctions, directories, relative and network paths at authorization', async () => {
  const { file } = await image();
  const root = await temp();
  await fs.link(file, path.join(root, 'hard.png'));
  await fs.symlink(path.dirname(file), path.join(root, 'linked'), 'junction');
  const source = await sourceForTest();
  for (const target of [
    file,
    path.join(root, 'hard.png'),
    path.join(root, 'linked/private.png'),
    root,
    '../private.png',
    '\\\\host\\share\\image.png',
  ]) {
    await expect(
      source.authorize(randomUUID(), target, signal()),
    ).rejects.toThrow();
  }
});

it('rejects invalid and oversized images with safe errors', async () => {
  const file = path.join(await temp(), 'secret-path.png');
  const source = await sourceForTest();
  await fs.writeFile(file, 'not an image');
  await expect(
    source.authorize(randomUUID(), file, signal()),
  ).rejects.toMatchObject({ code: 'IMAGE_INVALID' });
  await fs.writeFile(file, Buffer.alloc(20 * 1024 * 1024 + 1));
  await expect(
    source.authorize(randomUUID(), file, signal()),
  ).rejects.toMatchObject({ code: 'IMAGE_LIMIT_EXCEEDED' });
  await fs.unlink(file);
  await expect(
    source.authorize(randomUUID(), file, signal()),
  ).rejects.toMatchObject({
    code: 'IMAGE_UNAVAILABLE',
    message: expect.not.stringContaining(file),
  });
});

it('binds tokens and opaque capabilities to their source instance and live session', async () => {
  const { file } = await image();
  const source = await sourceForTest();
  const session = randomUUID();
  const dto = await source.authorize(session, file, signal());
  const capability = source.capability(session);
  const name = `${dto.imageToken}.image`;
  await expect(
    source.read(randomUUID(), dto.imageToken, signal()),
  ).rejects.toThrow();
  await expect(
    source.readCapability({ kind: 'manual-images' }, name, signal()),
  ).rejects.toThrow();
  await expect(
    (await sourceForTest()).readCapability(capability, name, signal()),
  ).rejects.toThrow();
  for (const invalid of [
    file,
    dto.imageToken,
    `../${name}`,
    `${name}/`,
    name.toUpperCase(),
    `${name}:stream`,
  ]) {
    await expect(
      source.readCapability(capability, invalid, signal()),
    ).rejects.toThrow();
  }
  await source.release(session);
  const next = await source.authorize(session, file, signal());
  await expect(
    source.read(session, dto.imageToken, signal()),
  ).rejects.toThrow();
  await expect(
    source.readCapability(capability, `${next.imageToken}.image`, signal()),
  ).rejects.toThrow();
  expect(
    (await source.read(session, next.imageToken, signal())).bytes.length,
  ).toBeGreaterThan(0);
});

it('retains repeated references and revokes tokens after their final reference is removed', async () => {
  const { file } = await image();
  const source = await sourceForTest();
  const session = randomUUID();
  const first = await source.authorize(session, file, signal());
  const second = await source.authorize(session, file, signal());
  await source.retain(session, [first.imageToken, first.imageToken]);
  await expect(
    source.read(session, first.imageToken, signal()),
  ).resolves.toHaveProperty('bytes');
  await expect(
    source.read(session, second.imageToken, signal()),
  ).rejects.toThrow();
  await source.retain(session, []);
  await expect(
    source.read(session, first.imageToken, signal()),
  ).rejects.toThrow();
});

it.each(['release', 'retain', 'abort'] as const)(
  'never returns bytes revoked by %s during handle reading',
  async (mode) => {
    const { file } = await image();
    const source = await sourceForTest();
    const session = randomUUID();
    const dto = await source.authorize(session, file, signal());
    const controller = new AbortController();
    const realOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(
      async (...args: Parameters<typeof realOpen>) => {
        const handle = await realOpen(...args);
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          if (mode === 'release') await source.release(session);
          if (mode === 'retain') await source.retain(session, []);
          if (mode === 'abort') controller.abort();
          return result;
        }) as typeof handle.read;
        return handle;
      },
    );
    await expect(
      source.read(session, dto.imageToken, controller.signal),
    ).rejects.toThrow();
    await fs.unlink(file);
  },
);

it('does not restore a session released during authorization', async () => {
  const { file } = await image();
  const source = await sourceForTest();
  const session = randomUUID();
  const pending = source.authorize(session, file, signal());
  await source.release(session);
  await expect(pending).rejects.toThrow();
});

it('bounds outstanding reads and authorizations without queueing work', async () => {
  const { file } = await image();
  const source = await sourceForTest();
  const session = randomUUID();
  const pending = source.authorize(session, file, signal());
  await expect(source.authorize(session, file, signal())).rejects.toThrow();
  const dto = await pending;
  const reading = source.read(session, dto.imageToken, signal());
  await expect(
    source.read(session, dto.imageToken, signal()),
  ).rejects.toThrow();
  await reading;
});

it('enforces 200 images and makes capacity available after reference revocation', async () => {
  const { file } = await image();
  const source = await sourceForTest();
  const session = randomUUID();
  const tokens: string[] = [];
  for (let index = 0; index < 200; index++)
    tokens.push((await source.authorize(session, file, signal())).imageToken);
  await expect(source.authorize(session, file, signal())).rejects.toMatchObject(
    { code: 'IMAGE_LIMIT_EXCEEDED' },
  );
  await source.retain(session, tokens.slice(1));
  await expect(
    source.authorize(session, file, signal()),
  ).resolves.toHaveProperty('imageToken');
});

it('checks the content hash independently of unchanged file identity and byte count', async () => {
  const { file } = await image();
  const source = await sourceForTest();
  const session = randomUUID();
  const dto = await source.authorize(session, file, signal());
  const realOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        // Simulate bytes changing despite indistinguishable file metadata.
        if (result.bytesRead) {
          const bytes = new Uint8Array(
            result.buffer.buffer,
            result.buffer.byteOffset,
            result.buffer.byteLength,
          );
          bytes[0] ^= 1;
        }
        return result;
      }) as typeof handle.read;
      return handle;
    },
  );
  await expect(
    source.read(session, dto.imageToken, signal()),
  ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
});

it('enforces the inclusive 200 MiB session total and frees bytes on release', async () => {
  const { file, bytes } = await image('jpeg');
  await fs.writeFile(
    file,
    Buffer.concat([bytes, Buffer.alloc(20 * 1024 * 1024 - bytes.length)]),
  );
  const source = await sourceForTest();
  const session = randomUUID();
  for (let index = 0; index < 10; index++) {
    expect((await source.authorize(session, file, signal())).byteSize).toBe(
      20 * 1024 * 1024,
    );
  }
  await expect(source.authorize(session, file, signal())).rejects.toMatchObject(
    { code: 'IMAGE_LIMIT_EXCEEDED' },
  );
  await source.release(session);
  await expect(
    source.authorize(session, file, signal()),
  ).resolves.toHaveProperty('imageToken');
}, 20_000);

it('rejects a source directory replaced by a junction after authorization', async () => {
  const { bytes } = await image();
  const root = await temp();
  const directory = path.join(root, 'selected');
  await fs.mkdir(directory);
  const file = path.join(directory, 'image.png');
  await fs.writeFile(file, bytes);
  const replacement = path.join(root, 'original');
  const source = await sourceForTest();
  const session = randomUUID();
  const dto = await source.authorize(session, file, signal());
  await fs.rename(directory, replacement);
  await fs.symlink(replacement, directory, 'junction');
  await expect(source.authorize(session, file, signal())).rejects.toThrow();
  await expect(
    source.read(session, dto.imageToken, signal()),
  ).rejects.toThrow();
});

it('rejects invalid bytes through complete image validation', async () => {
  const source = await sourceForTest();
  expect(source.authorizeBytes).toBeTypeOf('function');
  await expect(
    source.authorizeBytes(randomUUID(), new Uint8Array([1]), signal()),
  ).rejects.toMatchObject({ code: 'IMAGE_INVALID' });
});
it('binds saved images in the same full 200-token registry slot and preserves history read ownership', async () => {
  const { file, bytes } = await image();
  const store = createManualTempStore(await temp());
  expect(await store.recover()).toBe(true);
  const source = createManualImageSource(store, {
    readImage: async () => bytes,
  } as never);
  const session = randomUUID(),
    articleKey = randomUUID(),
    assetKey = randomUUID();
  const tokens: string[] = [];
  for (let n = 0; n < 200; n++)
    tokens.push((await source.authorize(session, file, signal())).imageToken);
  const article: StoredArticle = {
    articleKey,
    importId: randomUUID(),
    externalId: 'saved',
    title: 'Title',
    contentDeclaration: 'repost',
    createdAt: '2026-10-08T00:00:00.000Z',
    body: [
      { type: 'paragraph', text: 'Body' },
      { type: 'image', image_id: tokens[0] },
    ],
    assets: [
      {
        assetKey,
        imageId: tokens[0],
        relativePath: `${articleKey}/${assetKey}.png`,
        mime: 'image/png',
        width: 2,
        height: 3,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
  expect(source.bindSavedImage).toBeTypeOf('function');
  const lease = await source.bindSavedImage(
    session,
    article,
    assetKey,
    tokens[0],
    signal(),
  );
  expect(
    (await source.readStored(lease, session, articleKey, tokens[0], signal()))
      .bytes,
  ).toEqual(bytes);
  await expect(
    source.bindSavedImage(session, article, assetKey, tokens[1], signal()),
  ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
  await fs.rename(file, file + '.moved');
  await source.retain(session, [], { preserveHistory: true });
  expect((await source.read(session, tokens[0], signal())).bytes).toEqual(
    bytes,
  );
  await source.bindSavedImage(session, article, assetKey, tokens[0], signal());
  await expect(
    source.authorize(session, file + '.moved', signal()),
  ).rejects.toMatchObject({ code: 'IMAGE_LIMIT_EXCEEDED' });
  await source.retain(session, tokens.slice(1));
  await expect(source.read(session, tokens[0], signal())).rejects.toMatchObject(
    { code: 'SOURCE_NOT_ALLOWED' },
  );
  await expect(
    source.readStored(lease, session, articleKey, tokens[0], signal()),
  ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
  await expect(
    source.authorize(session, file + '.moved', signal()),
  ).resolves.toHaveProperty('imageToken');
  await expect(
    source.bindSavedImage(randomUUID(), article, assetKey, tokens[0], signal()),
  ).rejects.toThrow();
  await expect(
    source.bindSavedImage(session, article, assetKey, randomUUID(), signal()),
  ).rejects.toThrow();
  await source.release(session);
  await expect(
    source.readStored(lease, session, articleKey, tokens[0], signal()),
  ).rejects.toThrow();
});
it('a rejected overlapping stored read cannot retire the original physical read owner', async () => {
  const { file, bytes } = await image();
  const store = createManualTempStore(await temp());
  expect(await store.recover()).toBe(true);
  let hold = false,
    finish!: (value: Uint8Array) => void;
  const source = createManualImageSource(store, {
    readImage: async () =>
      hold
        ? new Promise<Uint8Array>((r) => {
            finish = r;
          })
        : bytes,
  } as never);
  const session = randomUUID(),
    articleKey = randomUUID(),
    assetKey = randomUUID();
  const token = (await source.authorize(session, file, signal())).imageToken;
  const article: StoredArticle = {
    articleKey,
    importId: randomUUID(),
    externalId: 'saved',
    title: 'Title',
    contentDeclaration: 'repost',
    createdAt: '2026-10-08T00:00:00.000Z',
    body: [
      { type: 'paragraph', text: 'Body' },
      { type: 'image', image_id: token },
    ],
    assets: [
      {
        assetKey,
        imageId: token,
        relativePath: `${articleKey}/${assetKey}.png`,
        mime: 'image/png',
        width: 2,
        height: 3,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
  const lease = await source.bindSavedImage(
    session,
    article,
    assetKey,
    token,
    signal(),
  );
  hold = true;
  const pending = source.readStored(
    lease,
    session,
    articleKey,
    token,
    signal(),
  );
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'SOURCE_NOT_ALLOWED',
  });
  await expect(
    source.readStored(lease, session, articleKey, token, signal()),
  ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
  let released = false;
  const closing = source.release(session).then(() => {
    released = true;
  });
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(released).toBe(false);
  finish(bytes);
  await rejected;
  await closing;
  expect(released).toBe(true);
});

function savedFixture(token: string, bytes: Uint8Array): StoredArticle {
  const articleKey = randomUUID(),
    assetKey = randomUUID();
  return {
    articleKey,
    importId: randomUUID(),
    externalId: 'isolated',
    title: 'Fixture',
    contentDeclaration: 'repost',
    createdAt: '2026-10-08T00:00:00.000Z',
    body: [
      { type: 'paragraph', text: 'Body' },
      { type: 'image', image_id: token },
    ],
    assets: [
      {
        assetKey,
        imageId: token,
        relativePath: articleKey + '/' + assetKey + '.png',
        mime: 'image/png',
        width: 2,
        height: 3,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
}
it.each(['release', 'retain'] as const)(
  'bound temp generic read awaits physical owner before %s and preserves original cleanup',
  async (mode) => {
    const { bytes } = await image();
    const store = createManualTempStore(await temp());
    expect(await store.recover()).toBe(true);
    const remove = vi.spyOn(store, 'remove');
    let hold = false,
      entered = false,
      finish!: (bytes: Uint8Array) => void;
    const source = createManualImageSource(store, {
      readImage: async () => {
        if (!hold) return bytes;
        entered = true;
        return new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        });
      },
    } as never);
    const sid = randomUUID();
    const imageDto = await source.authorizeBytes(sid, bytes, signal());
    const article = savedFixture(imageDto.imageToken, bytes);
    const asset = article.assets[0];
    const lease = await source.bindSavedImage(
      sid,
      article,
      asset.assetKey,
      imageDto.imageToken,
      signal(),
    );
    hold = true;
    const read = source.read(sid, imageDto.imageToken, signal());
    const reading = read.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await Promise.resolve();
    expect(entered).toBe(true);
    await expect(
      source.read(sid, imageDto.imageToken, signal()),
    ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    let settled = false;
    const closing = (
      mode === 'release' ? source.release(sid) : source.retain(sid, [])
    ).then(() => {
      settled = true;
    });
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    finish(bytes);
    const result = await reading;
    await closing;
    if (mode === 'release')
      expect(result).toMatchObject({ error: { code: 'SOURCE_NOT_ALLOWED' } });
    else expect(result).toMatchObject({ value: { bytes } });
    expect(remove).toHaveBeenCalledTimes(1);
    await expect(
      source.readStored(
        lease,
        sid,
        article.articleKey,
        imageDto.imageToken,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    await expect(
      source.read(sid, imageDto.imageToken, signal()),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    await source.release(sid);
    expect(remove).toHaveBeenCalledTimes(1);
  },
);
it('bound generic reads reject damaged formal bytes rather than falling back to the external local file', async () => {
  const { file, bytes } = await image();
  const store = createManualTempStore(await temp());
  expect(await store.recover()).toBe(true);
  let formalBytes = bytes;
  const source = createManualImageSource(store, {
    readImage: async () => formalBytes,
  } as never);
  const sid = randomUUID(),
    dto = await source.authorize(sid, file, signal());
  const article = savedFixture(dto.imageToken, bytes);
  await source.bindSavedImage(
    sid,
    article,
    article.assets[0].assetKey,
    dto.imageToken,
    signal(),
  );
  formalBytes = Buffer.alloc(bytes.length);
  await expect(
    source.read(sid, dto.imageToken, signal()),
  ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
  await source.release(sid);
  expect(await fs.readFile(file)).toEqual(bytes);
});
