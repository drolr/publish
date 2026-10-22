import { expect, _electron as electron, type JSHandle } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { BrowserType } from 'playwright-core';
import { denyExternalNetwork } from './network-policy';

export async function checkPackagedBrowser(root: string): Promise<void> {
  // Resolve strictly from the extracted ZIP, never the workspace dependency.
  const requirePackaged = createRequire(
    join(root, 'resources/app.asar.unpacked/probe.cjs'),
  );
  const runtime = requirePackaged('playwright-core') as {
    chromium: BrowserType;
  };
  expect(requirePackaged.resolve('playwright-core')).toContain(
    join(root, 'resources'),
  );
  expect(requirePackaged('playwright-core/package.json').version).toBe(
    '1.63.0',
  );
  const profile = join(root, 'offline-profile');
  const context = await runtime.chromium.launchPersistentContext(profile, {
    channel: 'msedge',
    headless: false,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  let canaryHits = 0;
  const canary = createServer((_request, response) => {
    canaryHits++;
    response.end('owned-package-canary');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      canary.once('error', reject);
      canary.listen(0, '127.0.0.2', resolve);
    });
    // This new context needs its own policy, before any requested navigation.
    await denyExternalNetwork(context);
    const version = context.browser()!.version();
    expect(version).toMatch(/^(153|154|155)\./);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('about:blank');
    expect(page.url()).toBe('about:blank');
    // This loopback host is owned by the test but outside the policy allow-list.
    // Prove the policy blocks a real reachable server, then restore the policy.
    const address = canary.address() as { port: number };
    const canaryUrl = `http://127.0.0.2:${address.port}/owned`;
    await expect(page.goto(canaryUrl)).rejects.toThrow();
    expect(canaryHits).toBe(0);
    await context.unroute('**/*');
    await page.goto(canaryUrl);
    expect(await page.textContent('body')).toBe('owned-package-canary');
    expect(canaryHits).toBeGreaterThan(0);
    await denyExternalNetwork(context);
    const reachableHits = canaryHits;
    await expect(page.goto(`${canaryUrl}?blocked-again`)).rejects.toThrow();
    expect(canaryHits).toBe(reachableHits);
    console.log(
      `Packaged network policy: blocked0 / reachable${reachableHits} / restored${canaryHits}`,
    );
    console.log(
      `Packaged Playwright 1.63.0 / Edge ${version}: isolated offline lifecycle`,
    );
    // A second process cannot take the same live profile; this is a real lock.
    await expect(
      runtime.chromium.launchPersistentContext(profile, {
        channel: 'msedge',
        headless: true,
        chromiumSandbox: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        serviceWorkers: 'block',
        acceptDownloads: false,
      }),
    ).rejects.toThrow();
  } finally {
    try {
      await context.close();
    } finally {
      await new Promise<void>((resolve) => canary.close(() => resolve()));
    }
  }
  const reopened = await runtime.chromium.launchPersistentContext(profile, {
    channel: 'msedge',
    headless: false,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  try {
    await denyExternalNetwork(reopened);
    await (reopened.pages()[0] ?? (await reopened.newPage())).goto(
      'about:blank',
    );
  } finally {
    await reopened.close();
  }
  // Missing executable must fail, never skip as a successful smoke.
  await expect(
    runtime.chromium.launchPersistentContext(
      join(root, 'missing-edge-profile'),
      {
        executablePath: join(root, 'nonexistent-edge.exe'),
        headless: true,
        chromiumSandbox: true,
        serviceWorkers: 'block',
      },
    ),
  ).rejects.toThrow();
}

export async function checkPackagedBrowserFailures(
  root: string,
): Promise<void> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: join(root, 'draft-assistant.exe'),
    args: [`--user-data-dir=${join(root, 'failure-data')}`],
    env: environment,
  });
  let originalLaunch:
    JSHandle<BrowserType['launchPersistentContext']> | undefined;
  try {
    originalLaunch = await app.evaluateHandle(({ app }) => {
      const localRequire = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json') as NodeJS.Require;
      return (localRequire('playwright-core') as { chromium: BrowserType })
        .chromium.launchPersistentContext;
    });
    const page = await app.firstWindow();
    await expect(
      page.getByRole('heading', { name: '汽车经销商草稿助手' }),
    ).toBeVisible();
    for (const failure of [
      'missing',
      'unsupported',
      'unknown',
      'locked',
    ] as const) {
      const boundary = await app.evaluateHandle(({ app }, failure) => {
        const localRequire = process
          .getBuiltinModule('module')
          .createRequire(app.getAppPath() + '/package.json') as NodeJS.Require;
        const runtime = localRequire('playwright-core') as {
          chromium: {
            launchPersistentContext: (...args: unknown[]) => Promise<unknown>;
          };
        };
        const observed = {
          resolved: localRequire.resolve('playwright-core'),
          calls: 0,
          closed: 0,
        };
        // Test-only replacement at the actual packaged dependency boundary. It
        // cannot launch a browser or provide any navigation/page capability.
        runtime.chromium.launchPersistentContext = async () => {
          observed.calls++;
          if (failure !== 'unsupported' && failure !== 'unknown')
            throw new Error(`private-path:${failure}`);
          const context = Object.assign(
            new (process.getBuiltinModule('events').EventEmitter)(),
            {
              browser: () =>
                failure === 'unknown' ? null : { version: () => '999.0.0.0' },
              close: async () => {
                observed.closed++;
                context.emit('close');
              },
            },
          );
          return context;
        };
        return observed;
      }, failure);
      expect((await boundary.jsonValue()).resolved).toContain(
        join(root, 'resources'),
      );
      const result = await page.evaluate(() =>
        window.desktopApi.openDraftSession(),
      );
      const reason =
        failure === 'unsupported' || failure === 'unknown'
          ? 'BROWSER_UNSUPPORTED'
          : 'BROWSER_UNAVAILABLE';
      expect(result).toMatchObject({
        status: 'blocked',
        reason,
        view: {
          session: { status: 'blocked', reason, bindingToken: null },
          task: null,
        },
      });
      expect(JSON.stringify(result)).not.toContain('private-path');
      expect(JSON.stringify(result)).not.toContain(root);
      expect(
        await page.evaluate(() => window.desktopApi.listArticles()),
      ).toMatchObject({ status: 'ok' });
      expect(await boundary.jsonValue()).toMatchObject({
        calls: 1,
        closed: failure === 'unsupported' || failure === 'unknown' ? 1 : 0,
      });
      await boundary.dispose();
    }
  } finally {
    try {
      if (originalLaunch)
        await app.evaluate(({ app }, original) => {
          const localRequire = process
            .getBuiltinModule('module')
            .createRequire(
              app.getAppPath() + '/package.json',
            ) as NodeJS.Require;
          (
            localRequire('playwright-core') as { chromium: BrowserType }
          ).chromium.launchPersistentContext = original;
        }, originalLaunch);
      await originalLaunch?.dispose();
    } finally {
      await app.close();
    }
  }
}
