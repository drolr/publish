import {
  test,
  expect,
  chromium,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import type { StoredAsset } from '../../src/contracts/stored-article';
const publicImage = 'https://www.gstatic.com/webp/gallery/1.png';
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const snapshot = (page: Page) =>
  page.evaluate(() => window.desktopApi.getManualArticleState());
async function settle(page: Page) {
  await expect
    .poll(
      async () => {
        const s = await snapshot(page);
        return s.state === 'editing' && 'pasteSummary' in s
          ? s.pasteSummary?.outcome
          : undefined;
      },
      { timeout: 90000 },
    )
    .toBeDefined();
  const s = await snapshot(page);
  if (!('draft' in s)) throw Error('missing draft');
  return s;
}
async function offline(application: ElectronApplication) {
  await application.evaluate(async ({ session }) => {
    await session.defaultSession.enableNetworkEmulation({ offline: true });
    // Test-only main-context guard installed before save and reopening reads.
    const net = process.getBuiltinModule('net');
    Reflect.set(globalThis, 't7NetworkAttempts', 0);
    net.Socket.prototype.connect = function () {
      Reflect.set(
        globalThis,
        't7NetworkAttempts',
        Number(Reflect.get(globalThis, 't7NetworkAttempts')) + 1,
      );
      throw Error('T7 offline');
    } as typeof net.Socket.prototype.connect;
    try {
      new net.Socket().connect({ host: '203.0.113.1', port: 443 });
    } catch {
      /* probe proves the fail-closed test guard */
    }
    if (Reflect.get(globalThis, 't7NetworkAttempts') !== 1)
      throw Error('offline guard');
    Reflect.set(globalThis, 't7NetworkAttempts', 0);
  });
}
for (const target of ['desktop', 'package'] as const)
  for (const channel of ['chrome', 'msedge'] as const) {
    test(`native_${channel}_${target}_whole_article_offline_reopen`, async () => {
      test.skip(
        process.env.WEB_PASTE_NATIVE !== '1',
        'Opt-in actual system clipboard and public fixture image',
      );
      test.setTimeout(300000);
      const evidenceBase = resolve('.tmp/web-paste-native');
      mkdirSync(evidenceBase, { recursive: true });
      const root = mkdtempSync(join(evidenceBase, `${target}-${channel}-`));
      const report: Record<string, unknown> = {
        target,
        channel,
        startedAt: new Date().toISOString(),
        status: 'PARTIAL',
      };
      const reportFile = join(root, 'evidence.json');
      let executablePath: string | undefined;
      if (target === 'desktop') {
        cpSync('.webpack/x64/main', '.webpack/main', { recursive: true });
        cpSync('.webpack/x64/renderer', '.webpack/renderer', {
          recursive: true,
        });
      }
      if (target === 'package') {
        const zipDir = resolve('out/make/zip/win32/x64');
        const zip = readdirSync(zipDir).filter((n) => n.endsWith('.zip'));
        expect(zip).toHaveLength(1);
        const extract = mkdtempSync(join(tmpdir(), 'draft-native-package-'));
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Expand-Archive -LiteralPath $env:T7_ZIP -DestinationPath $env:T7_EXTRACT',
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              T7_ZIP: join(zipDir, zip[0]),
              T7_EXTRACT: extract,
            },
          },
        );
        executablePath = join(extract, 'draft-assistant.exe');
        expect(existsSync(join(extract, 'node_modules'))).toBe(false);
        expect(
          existsSync(join(extract, 'resources/web-paste-worker.cjs')),
        ).toBe(true);
        report.zipSha256 = digest(readFileSync(join(zipDir, zip[0])));
      }
      let fragment = `<p>整篇前文 😀</p><img src="${publicImage}"><p>整篇后文</p><p>行内前<img src="${publicImage}">行内后</p>`;
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><body><article id="article">${fragment}</article></body></html>`,
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('server');
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      delete environment.ELECTRON_RUN_AS_NODE;
      const userData = join(root, 'user-data');
      mkdirSync(userData);
      const launch = () =>
        electron.launch({
          executablePath,
          cwd: executablePath ? resolve(executablePath, '..') : process.cwd(),
          args: [
            ...(executablePath ? [] : ['.']),
            `--user-data-dir=${userData}`,
          ],
          env: environment,
        });
      let application: ElectronApplication | undefined;
      const browser = await chromium.launch({
        channel,
        headless: false,
        chromiumSandbox: true,
      });
      try {
        report.browserVersion = browser.version();
        const context = await browser.newContext();
        const source = await context.newPage();
        application = await launch();
        let page = await application.firstWindow();
        report.electronVersion = await application.evaluate(
          () => process.versions.electron,
        );
        await expect
          .poll(() =>
            page.evaluate(() =>
              window.desktopApi.getAppStatus().then((s) => s.state),
            ),
          )
          .toBe('ready');
        await page
          .getByRole('button', { name: '新建文章', exact: true })
          .click();
        await expect(
          page.getByRole('button', { name: '富文本粘贴', exact: true }),
        ).toHaveAttribute('aria-pressed', 'true');
        await expect(
          page.getByRole('button', { name: '添加图片', exact: true }),
        ).toHaveCount(0);
        const clipboardEvidence: unknown[] = [];
        report.clipboard = clipboardEvidence;
        async function copyPaste(plain = false) {
          await source.goto(
            `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`,
          );
          if (!plain)
            await expect
              .poll(
                () =>
                  source.evaluate(() =>
                    Array.from(document.images).every(
                      (i) => i.complete && i.naturalWidth > 0,
                    ),
                  ),
                { timeout: 45000 },
              )
              .toBe(true);
          await source.bringToFront();
          if (plain) {
            await source.locator('textarea').focus();
            await source.keyboard.press('Control+A');
          } else
            await source.evaluate(() => {
              const range = document.createRange();
              range.selectNodeContents(document.getElementById('article')!);
              const s = getSelection()!;
              s.removeAllRanges();
              s.addRange(range);
            });
          await source.keyboard.press('Control+C');
          const formats = await application!.evaluate(async ({ clipboard }) => {
            const items = await clipboard.read();
            const formats = items.flatMap((item) => item.types);
            const htmlItem = items.find((item) =>
              item.types.includes('text/html'),
            );
            const html = htmlItem
              ? ((await htmlItem.getType('text/html')) as Blob)
              : undefined;
            return {
              formats,
              htmlBytes: html?.size ?? 0,
              plainBytes: Buffer.byteLength(await clipboard.readText()),
            };
          });
          expect(formats.plainBytes).toBeGreaterThan(0);
          if (!plain) expect(formats.htmlBytes).toBeGreaterThan(0);
          await page.evaluate(() => {
            Reflect.set(window, 't7PasteEvent', undefined);
            document.addEventListener(
              'paste',
              (event) =>
                Reflect.set(window, 't7PasteEvent', {
                  trusted: event.isTrusted,
                  types: [...(event.clipboardData?.types ?? [])],
                }),
              { once: true, capture: true },
            );
          });
          await page.bringToFront();
          const area = page.getByRole('textbox', {
            name: '粘贴整篇图文',
            exact: true,
          });
          const waitedForUi = await area.isDisabled();
          await expect(area).toBeEnabled();
          await area.focus();
          await expect(area).toBeFocused();
          const before = await snapshot(page);
          await page.keyboard.press('Control+V');
          await expect
            .poll(() => snapshot(page).then((s) => s.revision))
            .toBeGreaterThan(before.revision);
          expect(
            await page.evaluate(() => Reflect.get(window, 't7PasteEvent')),
          ).toMatchObject({ trusted: true });
          clipboardEvidence.push({
            ...formats,
            waitedForUi,
            event: await page.evaluate(() =>
              Reflect.get(window, 't7PasteEvent'),
            ),
          });
          return settle(page);
        }
        let s = await copyPaste();
        expect(s.pasteSummary?.outcome).toBe('completed');
        expect(
          s.draft.blocks.map((b) => (b.type === 'paragraph' ? b.text : b.type)),
        ).toEqual([
          '整篇前文 😀',
          'image',
          '整篇后文',
          '行内前',
          'image',
          '行内后',
        ]);
        expect(s.images).toHaveLength(2);
        expect(new Set(s.images.map((i) => i.imageToken)).size).toBe(2);
        const ready: {
          token: string;
          mime: string;
          byteSize: number;
          sha256: string;
          width: number;
          height: number;
        }[] = [];
        for (const image of s.images) {
          const bytes = await page.evaluate(
            async ({ sessionId, token }) => {
              const result = await window.desktopApi.getManualImage(
                sessionId,
                token,
              );
              if (result.status !== 'ok') throw Error('ready bytes');
              return Array.from(result.bytes);
            },
            { sessionId: s.sessionId, token: image.imageToken },
          );
          expect(bytes.length).toBe(image.byteSize);
          expect(image.byteSize).toBeGreaterThan(0);
          ready.push({
            token: image.imageToken,
            mime: image.mime,
            byteSize: bytes.length,
            sha256: digest(Uint8Array.from(bytes)),
            width: image.width,
            height: image.height,
          });
          expect(
            await page.evaluate(
              ({ sessionId, token }) =>
                window.desktopApi.getManualImage(sessionId, token),
              { sessionId: randomUUID(), token: image.imageToken },
            ),
          ).toMatchObject({ status: 'not_found' });
        }
        const readyTokens = s.draft.blocks.flatMap((block) =>
          block.type === 'image' ? [block.imageToken] : [],
        );
        expect(ready.map((image) => image.token)).toEqual(readyTokens);
        report.wholeArticle = {
          sequence: s.draft.blocks.map((b) => b.type),
          sessionBound: true,
          ready,
        };
        // Native second copy appends to the exact same draft, including repeated source positions.
        fragment = '<p>第二次追加</p>';
        s = await copyPaste();
        expect(s.draft.blocks.at(-1)).toMatchObject({
          type: 'paragraph',
          text: '第二次追加',
        });
        expect(s.draft.blocks).toHaveLength(7);
        await page
          .getByLabel('文章标题', { exact: true })
          .fill(`Native ${channel} ${target}`);
        await page
          .getByLabel('文章声明', { exact: true })
          .selectOption('original');
        await expect(
          page.getByRole('status').filter({ hasText: '输入已同步' }),
        ).toBeVisible();
        await offline(application);
        await page
          .getByRole('button', { name: '保存到文章池', exact: true })
          .click();
        await expect(
          page.getByRole('heading', {
            name: `Native ${channel} ${target}`,
            exact: true,
          }),
        ).toBeVisible();
        const repository = openArticleRepository(
          join(userData, 'data/app.sqlite'),
          resolve('src/infrastructure/persistence/migrations'),
        );
        let key: string;
        let expectedAssets: StoredAsset[] = [];
        try {
          const listed = repository.list!();
          if (listed.status !== 'ok') throw new Error('Library unavailable');
          const summaries = listed.page.items;
          expect(summaries).toHaveLength(1);
          key = summaries[0].articleKey;
          const article = repository.load(key)!;
          expect(article.body.map((b) => b.type)).toEqual([
            'paragraph',
            'image',
            'paragraph',
            'paragraph',
            'image',
            'paragraph',
            'paragraph',
          ]);
          expect(
            article.body.filter((block) => block.type === 'paragraph'),
          ).toEqual([
            { type: 'paragraph', text: '整篇前文 😀' },
            { type: 'paragraph', text: '整篇后文' },
            { type: 'paragraph', text: '行内前' },
            { type: 'paragraph', text: '行内后' },
            { type: 'paragraph', text: '第二次追加' },
          ]);
          expect(article.contentDeclaration).toBe('original');
          expect(article.assets).toHaveLength(2);
          expect(
            article.body
              .filter((block) => block.type === 'image')
              .map((block) => block.image_id),
          ).toEqual(readyTokens);
          expect(article.assets.map((asset) => asset.imageId)).toEqual(
            readyTokens,
          );
          expect(
            new Set(article.assets.map((asset) => asset.assetKey)).size,
          ).toBe(2);
          expect(
            new Set(article.assets.map((asset) => asset.relativePath)).size,
          ).toBe(2);
          const formal = article.assets.map((asset, index) => {
            const expected = ready[index];
            expect(asset).toMatchObject({
              imageId: expected.token,
              mime: expected.mime,
              byteSize: expected.byteSize,
              sha256: expected.sha256,
              width: expected.width,
              height: expected.height,
            });
            expect(asset.relativePath).not.toContain('manual-temp');
            const bytes = readFileSync(
              join(userData, 'assets', asset.relativePath),
            );
            expect(bytes.length).toBe(asset.byteSize);
            expect(digest(bytes)).toBe(asset.sha256);
            return { ...asset };
          });
          expectedAssets = formal;
          report.persistence = {
            articleKey: key,
            body: article.body,
            sequence: article.body.map((b) => b.type),
            assets: formal,
          };
        } finally {
          repository.close();
        }
        expect(
          await application.evaluate(() =>
            Reflect.get(globalThis, 't7NetworkAttempts'),
          ),
        ).toBe(0);
        await page.screenshot({
          path: join(root, 'saved.png'),
          fullPage: true,
        });
        await application.close();
        application = await launch();
        await offline(application);
        page = await application.firstWindow();
        await expect
          .poll(() =>
            page.evaluate(() =>
              window.desktopApi.getAppStatus().then((s) => s.state),
            ),
          )
          .toBe('ready');
        expect(await snapshot(page)).toMatchObject({ state: 'idle' });
        const preview = await page.evaluate(
          (key) => window.desktopApi.getArticlePreview(key),
          key!,
        );
        if (preview.status !== 'ok') throw Error('reopen');
        expect(preview.article.body).toHaveLength(7);
        expect(
          preview.article.body.filter((block) => block.type === 'paragraph'),
        ).toEqual([
          { type: 'paragraph', text: '整篇前文 😀' },
          { type: 'paragraph', text: '整篇后文' },
          { type: 'paragraph', text: '行内前' },
          { type: 'paragraph', text: '行内后' },
          { type: 'paragraph', text: '第二次追加' },
        ]);
        expect(
          preview.article.body
            .filter((block) => block.type === 'image')
            .map((block) => block.image_id),
        ).toEqual(readyTokens);
        expect(preview.article.assets).toEqual(
          expectedAssets.map(({ assetKey, imageId, mime, width, height }) => ({
            assetKey,
            imageId,
            mime,
            width,
            height,
          })),
        );
        const reopenedRepository = openArticleRepository(
          join(userData, 'data/app.sqlite'),
          resolve('src/infrastructure/persistence/migrations'),
        );
        try {
          expect(reopenedRepository.load(key!)!.assets).toEqual(expectedAssets);
        } finally {
          reopenedRepository.close();
        }
        const reopenedAssets: StoredAsset[] = [];
        for (const [index, asset] of preview.article.assets.entries()) {
          const bytes = await page.evaluate(
            async ({ key, asset }) => {
              const r = await window.desktopApi.getArticleImage(key, asset);
              if (r.status !== 'ok') throw Error('offline image');
              return Array.from(r.bytes);
            },
            { key: key!, asset: asset.assetKey },
          );
          const expected = expectedAssets[index];
          expect(asset.imageId).toBe(readyTokens[index]);
          expect(bytes.length).toBe(expected.byteSize);
          expect(digest(Uint8Array.from(bytes))).toBe(expected.sha256);
          expect(
            digest(
              readFileSync(join(userData, 'assets', expected.relativePath)),
            ),
          ).toBe(expected.sha256);
          reopenedAssets.push({ ...expected });
        }
        expect(
          await application.evaluate(() =>
            Reflect.get(globalThis, 't7NetworkAttempts'),
          ),
        ).toBe(0);
        await page
          .getByRole('button', {
            name: new RegExp(`Native ${channel} ${target}`),
          })
          .click();
        await expect(
          page.getByRole('img', { name: '第 1 张图片', exact: true }),
        ).toBeVisible();
        await page
          .getByRole('button', { name: '查看第 2 张图片', exact: true })
          .click();
        await expect(
          page.getByRole('img', { name: '第 2 张图片', exact: true }),
        ).toBeVisible();
        expect(
          await page
            .getByRole('img')
            .evaluate((img) => (img as HTMLImageElement).naturalWidth),
        ).toBeGreaterThan(0);
        await page.screenshot({
          path: join(root, 'offline-reopen.png'),
          fullPage: true,
        });
        expect(
          await application.evaluate(() =>
            Reflect.get(globalThis, 't7NetworkAttempts'),
          ),
        ).toBe(0);
        report.offlineReopen = {
          images: 2,
          networkAttempts: 0,
          assets: reopenedAssets,
          imageIds: readyTokens,
          visiblePreview: true,
        };
        await page
          .getByRole('button', { name: '新建文章', exact: true })
          .click();
        fragment = '<textarea>纯文原生复制\n\n第二段</textarea>';
        s = await copyPaste(true);
        expect(s.pasteSummary?.plainOnly).toBe(true);
        expect(
          s.draft.blocks.map((b) => (b.type === 'paragraph' ? b.text : b.type)),
        ).toEqual(['纯文原生复制', '第二段']);
        // App transport is offline; browser still copies an actually loaded public image.
        fragment = `<p>失败前</p><img src="${publicImage}"><p>失败后</p>`;
        s = await copyPaste();
        expect(s.pasteSummary?.outcome).toBe('partial');
        expect(s.candidates).toHaveLength(1);
        await expect(
          page.getByRole('button', { name: '保存到文章池', exact: true }),
        ).toBeDisabled();
        expect(s.draft.blocks.map((b) => b.type)).toEqual([
          'paragraph',
          'paragraph',
          'paragraph',
          'image-pending',
          'paragraph',
        ]);
        const beforeSwitch = await snapshot(page);
        await page
          .getByRole('button', { name: '手动录入', exact: true })
          .click();
        await page
          .getByRole('button', { name: '富文本粘贴', exact: true })
          .click();
        expect(await snapshot(page)).toEqual(beforeSwitch);
        report.failure = {
          retainedPositions: true,
          saveBlocked: true,
          reason: s.candidates[0].reason,
        };
        report.clipboard = clipboardEvidence;
        report.status = 'PASS';
        report.completedAt = new Date().toISOString();
        await application.evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({
            response: 1,
            checkboxChecked: false,
          });
        });
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        writeFileSync(reportFile, JSON.stringify(report, null, 2));
        await application
          ?.evaluate(({ dialog }) => {
            dialog.showMessageBox = async () => ({
              response: 1,
              checkboxChecked: false,
            });
          })
          .catch(() => {});
        await application?.close();
        await browser.close();
        server.close();
      }
    });
  }
