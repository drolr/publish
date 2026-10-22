import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createManualArticleController } from '../../src/application/manual-article';
import { createImportController } from '../../src/application/import-controller';
import { createLibraryWriteGate } from '../../src/desktop/main/library-write-gate';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { createManualImageSource } from '../../src/infrastructure/assets/manual-image-source';
import { createManualTempStore } from '../../src/infrastructure/assets/manual-temp-store';
import { createWebPasteImageReader } from '../../src/infrastructure/assets/web-paste-image-reader';
import * as remote from '../../src/infrastructure/assets/remote-reader';
vi.mock('../../src/infrastructure/assets/remote-reader', async (original) => ({
  ...(await original<typeof remote>()),
}));
const base = path.resolve('.tmp/web-paste-images');
const roots: string[] = [];
const signal = () => new AbortController().signal;
async function setup() {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  roots.push(root);
  const store = createManualTempStore(root);
  expect(await store.recover()).toBe(true);
  return { root, store, source: createManualImageSource(store) };
}
async function image(format: 'png' | 'jpeg' | 'webp' = 'png') {
  return sharp({
    create: { width: 2, height: 3, channels: 3, background: 'white' },
  })
    .toFormat(format)
    .toBuffer();
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + path.sep)) throw Error('unsafe');
    await fs.rm(root, { recursive: true, force: true });
  }
});
it.each(['png', 'jpeg', 'webp'] as const)(
  'authorizes actual static %s original bytes and reader acquires them',
  async (format) => {
    const { source } = await setup();
    const bytes = await image(format);
    vi.spyOn(remote, 'readRemoteImage').mockResolvedValue(bytes);
    const id = randomUUID();
    const dto = await createWebPasteImageReader(source).acquire(
      id,
      'https://images.example/a',
      signal(),
    );
    expect(dto).toMatchObject({
      mime: `image/${format}`,
      width: 2,
      height: 3,
      byteSize: bytes.length,
    });
    expect((await source.read(id, dto.imageToken, signal())).bytes).toEqual(
      bytes,
    );
  },
);
it('remove_last_reference_only retains duplicates, deletes temp bytes and never deletes local originals', async () => {
  const { source, root } = await setup();
  const bytes = await image();
  const local = path.join(root, 'original.png');
  await fs.writeFile(local, bytes);
  const id = randomUUID();
  const a = await source.authorize(id, local, signal());
  const b = await source.authorizeBytes(id, bytes, signal());
  await source.retain(id, [b.imageToken, b.imageToken]);
  expect((await source.read(id, b.imageToken, signal())).bytes).toEqual(bytes);
  await expect(source.read(id, a.imageToken, signal())).rejects.toThrow();
  await source.retain(id, []);
  expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
  expect(await fs.readFile(local)).toEqual(bytes);
});
it('mixed_local_remote_total_budget shares the inclusive 200 image count', async () => {
  const { source, root } = await setup();
  const bytes = await image();
  const local = path.join(root, 'original.png');
  await fs.writeFile(local, bytes);
  const id = randomUUID();
  for (let i = 0; i < 199; i++) await source.authorize(id, local, signal());
  const last = await source.authorizeBytes(id, bytes, signal());
  await expect(
    source.authorizeBytes(id, bytes, signal()),
  ).rejects.toMatchObject({ code: 'IMAGE_LIMIT' });
  await expect(source.authorize(id, local, signal())).rejects.toMatchObject({
    code: 'IMAGE_LIMIT_EXCEEDED',
  });
  await source.retain(id, [last.imageToken]);
  await expect(
    source.authorizeBytes(id, bytes, signal()),
  ).resolves.toHaveProperty('imageToken');
}, 20000);
it('mixed_local_remote_total_budget shares inclusive 200 MiB and rejects one extra byte', async () => {
  const { source, root } = await setup();
  const bytes = await image('jpeg');
  const large = Buffer.concat([
    bytes,
    Buffer.alloc(20 * 1024 * 1024 - bytes.length),
  ]);
  const local = path.join(root, 'original.jpg');
  await fs.writeFile(local, large);
  const id = randomUUID();
  for (let i = 0; i < 9; i++) await source.authorize(id, local, signal());
  const last = await source.authorizeBytes(id, large, signal());
  await expect(
    source.authorizeBytes(id, Buffer.from([1]), signal()),
  ).rejects.toMatchObject({ code: 'IMAGE_LIMIT' });
  await source.retain(id, [last.imageToken]);
  await expect(
    source.authorizeBytes(id, bytes, signal()),
  ).resolves.toHaveProperty('imageToken');
}, 20000);
it.each([
  [Buffer.from('<html>login</html>'), 'IMAGE_INVALID'],
  [Buffer.from([1, 2, 3]), 'IMAGE_INVALID'],
  [Buffer.alloc(20 * 1024 * 1024 + 1), 'IMAGE_LIMIT'],
] as const)('rejects invalid or oversized real bytes', async (bytes, code) => {
  const { source } = await setup();
  await expect(
    source.authorizeBytes(randomUUID(), bytes, signal()),
  ).rejects.toMatchObject({ code });
});
it('unsupported sources do not invoke network and fatal temp errors remain fatal', async () => {
  const { source, store } = await setup();
  const read = vi
    .spyOn(remote, 'readRemoteImage')
    .mockRejectedValue(new WebPasteFailure('SOURCE_UNSUPPORTED'));
  const reader = createWebPasteImageReader(source);
  for (const raw of [
    'data:image/png;base64,AA',
    'blob:https://example/a',
    'file:///a',
    '/a',
    '//example/a',
    'https://u:p@example/a',
    'https://example/a#b',
    'https:example/a',
    'https:///example/a',
    'https:////example/a',
  ])
    await expect(
      reader.acquire(randomUUID(), raw, signal()),
    ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  expect(read).not.toHaveBeenCalled();
  read.mockResolvedValue(await image());
  vi.spyOn(store, 'put').mockRejectedValue({ code: 'RECOVERY_REQUIRED' });
  await expect(
    reader.acquire(randomUUID(), 'https://example/a', signal()),
  ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});
import * as validator from '../../src/infrastructure/assets/image-validator';
import { WebPasteFailure } from '../../src/domain/web-paste-error';
vi.mock(
  '../../src/infrastructure/assets/image-validator',
  async (original) => ({ ...(await original<typeof validator>()) }),
);
it('does exactly one complete validation per acquisition', async () => {
  const { source } = await setup();
  vi.spyOn(remote, 'readRemoteImage').mockResolvedValue(await image());
  const validation = vi.spyOn(validator, 'validateImage');
  await createWebPasteImageReader(source).acquire(
    randomUUID(),
    'https://example/a',
    signal(),
  );
  expect(validation).toHaveBeenCalledTimes(1);
});
it.each(['abort', 'release', 'retain'] as const)(
  'late sealed authorization is cleaned before %s settles and cannot publish a token',
  async (mode) => {
    const { source, store, root } = await setup();
    const id = randomUUID();
    const c = new AbortController();
    const realPut = store.put;
    let reached!: () => void;
    const entered = new Promise<void>((r) => (reached = r));
    let unblock!: () => void;
    const wait = new Promise<void>((r) => (unblock = r));
    vi.spyOn(store, 'put').mockImplementation(async (...args) => {
      const ref = await realPut(...args);
      reached();
      await wait;
      return ref;
    });
    const pending = source.authorizeBytes(id, await image(), c.signal);
    const rejected = expect(pending).rejects.toThrow();
    await entered;
    let settled = false;
    let cleanup: Promise<void> = Promise.resolve();
    if (mode === 'abort') c.abort();
    if (mode === 'release') cleanup = source.release(id);
    if (mode === 'retain') cleanup = source.retain(id, []);
    if (mode !== 'abort') {
      void cleanup.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
    }
    unblock();
    await rejected;
    await cleanup;
    expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
  },
);
it('cleanup failure wins over cancellation and release awaits and reports failed late cleanup', async () => {
  const { source, store } = await setup();
  const id = randomUUID();
  const c = new AbortController();
  const realPut = store.put;
  let reached!: () => void;
  const entered = new Promise<void>((r) => (reached = r));
  let unblock!: () => void;
  const wait = new Promise<void>((r) => (unblock = r));
  vi.spyOn(store, 'put').mockImplementation(async (...args) => {
    const ref = await realPut(...args);
    reached();
    await wait;
    return ref;
  });
  vi.spyOn(store, 'remove').mockRejectedValue(
    new WebPasteFailure('RECOVERY_REQUIRED'),
  );
  const pending = source.authorizeBytes(id, await image(), c.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
  });
  await entered;
  c.abort();
  const cleanup = source.release(id);
  const cleanupRejected = expect(cleanup).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
  });
  unblock();
  await Promise.all([rejected, cleanupRejected]);
});
it('source rejects actual animated image bytes', async () => {
  const { source } = await setup();
  const bytes = await sharp(
    Buffer.concat([Buffer.alloc(12, 0), Buffer.alloc(12, 255)]),
    { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } },
  )
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  await expect(
    source.authorizeBytes(randomUUID(), bytes, signal()),
  ).rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED' });
});
it('reports network timeout as retryable image timeout without accepting delayed bytes', async () => {
  const { source } = await setup();
  const bytes = await image();
  vi.useFakeTimers();
  try {
    vi.spyOn(remote, 'readRemoteImage').mockImplementation(
      async (_raw, sig) =>
        new Promise((resolve) => {
          sig.addEventListener('abort', () => resolve(bytes), { once: true });
        }),
    );
    const pending = createWebPasteImageReader(source).acquire(
      randomUUID(),
      'https://example/a',
      signal(),
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'IMAGE_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(30001);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});
it('bounds complete decode to 30 seconds and waits for late decoder settlement without writing bytes', async () => {
  const { source, root } = await setup();
  const bytes = await image();
  vi.useFakeTimers();
  try {
    vi.spyOn(validator, 'validateImage').mockImplementation(
      async (_bytes, sig) =>
        new Promise((resolve) => {
          sig.addEventListener(
            'abort',
            () =>
              resolve({
                mime: 'image/png',
                extension: 'png',
                width: 2,
                height: 3,
              }),
            { once: true },
          );
        }),
    );
    const pending = source.authorizeBytes(randomUUID(), bytes, signal());
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'IMAGE_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(30001);
    await rejected;
    expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
it.each([
  'private',
  'mixed-dns',
  'peer-rebind',
  'redirect-rebind',
  'downgrade',
  'four-redirects',
] as const)(
  'network_policy_unchanged: %s never yields an image token',
  async (mode) => {
    const { source } = await setup();
    const bytes = await image();
    let resolutions = 0;
    const read = remote.createRemoteImageReader({
      resolve: async () => {
        resolutions++;
        if (
          mode === 'private' ||
          (mode === 'redirect-rebind' && resolutions > 1)
        )
          return [{ address: '127.0.0.1', family: 4 }];
        if (mode === 'mixed-dns')
          return [
            { address: '8.8.8.8', family: 4 },
            { address: '10.0.0.1', family: 4 },
          ];
        return [{ address: '8.8.8.8', family: 4 }];
      },
      request: async () => ({
        status: ['redirect-rebind', 'downgrade', 'four-redirects'].includes(
          mode,
        )
          ? 302
          : 200,
        headers: {
          location:
            mode === 'downgrade'
              ? 'http://other.example/a'
              : 'https://other.example/a',
        },
        peerAddress: mode === 'peer-rebind' ? '127.0.0.1' : '8.8.8.8',
        body: (async function* () {
          yield bytes;
        })(),
        async close() {},
      }),
    });
    vi.spyOn(remote, 'readRemoteImage').mockImplementation(read);
    await expect(
      createWebPasteImageReader(source).acquire(
        randomUUID(),
        'https://example/a',
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  },
);
it('caller mutation cannot alter decoded metadata or sealed original bytes', async () => {
  const { source } = await setup();
  const input = await image();
  const original = Buffer.from(input);
  const id = randomUUID();
  const pending = source.authorizeBytes(id, input, signal());
  input.fill(0);
  const dto = await pending;
  expect(dto).toMatchObject({
    mime: 'image/png',
    width: 2,
    height: 3,
    byteSize: original.length,
  });
  expect((await source.read(id, dto.imageToken, signal())).bytes).toEqual(
    original,
  );
});
it.each(['dns', 'transport'] as const)(
  'deadline keeps %s ownership until settlement and ignores late results',
  async (mode) => {
    const { source, root } = await setup();
    const bytes = await image();
    let resolveDns!: (value: { address: string; family: number }[]) => void;
    let dnsSignal: AbortSignal | undefined;
    let settled = false;
    let resolveTransport!: (value: remote.RemoteResponse) => void;
    let requests = 0;
    let closed = 0;
    let consumed = 0;
    const read = remote.createRemoteImageReader({
      resolve: (_hostname, signal) => {
        dnsSignal = signal;
        return mode === 'dns'
          ? new Promise((resolve) => (resolveDns = resolve))
          : Promise.resolve([{ address: '8.8.8.8', family: 4 }]);
      },
      request: () => {
        requests++;
        return new Promise((resolve) => (resolveTransport = resolve));
      },
    });
    vi.spyOn(remote, 'readRemoteImage').mockImplementation(read);
    vi.useFakeTimers();
    try {
      const pending = createWebPasteImageReader(source).acquire(
        randomUUID(),
        'https://example/a',
        signal(),
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'IMAGE_TIMEOUT',
      });
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(30000);
      const before = requests;
      if (mode === 'dns') {
        expect(dnsSignal?.aborted).toBe(true);
        expect(settled).toBe(false);
        resolveDns([{ address: '8.8.8.8', family: 4 }]);
        await rejected;
      } else {
        expect(settled).toBe(false);
        resolveTransport({
          status: 302,
          headers: { location: 'https://other.example/a' },
          peerAddress: '8.8.8.8',
          body: (async function* () {
            consumed++;
            yield bytes;
          })(),
          async close() {
            closed++;
          },
        });
      }
      await rejected;
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(before);
      expect(consumed).toBe(0);
      if (mode === 'transport') expect(closed).toBeGreaterThan(0);
      expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  },
);
it('abort-ignoring late decoder cannot publish or write after its deadline', async () => {
  const { source, root } = await setup();
  const bytes = await image();
  vi.useFakeTimers();
  try {
    vi.spyOn(validator, 'validateImage').mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                mime: 'image/png',
                extension: 'png',
                width: 2,
                height: 3,
              }),
            31000,
          ),
        ),
    );
    const pending = source.authorizeBytes(randomUUID(), bytes, signal());
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'IMAGE_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(settled).toBe(false);
    expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it('HTTP retirement retains acquisition/controller ownership and write exclusion through shutdown', async () => {
  const { source, root } = await setup();
  let bodyReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    bodyReady = resolve;
  });
  let release!: () => void;
  const retirementGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let retired!: () => void;
  const realRetired = new Promise<void>((resolve) => {
    retired = resolve;
  });
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.write('first');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('listen');
  const transport = remote.createNodeTransport((options, callback) =>
    request(
      { ...options, hostname: '127.0.0.1', port: address.port },
      callback,
    ),
  );
  const read = remote.createRemoteImageReader({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async (target, signal) => {
      const response = await transport(
        { ...target, address: '127.0.0.1' },
        signal,
      );
      bodyReady();
      return {
        ...response,
        peerAddress: '8.8.8.8',
        close: async () => {
          await response.close();
          retired();
          // A bounded fixture-owned acknowledgment makes premature release observable.
          await retirementGate;
        },
      };
    },
  });
  vi.spyOn(remote, 'readRemoteImage').mockImplementation(read);
  const acquirer = createWebPasteImageReader(source);
  let acquisitionSettled = false;
  const manual = createManualArticleController({
    newId: randomUUID,
    fingerprint: JSON.stringify,
    externalExists: () => false,
    gate: () => 'ready',
    chooseImage: async () => undefined,
    readImage: (id, token, signal) => source.read(id, token, signal),
    retainImages: (id, tokens) => source.retain(id, tokens),
    releaseImages: (id) => source.release(id),
    save: async () => ({ status: 'cancelled' }),
    converter: {
      convert: async () => ({
        blocks: [{ type: 'image', source: 'http://fixture.example/a' }],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async (...args) => {
        try {
          return await acquirer.acquire(...args);
        } finally {
          acquisitionSettled = true;
        }
      },
    },
  });
  const imports = createImportController({
    newId: randomUUID,
    choose: async () => undefined,
    importArticle: async () => ({ status: 'cancelled' }),
  });
  const gate = createLibraryWriteGate({
    available: () => true,
    isClosing: () => false,
    manual,
    imports,
  });
  let shutdownSettled = false;
  let stopped: Promise<void> | undefined;
  try {
    const begun = (await manual.beginManualArticle()).snapshot;
    if (!('sessionId' in begun)) throw Error('session');
    await manual.startManualPaste(
      {
        sessionId: begun.sessionId,
        expectedRevision: begun.revision,
        commandId: begun.nextPasteCommandId,
      },
      { html: '<img src="http://fixture.example/a">', plain: '' },
    );
    await ready;
    await new Promise<void>((resolve) => setImmediate(resolve));
    stopped = manual.stopAndWait().then(() => {
      shutdownSettled = true;
    });
    await realRetired;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquisitionSettled).toBe(false);
    expect(shutdownSettled).toBe(false);
    expect(manual.isActive()).toBe(true);
    expect(gate.state()).not.toBe('ready');
    expect(gate.startImport()).toEqual({ status: 'unavailable' });
    expect(imports.isActive()).toBe(false);
    release();
    await stopped;
    expect(acquisitionSettled).toBe(true);
    expect(shutdownSettled).toBe(true);
    expect(manual.isActive()).toBe(false);
    expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
  } finally {
    release();
    server.closeAllConnections();
    await stopped;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
