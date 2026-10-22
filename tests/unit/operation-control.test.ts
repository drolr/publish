import { describe, expect, it, vi } from 'vitest';
import { createOperationControl } from '../../src/application/operation-control';

describe('runtime stop coordinator', () => {
  it('a failed stop never hides an active owner and allows resolution after settlement', async () => {
    let active = true;
    const control = createOperationControl({
      draft: {
        requestStop() {
          throw Error('failed stop');
        },
        state: () => (active ? 'active' : 'idle'),
      },
    });
    expect((await control.requestStopAll()).phase).toBe('stopping');
    expect(control.isStopping()).toBe(true);
    active = false;
    expect((await control.getOperationControlState()).phase).toBe(
      'needs_review',
    );
    expect(control.isStopping()).toBe(false);
  });
  it('signals every owner synchronously and waits for real settlement without repeated cancellation', async () => {
    let active = true;
    const requestStop = vi.fn();
    const control = createOperationControl({
      draft: { requestStop, state: () => (active ? 'active' : 'idle') },
    });
    const pending = control.requestStopAll();
    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(control.isStopping()).toBe(true);
    expect((await pending).phase).toBe('stopping');
    await control.requestStopAll();
    expect(requestStop).toHaveBeenCalledTimes(1);
    active = false;
    expect((await control.getOperationControlState()).phase).toBe('stopped');
    expect(control.isStopping()).toBe(false);
  });

  it('keeps uncertain results visible and still stops independent owners', async () => {
    const other = vi.fn();
    const control = createOperationControl({
      draft: {
        requestStop: () => {
          throw Error('private detail');
        },
        state: () => 'needs_review',
      },
      manual: { requestStop: other, state: () => 'idle' },
    });
    const result = await control.requestStopAll();
    expect(result.phase).toBe('needs_review');
    expect(other).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it('does not claim completion for a hung owner and can stop a later fresh operation', async () => {
    let active = false;
    const requestStop = vi.fn();
    const control = createOperationControl({
      browser: { requestStop, state: () => (active ? 'active' : 'idle') },
    });
    expect((await control.getOperationControlState()).phase).toBe('idle');
    expect((await control.requestStopAll()).phase).toBe('stopped');
    active = true;
    const next = await control.requestStopAll();
    expect(next.phase).toBe('stopping');
    expect(requestStop).toHaveBeenCalledTimes(2);
    expect((await control.getOperationControlState()).phase).toBe('stopping');
  });
});

it('keeps stop pending through asynchronous release instead of showing a false completion', async () => {
  let resolve!: () => void;
  let held = true;
  const barrier = new Promise<void>((r) => {
    resolve = r;
  });
  const control = createOperationControl({
    draft: {
      requestStop() {},
      state: () => (held ? 'needs_review' : 'idle'),
      settle: async () => {
        await barrier;
        held = false;
      },
    },
  });
  expect((await control.requestStopAll()).phase).toBe('stopping');
  expect(control.isStopping()).toBe(true);
  resolve();
  await vi.waitFor(async () =>
    expect((await control.getOperationControlState()).phase).toBe('stopped'),
  );
  expect(control.isStopping()).toBe(false);
});

it('a fresh explicit stop can recover a previous cleanup failure without replaying any operation', async () => {
  let failure = true;
  const control = createOperationControl({
    draft: {
      requestStop() {},
      state: () => 'idle',
      settle: async () => {
        if (failure) throw Error('close failed');
      },
    },
  });
  await control.requestStopAll();
  await vi.waitFor(async () =>
    expect((await control.getOperationControlState()).phase).toBe(
      'needs_review',
    ),
  );
  failure = false;
  await control.requestStopAll();
  await vi.waitFor(async () =>
    expect((await control.getOperationControlState()).phase).toBe('stopped'),
  );
  expect(control.isStopping()).toBe(false);
});

it('settled human review does not deadlock local resolution behind the stopping gate', async () => {
  const control = createOperationControl({
    manual: {
      requestStop() {},
      state: () => 'needs_review',
      settle: async () => {
        throw Error('dirty input retained');
      },
    },
  });
  await control.requestStopAll();
  await vi.waitFor(async () =>
    expect((await control.getOperationControlState()).phase).toBe(
      'needs_review',
    ),
  );
  expect(control.isStopping()).toBe(false);
});

it('failed release with an otherwise idle owner still blocks platform admission', async () => {
  const c = createOperationControl({
    draft: {
      requestStop() {},
      state: () => 'idle',
      settle: async () => {
        throw Error('close rejected');
      },
    },
  });
  await c.requestStopAll();
  await vi.waitFor(async () =>
    expect((await c.getOperationControlState()).phase).toBe('needs_review'),
  );
  expect(c.isStopping()).toBe(false);
  expect(c.hasUnresolvedStop()).toBe(true);
});
it('15 seconds of hung close is observation only and never releases occupancy', async () => {
  vi.useFakeTimers();
  try {
    let resolve!: () => void;
    const c = createOperationControl({
      draft: {
        requestStop() {},
        state: () => 'idle',
        settle: () =>
          new Promise<void>((r) => {
            resolve = r;
          }),
      },
    });
    await c.requestStopAll();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await c.getOperationControlState()).phase).toBe('stopping');
    expect(c.isStopping()).toBe(true);
    expect(c.hasUnresolvedStop()).toBe(true);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect((await c.getOperationControlState()).phase).toBe('stopped');
    expect(c.hasUnresolvedStop()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('retained review does not become false idle when local resolution runs and settles', async () => {
  let active = false;
  const c = createOperationControl({
    manual: {
      requestStop() {},
      state: () => (active ? 'active' : 'idle'),
      settle: async () => {
        throw Error('review');
      },
    },
  });
  await c.requestStopAll();
  await vi.waitFor(async () =>
    expect((await c.getOperationControlState()).phase).toBe('needs_review'),
  );
  active = true;
  expect((await c.getOperationControlState()).phase).toBe('needs_review');
  expect(c.isStopping()).toBe(false);
  active = false;
  expect((await c.getOperationControlState()).phase).toBe('needs_review');
  expect(c.hasUnresolvedStop()).toBe(true);
});

it('an unavailable owner keeps platform admission closed while another local operation resolves', async () => {
  let active = false;
  const c = createOperationControl({
    cover: { requestStop() {}, state: () => 'needs_review' },
    manual: { requestStop() {}, state: () => (active ? 'active' : 'idle') },
  });
  await c.requestStopAll();
  active = true;
  expect((await c.getOperationControlState()).phase).toBe('needs_review');
  expect(c.hasUnresolvedStop()).toBe(true);
  expect(c.isStopping()).toBe(false);
});
