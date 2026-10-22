import { createSocket, type RemoteInfo } from 'node:dgram';
import { once } from 'node:events';
import { Resolver } from 'node:dns/promises';
import { expect, it, vi } from 'vitest';
import { createCancellableImageDns } from '../../src/infrastructure/assets/image-dns';
import { createRemoteImageReader } from '../../src/infrastructure/assets/remote-reader';

interface Query {
  packet: Buffer;
  peer: RemoteInfo;
  type: number;
  questionEnd: number;
}
async function dnsFixture() {
  const socket = createSocket('udp4');
  const queries: Query[] = [];
  let notify: () => void = () => {};
  socket.on('message', (packet, peer) => {
    let end = 12;
    while (packet[end] !== 0) end += packet[end] + 1;
    end++;
    queries.push({
      packet,
      peer,
      type: packet.readUInt16BE(end),
      questionEnd: end + 4,
    });
    notify();
  });
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  return {
    queries,
    async wait(count: number) {
      while (queries.length < count)
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
    },
    resolver() {
      const resolver = new Resolver({ timeout: 30000, tries: 1 });
      resolver.setServers([`127.0.0.1:${address.port}`]);
      return resolver;
    },
    async reply(query: Query, addresses: readonly Buffer[] = [], rcode = 0) {
      const header = Buffer.alloc(12);
      header.writeUInt16BE(query.packet.readUInt16BE(0));
      header.writeUInt16BE(0x8180 | rcode, 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(addresses.length, 6);
      const records = addresses.map((address) => {
        const record = Buffer.alloc(12 + address.length);
        record.writeUInt16BE(0xc00c);
        record.writeUInt16BE(query.type, 2);
        record.writeUInt16BE(1, 4);
        record.writeUInt32BE(30, 6);
        record.writeUInt16BE(address.length, 10);
        address.copy(record, 12);
        return record;
      });
      const packet = Buffer.concat([
        header,
        query.packet.subarray(12, query.questionEnd),
        ...records,
      ]);
      await new Promise<void>((resolve, reject) =>
        socket.send(packet, query.peer.port, query.peer.address, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    async close() {
      socket.close();
      await once(socket, 'close');
    },
  };
}
const ipv4 = Buffer.from([8, 8, 8, 8]);
const ipv6 = Buffer.from('20014860486000000000000000008888', 'hex');

it('collects both real DNS families and refuses a mixed public/private answer before any connection', async () => {
  const fixture = await dnsFixture();
  const c = new AbortController();
  let requests = 0;
  try {
    const read = createRemoteImageReader({
      resolve: createCancellableImageDns(() => fixture.resolver()),
      request: async () => {
        requests++;
        throw Error('must not connect');
      },
    });
    const pending = read('image.example', c.signal); // malformed URL still cannot resolve
    await expect(pending).rejects.toHaveProperty('code');
    const acquisition = read('https://image.example/a', c.signal);
    const rejected = expect(acquisition).rejects.toMatchObject({
      code: 'SOURCE_NOT_ALLOWED',
    });
    await fixture.wait(2);
    await fixture.reply(
      fixture.queries.find((q) => q.type === 1)!,
      [ipv4],
    );
    await new Promise<void>((r) => setImmediate(r));
    expect(requests).toBe(0);
    await fixture.reply(
      fixture.queries.find((q) => q.type === 28)!,
      [Buffer.from('00000000000000000000000000000001', 'hex')],
    );
    await rejected;
    expect(requests).toBe(0);
  } finally {
    c.abort();
    await fixture.close();
  }
});
it.each(['both', 'no-aaaa', 'failed-aaaa', 'no-addresses'] as const)(
  'real complete-family DNS result: %s',
  async (mode) => {
    const fixture = await dnsFixture();
    const c = new AbortController();
    try {
      const pending = createCancellableImageDns(() => fixture.resolver())(
        'image.example',
        c.signal,
      );
      const result =
        mode === 'failed-aaaa' || mode === 'no-addresses'
          ? expect(pending).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' })
          : expect(pending).resolves.toEqual(
              mode === 'both'
                ? [
                    { address: '8.8.8.8', family: 4 },
                    { address: '2001:4860:4860::8888', family: 6 },
                  ]
                : [{ address: '8.8.8.8', family: 4 }],
            );
      await fixture.wait(2);
      await fixture.reply(
        fixture.queries.find((q) => q.type === 1)!,
        mode === 'no-addresses' ? [] : [ipv4],
      );
      await fixture.reply(
        fixture.queries.find((q) => q.type === 28)!,
        mode === 'both' ? [ipv6] : [],
        mode === 'failed-aaaa' ? 2 : 0,
      );
      await result;
    } finally {
      c.abort();
      await fixture.close();
    }
  },
);
it.each(['cancel', 'deadline'] as const)(
  'actual Resolver %s cancels both queries and acquisition waits for delayed query settlement',
  async (mode) => {
    const fixture = await dnsFixture();
    const c = new AbortController();
    let nativeCount = 0;
    let signalNative!: () => void;
    const nativeSettled = new Promise<void>(
      (resolve) => (signalNative = resolve),
    );
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    let settled = false;
    let requests = 0;
    let cancelled = 0;
    const resolver = fixture.resolver();
    const controlled = {
      resolve4: async (host: string) => {
        try {
          return await resolver.resolve4(host);
        } finally {
          if (++nativeCount === 2) signalNative();
          await gate;
        }
      },
      resolve6: async (host: string) => {
        try {
          return await resolver.resolve6(host);
        } finally {
          if (++nativeCount === 2) signalNative();
          await gate;
        }
      },
      cancel() {
        cancelled++;
        resolver.cancel();
      },
    };
    if (mode === 'deadline')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const read = createRemoteImageReader({
        resolve: createCancellableImageDns(() => controlled),
        request: async () => {
          requests++;
          throw Error('must not connect');
        },
      });
      const pending = read('https://image.example/a', c.signal);
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
      await fixture.wait(2);
      if (mode === 'cancel') c.abort();
      else await vi.advanceTimersByTimeAsync(30000);
      await nativeSettled;
      const early = settled;
      finish();
      await rejected;
      expect(early).toBe(false);
      expect(cancelled).toBe(1);
      expect(nativeCount).toBe(2);
      expect(requests).toBe(0);
      for (const q of fixture.queries)
        await fixture.reply(q, q.type === 1 ? [ipv4] : [ipv6]);
      await new Promise<void>((r) => setImmediate(r));
      expect(requests).toBe(0);
    } finally {
      c.abort();
      finish();
      resolver.cancel();
      vi.useRealTimers();
      await fixture.close();
    }
  },
);
it('cancelling one real per-operation Resolver cannot cancel another acquisition', async () => {
  const fixture = await dnsFixture();
  const a = new AbortController();
  const b = new AbortController();
  try {
    const resolve = createCancellableImageDns(() => fixture.resolver());
    const first = resolve('first.example', a.signal);
    const rejected = expect(first).rejects.toMatchObject({
      code: 'IMAGE_UNAVAILABLE',
    });
    await fixture.wait(2);
    const second = resolve('second.example', b.signal);
    await fixture.wait(4);
    a.abort();
    await rejected;
    for (const q of fixture.queries.slice(2))
      await fixture.reply(q, q.type === 1 ? [ipv4] : [ipv6]);
    await expect(second).resolves.toHaveLength(2);
  } finally {
    a.abort();
    b.abort();
    await fixture.close();
  }
});
