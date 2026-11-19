import { expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright-core';
import {
  checkBrowserHealthPackage,
  packagedEnvironment,
  cleanupOwned,
} from './browser-health-checks';

export const checkPackagedBrowser = checkBrowserHealthPackage;

// Faults are injected only into this controlled test process's dependencies.
// They are never runtime flags, renderer bypasses, or actual future-browser proof.
export async function checkPackagedBrowserFailures(
  root: string,
): Promise<void> {
  for (const failure of [
    'missing',
    'unavailable',
    'too-old',
    'unknown',
    'capability-timeout',
    'version-race',
    'close-unconfirmed',
    'delete-failed',
    'update-failed',
    'maintenance-held',
  ] as const) {
    const app = await electron.launch({
      executablePath: join(root, 'draft-assistant.exe'),
      args: [`--user-data-dir=${join(root, `failure-${failure}-data`)}`],
      env: packagedEnvironment(),
    });
    try {
      const boundary = await app.evaluateHandle(({ app }, failure) => {
        const localRequire = process
          .getBuiltinModule('module')
          .createRequire(app.getAppPath() + '/package.json') as NodeJS.Require;
        const runtime = localRequire('playwright-core') as {
          chromium: BrowserType;
        };
        const filesystem = process.getBuiltinModule('fs/promises');
        const original = runtime.chromium.launchPersistentContext;
        const originalRemove = filesystem.rm;
        const records: {
          context: BrowserContext;
          close: () => Promise<void>;
          path: string;
          closed: boolean;
        }[] = [];
        let calls = 0,
          deletions = 0;
        runtime.chromium.launchPersistentContext = async function (
          path,
          options,
        ) {
          calls++;
          if (failure === 'missing')
            throw Error(
              "Chromium distribution 'msedge' is not found private-path",
            );
          if (failure === 'unavailable')
            throw Error('private-path launch refused');
          const context = await original.call(this, path, options);
          const close = context.close.bind(context);
          const record = { context, close, path, closed: false };
          records.push(record);
          context.on('close', () => {
            record.closed = true;
          });
          if (failure === 'unknown') context.browser = () => null;
          if (
            failure === 'too-old' ||
            (failure === 'version-race' && calls === 2)
          ) {
            const browser = context.browser()!;
            browser.version = () =>
              failure === 'too-old' ? '152.0.0.0' : '157.0.0.0';
          }
          if (failure === 'capability-timeout') {
            const newPage = context.newPage.bind(context);
            context.newPage = async () => {
              const page = await newPage();
              page.evaluate = (() =>
                new Promise(() => {})) as typeof page.evaluate;
              return page;
            };
          }
          if (failure === 'close-unconfirmed')
            context.close = async () => {
              throw Error('private-path close refused');
            };
          if (failure === 'update-failed' || failure === 'maintenance-held') {
            const page = context.pages()[0];
            page.goto = async () => {
              if (failure === 'update-failed')
                throw Error('private-path official navigation failed');
              return null;
            };
          }
          return context;
        };
        if (failure === 'delete-failed')
          filesystem.rm = (async (path, options) => {
            if (String(path).includes('diagnostic-') && deletions++ === 0)
              throw Error('private-path deletion refused');
            return originalRemove(path, options);
          }) as typeof filesystem.rm;
        return {
          snapshot: () => ({
            resolved: localRequire.resolve('playwright-core'),
            calls,
            deletions,
            records: records.map(
              ({ context: _context, close: _close, ...record }) => {
                void _context;
                void _close;
                return record;
              },
            ),
          }),
          restore: async () => {
            runtime.chromium.launchPersistentContext = original;
            filesystem.rm = originalRemove;
            for (const record of records) record.context.close = record.close;
            const results = await Promise.allSettled(
              records
                .filter((record) => !record.closed)
                .map((record) => record.close()),
            );
            if (
              results.some((result) => result.status === 'rejected') ||
              records.some((record) => !record.closed)
            )
              throw Error('Owned injected context closure unconfirmed');
          },
        };
      }, failure);
      try {
        const page = await app.firstWindow();
        await expect(
          page.getByRole('heading', { name: '汽车经销商草稿助手' }),
        ).toBeVisible();
        expect(
          (await boundary.evaluate((b) => b.snapshot())).resolved,
        ).toContain(join(root, 'resources'));
        if (failure === 'version-race') {
          expect(
            await page.evaluate(() => window.desktopApi.openDraftSession()),
          ).toMatchObject({ status: 'blocked', reason: 'BROWSER_UNSUPPORTED' });
          expect(
            await page.evaluate(() => window.desktopApi.getBrowserHealth()),
          ).toMatchObject({
            status: 'check_failed',
            reason: 'version_changed',
          });
          expect((await boundary.evaluate((b) => b.snapshot())).calls).toBe(2);
        } else if (failure === 'maintenance-held') {
          expect(
            await page.evaluate(() => window.desktopApi.openBrowserUpdate()),
          ).toMatchObject({ status: 'ok', view: { status: 'update_open' } });
          expect(
            await page.evaluate(() => window.desktopApi.checkBrowserHealth()),
          ).toMatchObject({
            status: 'blocked',
            view: { reason: 'maintenance_open' },
          });
          expect(
            await page.evaluate(() => window.desktopApi.openDraftSession()),
          ).toMatchObject({ status: 'blocked' });
          expect((await boundary.evaluate((b) => b.snapshot())).calls).toBe(1);
        } else {
          const result = await page.evaluate(
            (update) =>
              update
                ? window.desktopApi.openBrowserUpdate()
                : window.desktopApi.checkBrowserHealth(),
            failure === 'update-failed',
          );
          const status =
            failure === 'missing'
              ? 'missing'
              : failure === 'unavailable' || failure === 'update-failed'
                ? 'unavailable'
                : failure === 'too-old'
                  ? 'too_old'
                  : failure === 'unknown'
                    ? 'unknown_version'
                    : 'check_failed';
          expect(result).toMatchObject({ status: 'blocked', view: { status } });
          expect(JSON.stringify(result)).not.toContain('private-path');
          expect(JSON.stringify(result)).not.toContain(root);
          if (failure === 'update-failed') {
            expect(result.view.reason).toBe('update_unavailable');
            await expect(
              page.getByText(/Edge 菜单 → 帮助和反馈 → 关于 Microsoft Edge/),
            ).toBeVisible();
          }
          if (failure === 'capability-timeout')
            expect(result.view).toMatchObject({
              stage: 'evaluate',
              reason: 'timeout',
            });
          if (failure === 'close-unconfirmed') {
            expect(result.view.reason).toBe('cleanup_failed');
            expect(
              (
                await page.evaluate(() =>
                  window.desktopApi.checkBrowserHealth(),
                )
              ).view.reason,
            ).toBe('ownership_unconfirmed');
            expect((await boundary.evaluate((b) => b.snapshot())).calls).toBe(
              1,
            );
          }
          if (failure === 'delete-failed') {
            expect(result.view.reason).toBe('cleanup_failed');
            expect(
              (await boundary.evaluate((b) => b.snapshot())).records[0].closed,
            ).toBe(true);
            expect(
              await page.evaluate(() => window.desktopApi.checkBrowserHealth()),
            ).toMatchObject({ status: 'ok', view: { status: 'passed' } });
            const state = await boundary.evaluate((b) => b.snapshot());
            expect(state.calls).toBe(2);
            expect(state.records[0].path).not.toBe(state.records[1].path);
          }
        }
        expect(
          await page.evaluate(() => window.desktopApi.listArticles()),
        ).toMatchObject({ status: 'ok' });
        console.log(
          `Packaged injected failure PASS: ${failure}`,
          await boundary.evaluate((b) => b.snapshot()),
        );
      } finally {
        await cleanupOwned([
          () => boundary.evaluate((b) => b.restore()),
          () => boundary.dispose(),
        ]);
      }
    } finally {
      await app.close();
    }
  }
}
