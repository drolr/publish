import { expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright-core';
import {
  checkLocalCapabilities,
  parseEdgeVersion,
} from '../../src/infrastructure/automation/browser-health-check';

export const packagedEnvironment = () => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
};

// Every close/restore/dispose is attempted even if an earlier cleanup rejects.
export async function cleanupOwned(
  steps: (() => Promise<unknown>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned package resource closure unconfirmed; preserve extraction root',
    );
}

// Exact runtime lookup from the extracted artifact, with no workspace fallback.
export function packagedRuntime(root: string) {
  const requirePackaged = createRequire(
    join(root, 'resources/app.asar.unpacked/probe.cjs'),
  );
  expect(requirePackaged.resolve('playwright-core')).toContain(
    join(root, 'resources/app.asar.unpacked/node_modules/playwright-core'),
  );
  expect(requirePackaged('playwright-core/package.json').version).toBe(
    '1.63.0',
  );
  return requirePackaged('playwright-core') as { chromium: BrowserType };
}

export async function checkBrowserHealthPackage(
  extractedRoot: string,
): Promise<void> {
  const runtime = packagedRuntime(extractedRoot);
  const evidence: Record<string, unknown> = {
    playwright: '1.63.0',
    maintenance: 'NOT RUN: set BROWSER_HEALTH_UPDATE_OPT_IN=1',
    matrix: [
      'nonce',
      'unique visible locator and exact Chinese',
      'contenteditable Chinese/newline order',
      'Range/Selection',
      '68-byte PNG exact bytes',
    ],
  };
  const evidenceDirectory = resolve(
    '.tmp/browser-health',
    `package-${Date.now()}`,
  );
  mkdirSync(evidenceDirectory, { recursive: true });
  let hits = 0;
  const canary = createServer((_request, response) => {
    hits++;
    response.end('owned-health-canary');
  });
  let context: BrowserContext | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      canary.once('error', reject);
      canary.listen(0, '127.0.0.1', resolve);
    });
    const options = {
      channel: 'msedge',
      headless: false,
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      serviceWorkers: 'block' as const,
      acceptDownloads: false,
    };
    const profile = join(extractedRoot, 'owned-matrix-profile');
    context = await runtime.chromium.launchPersistentContext(profile, options);
    const version = context.browser()!.version();
    expect(parseEdgeVersion(version)?.major).toBeGreaterThanOrEqual(153);
    evidence.edge = version;
    evidence.options = options;
    // Reuse the frozen production matrix, rather than a package-only approximation.
    await context.setOffline(true);
    await checkLocalCapabilities(context, new AbortController().signal);
    evidence.offlineMatrix =
      'PASS: explicit setOffline(true), frozen production matrix';
    await context.setOffline(false);
    const page = await context.newPage();
    const address = canary.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/owned`;
    await expect(page.goto(url)).rejects.toThrow();
    expect(hits).toBe(0);
    await context.unroute('**/*');
    await page.goto(url);
    expect(await page.textContent('body')).toBe('owned-health-canary');
    expect(hits).toBeGreaterThan(0);
    const reachable = hits;
    await context.route('**/*', (route) => route.abort());
    await expect(page.goto(`${url}?blocked-again`)).rejects.toThrow();
    expect(hits).toBe(reachable);
    evidence.canary = {
      blocked: 0,
      positiveControl: reachable,
      restored: hits,
    };
    await expect(
      runtime.chromium.launchPersistentContext(profile, options),
    ).rejects.toThrow();
    evidence.liveProfileLock = 'PASS';
    await context.close();
    context = undefined;
    context = await runtime.chromium.launchPersistentContext(profile, options);
    await context.route('**/*', (route) => route.abort());
    await context.close();
    context = undefined;
    evidence.closeAndReopen = 'PASS';
    await expect(
      runtime.chromium.launchPersistentContext(
        join(extractedRoot, 'owned-missing-exe-profile'),
        {
          ...options,
          executablePath: join(extractedRoot, 'nonexistent-edge.exe'),
        },
      ),
    ).rejects.toThrow();
    evidence.missingExecutable = 'PASS';
  } finally {
    try {
      await cleanupOwned([
        async () => context?.close(),
        () => new Promise<void>((resolve) => canary.close(() => resolve())),
      ]);
    } finally {
      writeFileSync(
        join(evidenceDirectory, 'evidence.json'),
        JSON.stringify(evidence, null, 2),
      );
    }
  }
  const app = await electron.launch({
    executablePath: join(extractedRoot, 'draft-assistant.exe'),
    args: [`--user-data-dir=${join(extractedRoot, 'owned-health-data')}`],
    env: packagedEnvironment(),
  });
  try {
    // Observe the actual production launches without changing versions or behavior.
    const observer = await app.evaluateHandle(({ app }) => {
      const localRequire = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json') as NodeJS.Require;
      const runtime = localRequire('playwright-core') as {
        chromium: BrowserType;
      };
      const original = runtime.chromium.launchPersistentContext;
      const records: {
        path: string;
        options: unknown;
        version: string;
        closed: boolean;
        context: BrowserContext;
      }[] = [];
      runtime.chromium.launchPersistentContext = async function (
        path,
        options,
      ) {
        const context = await original.call(this, path, options);
        const record = {
          path,
          options,
          version: context.browser()!.version(),
          closed: false,
          context,
        };
        records.push(record);
        context.on('close', () => {
          record.closed = true;
        });
        return context;
      };
      return {
        records,
        restore: () => {
          runtime.chromium.launchPersistentContext = original;
        },
        closeOwned: async () => {
          const results = await Promise.allSettled(
            records
              .filter((record) => !record.closed)
              .map((record) => record.context.close()),
          );
          if (
            results.some((result) => result.status === 'rejected') ||
            records.some((record) => !record.closed)
          )
            throw Error('Owned packaged context closure unconfirmed');
        },
        snapshot: () =>
          records.map(({ context: _context, ...record }) => {
            void _context;
            return record;
          }),
      };
    });
    try {
      const page = await app.firstWindow();
      await expect(
        page.getByRole('heading', { name: '汽车经销商草稿助手' }),
      ).toBeVisible();
      expect(await observer.evaluate((o) => o.snapshot())).toHaveLength(0);
      expect(
        await page.evaluate(() => window.desktopApi.getBrowserHealth()),
      ).toMatchObject({ status: 'unchecked', version: null });
      const result = await page.evaluate(() =>
        window.desktopApi.checkBrowserHealth(),
      );
      expect(result).toMatchObject({
        status: 'ok',
        view: { status: 'passed', version: evidence.edge, reason: null },
      });
      await expect(
        page.getByText('浏览器基础检查通过', { exact: true }),
      ).toBeVisible();
      expect(
        (await page.evaluate(() => window.desktopApi.getDraftState())).session
          .status,
      ).toBe('closed');
      const diagnostic = await observer.evaluate((o) => o.snapshot());
      expect(diagnostic).toHaveLength(1);
      expect(diagnostic[0]).toMatchObject({
        closed: true,
        options: {
          channel: 'msedge',
          headless: true,
          chromiumSandbox: true,
          ignoreDefaultArgs: ['--disable-extensions'],
          serviceWorkers: 'block',
          acceptDownloads: false,
        },
      });
      expect(diagnostic[0].path).toContain('diagnostic-');
      expect(existsSync(diagnostic[0].path)).toBe(false);
      evidence.typedApiDiagnostic = {
        result,
        launches: diagnostic,
        directoryRemoved: true,
      };
      if (process.env.BROWSER_HEALTH_UPDATE_OPT_IN === '1') {
        const update = await page.evaluate(() =>
          window.desktopApi.openBrowserUpdate(),
        );
        evidence.maintenance = {
          result: update,
          outcome:
            update.status === 'ok'
              ? 'PASS: fixed official page opened, no update/restart action'
              : 'PARTIAL: official navigation unavailable; manual fallback verified',
        };
        if (update.status === 'ok') {
          expect(update.view.status).toBe('update_open');
          expect(
            await observer.evaluate((o) =>
              o.records
                .at(-1)!
                .context.pages()
                .map((p) => p.url()),
            ),
          ).toEqual(['edge://settings/help']);
          expect(
            (await page.evaluate(() => window.desktopApi.checkBrowserHealth()))
              .view.reason,
          ).toBe('maintenance_open');
          expect(
            (await page.evaluate(() => window.desktopApi.openDraftSession()))
              .status,
          ).toBe('blocked');
          await observer.evaluate((o) => o.closeOwned());
          await expect
            .poll(() =>
              page.evaluate(() => window.desktopApi.getBrowserHealth()),
            )
            .toMatchObject({ status: 'unchecked' });
        } else {
          expect(update.view.reason).toBe('update_unavailable');
          await expect(
            page.getByText(/Edge 菜单 → 帮助和反馈 → 关于 Microsoft Edge/),
          ).toBeVisible();
        }
        const maintenance = (await observer.evaluate((o) => o.snapshot()))[1];
        expect(maintenance.path).toContain('maintenance-');
        expect(maintenance.path).not.toBe(diagnostic[0].path);
        await expect.poll(() => existsSync(maintenance.path)).toBe(false);
        expect(maintenance.closed).toBe(true);
        evidence.maintenanceLaunch = maintenance;
        expect(
          (await page.evaluate(() => window.desktopApi.checkBrowserHealth()))
            .view.status,
        ).toBe('passed');
      }
    } finally {
      await cleanupOwned([
        () => observer.evaluate((o) => o.closeOwned()),
        () => observer.evaluate((o) => o.restore()),
        () => observer.dispose(),
      ]);
    }
  } finally {
    try {
      await app.close();
    } finally {
      writeFileSync(
        join(evidenceDirectory, 'evidence.json'),
        JSON.stringify(evidence, null, 2),
      );
      console.log(
        `Actual packaged browser health evidence: ${join(evidenceDirectory, 'evidence.json')}`,
      );
    }
  }
}
