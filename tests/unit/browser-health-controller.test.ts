import { expect, it, vi } from 'vitest';
import { createBrowserHealthController } from '../../src/application/browser-health-controller';
import type { BrowserHealthRuntime } from '../../src/domain/ports/browser-health';
import type { BrowserHealthView } from '../../src/contracts/browser-health';
const view = (
  status: BrowserHealthView['status'],
  reason: BrowserHealthView['reason'] = null,
): BrowserHealthView => ({ status, reason, version: null, stage: null });
function setup() {
  let epoch = 0,
    occupied = false,
    business = false;
  let reason: BrowserHealthView['reason'] = null;
  let listener: (v: BrowserHealthView) => void = () => {};
  const runtime: BrowserHealthRuntime = {
    checkHealth: vi.fn(async () => ({
      status: 'ok' as const,
      view: { ...view('passed'), version: '153.0.0.0' },
    })),
    openUpdate: vi.fn(async () => {
      occupied = true;
      listener(view('update_open'));
      return { status: 'ok' as const, view: view('update_open') };
    }),
    invalidateHealth: vi.fn(),
    isOccupied: () => occupied,
    hasBusinessSession: () => business,
    subscribeHealth: (fn) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
  };
  const invalidateOperation = vi.fn(() => {
    epoch++;
    runtime.invalidateHealth();
  });
  const api = createBrowserHealthController({
    runtime,
    admission: () => reason,
    operationEpoch: () => epoch,
    invalidateOperation,
  });
  return {
    api,
    runtime,
    invalidateOperation,
    emit: (v: BrowserHealthView) => listener(v),
    occupy: (v: boolean) => {
      occupied = v;
    },
    business: () => {
      business = true;
    },
    block: (v: typeof reason) => {
      reason = v;
    },
    invalidate: () => {
      epoch++;
      listener(view('unchecked'));
    },
  };
}
it('maintenance_remains_exclusive_after_open_promise_resolves', async () => {
  const h = setup();
  expect((await h.api.getBrowserHealth()).status).toBe('unchecked');
  expect((await h.api.openBrowserUpdate()).view.status).toBe('update_open');
  expect((await h.api.checkBrowserHealth()).view.reason).toBe(
    'maintenance_open',
  );
  h.emit(view('check_failed', 'cleanup_failed'));
  expect((await h.api.openBrowserUpdate()).status).toBe('blocked');
  h.occupy(false);
  h.emit(view('unchecked'));
  expect((await h.api.checkBrowserHealth()).view.status).toBe('passed');
});
it.each(['task_busy', 'business_open', 'ownership_unconfirmed'] as const)(
  'health_commands_never_drain_or_mutate_tasks: %s',
  async (reason) => {
    const h = setup();
    h.block(reason);
    expect((await h.api.checkBrowserHealth()).view.reason).toBe(reason);
    expect((await h.api.openBrowserUpdate()).view.reason).toBe(reason);
    expect(h.runtime.checkHealth).not.toHaveBeenCalled();
    expect(h.runtime.openUpdate).not.toHaveBeenCalled();
    expect(h.invalidateOperation).not.toHaveBeenCalled();
  },
);
it('checks actual ownership even when admission or a passed DTO claims it is safe', async () => {
  const h = setup();
  h.occupy(true);
  expect((await h.api.checkBrowserHealth()).view.reason).toBe(
    'ownership_unconfirmed',
  );
  expect(h.runtime.checkHealth).not.toHaveBeenCalled();
  h.emit(view('passed'));
  expect((await h.api.getBrowserHealth()).status).not.toBe('passed');
});
it('old epoch results and events cannot overwrite a new operation and dispose unsubscribes', async () => {
  const h = setup();
  let release!: (
    v: Awaited<ReturnType<BrowserHealthRuntime['checkHealth']>>,
  ) => void;
  vi.mocked(h.runtime.checkHealth).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = h.api.checkBrowserHealth();
  expect((await h.api.getBrowserHealth()).status).toBe('checking');
  h.invalidate();
  release({ status: 'ok' as const, view: view('passed') });
  expect((await pending).status).toBe('blocked');
  h.emit(view('passed'));
  expect((await h.api.getBrowserHealth()).status).toBe('unchecked');
  h.api.dispose();
  h.emit(view('too_old'));
  expect((await h.api.getBrowserHealth()).status).toBe('unchecked');
});
it('rejects duplicate requests synchronously while the first check is pending', async () => {
  const h = setup();
  let release!: () => void;
  vi.mocked(h.runtime.checkHealth).mockImplementationOnce(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return { status: 'ok' as const, view: view('passed') };
  });
  const first = h.api.checkBrowserHealth();
  expect((await h.api.openBrowserUpdate()).status).toBe('blocked');
  expect(h.runtime.openUpdate).not.toHaveBeenCalled();
  release();
  await first;
});
it('starts unchecked on restart', async () => {
  const h = setup();
  expect((await h.api.checkBrowserHealth()).status).toBe('ok');
  expect((await setup().api.getBrowserHealth()).status).toBe('unchecked');
});

it('late rejection after stop or dispose never overwrites the newer unchecked projection', async () => {
  const h = setup();
  let reject!: (error: Error) => void;
  vi.mocked(h.runtime.checkHealth).mockImplementationOnce(
    () =>
      new Promise((_resolve, r) => {
        reject = r;
      }),
  );
  const pending = h.api.checkBrowserHealth();
  h.invalidate();
  reject(Error('private-path'));
  await pending;
  expect((await h.api.getBrowserHealth()).status).toBe('unchecked');
});

it('read projection follows actual ownership through failure and releases only after confirmed close', async () => {
  const h = setup();
  h.occupy(true);
  h.emit(view('check_failed', 'cleanup_failed'));
  expect(await h.api.getBrowserHealth()).toMatchObject({
    status: 'busy',
    reason: 'ownership_unconfirmed',
  });
  h.occupy(false);
  expect(await h.api.getBrowserHealth()).toMatchObject({
    status: 'check_failed',
    reason: 'cleanup_failed',
  });
});
it('busy business and task projections persist while the authoritative admission is blocked', async () => {
  const h = setup();
  h.business();
  expect((await h.api.checkBrowserHealth()).view.reason).toBe('business_open');
  expect((await h.api.getBrowserHealth()).reason).toBe('business_open');
  const task = setup();
  task.block('task_busy');
  await task.api.checkBrowserHealth();
  expect((await task.api.getBrowserHealth()).reason).toBe('task_busy');
  task.block(null);
  expect((await task.api.getBrowserHealth()).status).toBe('unchecked');
});
it.each(['reject', 'invalid'] as const)(
  'dispose ignores a late %s result',
  async (mode) => {
    const h = setup();
    let release!: (v: unknown) => void, reject!: (e: Error) => void;
    vi.mocked(h.runtime.checkHealth).mockImplementationOnce(
      () =>
        new Promise((resolve, r) => {
          release = resolve as (v: unknown) => void;
          reject = r;
        }),
    );
    const pending = h.api.checkBrowserHealth();
    h.api.dispose();
    const before = await h.api.getBrowserHealth();
    if (mode === 'reject') reject(Error('private'));
    else release({ invalid: 'private' });
    await pending;
    expect(await h.api.getBrowserHealth()).toEqual(before);
  },
);
