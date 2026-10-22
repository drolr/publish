import { createServer, request, type RequestOptions } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createNodeTransport,
  createRemoteImageReader,
} from '../../src/infrastructure/assets/remote-reader';

describe('Node remote transport', () => {
  it('pins numeric destination, preserves Host/SNI, validates TLS and has no proxy or session headers', async () => {
    const options: RequestOptions[] = [];
    const fake = vi.fn((input: RequestOptions) => {
      options.push(input);
      throw new Error('fixture stops before network');
    });
    const transport = createNodeTransport(fake, fake);
    await expect(
      transport(
        {
          url: new URL('https://images.example/p?q=1'),
          hostname: 'images.example',
          address: '8.8.8.8',
          family: 4,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('fixture');
    expect(options[0]).toMatchObject({
      hostname: '8.8.8.8',
      family: 4,
      port: 443,
      method: 'GET',
      path: '/p?q=1',
      agent: false,
      servername: 'images.example',
      rejectUnauthorized: true,
    });
    expect(options[0].headers).toEqual({
      Host: 'images.example',
      'Accept-Encoding': 'identity',
    });
    expect(options[0]).not.toHaveProperty('auth');
    expect(options[0]).not.toHaveProperty('lookup');
  });
  it('reads real chunked local fixture through an injected transport without relaxing production policy', async () => {
    const server = createServer((_req, res) => {
      res.write('first');
      setImmediate(() => res.end('second'));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture listen failed');
    let closeCount = 0;
    const read = createRemoteImageReader({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async (target, signal) => {
        const transport = createNodeTransport((options, callback) =>
          request(
            { ...options, hostname: '127.0.0.1', port: address.port },
            callback,
          ),
        );
        const response = await transport(
          { ...target, address: '127.0.0.1' },
          signal,
        );
        return {
          ...response,
          peerAddress: '8.8.8.8',
          close: () => {
            closeCount++;
            return response.close();
          },
        };
      },
    });
    try {
      expect(
        Buffer.from(
          await read('http://fixture.example/a', new AbortController().signal),
        ).toString(),
      ).toBe('firstsecond');
      expect(closeCount).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('production transport rejects a fixture socket whose peer is not the pinned destination', async () => {
    const server = createServer((_req, res) => res.end('never accepted'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture listen failed');
    let requestClosed = false;
    let socketClosed = false;
    const transport = createNodeTransport((options, callback) => {
      const req = request(
        { ...options, hostname: '127.0.0.1', port: address.port },
        callback,
      );
      req.once('close', () => {
        requestClosed = true;
      });
      req.once('socket', (socket) =>
        socket.once('close', () => {
          socketClosed = true;
        }),
      );
      return req;
    });
    try {
      await expect(
        transport(
          {
            url: new URL('http://fixture.example/a'),
            hostname: 'fixture.example',
            address: '8.8.8.8',
            family: 4,
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
      expect(requestClosed).toBe(true);
      expect(socketClosed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it.each(['headers', 'body'] as const)(
  'retires real HTTP %s resources and pending iteration before reader cancellation settles',
  async (phase) => {
    const events: string[] = [];
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const server = createServer((_req, res) => {
      if (phase === 'headers') reached();
      else {
        res.writeHead(200);
        res.write('first');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('listen');
    const transport = createNodeTransport((options, callback) => {
      const req = request(
        { ...options, hostname: '127.0.0.1', port: address.port },
        (res) => {
          res.once('close', () => events.push('response-close'));
          callback(res);
        },
      );
      req.once('socket', (socket) =>
        socket.once('close', () => events.push('socket-close')),
      );
      req.once('close', () => events.push('request-close'));
      return req;
    });
    const read = createRemoteImageReader({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async (target, signal) => {
        const response = await transport(
          { ...target, address: '127.0.0.1' },
          signal,
        );
        const iterator = response.body[Symbol.asyncIterator]();
        return {
          ...response,
          peerAddress: '8.8.8.8',
          body: {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                reached();
                try {
                  return await iterator.next();
                } finally {
                  events.push('iteration-settled');
                }
              },
              return: () => iterator.return!(),
            }),
          },
        };
      },
    });
    const abort = new AbortController();
    const pending = read('http://fixture.example/image', abort.signal).catch(
      (error: unknown) => {
        events.push('reader-settled');
        return error;
      },
    );
    try {
      await ready;
      await new Promise<void>((resolve) => setImmediate(resolve));
      abort.abort();
      expect(await pending).toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
      expect(events).toContain('request-close');
      expect(events).toContain('socket-close');
      if (phase === 'body') {
        expect(events).toContain('response-close');
        expect(events.lastIndexOf('iteration-settled')).toBeLessThan(
          events.indexOf('reader-settled'),
        );
      }
      expect(events.at(-1)).toBe('reader-settled');
    } finally {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each([
  'normal',
  'redirect',
  'status',
  'encoding',
  'truncated',
  'early-error',
] as const)(
  'awaits all real HTTP closes for %s, including before the next redirect hop',
  async (mode) => {
    const owned: { request: boolean; socket: boolean; response?: boolean }[] =
      [];
    const server = createServer((req, res) => {
      if (mode === 'early-error') {
        req.socket.destroy();
        return;
      }
      if (mode === 'redirect' && req.url === '/image') {
        res.writeHead(302, { location: '/next' });
        res.write('redirect');
        return;
      }
      if (mode === 'status') {
        res.writeHead(404);
        res.write('missing');
        return;
      }
      if (mode === 'encoding') {
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        res.write('encoded');
        return;
      }
      if (mode === 'truncated') {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('short');
        setImmediate(() => res.destroy());
        return;
      }
      res.end('image');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('listen');
    const transport = createNodeTransport((options, callback) => {
      for (const previous of owned)
        expect(previous).toEqual({
          request: true,
          socket: true,
          response: true,
        });
      const state: (typeof owned)[number] = { request: false, socket: false };
      owned.push(state);
      const req = request(
        { ...options, hostname: '127.0.0.1', port: address.port },
        (res) => {
          state.response = false;
          res.once('close', () => {
            state.response = true;
          });
          callback(res);
        },
      );
      req.once('close', () => {
        state.request = true;
      });
      req.once('socket', (socket) =>
        socket.once('close', () => {
          state.socket = true;
        }),
      );
      return req;
    });
    const read = createRemoteImageReader({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async (target, signal) => {
        const response = await transport(
          { ...target, address: '127.0.0.1' },
          signal,
        );
        return {
          ...response,
          peerAddress: '8.8.8.8',
          close: async () => {
            const completion = response.close();
            expect(response.close()).toBe(completion);
            await completion;
          },
        };
      },
    });
    try {
      const pending = read(
        'http://fixture.example/image',
        new AbortController().signal,
      );
      if (mode === 'normal' || mode === 'redirect')
        expect(Buffer.from(await pending).toString()).toBe('image');
      else
        await expect(pending).rejects.toMatchObject({
          code: 'IMAGE_UNAVAILABLE',
        });
      expect(owned).toHaveLength(mode === 'redirect' ? 2 : 1);
      for (const state of owned)
        expect(state).toEqual({
          request: true,
          socket: true,
          ...(mode === 'early-error' ? {} : { response: true }),
        });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
