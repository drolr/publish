import { afterEach, expect, it, vi } from 'vitest';
import {
  runManualPasteImages,
  type PasteImageEvent,
} from '../../src/application/manual-paste-runner';
import { WebPasteFailure } from '../../src/domain/web-paste-error';

const image = {
  imageToken: '00000000-0000-4000-8000-000000000090',
  mime: 'image/png' as const,
  width: 1,
  height: 1,
  byteSize: 10,
};
afterEach(() => vi.useRealTimers());
it('settles each event before starting the next image and continues after ordinary failures', async () => {
  const events: PasteImageEvent[] = [];
  const calls: string[] = [];
  await runManualPasteImages(
    ['a', 'b', 'c'].map((candidateId) => ({
      candidateId,
      source: `https://example.com/${candidateId}`,
    })),
    new AbortController().signal,
    async (source) => {
      calls.push(source);
      expect(events.at(-1)?.type).toBe('fetching');
      if (source.endsWith('/b')) throw new WebPasteFailure('IMAGE_NETWORK');
      return image;
    },
    async (event) => {
      events.push(event);
    },
  );
  expect(calls).toHaveLength(3);
  expect(events.map((e) => [e.candidateId, e.type])).toEqual([
    ['a', 'fetching'],
    ['a', 'ready'],
    ['b', 'fetching'],
    ['b', 'failed'],
    ['c', 'fetching'],
    ['c', 'ready'],
  ]);
  expect(events[3]).toMatchObject({ reason: 'IMAGE_NETWORK', retryable: true });
});
it('never acquires permanently unsupported references, even after cancellation', async () => {
  const abort = new AbortController();
  abort.abort();
  const events: PasteImageEvent[] = [];
  await runManualPasteImages(
    [
      { candidateId: 'a', source: 'file:///secret' },
      { candidateId: 'b', source: 'https://example.com/b' },
    ],
    abort.signal,
    async () => {
      throw new Error('must not acquire');
    },
    async (e) => {
      events.push(e);
    },
  );
  expect(events).toEqual([
    {
      candidateId: 'a',
      type: 'failed',
      reason: 'SOURCE_UNSUPPORTED',
      retryable: false,
    },
    { candidateId: 'b', type: 'cancelled' },
  ]);
});
it('deadline stops later images but awaits the current late resource and ready cleanup event', async () => {
  vi.useFakeTimers();
  let resolve!: (value: typeof image) => void;
  const events: PasteImageEvent[] = [];
  let acquired = 0;
  let done = false;
  let seenSignal: AbortSignal | undefined;
  const running = runManualPasteImages(
    [
      { candidateId: 'a', source: 'https://example.com/a' },
      { candidateId: 'b', source: 'https://example.com/b' },
    ],
    new AbortController().signal,
    async (_, signal) => {
      acquired++;
      seenSignal = signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
    async (e) => {
      events.push(e);
    },
  ).then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(600000);
  expect(seenSignal?.aborted).toBe(true);
  expect(done).toBe(false);
  expect(acquired).toBe(1);
  resolve(image);
  await running;
  expect(events.map((e) => e.type)).toEqual([
    'fetching',
    'ready',
    'failed',
    'failed',
  ]);
  expect(events.slice(-2)).toEqual([
    {
      candidateId: 'a',
      type: 'failed',
      reason: 'OPERATION_TIMEOUT',
      retryable: true,
    },
    {
      candidateId: 'b',
      type: 'failed',
      reason: 'OPERATION_TIMEOUT',
      retryable: true,
    },
  ]);
});
it('storage uncertainty halts the queue, including when user cancellation races it', async () => {
  const abort = new AbortController();
  let calls = 0;
  await expect(
    runManualPasteImages(
      [
        { candidateId: 'a', source: 'https://example.com/a' },
        { candidateId: 'b', source: 'https://example.com/b' },
      ],
      abort.signal,
      async () => {
        calls++;
        abort.abort();
        throw new WebPasteFailure('RECOVERY_REQUIRED');
      },
      async () => {},
    ),
  ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(calls).toBe(1);
});
it.each([
  'SOURCE_UNSUPPORTED',
  'IMAGE_INVALID',
  'IMAGE_UNSUPPORTED',
  'IMAGE_LIMIT',
] as const)(
  'does not turn known permanent %s into a retryable cancellation',
  async (reason) => {
    const abort = new AbortController();
    const events: PasteImageEvent[] = [];
    await runManualPasteImages(
      [{ candidateId: 'a', source: 'https://example.com/a' }],
      abort.signal,
      async () => {
        abort.abort();
        throw new WebPasteFailure(reason);
      },
      async (event) => {
        events.push(event);
      },
    );
    expect(events.at(-1)).toEqual({
      candidateId: 'a',
      type: 'failed',
      reason,
      retryable: false,
    });
  },
);
