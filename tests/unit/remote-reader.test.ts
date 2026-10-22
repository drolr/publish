import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteImageReader,
  type RemoteResponse,
  type RemoteTarget,
} from '../../src/infrastructure/assets/remote-reader';

const signal = () => new AbortController().signal;
const response = (options: Partial<RemoteResponse> = {}): RemoteResponse => ({
  status: 200,
  headers: {},
  peerAddress: '8.8.8.8',
  body: Readable.from([Buffer.from('image')]),
  close: vi.fn(async () => {}),
  ...options,
});
const resolver = async () => [{ address: '8.8.8.8', family: 4 as const }];

describe('bounded remote image reader', () => {
  it('accepts exactly the byte limit with no Content-Length', async () => {
    const res = response({
      body: Readable.from([Buffer.alloc(20 * 1024 * 1024)]),
    });
    expect(
      (
        await createRemoteImageReader({
          resolve: resolver,
          request: async () => res,
        })('https://images.example/a', signal())
      ).length,
    ).toBe(20 * 1024 * 1024);
  });
  it('preserves only safe errors when a streamed response is truncated', async () => {
    async function* brokenBody() {
      yield Buffer.from('first');
      throw new Error('secret-token-path');
    }
    const res = response({ body: brokenBody() });
    const promise = createRemoteImageReader({
      resolve: resolver,
      request: async () => res,
    })('https://images.example/a', signal());
    await expect(promise).rejects.toMatchObject({
      code: 'IMAGE_UNAVAILABLE',
      message: '图片无法取得，请检查素材后重试。',
    });
    expect(res.close).toHaveBeenCalled();
  });
  it('ends stalled connection/headers at the same deadline', async () => {
    vi.useFakeTimers();
    try {
      let connectionSignal: AbortSignal | undefined;
      const pending = createRemoteImageReader({
        resolve: resolver,
        request: (_target, currentSignal) => {
          connectionSignal = currentSignal;
          return new Promise((_resolve, reject) => {
            currentSignal.addEventListener(
              'abort',
              () => reject(new Error('settled')),
              { once: true },
            );
          });
        },
      })('https://images.example/a', signal());
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'IMAGE_UNAVAILABLE',
      });
      await vi.advanceTimersByTimeAsync(30000);
      await assertion;
      expect(connectionSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('pins the checked address, preserves the original URL and returns original bytes', async () => {
    const targets: RemoteTarget[] = [];
    const read = createRemoteImageReader({
      resolve: resolver,
      request: async (target) => {
        targets.push(target);
        return response();
      },
    });
    expect(
      Buffer.from(
        await read('https://images.example/a?token=secret', signal()),
      ).toString(),
    ).toBe('image');
    expect(targets[0]).toMatchObject({
      address: '8.8.8.8',
      family: 4,
      hostname: 'images.example',
    });
    expect(targets[0].url.protocol).toBe('https:');
  });
  it('rejects an entire mixed DNS answer before connecting', async () => {
    const request = vi.fn();
    const read = createRemoteImageReader({
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      request,
    });
    await expect(
      read('https://images.example/a', signal()),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    'http://127.1/a',
    'http://2130706433/a',
    'https://user:pass@example.com/a',
    'ftp://example.com/a',
    'https://example.com:444/a',
    'http://[::ffff:8.8.8.8]/a',
    'https://example.com/a#b',
    'https://example.com/a\n',
  ])('rejects unsafe source %s', async (url) => {
    const request = vi.fn();
    await expect(
      createRemoteImageReader({ resolve: resolver, request })(url, signal()),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    expect(request).not.toHaveBeenCalled();
  });
  it('closes a response whose actual peer differs from the pinned address', async () => {
    const res = response({ peerAddress: '1.1.1.1' });
    await expect(
      createRemoteImageReader({ resolve: resolver, request: async () => res })(
        'https://images.example/a',
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    expect(res.close).toHaveBeenCalled();
  });
  it('rechecks redirect DNS and blocks rebinding', async () => {
    let count = 0;
    const res = response({ status: 302, headers: { location: '/next' } });
    const read = createRemoteImageReader({
      resolve: async () => [
        { address: ++count === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 },
      ],
      request: async () => res,
    });
    await expect(
      read('https://images.example/a', signal()),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    expect(count).toBe(2);
    expect(res.close).toHaveBeenCalled();
  });
  it('rejects HTTPS downgrade and a fourth redirect', async () => {
    for (const location of ['http://images.example/a', '/again']) {
      const request = vi.fn(async () =>
        response({ status: 302, headers: { location } }),
      );
      await expect(
        createRemoteImageReader({ resolve: resolver, request })(
          'https://images.example/a',
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
      expect(request).toHaveBeenCalledTimes(
        location.startsWith('http:') ? 1 : 4,
      );
    }
  });
  it('accepts three validated redirects', async () => {
    let count = 0;
    const read = createRemoteImageReader({
      resolve: resolver,
      request: async () =>
        ++count <= 3
          ? response({ status: 307, headers: { location: '/next' } })
          : response(),
    });
    expect((await read('http://images.example/a', signal())).length).toBe(5);
    expect(count).toBe(4);
  });
  it.each([{ status: 404 }, { headers: { 'content-encoding': 'gzip' } }])(
    'rejects status or encoding %j',
    async (options) => {
      const res = response(options);
      await expect(
        createRemoteImageReader({
          resolve: resolver,
          request: async () => res,
        })('https://images.example/a', signal()),
      ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
      expect(res.close).toHaveBeenCalled();
    },
  );
  it('enforces actual streamed bytes despite false content length', async () => {
    const res = response({
      headers: { 'content-length': '1' },
      body: Readable.from([Buffer.alloc(20 * 1024 * 1024), Buffer.from('x')]),
    });
    await expect(
      createRemoteImageReader({ resolve: resolver, request: async () => res })(
        'https://images.example/a',
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_LIMIT_EXCEEDED' });
    expect(res.close).toHaveBeenCalled();
  });
  it('cancels stalled DNS without exposing its error', async () => {
    const controller = new AbortController();
    const read = createRemoteImageReader({
      resolve: (_hostname, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled DNS settled')),
            { once: true },
          );
        }),
      request: vi.fn(),
    });
    const pending = read('https://images.example/a', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
  });
  it('times out stalled DNS at the 30 second whole-image deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = createRemoteImageReader({
        resolve: (_hostname, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled DNS settled')),
              { once: true },
            );
          }),
        request: vi.fn(),
      })('https://images.example/a', signal());
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'IMAGE_UNAVAILABLE',
      });
      await vi.advanceTimersByTimeAsync(30000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it('closes stalled body on cancellation', async () => {
    const controller = new AbortController();
    const body = new Readable({ read() {} });
    const res = response({
      body,
      close: async () => {
        body.destroy();
      },
    });
    const pending = createRemoteImageReader({
      resolve: resolver,
      request: async () => res,
    })('https://images.example/a', controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    expect(body.destroyed).toBe(true);
  });
});
it('retains DNS ownership after abort until the resolver confirms settlement', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let settled = false;
  let requests = 0;
  const read = createRemoteImageReader({
    resolve: async () => {
      await gate;
      return [{ address: '8.8.8.8', family: 4 }];
    },
    request: async () => {
      requests++;
      return response();
    },
  });
  const pending = read('https://images.example/a', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'IMAGE_UNAVAILABLE',
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeDns = settled;
  finish();
  await rejected;
  expect(settledBeforeDns).toBe(false);
  expect(requests).toBe(0);
});
