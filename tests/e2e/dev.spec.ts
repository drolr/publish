import { test, expect, chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Forge development server starts the real application', async () => {
  test.setTimeout(90000);
  const root = mkdtempSync(join(tmpdir(), 'draft-dev-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Forge's public API returns the actual Electron child. Record its normal
  // exit before webpack's built-in listener closes the watch owner.
  const ownerScript = join(root, 'forge-owner.mjs');
  const exitEvidencePath = join(root, 'electron-exit.json');
  writeFileSync(
    ownerScript,
    `
    import { writeFileSync } from 'node:fs';
    const { api } = await import(${JSON.stringify(pathToFileURL(require.resolve('@electron-forge/core')).href)});
    const electron = await api.start({ dir: ${JSON.stringify(process.cwd())}, interactive: false,
      args: ['--remote-debugging-port=0', '--inspect=0', ${JSON.stringify(`--user-data-dir=${root}`)}] });
    process.send?.({ kind: 'electron-started', pid: electron.pid });
    // Webpack postStart exits its owner in an earlier exit listener. Record
    // the returned child's real exit synchronously before that cleanup.
    electron.prependOnceListener('exit', (code, signal) => {
      const evidence = { kind: 'electron-exit', code, signal, pid: electron.pid };
      writeFileSync(${JSON.stringify(exitEvidencePath)}, JSON.stringify(evidence));
    });
  `,
  );
  const child = spawn(process.execPath, [ownerScript], {
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let electronPid: number | undefined;
  child.on(
    'message',
    (message: {
      kind: string;
      code: number | null;
      signal: string | null;
      pid: number;
    }) => {
      if (message.kind === 'electron-started') electronPid = message.pid;
    },
  );
  child.stdout!.on('data', (data: Buffer) => process.stdout.write(data));
  child.stderr!.on('data', (data: Buffer) => process.stderr.write(data));
  try {
    const endpoints = await new Promise<{ browser: string; main: string }>(
      (done, reject) => {
        let log = '';
        const timer = setTimeout(
          () => reject(new Error(`Dev launch timed out: ${log.slice(-4000)}`)),
          60000,
        );
        const collect = (data: Buffer) => {
          log = (log + data.toString()).slice(-16000);
          const browser = /DevTools listening on (ws:\/\/[^\s]+)/.exec(log);
          const main = /Debugger listening on (ws:\/\/[^\s]+)/.exec(log);
          if (browser && main) {
            clearTimeout(timer);
            done({ browser: browser[1], main: main[1] });
          }
        };
        child.stdout!.on('data', collect);
        child.stderr!.on('data', collect);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`Dev launch exited: ${log.slice(-4000)}`));
        });
      },
    );
    const browser = await chromium.connectOverCDP(endpoints.browser);
    console.info('Owned dev checkpoint: CDP attached');
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.waitForEvent('page'));
      await expect(page.getByText('还没有文章', { exact: true })).toBeVisible();
      console.info('Owned dev checkpoint: application ready');
      expect(
        await page.evaluate(() => window.desktopApi.getAppStatus()),
      ).toEqual({ state: 'ready', appVersion: '0.1.0', schemaVersion: 14 });
      expect(
        await page.evaluate(() => window.desktopApi.getDraftState()),
      ).toMatchObject({
        session: { status: 'closed' },
        preparation: null,
        task: null,
      });
      expect(existsSync(join(root, 'profiles'))).toBe(false);
      await page.screenshot({ path: resolve('test-results/dev-window.png') });
      expect(
        await page.evaluate(() => window.desktopApi.getManualArticleState()),
      ).toMatchObject({ state: 'idle' });
      // DOM window.close destroys webContents before BrowserWindow's close
      // handshake on this Electron version. Ask the documented main-process
      // app.quit path while the renderer is alive, then detach the inspector.
      const inspector = new WebSocket(endpoints.main);
      try {
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(
            () => reject(Error('Main inspector unavailable')),
            5000,
          );
          inspector.addEventListener(
            'error',
            () => {
              clearTimeout(timer);
              reject(Error('Main inspector failed'));
            },
            { once: true },
          );
          inspector.addEventListener(
            'open',
            () => {
              clearTimeout(timer);
              done();
            },
            { once: true },
          );
        });
        const invoke = (id: number, expression: string) =>
          new Promise<unknown>((done, reject) => {
            const timer = setTimeout(
              () => reject(Error('Main quit command unacknowledged')),
              5000,
            );
            inspector.addEventListener('message', (event) => {
              const reply = JSON.parse(String(event.data)) as {
                id?: number;
                result?: {
                  exceptionDetails?: unknown;
                  result?: { value?: unknown };
                };
                error?: unknown;
              };
              if (reply.id !== id) return;
              clearTimeout(timer);
              if (reply.error || reply.result?.exceptionDetails)
                reject(Error('Main quit command failed'));
              else done(reply.result?.result?.value);
            });
            inspector.send(
              JSON.stringify({
                id,
                method: 'Runtime.evaluate',
                params: {
                  expression,
                  returnByValue: true,
                },
              }),
            );
          });
        await expect.poll(() => electronPid, { timeout: 5000 }).toBeTruthy();
        const inspectedPid = await invoke(1, 'process.pid');
        expect(inspectedPid).toBe(electronPid);
        console.info(
          'Owned dev checkpoint: inspector PID matched returned Electron child',
          inspectedPid,
        );
        await invoke(2, "process.mainModule.require('electron').app.quit()");
      } finally {
        inspector.close();
      }
      await expect.poll(() => page.isClosed(), { timeout: 10000 }).toBe(true);
      console.info(
        'Owned dev checkpoint: page closed after app.quit; awaiting Electron exit',
      );
      await browser.close();
      console.info('Owned dev checkpoint: CDP owner disconnected');
      await expect
        .poll(
          () =>
            existsSync(exitEvidencePath)
              ? JSON.parse(readFileSync(exitEvidencePath, 'utf8'))
              : undefined,
          { timeout: 10000 },
        )
        .toMatchObject({ code: 0, signal: null, pid: electronPid });
      console.info(
        'Owned Forge Electron exit',
        readFileSync(exitEvidencePath, 'utf8'),
      );
      await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
      console.info(
        'Owned dev checkpoint: Electron child exited after documented app.quit; Forge watch owner cleanup follows',
      );
    } finally {
      await browser.close();
    }
  } finally {
    if (child.exitCode === null && child.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        /* The owned process may already have exited. */
      }
    }
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
});
