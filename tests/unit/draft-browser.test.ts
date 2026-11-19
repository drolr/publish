import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  readdir,
  rename,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserHealthController } from '../../src/application/browser-health-controller';
import { BrowserHealthFailure } from '../../src/infrastructure/automation/browser-health-check';
import { createBrowserSession } from '../../src/infrastructure/automation/browser-session';
const { launch, capabilities } = vi.hoisted(() => ({
  launch: vi.fn(),
  capabilities: vi.fn(async () => {}),
}));
vi.mock('playwright-core', () => ({
  chromium: { launchPersistentContext: launch },
}));
vi.mock(
  '../../src/infrastructure/automation/browser-health-check',
  async (original) => ({
    ...(await original<object>()),
    checkLocalCapabilities: capabilities,
  }),
);
const removal = vi.hoisted(() => ({ fail: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options: Parameters<typeof actual.rm>[1],
    ) => {
      if (removal.fail && String(path).includes('diagnostic-')) {
        removal.fail = false;
        throw Error('private cleanup path');
      }
      return actual.rm(path, options);
    },
  };
});
let root: string, epoch: number;
const sessions: ReturnType<typeof createBrowserSession>[] = [];
function session(path = join(root, 'profile')) {
  const value = createBrowserSession(path, {
    temporaryRoot: join(root, 'health'),
    operationEpoch: () => epoch,
  });
  sessions.push(value);
  return value;
}
function context(version: string | null = '156.0.4314.58') {
  const value = Object.assign(new EventEmitter(), {
    browser: () => (version === null ? null : { version: () => version }),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    close: vi.fn(async () => {
      value.emit('close');
    }),
  });
  return value;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'browser-health-test-'));
  epoch = 1;
  launch.mockReset();
  capabilities.mockReset().mockResolvedValue(undefined);
  launch.mockImplementation(async () => context());
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    sessions.splice(0).map((s) => s.close().catch(() => undefined)),
  );
  await rm(root, { recursive: true, force: true });
});
it.each(['153.0.0.0', '156.0.4314.58', '999.0.0.0'])(
  'every open requires fresh diagnostic and matching business version %s',
  async (version) => {
    launch.mockImplementation(async () => context(version));
    const value = session();
    const events: unknown[] = [];
    value.subscribeHealth((v) => events.push(v));
    const first = value.open();
    expect(value.open()).toBe(first);
    await first;
    expect(capabilities).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(value.current()).toBeDefined();
    await value.open();
    expect(launch).toHaveBeenCalledTimes(2);
    await value.close();
    await value.open();
    expect(capabilities).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(4);
    expect(events).toContainEqual({
      status: 'passed',
      version,
      stage: null,
      reason: null,
    });
  },
);
it('manual check never supplies a reusable ticket', async () => {
  const value = session();
  expect((await value.checkHealth()).status).toBe('ok');
  expect(launch.mock.calls[0][1].headless).toBe(true);
  expect(value.current()).toBeUndefined();
  expect(value.isOccupied()).toBe(false);
  await value.open();
  expect(capabilities).toHaveBeenCalledTimes(2);
  expect(launch).toHaveBeenCalledTimes(3);
});
it('only diagnostic owners run headless while every fresh business open stays headed', async () => {
  const value = session();
  await value.open();
  await value.close();
  await value.open();
  expect(launch.mock.calls.map(([, options]) => options.headless)).toEqual([
    true,
    false,
    true,
    false,
  ]);
  for (const [, options] of launch.mock.calls)
    expect(options).toMatchObject({
      channel: 'msedge',
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      acceptDownloads: false,
    });
  expect(capabilities).toHaveBeenCalledTimes(2);
});
it.each([
  ['152.0.0.0', 'too_old'],
  ['156.0.0', 'unknown_version'],
  [null, 'unknown_version'],
])('rejects version %s before capabilities', async (version, status) => {
  const browser = context(version);
  launch.mockResolvedValue(browser);
  const value = session();
  const result = await value.checkHealth();
  expect(result.view.status).toBe(status);
  expect(capabilities).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalledOnce();
  expect(value.current()).toBeUndefined();
});
it('version race never publishes ready and closes business once', async () => {
  const diagnostic = context(),
    business = context('157.0.0.0');
  launch.mockResolvedValueOnce(diagnostic).mockResolvedValueOnce(business);
  const value = session();
  const events: unknown[] = [];
  value.subscribeHealth((v) => events.push(v));
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNSUPPORTED',
  });
  expect(business.close).toHaveBeenCalledOnce();
  expect(value.current()).toBeUndefined();
  expect(events).toContainEqual({
    status: 'check_failed',
    version: '157.0.0.0',
    stage: 'version',
    reason: 'version_changed',
  });
  expect(launch).toHaveBeenCalledTimes(2);
});
it('epoch change during diagnostics prevents business launch', async () => {
  capabilities.mockImplementationOnce(async () => {
    epoch++;
  });
  const value = session();
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(launch).toHaveBeenCalledOnce();
  expect(value.current()).toBeUndefined();
});
it('invalidate during diagnostics prevents business launch', async () => {
  const value = session();
  capabilities.mockImplementationOnce(async () => {
    value.invalidateHealth();
  });
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(launch).toHaveBeenCalledOnce();
});
it('business expiry after launch prevents ready', async () => {
  const value = session();
  launch
    .mockImplementationOnce(async () => context())
    .mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 31000);
      return context();
    });
  vi.useFakeTimers({ toFake: ['Date'] });
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(value.current()).toBeUndefined();
});
it('diagnostic failure closes and cleans exact profile before allowing a fresh check', async () => {
  capabilities.mockRejectedValueOnce(new BrowserHealthFailure('editor'));
  const value = session();
  expect((await value.checkHealth()).view).toMatchObject({
    status: 'check_failed',
    stage: 'editor',
  });
  expect(await readdir(join(root, 'health'))).toEqual([]);
  expect((await value.checkHealth()).status).toBe('ok');
});
it('retains ownership when diagnostic close fails and never removes live directory', async () => {
  const browser = context();
  browser.close.mockRejectedValueOnce(Error('private'));
  launch.mockResolvedValue(browser);
  const value = session();
  expect((await value.checkHealth()).view).toMatchObject({
    reason: 'cleanup_failed',
  });
  expect(value.isOccupied()).toBe(true);
  expect((await readdir(join(root, 'health'))).length).toBe(1);
  expect((await value.checkHealth()).view.reason).toBe('ownership_unconfirmed');
  await expect(session().open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(launch).toHaveBeenCalledOnce();
  await value.close();
  expect(value.isOccupied()).toBe(false);
});
it('close during pending launch waits for late context and never publishes ready', async () => {
  let finish!: (v: ReturnType<typeof context>) => void;
  launch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const value = session();
  const opening = value.open();
  const rejection = expect(opening).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  const closing = value.close();
  expect(value.isOccupied()).toBe(true);
  const browser = context();
  finish(browser);
  await closing;
  await rejection;
  expect(browser.close).toHaveBeenCalledOnce();
  expect(value.current()).toBeUndefined();
  expect(launch).toHaveBeenCalledOnce();
});
it('check and update reject while diagnostic lane is owned', async () => {
  let finish!: () => void;
  capabilities.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const value = session();
  const first = value.checkHealth();
  await vi.waitFor(() => expect(capabilities).toHaveBeenCalledOnce());
  expect((await value.checkHealth()).view.status).toBe('busy');
  expect((await value.openUpdate()).view.status).toBe('busy');
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  finish();
  await first;
});
it('business open requires manual close before check or update', async () => {
  const value = session();
  await value.open();
  expect((await value.checkHealth()).view.reason).toBe('business_open');
  expect((await value.openUpdate()).view.reason).toBe('business_open');
  expect(launch).toHaveBeenCalledTimes(2);
});
it('external business close invalidates generation', async () => {
  const business = context();
  launch.mockResolvedValueOnce(context()).mockResolvedValueOnce(business);
  const value = session();
  await value.open();
  const before = value.generation();
  business.emit('close');
  expect(value.current()).toBeUndefined();
  expect(value.generation()).not.toBe(before);
  await value.open();
  expect(launch).toHaveBeenCalledTimes(4);
});
it.each([
  'relative/profile',
  '\\\\server\\share\\profile',
  '\\\\?\\C:\\profile',
])('rejects unsafe business path %s before launch', async (path) => {
  await expect(session(path).open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(launch).not.toHaveBeenCalled();
});
it('refuses unowned nonempty profile without modification', async () => {
  await mkdir(join(root, 'profile'));
  await writeFile(join(root, 'profile', 'Preferences'), 'existing');
  await expect(session().open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(launch).not.toHaveBeenCalled();
});
it('refuses junction ancestors', async () => {
  await mkdir(join(root, 'real'));
  await symlink(join(root, 'real'), join(root, 'linked'), 'junction');
  await expect(
    session(join(root, 'linked', 'profile')).open(),
  ).rejects.toMatchObject({ reason: 'BROWSER_UNAVAILABLE' });
  expect(launch).not.toHaveBeenCalled();
});
it('sanitizes launch failure and permits later explicit retry', async () => {
  launch.mockRejectedValueOnce(Error('private path'));
  const value = session();
  await expect(value.open()).rejects.toMatchObject({
    message: 'BROWSER_UNAVAILABLE',
  });
  await value.open();
  expect(value.current()).toBeDefined();
});
it('blocks same-profile factory and preserves close-failure guard', async () => {
  const business = context();
  launch.mockResolvedValueOnce(context()).mockResolvedValueOnce(business);
  const value = session();
  await value.open();
  await expect(session().open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  business.close.mockRejectedValueOnce(Error('private'));
  await expect(value.close()).rejects.toMatchObject({
    message: 'BROWSER_UNAVAILABLE',
  });
  expect(value.isOccupied()).toBe(true);
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  await value.close();
  await session().open();
});
it('immediate close prevents launch during profile validation', async () => {
  const value = session();
  const opening = value.open();
  const rejection = expect(opening).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  await value.close();
  await rejection;
  expect(launch).not.toHaveBeenCalled();
});
it('launch timeout returns blocked while pending ownership survives and late resolution only cleans', async () => {
  let finish!: (v: ReturnType<typeof context>) => void;
  launch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const value = session();
  vi.useFakeTimers();
  const checking = value.checkHealth();
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(25001);
  expect((await checking).view).toMatchObject({
    reason: 'timeout',
    stage: 'launch',
  });
  expect(value.isOccupied()).toBe(true);
  expect((await value.checkHealth()).view.reason).toBe('ownership_unconfirmed');
  const late = context();
  finish(late);
  vi.useRealTimers();
  await vi.waitFor(() => expect(value.isOccupied()).toBe(false));
  expect(late.close).toHaveBeenCalledOnce();
  expect(value.current()).toBeUndefined();
  expect(launch).toHaveBeenCalledOnce();
});
it('close timeout never releases owner until context close is confirmed', async () => {
  const business = context();
  launch.mockResolvedValueOnce(context()).mockResolvedValueOnce(business);
  const value = session();
  await value.open();
  let finish!: () => void;
  business.close.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => {
          business.emit('close');
          resolve();
        };
      }),
  );
  vi.useFakeTimers();
  const closing = value.close();
  const rejected = expect(closing).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  await vi.advanceTimersByTimeAsync(10001);
  await rejected;
  expect(value.isOccupied()).toBe(true);
  await expect(session().open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  finish();
  vi.useRealTimers();
  await vi.waitFor(() => expect(value.isOccupied()).toBe(false));
  expect(value.current()).toBeUndefined();
});
it('close during manual preparation cancels check and leaves no temporary profile', async () => {
  const value = session();
  const checking = value.checkHealth();
  await value.close();
  expect((await checking).status).toBe('blocked');
  expect(value.isOccupied()).toBe(false);
  expect(await readdir(join(root, 'health'))).toEqual([]);
  expect(launch).not.toHaveBeenCalled();
});
it('maintenance uses isolated profile and never exposes business context', async () => {
  const page = Object.assign(new EventEmitter(), {
    goto: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    mainFrame: () => ({ url: () => 'edge://settings/help' }),
  });
  const maintenance = Object.assign(context(), {
    pages: () => [],
    route: vi.fn(async () => {}),
    newPage: vi.fn(async () => page),
  });
  launch.mockResolvedValueOnce(maintenance);
  const value = session();
  expect((await value.openUpdate()).view.status).toBe('update_open');
  expect(value.current()).toBeUndefined();
  expect(value.isOccupied()).toBe(true);
  expect(capabilities).not.toHaveBeenCalled();
  expect(launch.mock.calls[0][0]).not.toBe(join(root, 'profile'));
  expect(launch.mock.calls[0][1]).toMatchObject({
    headless: false,
    channel: 'msedge',
    chromiumSandbox: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  expect((await value.checkHealth()).view.reason).toBe('maintenance_open');
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  maintenance.emit('close');
  await vi.waitFor(() => expect(value.isOccupied()).toBe(false));
  expect(await readdir(join(root, 'health'))).toEqual([]);
  await value.open();
  expect(capabilities).toHaveBeenCalledOnce();
});
it('cleanup failure quarantines only after confirmed close and uses a fresh directory next time', async () => {
  const value = session();
  removal.fail = true;
  expect((await value.checkHealth()).view).toMatchObject({
    stage: 'cleanup',
    reason: 'cleanup_failed',
  });
  expect(value.isOccupied()).toBe(false);
  expect(await readdir(join(root, 'health'))).toHaveLength(1);
  const old = launch.mock.calls[0][0];
  expect((await value.checkHealth()).status).toBe('ok');
  expect(launch.mock.calls[1][0]).not.toBe(old);
  expect(await readdir(join(root, 'health'))).toHaveLength(1);
  expect(value.current()).toBeUndefined();
});
it('late diagnostic close confirmation cleans directory and releases its lease', async () => {
  const diagnostic = context();
  let finish!: () => void;
  diagnostic.close.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => {
          diagnostic.emit('close');
          resolve();
        };
      }),
  );
  launch.mockResolvedValueOnce(diagnostic);
  const value = session();
  vi.useFakeTimers();
  const checking = value.checkHealth();
  await vi.waitFor(() => expect(diagnostic.close).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(10001);
  expect((await checking).view.reason).toBe('cleanup_failed');
  expect(value.isOccupied()).toBe(true);
  finish();
  vi.useRealTimers();
  await vi.waitFor(() => expect(value.isOccupied()).toBe(false));
  expect(await readdir(join(root, 'health'))).toEqual([]);
});
it('missing Edge installation is distinguished from generic launch failure without exposing paths', async () => {
  launch.mockRejectedValueOnce(
    Error(
      "browserType.launchPersistentContext: Chromium distribution 'msedge' is not found at C:/private/profile",
    ),
  );
  const value = session();
  expect((await value.checkHealth()).view).toEqual({
    status: 'missing',
    version: null,
    stage: 'launch',
    reason: null,
  });
});
it('capability failure retains detected version and context closes despite page-close failure', async () => {
  const diagnostic = context();
  launch.mockResolvedValueOnce(diagnostic);
  capabilities.mockRejectedValueOnce(
    new BrowserHealthFailure('cleanup', 'cleanup_failed'),
  );
  const value = session();
  const result = await value.checkHealth();
  expect(result.view).toMatchObject({
    status: 'check_failed',
    version: '156.0.4314.58',
    stage: 'cleanup',
    reason: 'cleanup_failed',
  });
  expect(diagnostic.close).toHaveBeenCalledOnce();
  expect(value.isOccupied()).toBe(false);
});
it('rejects temporary roots overlapping the business profile before any launch', async () => {
  const value = createBrowserSession(join(root, 'profile'), {
    temporaryRoot: join(root, 'profile', 'health'),
    operationEpoch: () => 1,
  });
  sessions.push(value);
  expect((await value.checkHealth()).status).toBe('blocked');
  expect(launch).not.toHaveBeenCalled();
});
it('close retains pending launch for its bounded deadline and late result is disposal only', async () => {
  let finish!: (v: ReturnType<typeof context>) => void;
  launch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const value = session();
  const checking = value.checkHealth();
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  let settled = false;
  const closing = value.close().catch(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(9999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  await closing;
  expect(value.isOccupied()).toBe(true);
  expect((await checking).status).toBe('blocked');
  const late = context();
  finish(late);
  vi.useRealTimers();
  await vi.waitFor(() => expect(value.isOccupied()).toBe(false));
  expect(late.close).toHaveBeenCalledOnce();
  expect(value.current()).toBeUndefined();
});
it('cleanup refuses a replaced real directory even at its previously owned path', async () => {
  let replacement = '';
  capabilities.mockImplementationOnce(async () => {
    replacement = String(launch.mock.calls[0][0]);
    await rename(replacement, replacement + '-retired');
    await mkdir(replacement);
    await writeFile(join(replacement, 'foreign'), 'preserve');
  });
  const value = session();
  expect((await value.checkHealth()).view.reason).toBe('cleanup_failed');
  expect(await readFile(join(replacement, 'foreign'), 'utf8')).toBe('preserve');
  expect(value.isOccupied()).toBe(false);
});

it.each(['capability', 'cleanup', 'unconfirmed-close'] as const)(
  'real runtime events after invalidation cannot overwrite new state: %s; direct business open still reports fresh events',
  async (mode) => {
    const value = session();
    const controller = createBrowserHealthController({
      runtime: value,
      admission: () => null,
      operationEpoch: () => epoch,
      invalidateOperation: () => {
        epoch++;
        value.invalidateHealth();
      },
    });
    const old = context();
    if (mode === 'unconfirmed-close')
      old.close.mockRejectedValueOnce(Error('private close'));
    launch.mockResolvedValueOnce(old);
    let finish!: () => void;
    capabilities.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = () =>
            mode === 'capability'
              ? reject(new BrowserHealthFailure('editor'))
              : resolve();
        }),
    );
    try {
      const pending = controller.checkBrowserHealth();
      await vi.waitFor(() => expect(capabilities).toHaveBeenCalledOnce());
      epoch++;
      value.invalidateHealth();
      if (mode === 'cleanup') removal.fail = true;
      finish();
      expect((await pending).status).toBe('blocked');
      expect(await controller.getBrowserHealth()).toMatchObject(
        mode === 'unconfirmed-close'
          ? { status: 'busy', reason: 'ownership_unconfirmed' }
          : { status: 'unchecked', reason: null },
      );
      if (mode === 'unconfirmed-close') await value.close();
      expect(value.isOccupied()).toBe(false);
      // No manual health check between stop and the fresh business-open attempts.
      let rejectFresh!: () => void;
      capabilities.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFresh = () => reject(new BrowserHealthFailure('editor'));
          }),
      );
      const failing = value.open();
      const rejected = expect(failing).rejects.toMatchObject({
        reason: 'BROWSER_UNSUPPORTED',
      });
      await vi.waitFor(() => expect(capabilities).toHaveBeenCalledTimes(2));
      expect(await controller.getBrowserHealth()).toMatchObject({
        status: 'checking',
        stage: 'evaluate',
      });
      rejectFresh();
      await rejected;
      expect(await controller.getBrowserHealth()).toMatchObject({
        status: 'check_failed',
        stage: 'editor',
        reason: 'capability_failed',
      });
      await value.open();
      expect(await controller.getBrowserHealth()).toMatchObject({
        status: 'busy',
        reason: 'business_open',
        version: '156.0.4314.58',
      });
      await value.close();
      expect(await controller.getBrowserHealth()).toMatchObject({
        status: 'unchecked',
        reason: null,
      });
    } finally {
      controller.dispose();
    }
  },
);
it('a stale business close callback cannot invalidate the next owned operation', async () => {
  const value = session();
  const firstBusiness = context();
  launch.mockResolvedValueOnce(context()).mockResolvedValueOnce(firstBusiness);
  await value.open();
  firstBusiness.emit('close');
  let finish!: () => void;
  capabilities.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const opening = value.open();
  await vi.waitFor(() => expect(capabilities).toHaveBeenCalledTimes(2));
  firstBusiness.emit('close');
  finish();
  await opening;
  expect(value.current()).toBeDefined();
  expect(value.hasBusinessSession()).toBe(true);
});
