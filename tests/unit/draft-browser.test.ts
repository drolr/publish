import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserSession } from '../../src/infrastructure/automation/browser-session';
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright-core', () => ({
  chromium: { launchPersistentContext: launch },
}));
let root: string;
const sessions: ReturnType<typeof createBrowserSession>[] = [];
function session(path = join(root, 'profile')) {
  const value = createBrowserSession(path);
  sessions.push(value);
  return value;
}
function context(version: string | null = '153.0.1.0') {
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
  root = await mkdtemp(join(tmpdir(), 'draft-browser-test-'));
  launch.mockReset();
});
afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map((s) => s.close().catch(() => undefined)),
  );
  await rm(root, { recursive: true, force: true });
});
it.each(['153.0.1.0', '154.0.4258.37', '155.0.4283.45'])(
  'merges simultaneous opens and launches only the approved Edge configuration (%s)',
  async (version) => {
    const browser = context(version);
    launch.mockResolvedValue(browser);
    const value = session();
    const before = value.generation();
    const first = value.open();
    expect(value.open()).toBe(first);
    expect(await first).toBe(browser);
    expect(value.current()).toBe(browser);
    expect(launch).toHaveBeenCalledWith(join(root, 'profile'), {
      channel: 'msedge',
      headless: false,
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      viewport: null,
      acceptDownloads: false,
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.setDefaultTimeout).toHaveBeenCalledWith(10000);
    expect(browser.setDefaultNavigationTimeout).toHaveBeenCalledWith(30000);
    expect(value.generation()).not.toBe(before);
    await value.open();
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(session().open()).rejects.toMatchObject({
      reason: 'BROWSER_UNAVAILABLE',
    });
    await value.close();
    launch.mockResolvedValue(context(version));
    await session().open();
    expect(launch).toHaveBeenCalledTimes(2);
  },
);
it('launch errors are sanitized, leave no ready context, and allow a later manual open', async () => {
  launch
    .mockRejectedValueOnce(new Error('secret local path'))
    .mockResolvedValue(context());
  const value = session();
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
    message: 'BROWSER_UNAVAILABLE',
  });
  expect(value.current()).toBeUndefined();
  await value.open();
  expect(launch).toHaveBeenCalledTimes(2);
});
it.each(['152.9.0', '156.0.0', '999.0.0', 'unknown', null])(
  'closes unsupported browser version %s before exposing readiness',
  async (version) => {
    const browser = context(version);
    launch.mockResolvedValue(browser);
    const value = session();
    await expect(value.open()).rejects.toMatchObject({
      reason: 'BROWSER_UNSUPPORTED',
    });
    expect(value.current()).toBeUndefined();
    expect(browser.close).toHaveBeenCalledTimes(1);
    launch.mockResolvedValue(context());
    await session().open();
    expect(launch).toHaveBeenCalledTimes(2);
  },
);
it.each(['156.0.0', '999.0.0', 'unknown', null])(
  'retains an unsupported version %s lease when disposal is unconfirmed',
  async (version) => {
    const browser = context(version);
    browser.close.mockRejectedValueOnce(new Error('private close failure'));
    launch.mockResolvedValue(browser);
    const value = session();
    await expect(value.open()).rejects.toMatchObject({
      reason: 'BROWSER_UNSUPPORTED',
    });
    expect(value.current()).toBeUndefined();
    await expect(value.open()).rejects.toMatchObject({
      reason: 'BROWSER_UNAVAILABLE',
    });
    await expect(session().open()).rejects.toMatchObject({
      reason: 'BROWSER_UNAVAILABLE',
    });
    expect(launch).toHaveBeenCalledTimes(1);
    await value.close();
    expect(browser.close).toHaveBeenCalledTimes(2);
    launch.mockResolvedValue(context());
    await session().open();
    expect(launch).toHaveBeenCalledTimes(2);
  },
);
it('invalidates generation after an external close and allows a fresh session', async () => {
  const browser = context();
  launch.mockResolvedValue(browser);
  const value = session();
  await value.open();
  const old = value.generation();
  browser.emit('close');
  expect(value.current()).toBeUndefined();
  expect(value.generation()).not.toBe(old);
  launch.mockResolvedValue(context());
  await value.open();
  expect(launch).toHaveBeenCalledTimes(2);
});
it('close during a pending launch waits for disposal and never publishes readiness', async () => {
  let finish!: (value: ReturnType<typeof context>) => void;
  launch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const value = session();
  const opening = value.open();
  const rejected = expect(opening).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  const closing = value.close();
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  const browser = context();
  finish(browser);
  await closing;
  await rejected;
  expect(value.current()).toBeUndefined();
  expect(browser.close).toHaveBeenCalledTimes(1);
});
it('merges close calls and does not open a second context while closing', async () => {
  const browser = context();
  launch.mockResolvedValue(browser);
  const value = session();
  await value.open();
  let finish!: () => void;
  browser.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          browser.emit('close');
          resolve();
        };
      }),
  );
  const first = value.close();
  expect(value.close()).toBe(first);
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  finish();
  await first;
  expect(browser.close).toHaveBeenCalledTimes(1);
});
it.each([
  'relative/profile',
  '\\\\server\\share\\profile',
  '\\\\?\\C:\\profile',
])('rejects unsafe path %s before launching', async (path) => {
  await expect(session(path).open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(launch).not.toHaveBeenCalled();
});
it('refuses a nonempty unowned profile without changing its contents', async () => {
  await mkdir(join(root, 'profile'));
  await writeFile(join(root, 'profile', 'Preferences'), 'existing');
  await expect(session().open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(launch).not.toHaveBeenCalled();
});
it('refuses a junction ancestor', async () => {
  await mkdir(join(root, 'real'));
  await symlink(join(root, 'real'), join(root, 'linked'), 'junction');
  await expect(
    session(join(root, 'linked', 'profile')).open(),
  ).rejects.toMatchObject({ reason: 'BROWSER_UNAVAILABLE' });
  expect(launch).not.toHaveBeenCalled();
});
it('reuses its owned profile after close with a fresh factory', async () => {
  launch.mockResolvedValue(context());
  await session().open();
  await sessions[0].close();
  await writeFile(join(root, 'profile', 'Preferences'), 'browser state');
  launch.mockResolvedValue(context());
  await session().open();
  expect(launch).toHaveBeenCalledTimes(2);
});

it('blocks another factory from owning the same live profile', async () => {
  launch.mockResolvedValue(context());
  await session().open();
  await expect(session().open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(launch).toHaveBeenCalledTimes(1);
});
it('retains ownership and blocks reopening when close fails', async () => {
  const browser = context();
  launch.mockResolvedValue(browser);
  const value = session();
  await value.open();
  browser.close.mockRejectedValueOnce(new Error('private path'));
  await expect(value.close()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
    message: 'BROWSER_UNAVAILABLE',
  });
  expect(value.current()).toBeUndefined();
  await expect(value.open()).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(launch).toHaveBeenCalledTimes(1);
  await value.close();
});
it('does not launch when immediately closed during profile checks', async () => {
  const value = session();
  const opening = value.open();
  const rejection = expect(opening).rejects.toMatchObject({
    reason: 'BROWSER_UNAVAILABLE',
  });
  await value.close();
  await rejection;
  expect(launch).not.toHaveBeenCalled();
});
it('a missing runtime fails only on open and returns a sanitized error', async () => {
  vi.resetModules();
  vi.doMock('playwright-core', () => {
    throw new Error('module missing at private path');
  });
  try {
    const { createBrowserSession: create } =
      await import('../../src/infrastructure/automation/browser-session');
    const value = create(join(root, 'missing-runtime'));
    sessions.push(value);
    expect(value.current()).toBeUndefined();
    await expect(value.open()).rejects.toMatchObject({
      reason: 'BROWSER_UNAVAILABLE',
      message: 'BROWSER_UNAVAILABLE',
    });
  } finally {
    vi.doMock('playwright-core', () => ({
      chromium: { launchPersistentContext: launch },
    }));
    vi.resetModules();
  }
});
