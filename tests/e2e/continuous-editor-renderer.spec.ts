import { installCoverBridge } from './cover-renderer-fixture';
import { test, expect, type Page } from '@playwright/test';
import webpack from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ManualDraft } from '../../src/contracts/manual-article';
import type {
  DocumentCommand,
  DraftRange,
} from '../../src/contracts/manual-edit';
test.beforeAll(async () => {
  await new Promise<void>((done, reject) =>
    webpack(
      {
        mode: 'development',
        entry: resolve('src/renderer/main.tsx'),
        output: {
          path: resolve('.tmp/continuous-renderer'),
          filename: 'app.js',
        },
        module: {
          rules: [
            {
              test: /\.tsx?$/,
              loader: 'ts-loader',
              options: {
                transpileOnly: true,
                compilerOptions: { noEmit: false },
              },
            },
            {
              test: /\.css$/,
              use: [MiniCssExtractPlugin.loader, 'css-loader'],
            },
          ],
        },
        plugins: [new MiniCssExtractPlugin({ filename: 'app.css' })],
        resolve: { extensions: ['.tsx', '.ts', '.js'] },
        devtool: false,
      },
      (error, stats) =>
        error || stats?.hasErrors()
          ? reject(error ?? Error(stats?.toString()))
          : done(),
    ),
  );
});
const rendererErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  rendererErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(rendererErrors.get(page), 'uncaught renderer errors').toEqual([]);
});
async function mount(page: Page, scenario = 'normal') {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !== 'http://localhost' ||
      !['/', '/app.js', '/app.css'].includes(url.pathname)
    )
      return route.abort();
    await route.fulfill(
      url.pathname === '/'
        ? {
            contentType: 'text/html; charset=utf-8',
            body: '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
          }
        : {
            contentType: url.pathname.endsWith('js')
              ? 'text/javascript'
              : 'text/css',
            body: readFileSync(
              resolve('.tmp/continuous-renderer', url.pathname.slice(1)),
            ),
          },
    );
  });
  await page.addInitScript(
    ({ scenario }) => {
      const id = '11111111-1111-4111-8111-111111111111';
      const imageKey = '22222222-2222-4222-8222-222222222222';
      const lastKey = '33333333-3333-4333-8333-333333333333';
      let state = JSON.parse(
        sessionStorage.getItem('manual') ?? '{"state":"idle","revision":0}',
      );
      let closeListener: ((r: { requestId: string }) => void) | undefined;
      let calls = 0;
      const log = (name: string, value: unknown) => {
        const logs = JSON.parse(sessionStorage.getItem(name) ?? '[]');
        logs.push(value);
        sessionStorage.setItem(name, JSON.stringify(logs));
      };
      const remember = () => {
        sessionStorage.setItem('manual', JSON.stringify(state));
        return structuredClone(state);
      };
      const reply = (status = 'ok') => ({ status, snapshot: remember() });
      const ticket = (c: DocumentCommand) => {
        log('commands', c);
        if (
          c.clientSequence !== state.nextClientSequence ||
          c.commandId !== state.nextEditCommandId ||
          c.expectedDocumentRevision !== state.documentRevision
        )
          throw Error('wrong ticket');
        state.nextClientSequence++;
        state.nextEditCommandId = crypto.randomUUID();
      };
      const confirm = (c: DocumentCommand, draft: ManualDraft) => {
        state = {
          ...state,
          draft,
          revision: state.revision + 1,
          documentRevision: state.documentRevision + 1,
          acknowledgedEdit: {
            clientSequence: c.clientSequence,
            commandId: c.commandId,
          },
          dirty: true,
          issues: undefined,
          result: undefined,
          saveOutcome: undefined,
        };
        return reply();
      };
      const base = () => ({
        state: 'editing',
        revision: state.revision + 1,
        sessionId: id,
        nextPasteCommandId: crypto.randomUUID(),
        nextEditCommandId: crypto.randomUUID(),
        nextClientSequence: 7,
        nextSaveOperationId: crypto.randomUUID(),
        target: { kind: 'new' },
        documentRevision: 0,
        acknowledgedEdit: null,
        externalId: 'manual-' + id,
        dirty: false,
        candidates: [],
        images: [],
        draft: {
          title: '',
          contentDeclaration: 'repost',
          blocks: [{ type: 'paragraph', blockKey: id, text: '' }],
        },
      });
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
        ),
        (c) => c.charCodeAt(0),
      );
      const image = (key = imageKey) => ({
        imageToken: key,
        mime: 'image/png',
        width: 1,
        height: 1,
        byteSize: png.length,
      });
      Object.assign(window, {
        fixtureClose: () => closeListener?.({ requestId: lastKey }),
        fixturePatch: (patch: Record<string, unknown>) => {
          state = { ...state, ...patch, revision: state.revision + 1 };
          remember();
        },
        fixtureRead: () => remember(),
      });
      if (
        scenario === 'existing' ||
        scenario === 'held-focus' ||
        scenario === 'images' ||
        scenario === 'late-image' ||
        scenario === 'bytes' ||
        scenario === 'pixels' ||
        scenario === 'pending' ||
        scenario === 'stopping-image' ||
        scenario === 'busy-image'
      ) {
        state = base();
        state.target = {
          kind: 'existing',
          articleKey: id,
          externalId: 'manual-' + id,
          importId: id,
          baseArticleRevision: 1,
        };
        state.draft.title = '已保存文章';
        state.draft.blocks = [
          { type: 'paragraph', blockKey: id, text: '前文😀' },
          { type: 'image', blockKey: imageKey, imageToken: imageKey },
          { type: 'paragraph', blockKey: lastKey, text: '后文' },
        ];
        state.images = [image()];
        if (scenario === 'held-focus') {
          state.draft.blocks[0].text = 'Alpha paragraph';
          state.draft.blocks[2].text = 'Omega paragraph';
        }
        if (scenario === 'images') {
          state.draft.blocks = Array.from({ length: 12 }, () => ({
            type: 'image',
            blockKey: crypto.randomUUID(),
            imageToken: crypto.randomUUID(),
          }));
          state.images = state.draft.blocks.map((b: { imageToken: string }) =>
            image(b.imageToken),
          );
        }
        if (scenario === 'bytes' || scenario === 'pixels') {
          state.draft.blocks = Array.from({ length: 6 }, () => ({
            type: 'image',
            blockKey: crypto.randomUUID(),
            imageToken: crypto.randomUUID(),
          }));
          state.images = state.draft.blocks.map(
            (b: { imageToken: string }) => ({
              ...image(b.imageToken),
              width: scenario === 'pixels' ? 5000 : 1,
              height: scenario === 'pixels' ? 5000 : 1,
              byteSize: scenario === 'bytes' ? 8 * 1024 * 1024 : png.length,
            }),
          );
        }
        if (scenario === 'pending' || scenario === 'stopping-image') {
          state.draft.blocks[1] = {
            type: 'image-pending',
            blockKey: imageKey,
            candidateId: imageKey,
          };
          state.images = [];
          state.candidates = [
            {
              candidateId: imageKey,
              blockKey: imageKey,
              state: scenario === 'stopping-image' ? 'fetching' : 'failed',
              retryable: scenario !== 'stopping-image',
              reason:
                scenario === 'stopping-image' ? undefined : 'IMAGE_NETWORK',
            },
          ];
          if (scenario === 'stopping-image') {
            state.dirty = true; // Canonical paste has already admitted new positions.
            state.state = 'pasting';
            state.jobId = lastKey;
            state.operationKind = 'paste';
            state.pasteProgress = {
              jobId: lastKey,
              kind: 'paste',
              phase: 'images',
              admitted: true,
              current: 1,
              total: 1,
            };
          }
          Object.assign(window, {
            fixtureReady: () => {
              state = {
                ...state,
                revision: state.revision + 1,
                images: [image()],
                candidates: [],
                draft: {
                  ...state.draft,
                  blocks: state.draft.blocks.map((b: { type: string }) =>
                    b.type === 'image-pending'
                      ? {
                          type: 'image',
                          blockKey: imageKey,
                          imageToken: imageKey,
                        }
                      : b,
                  ),
                },
              };
              remember();
            },
          });
        }
        remember();
      }
      const api = {
        getAppStatus: async () => ({
          state: 'ready',
          appVersion: '1',
          schemaVersion: 14,
        }),
        getImportStatus: async () => ({ state: 'idle', revision: 0 }),
        getDraftState: async () => ({
          session: {
            status: 'closed',
            bindingToken: null,
            storeName: null,
            reason: null,
          },
          preparation: null,
          task: null,
        }),
        listArticles: async () => ({
          status: 'ok',
          page: {
            items: [],
            totalCount: 0,
            membershipRevision: 0,
            pageNumber: 1,
            totalPages: 1,
          },
        }),
        getArticleDeclarations: async () => ({ status: 'ok', items: [] }),
        setArticleDeclarations: async () => ({ status: 'unavailable' }),
        startArticleImport: async () => ({ status: 'unavailable' }),
        cancelArticleImport: async () => ({ state: 'idle', revision: 0 }),
        getArticlePreview: async () => ({ status: 'not_found' }),
        getArticleImage: async () => ({ status: 'not_found' }),
        getManualArticleState: async () => remember(),
        beginManualArticle: async () => {
          state = base();
          return reply();
        },
        // Legacy fixture lets RED reach the old UI, but any GREEN use fails.
        updateManualDraft: async (
          _s: string,
          _r: number,
          draft: ManualDraft,
        ) => {
          log('legacy', true);
          state.draft = draft;
          return reply();
        },
        applyManualEdit: async (c: DocumentCommand, draft: ManualDraft) => {
          log('edits', draft);
          ticket(c);
          calls++;
          if (scenario === 'slow') await new Promise((r) => setTimeout(r, 400));
          if (scenario === 'sync-failure' && calls === 1)
            throw Error('transport');
          if (scenario === 'invalid-sync') return reply('invalid');
          const answer = confirm(c, draft);
          if (scenario === 'lost-edit' && calls === 1) throw Error('lost');
          return answer;
        },
        spliceManualPaste: async (
          c: DocumentCommand,
          range: DraftRange,
          input: {
            html?: string;
            plain?: string;
            kind?: string;
            grantId?: string;
          },
        ) => {
          ticket(c);
          log('pastes', { range, input });
          if (scenario === 'held-focus')
            await new Promise<void>((release) =>
              Object.assign(window, { releaseOperation: release }),
            );
          if (scenario === 'rejected' || input.kind === 'internal')
            return reply('invalid');
          if (scenario === 'cancelled') {
            state = {
              ...state,
              state: 'pasting',
              jobId: lastKey,
              operationKind: 'paste',
              revision: state.revision + 1,
            };
            return reply('started');
          }
          const blocks = state.draft.blocks as ManualDraft['blocks'];
          const ai = blocks.findIndex(
              (b) => b.blockKey === range.anchor.blockKey,
            ),
            hi = blocks.findIndex((b) => b.blockKey === range.head.blockKey);
          const a = blocks[ai],
            h = blocks[hi];
          const prefix =
            a?.type === 'paragraph' && range.anchor.kind === 'text'
              ? a.text.slice(0, range.anchor.offset)
              : '';
          const suffix =
            h?.type === 'paragraph' && range.head.kind === 'text'
              ? h.text.slice(range.head.offset)
              : '';
          const replacement = [
            {
              type: 'paragraph' as const,
              blockKey:
                a?.type === 'paragraph' && range.anchor.kind === 'text'
                  ? a.blockKey
                  : crypto.randomUUID(),
              text: prefix + (input.plain ?? '') + suffix,
            },
          ];
          const draft = {
            ...state.draft,
            blocks: [
              ...blocks.slice(0, ai),
              ...replacement,
              ...blocks.slice(hi + 1),
            ],
          };
          return confirm(c, draft);
        },
        insertManualImage: async (c: DocumentCommand, range: DraftRange) => {
          ticket(c);
          log('pickers', range);
          if (scenario === 'cancel-picker') return reply();
          state.images.push(image());
          const blocks = state.draft.blocks;
          const index = blocks.findIndex(
            (b: { blockKey: string }) => b.blockKey === range.head.blockKey,
          );
          return confirm(c, {
            ...state.draft,
            blocks: [
              ...blocks.slice(0, index + 1),
              { type: 'image', blockKey: imageKey, imageToken: imageKey },
              ...blocks.slice(index + 1),
            ],
          });
        },
        retryManualPasteImage: async (
          retryCommand: {
            sessionId: string;
            expectedRevision: number;
            commandId: string;
          },
          candidateId: string,
        ) => {
          if (scenario === 'stopping-image') {
            if (
              retryCommand.sessionId !== state.sessionId ||
              retryCommand.expectedRevision !== state.revision ||
              retryCommand.commandId !== state.nextPasteCommandId
            )
              throw Error('wrong retry ticket');
            Reflect.get(window, 'fixtureReady')();
          }
          log('retries', candidateId);
          if (scenario === 'lost-retry') {
            Reflect.get(window, 'fixtureReady')();
            throw Error('lost retry');
          }
          return reply();
        },
        cancelManualOperation: async () => {
          if (scenario === 'stopping-image') {
            state.candidates[0] = {
              ...state.candidates[0],
              state: 'cancelled',
              retryable: true,
              reason: 'CANCELLED',
            };
            delete state.pasteProgress;
          }
          state = {
            ...state,
            state: 'editing',
            jobId: undefined,
            operationKind: undefined,
            revision: state.revision + 1,
            result: { status: 'cancelled' },
          };
          return reply();
        },
        commitManualDocument: async (c: {
          operationId: string;
          expectedDocumentRevision: number;
        }) => {
          log('saves', c);
          if (scenario === 'save-unknown') throw Error('unknown commit');
          if (scenario === 'cleanup') {
            state = {
              ...state,
              saveOutcome: {
                kind: 'created',
                articleKey: id,
                articleRevision: 1,
                operationId: c.operationId,
              },
              dirty: false,
              result: {
                status: 'failed',
                code: 'RECOVERY_REQUIRED',
                message: '文章已保存到本机，清理状态需要核对。',
              },
              issues: [{ message: '请关闭应用后核对' }],
            };
            return reply('unavailable');
          }
          if (c.expectedDocumentRevision !== state.documentRevision)
            throw Error('stale save');
          if (
            !state.draft.title.trim() ||
            state.draft.title !== state.draft.title.trim()
          ) {
            state.issues = [{ message: '请填写有效标题，保留原输入供修改。' }];
            state.nextSaveOperationId = crypto.randomUUID();
            return reply('invalid');
          }
          if (scenario === 'saving') {
            state = {
              ...state,
              state: 'saving',
              jobId: lastKey,
              operationKind: 'save',
              revision: state.revision + 1,
            };
            return reply('started');
          }
          state = {
            ...state,
            dirty: false,
            revision: state.revision + 1,
            target: {
              kind: 'existing',
              articleKey: id,
              externalId: state.externalId,
              importId: id,
              baseArticleRevision: 2,
            },
            saveOutcome: {
              kind: 'created',
              articleKey: id,
              articleRevision: 2,
              operationId: c.operationId,
            },
            nextSaveOperationId: crypto.randomUUID(),
          };
          const answer = reply();
          if (scenario === 'lost-save') throw Error('lost');
          return answer;
        },
        getManualSaveResult: async (_s: string, operationId: string) => {
          log('lookups', operationId);
          if (scenario === 'save-unknown')
            return { status: 'needs_review', operationId };
          return { status: 'committed', receipt: { operationId } };
        },
        closeManualEditor: async (c: DocumentCommand, choice: string) => {
          ticket(c);
          log('closes', choice);
          if (choice === 'discard')
            state = { state: 'idle', revision: state.revision + 1 };
          return reply();
        },
        copyManualSelection: async (
          c: DocumentCommand,
          range: DraftRange,
          cut: boolean,
        ) => {
          ticket(c);
          log('copies', { range, cut });
          if (scenario === 'held-focus')
            await new Promise<void>((release) =>
              Object.assign(window, { releaseOperation: release }),
            );
          return reply();
        },
        onManualCloseRequest: (listener: typeof closeListener) => {
          closeListener = listener;
          return () => {
            closeListener = undefined;
          };
        },
        respondManualClose: async (
          requestId: string,
          sessionId: string,
          documentRevision: number,
          status: string,
        ) => {
          log('closeResponses', {
            requestId,
            sessionId,
            documentRevision,
            status,
          });
          return reply();
        },
        getManualImage: async (_s: string, token: string) => {
          log('reads', token);
          if (scenario === 'late-image')
            await new Promise<void>((r) =>
              Object.assign(window, { releaseImage: r }),
            );
          if (
            scenario === 'busy-image' &&
            JSON.parse(sessionStorage.getItem('reads') ?? '[]').length === 1
          )
            return { status: 'busy' };
          const metadata = state.images.find(
            (i: { imageToken: string }) => i.imageToken === token,
          );
          const bytes = new Uint8Array(metadata?.byteSize ?? png.length);
          bytes.set(png);
          Object.assign(window, {
            lastReadPixels: (metadata?.width ?? 1) * (metadata?.height ?? 1),
          });
          return { status: 'ok', mime: 'image/png', bytes };
        },
      };
      Object.assign(window, { desktopApi: api });
      const create = URL.createObjectURL.bind(URL),
        revoke = URL.revokeObjectURL.bind(URL);
      let active = 0,
        max = 0,
        activeBytes = 0,
        maxBytes = 0,
        activePixels = 0,
        maxPixels = 0;
      const leases = new Map<string, { bytes: number; pixels: number }>();
      URL.createObjectURL = (b) => {
        if (!(b instanceof Blob)) throw Error('Editor previews must be Blobs');
        active++;
        max = Math.max(max, active);
        activeBytes += b.size;
        activePixels += Number(Reflect.get(window, 'lastReadPixels') ?? 1);
        maxBytes = Math.max(maxBytes, activeBytes);
        maxPixels = Math.max(maxPixels, activePixels);
        const url = create(b);
        leases.set(url, {
          bytes: b.size,
          pixels: Number(Reflect.get(window, 'lastReadPixels') ?? 1),
        });
        Object.assign(window, {
          blobActive: active,
          blobMax: max,
          blobBytes: activeBytes,
          blobMaxBytes: maxBytes,
          blobPixels: activePixels,
          blobMaxPixels: maxPixels,
        });
        return url;
      };
      URL.revokeObjectURL = (u) => {
        active--;
        const lease = leases.get(u)!;
        activeBytes -= lease.bytes;
        activePixels -= lease.pixels;
        leases.delete(u);
        Object.assign(window, { blobActive: active });
        revoke(u);
      };
    },
    { scenario },
  );
  await installCoverBridge(page);
  await page.goto('http://localhost/');
  if (
    ![
      'existing',
      'held-focus',
      'images',
      'late-image',
      'bytes',
      'pixels',
      'pending',
      'stopping-image',
      'busy-image',
    ].includes(scenario)
  )
    await page.getByRole('button', { name: '新建文章', exact: true }).click();
}
async function logs(page: Page, name: string) {
  return page.evaluate(
    (name) => JSON.parse(sessionStorage.getItem(name) ?? '[]'),
    name,
  );
}
async function paste(page: Page, plain: string, html = '') {
  await page.getByRole('textbox', { name: '文章正文', exact: true }).evaluate(
    (el, { plain, html }) => {
      const data = new DataTransfer();
      data.setData('text/plain', plain);
      data.setData('text/html', html);
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { plain, html },
  );
}

test('same_editor_new_and_existing and untouched new session remains clean', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文' });
  await expect(body).toBeEditable();
  await expect(page.getByRole('button', { name: /上移|下移/ })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '保存到文章池', exact: true }),
  ).toBeDisabled();
  expect(await logs(page, 'edits')).toHaveLength(0);
  await body.pressSequentially('自然正文😀');
  await page.getByLabel('文章标题', { exact: true }).fill('标题');
  await page.getByRole('button', { name: '保存到文章池', exact: true }).click();
  await expect(page.getByText('已保存到文章池', { exact: true })).toBeVisible();
  await expect(body).toBeEditable();
  await body.pressSequentially('修改');
  await expect(body).toContainText('自然正文😀修改');
  expect(await logs(page, 'legacy')).toHaveLength(0);
});
test('late_ack_preserves_selection and exact issued sequence after rejection', async ({
  page,
}) => {
  await mount(page, 'slow');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('旧');
  await expect.poll(async () => (await logs(page, 'edits')).length).toBe(1);
  await body.pressSequentially('新😀');
  const before = await page.evaluate(() => ({
    offset: getSelection()?.anchorOffset,
    text: getSelection()?.anchorNode?.textContent,
  }));
  await expect(page.getByText('输入已同步', { exact: true })).toBeVisible();
  const after = await page.evaluate(() => ({
    offset: getSelection()?.anchorOffset,
    text: getSelection()?.anchorNode?.textContent,
  }));
  expect(after).toEqual(before);
  await expect(body).toContainText('旧新😀');
  expect(
    (await logs(page, 'commands')).map(
      (c: DocumentCommand) => c.clientSequence,
    ),
  ).toEqual([7, 8]);
});
test('composition_and_emoji_roundtrip plus title composition flush on native close request', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.dispatchEvent('compositionstart');
  await body.pressSequentially('校对😀中文');
  await page.waitForTimeout(150);
  expect(await logs(page, 'edits')).toHaveLength(0);
  await body.dispatchEvent('compositionend');
  await expect(page.getByText('输入已同步', { exact: true })).toBeVisible();
  await expect(body).toHaveText('校对😀中文');
  const title = page.getByLabel('文章标题', { exact: true });
  await title.dispatchEvent('compositionstart');
  await title.fill('拼音');
  await page.evaluate(() => Reflect.get(window, 'fixtureClose')());
  await page.waitForTimeout(150);
  expect(await logs(page, 'closeResponses')).toHaveLength(0);
  await title.fill('中文标题');
  await title.dispatchEvent('compositionend');
  await expect
    .poll(async () => (await logs(page, 'closeResponses')).length)
    .toBe(1);
  expect((await logs(page, 'edits')).at(-1).title).toBe('中文标题');
  expect((await logs(page, 'closeResponses'))[0].status).toBe('flushed');
});
test('middle_splice_across_image preserves main range and one undo history event', async ({
  page,
}) => {
  await mount(page, 'existing');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+Shift+End');
  await paste(page, '替换');
  await expect(body).toContainText('前替换');
  expect((await logs(page, 'pastes'))[0].range.anchor.offset).toBe(1);
  await body.press('Control+z');
  await expect(body).toContainText('前文😀');
  await expect(body).toContainText('后文');
  await expect(page.getByRole('img')).toHaveCount(1);
});
test('undo_image_after_save and mode_switch_preserves_doc', async ({
  page,
}) => {
  await mount(page, 'existing');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.click();
  await body.press('Control+Home');
  await body.press('Control+Shift+End');
  await body.press('Backspace');
  await body.pressSequentially('删图后正文');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(
    page.getByText('文章已保存到本机', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '手动录入', exact: true }).click();
  await expect(body).toContainText('删图后正文');
  await page.getByRole('button', { name: '富文本粘贴', exact: true }).click();
  await body.press('Control+z');
  await expect(page.getByRole('img')).toHaveCount(1);
  await expect(body).toContainText('前文😀');
});
test('rejected paste preserves selection and next command uses exact new floor', async ({
  page,
}) => {
  await mount(page, 'rejected');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('保留');
  await body.press('Control+a');
  await paste(page, '拒绝');
  await expect(page.getByRole('alert')).toContainText('粘贴');
  await expect(body).toContainText('保留');
  await body.press('ArrowRight');
  await body.pressSequentially('后续');
  await expect(page.getByText('输入已同步', { exact: true })).toBeVisible();
  expect(
    (await logs(page, 'commands')).map(
      (c: DocumentCommand) => c.clientSequence,
    ),
  ).toEqual([7, 8, 9]);
});
test('800x600_keyboard_reachable and dirty discard dialog', async ({
  page,
}) => {
  await mount(page);
  await page.setViewportSize({ width: 800, height: 600 });
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('键盘正文');
  await page.getByRole('button', { name: '手动录入', exact: true }).click();
  await page.getByRole('button', { name: '添加图片', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: '保存到文章池', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: '放弃录入', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('dialog').getByRole('button', {
      name: /停止所有未完成操作|停止并初始化/,
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('button', { name: '放弃修改', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(body).toContainText('键盘正文');
  const textBounds = await body.locator('p').first().boundingBox();
  const saveBounds = await page
    .getByRole('button', { name: '保存到文章池', exact: true })
    .boundingBox();
  expect(saveBounds!.y).toBeGreaterThanOrEqual(
    textBounds!.y + textBounds!.height,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve('.tmp/continuous-editor-800.png'),
    fullPage: true,
  });
});

test('ready_patch_keeps_history and retained key restores a ready image after undo', async ({
  page,
}) => {
  await mount(page, 'pending');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.click();
  await body.press('Control+End');
  await body.pressSequentially('校对');
  await expect(page.getByText('输入已同步', { exact: true })).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'fixtureReady')());
  await expect(page.getByRole('img')).toHaveCount(1);
  await body.press('Control+z');
  await expect(body).toContainText('后文');
  await expect(body).not.toContainText('校对');
  await expect(page.getByRole('img')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: '保存修改', exact: true }),
  ).toBeEnabled();
});
test('visible_images_release_late_blobs and queued lightweight images load automatically', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await mount(page, 'images');
  await page.addStyleTag({
    content: '.inline-article-image{max-height:30px;min-height:30px}',
  });
  await expect
    .poll(async () => new Set(await logs(page, 'reads')).size, {
      timeout: 10000,
    })
    .toBe(12);
  expect(
    await page.evaluate(() => Reflect.get(window, 'blobMax')),
  ).toBeLessThanOrEqual(8);
  expect(
    await page.evaluate(() => Reflect.get(window, 'blobActive')),
  ).toBeGreaterThan(0);
  await page.getByRole('button', { name: '结束编辑', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'blobActive')))
    .toBe(0);
});
for (const scenario of ['bytes', 'pixels'])
  test(`preview ${scenario} reservation ceiling is enforced while visible items rotate`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1200 });
    await mount(page, scenario);
    await page.addStyleTag({
      content: '.inline-article-image{max-height:70px;min-height:70px}',
    });
    await expect
      .poll(async () => new Set(await logs(page, 'reads')).size, {
        timeout: 10000,
      })
      .toBe(6);
    expect(
      await page.evaluate(() => Reflect.get(window, 'blobMaxBytes')),
    ).toBeLessThanOrEqual(40 * 1024 * 1024);
    expect(
      await page.evaluate(() => Reflect.get(window, 'blobMaxPixels')),
    ).toBeLessThanOrEqual(50_000_000);
    if (scenario === 'bytes')
      expect(
        await page.evaluate(() => Reflect.get(window, 'blobMax')),
      ).toBeLessThanOrEqual(5);
    else
      expect(
        await page.evaluate(() => Reflect.get(window, 'blobMax')),
      ).toBeLessThanOrEqual(2);
  });
test('late image response after session close never creates an obsolete Blob', async ({
  page,
}) => {
  await mount(page, 'late-image');
  await expect.poll(async () => (await logs(page, 'reads')).length).toBe(1);
  await page.getByRole('button', { name: '结束编辑', exact: true }).click();
  await expect(page.getByText('还没有文章', { exact: true })).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'releaseImage')());
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => Reflect.get(window, 'blobActive') ?? 0),
  ).toBe(0);
});
test('Enter, soft break and emoji keyboard edits roundtrip through main without duplicate keys', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('第一😀');
  await body.press('Shift+Enter');
  await body.pressSequentially('软换行');
  await body.press('Enter');
  await body.pressSequentially('第二');
  await expect(page.getByText('输入已同步', { exact: true })).toBeVisible();
  const last = (await logs(page, 'edits')).at(-1);
  expect(last.blocks.map((b: { text: string }) => b.text)).toEqual([
    '第一😀\n软换行',
    '第二',
  ]);
  expect(
    new Set(last.blocks.map((b: { blockKey: string }) => b.blockKey)).size,
  ).toBe(2);
  await page.reload();
  await expect(body).toContainText('第一😀');
  await expect(body).toContainText('第二');
});
test('cancelled paste and manual picker preserve the body without second writer', async ({
  page,
}) => {
  await mount(page, 'cancelled');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('保留正文');
  await paste(page, '取消');
  await expect(body).not.toBeEditable();
  await page.getByRole('button', { name: '停止取图', exact: true }).click();
  await expect(body).toBeEditable();
  await expect(body).toContainText('保留正文');
  expect(await logs(page, 'pastes')).toHaveLength(1);
});
test('oversized title stays visible, never crosses bridge, and explicit discard still works', async ({
  page,
}) => {
  await mount(page);
  const title = page.getByLabel('文章标题', { exact: true });
  await title.fill('长'.repeat(513));
  await expect(page.getByRole('alert')).toContainText('超出');
  await page.getByRole('button', { name: '保存到文章池', exact: true }).click();
  await expect(title).toHaveValue('长'.repeat(513));
  expect(await logs(page, 'edits')).toHaveLength(0);
  expect(await logs(page, 'saves')).toHaveLength(0);
  await page.getByRole('button', { name: '放弃录入', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByText('还没有文章', { exact: true })).toBeVisible();
});
test('raw invalid title preserves body and history; corrected explicit title saves', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('保留校对');
  await page.getByLabel('文章标题', { exact: true }).fill(' 标题 ');
  await page.getByRole('button', { name: '保存到文章池', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '请填写有效标题' }),
  ).toBeVisible();
  await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(
    ' 标题 ',
  );
  await expect(body).toContainText('保留校对');
  await page.getByLabel('文章标题', { exact: true }).fill('标题');
  await page.getByRole('button', { name: '保存到文章池', exact: true }).click();
  await expect(
    page.getByText('文章已保存到本机', { exact: true }),
  ).toBeVisible();
  await body.press('Control+z');
  await expect(body).not.toContainText('保留校对');
});
test('lost edit and save responses query matching main results without automatic replay', async ({
  page,
}) => {
  await mount(page, 'lost-edit');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('不会重放');
  await expect
    .poll(async () =>
      page.evaluate(
        () => Reflect.get(window, 'fixtureRead')().draft.blocks[0].text,
      ),
    )
    .toBe('不会重放');
  await expect(body).toBeEditable();
  expect(await logs(page, 'edits')).toHaveLength(1);
  await page.reload();
  await expect(body).toContainText('不会重放');
  expect(await logs(page, 'edits')).toHaveLength(1);
});
test('lost save result queries operation receipt and never repeats commit', async ({
  page,
}) => {
  await mount(page, 'lost-save');
  await page
    .getByRole('textbox', { name: '文章正文' })
    .pressSequentially('正文');
  await page.getByLabel('文章标题', { exact: true }).fill('提交一次');
  await page.getByRole('button', { name: '保存到文章池', exact: true }).click();
  await expect(
    page.getByText('文章已保存到本机', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await logs(page, 'lookups')).length)
    .toBeGreaterThan(0);
  expect(await logs(page, 'saves')).toHaveLength(1);
  await expect(page.getByRole('textbox', { name: '文章正文' })).toBeEditable();
});
test('only active shared private marker routes opaque internal grant and rejected grant keeps selection', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('内部图文');
  await body.press('Control+a');
  await paste(
    page,
    '文字',
    '<pre>文字</pre><!--application/x-draft-assistant-fragment:11111111-1111-4111-8111-111111111111-->',
  );
  await expect(page.getByRole('alert')).toContainText('粘贴');
  await expect(body).toContainText('内部图文');
  expect((await logs(page, 'pastes'))[0].input).toEqual({
    kind: 'internal',
    grantId: '11111111-1111-4111-8111-111111111111',
  });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    '内部图文',
  );
});
test('active Copy flushes fresh input before sending the confirmed selection', async ({
  page,
}) => {
  await mount(page, 'slow');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('选择😀');
  await body.press('Control+a');
  await body.evaluate((el) =>
    el.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true }),
    ),
  );
  await expect.poll(async () => (await logs(page, 'copies')).length).toBe(1);
  const copy = (await logs(page, 'copies'))[0];
  expect(copy.cut).toBe(false);
  expect(copy.range.anchor).toMatchObject({ kind: 'edge', side: 'before' });
  expect(copy.range.head).toMatchObject({ kind: 'edge', side: 'after' });
  expect((await logs(page, 'edits')).at(-1).blocks[0].text).toBe('选择😀');
});

test('unknown commit remains frozen even when main state read still says editing', async ({
  page,
}) => {
  await mount(page, 'save-unknown');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('提交状态未知');
  await page.getByLabel('文章标题', { exact: true }).fill('标题');
  await page.getByRole('button', { name: '保存到文章池', exact: true }).click();
  await expect
    .poll(async () => (await logs(page, 'lookups')).length)
    .toBeGreaterThan(0);
  await page.waitForTimeout(600);
  await expect(body).not.toBeEditable();
  await expect(body).toContainText('提交状态未知');
  expect(await logs(page, 'saves')).toHaveLength(1);
});
test('BODY composition holds CtrlS until final input and late ACK does not reload composition', async ({
  page,
}) => {
  await mount(page, 'slow');
  await page.getByLabel('文章标题', { exact: true }).fill('中文保存');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('校对');
  await expect.poll(async () => (await logs(page, 'edits')).length).toBe(1);
  await body.dispatchEvent('compositionstart');
  await body.pressSequentially('😀中文');
  await body.press('Control+s');
  await page.waitForTimeout(500);
  expect(await logs(page, 'saves')).toHaveLength(0);
  await expect(body).toHaveText('校对😀中文');
  await body.dispatchEvent('compositionend');
  await expect(
    page.getByText('文章已保存到本机', { exact: true }),
  ).toBeVisible();
  expect((await logs(page, 'edits')).at(-1).blocks[0].text).toBe('校对😀中文');
  expect(await logs(page, 'saves')).toHaveLength(1);
});
test('TITLE composition holds CtrlS until final title after delayed input acknowledgement', async ({
  page,
}) => {
  await mount(page, 'slow');
  await page
    .getByRole('textbox', { name: '文章正文' })
    .pressSequentially('正文');
  const title = page.getByLabel('文章标题', { exact: true });
  await title.dispatchEvent('compositionstart');
  await title.fill('pinyin');
  await title.press('Control+s');
  await page.waitForTimeout(500);
  expect(await logs(page, 'saves')).toHaveLength(0);
  await title.fill('中文标题');
  await title.dispatchEvent('compositionend');
  await expect(
    page.getByText('文章已保存到本机', { exact: true }),
  ).toBeVisible();
  expect((await logs(page, 'edits')).at(-1).title).toBe('中文标题');
});
test('saving and cleanup unknown freeze keyboard history and show committed local fact', async ({
  page,
}) => {
  await mount(page, 'cleanup');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('已保存正文');
  await page.getByLabel('文章标题', { exact: true }).fill('标题');
  await page.getByRole('button', { name: '保存到文章池', exact: true }).click();
  await expect(
    page.getByText('文章已保存到本机', { exact: true }),
  ).toBeVisible();
  await expect(body).not.toBeEditable();
  await body.press('Control+z');
  await expect(body).toContainText('已保存正文');
  await expect(
    page.getByRole('button', { name: '放弃录入', exact: true }),
  ).toBeDisabled();
});
test('save cancellation preserves body and resumes the same editor', async ({
  page,
}) => {
  await mount(page, 'saving');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('正在保存');
  await page.getByLabel('文章标题', { exact: true }).fill('标题');
  await page.getByRole('button', { name: '保存到文章池', exact: true }).click();
  await expect(body).not.toBeEditable();
  await page.getByRole('button', { name: '取消保存', exact: true }).click();
  await expect(body).toBeEditable();
  await expect(body).toContainText('正在保存');
});
test('manual picker is optional and shares current body range and undo history', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('连续正文');
  await page.getByRole('button', { name: '手动录入', exact: true }).click();
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  await expect(page.getByRole('img')).toHaveCount(1);
  expect((await logs(page, 'pickers'))[0].anchor.offset).toBe(4);
  await body.press('Control+z');
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(body).toContainText('连续正文');
  expect(await logs(page, 'legacy')).toHaveLength(0);
});
test('cancelled picker, busy preview, and retry only use the authorized current operation', async ({
  page,
}) => {
  await mount(page, 'cancel-picker');
  await page.getByRole('button', { name: '手动录入', exact: true }).click();
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('原正文');
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  await expect(body).toContainText('原正文');
  await expect(page.getByRole('img')).toHaveCount(0);
  expect(await logs(page, 'pickers')).toHaveLength(1);
});
test('busy image preview automatically retries without reopening picker', async ({
  page,
}) => {
  await mount(page, 'busy-image');
  await expect(page.getByRole('img')).toHaveCount(1);
  expect(await logs(page, 'reads')).toHaveLength(2);
  expect(await logs(page, 'pickers')).toHaveLength(0);
});
test('pending image disables save and permanent failure offers no retry', async ({
  page,
}) => {
  await mount(page, 'pending');
  await expect(
    page.getByRole('button', { name: '保存修改', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '重试正文图片', exact: true }).click();
  expect(await logs(page, 'retries')).toHaveLength(1);
  await page.evaluate(() => {
    const state = Reflect.get(window, 'fixtureRead')();
    state.candidates[0].retryable = false;
    state.candidates[0].reason = 'SOURCE_UNSUPPORTED';
    Reflect.get(window, 'fixturePatch')({ candidates: state.candidates });
  });
  await expect(
    page.getByRole('button', { name: '重试正文图片', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('alert').filter({ hasText: '图片来源暂不支持' }),
  ).toBeVisible();
});
test('paste budget rejects before bridge and external HTML never executes or enters DOM', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文' });
  await paste(page, '超'.repeat(2 * 1024 * 1024));
  await expect(page.getByRole('alert')).toContainText('超出');
  expect(await logs(page, 'pastes')).toHaveLength(0);
  expect(await logs(page, 'edits')).toHaveLength(0);
  await paste(
    page,
    '安全正文',
    '<script>window.stolen=true</script><img src="https://private.example/secret"><p>安全正文</p>',
  );
  await expect(body).toContainText('安全正文');
  expect(
    await page.evaluate(() => Reflect.get(window, 'stolen')),
  ).toBeUndefined();
  await expect(body.locator('script, img[src^="https:"]')).toHaveCount(0);
});
test('failed input sync retains raw text through query and blocks mode switch until retry correction', async ({
  page,
}) => {
  await mount(page, 'sync-failure');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('输入保留');
  await expect(page.getByRole('alert')).toContainText('未获确认');
  await expect(body).toContainText('输入保留');
  await body.pressSequentially('校对');
  await page.getByRole('button', { name: '手动录入', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '手动录入', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect((await logs(page, 'edits')).at(-1).blocks[0].text).toBe(
    '输入保留校对',
  );
});
test('middle text paste leaves caret after inserted fragment and is separate from following typing history', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('abcd');
  await body.press('Home');
  await body.press('ArrowRight');
  await paste(page, 'X');
  await expect(body).toContainText('aXbcd');
  await body.pressSequentially('Y');
  await expect(body).toHaveText('aXYbcd');
  await body.press('Control+z');
  await expect(body).toHaveText('aXbcd');
  await body.press('Control+z');
  await expect(body).toHaveText('abcd');
});

for (const action of ['save', 'close'] as const) {
  test(`consecutive BODY compositions keep ${action} and sync held until second final settlement`, async ({
    page,
  }) => {
    await mount(page);
    await page.getByLabel('文章标题', { exact: true }).fill('连续输入法');
    const body = page.getByRole('textbox', { name: '文章正文' });
    await body.pressSequentially('校对');
    await expect(page.getByText('输入已同步', { exact: true })).toBeVisible();
    const baseline = (await logs(page, 'edits')).length;
    await body.evaluate((el) =>
      Object.assign(window, { compositionEditorDOM: el }),
    );
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await body.dispatchEvent('compositionstart');
    await body.pressSequentially('甲');
    await body.dispatchEvent('compositionend');
    // Fake time has not moved: B starts before A's pending 30ms settlement.
    await body.dispatchEvent('compositionstart');
    await body.pressSequentially('pinyin');
    if (action === 'save') await body.press('Control+s');
    else await page.evaluate(() => Reflect.get(window, 'fixtureClose')());
    await page.clock.runFor(200);
    expect({
      edits: (await logs(page, 'edits')).length,
      saves: (await logs(page, 'saves')).length,
      closeResponses: (await logs(page, 'closeResponses')).length,
    }).toEqual({ edits: baseline, saves: 0, closeResponses: 0 });
    await expect(body).toHaveText('校对甲pinyin');
    for (let n = 0; n < 6; n++) await body.press('Backspace');
    await body.pressSequentially('中文😀');
    await body.dispatchEvent('compositionend');
    await page.clock.runFor(29);
    expect(await logs(page, 'edits')).toHaveLength(baseline);
    expect(await logs(page, 'saves')).toHaveLength(0);
    expect(await logs(page, 'closeResponses')).toHaveLength(0);
    await page.clock.runFor(1);
    const edits = await logs(page, 'edits');
    expect(edits).toHaveLength(baseline + 1);
    expect(edits.at(-1).blocks[0].text).toBe('校对甲中文😀');
    const commands = await logs(page, 'commands');
    const confirmedSequence = commands.at(-1).clientSequence;
    if (action === 'save') {
      expect(await logs(page, 'saves')).toHaveLength(1);
      const save = (await logs(page, 'saves'))[0];
      const state = await page.evaluate(() =>
        Reflect.get(window, 'fixtureRead')(),
      );
      expect(save.expectedDocumentRevision).toBe(state.documentRevision);
      expect(state.acknowledgedEdit.clientSequence).toBe(confirmedSequence);
    } else {
      expect(await logs(page, 'closeResponses')).toHaveLength(1);
      const close = (await logs(page, 'closeResponses'))[0];
      const state = await page.evaluate(() =>
        Reflect.get(window, 'fixtureRead')(),
      );
      expect(close.status).toBe('flushed');
      expect(close.documentRevision).toBe(state.documentRevision);
      expect(state.acknowledgedEdit.clientSequence).toBe(confirmedSequence);
    }
    await expect(body).toHaveText('校对甲中文😀');
    expect(
      await body.evaluate(
        (el) => el === Reflect.get(window, 'compositionEditorDOM'),
      ),
    ).toBe(true);
  });
}
test('a harmless same-session projection rerender preserves native caret before selection observation', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文' });
  await body.pressSequentially('abcd');
  await expect
    .poll(async () => (await logs(page, 'edits')).at(-1)?.blocks[0].text)
    .toBe('abcd');
  const before = await logs(page, 'edits');
  await body.evaluate((el) => {
    Reflect.set(window, 'sameEditorBody', el);
    document.addEventListener(
      'selectionchange',
      (event) => {
        if (Reflect.get(window, 'holdSelectionObserver'))
          event.stopImmediatePropagation();
      },
      true,
    );
    Reflect.set(window, 'holdSelectionObserver', true);
  });
  await body.press('Home');
  expect(await page.evaluate(() => document.getSelection()?.anchorOffset)).toBe(
    0,
  );
  // Model an ACK/projection rerender before ProseMirror observes the native Home selection.
  // Programmatic click does not move focus; it changes only the existing input mode.
  await page
    .getByRole('button', { name: '手动录入', exact: true })
    .dispatchEvent('click');
  await expect(
    page.getByRole('button', { name: '添加图片', exact: true }),
  ).toBeVisible();
  expect(
    await body.evaluate((el) => el === Reflect.get(window, 'sameEditorBody')),
  ).toBe(true);
  expect(await page.evaluate(() => document.getSelection()?.anchorOffset)).toBe(
    0,
  );
  expect(await logs(page, 'edits')).toHaveLength(before.length);
  await body.press('ArrowRight');
  await paste(page, 'X');
  await expect(body).toHaveText('aXbcd');
  expect((await logs(page, 'pastes')).at(-1).range.anchor.offset).toBe(1);
  await body.pressSequentially('Y');
  await expect(body).toHaveText('aXYbcd');
  await page.evaluate(() =>
    Reflect.set(window, 'holdSelectionObserver', false),
  );
  await body.press('Control+z');
  await expect(body).toHaveText('aXbcd');
  await body.press('Control+z');
  await expect(body).toHaveText('abcd');
  await body.press('Control+z');
  await expect(body).toHaveText('');
});
for (const kind of ['node', 'all', 'reversed'] as const)
  test(`same-session projection keeps ${kind} image/text selection and copy semantics`, async ({
    page,
  }) => {
    await mount(page, 'existing');
    const body = page.getByRole('textbox', { name: '文章正文' });
    await expect(body).toBeEditable();
    await expect(page.getByRole('img')).toHaveCount(1);
    if (kind === 'node') await page.getByRole('img').click();
    else if (kind === 'all') await body.press('Control+a');
    else
      await body.evaluate((el) => {
        const paragraphs = el.querySelectorAll('p');
        document
          .getSelection()
          ?.setBaseAndExtent(
            paragraphs[1].firstChild!,
            1,
            paragraphs[0].firstChild!,
            1,
          );
      });
    await page
      .getByRole('button', { name: '手动录入', exact: true })
      .dispatchEvent('click');
    await expect(
      page.getByRole('button', { name: '添加图片', exact: true }),
    ).toBeVisible();
    if (kind === 'node')
      await expect(body.locator('.ProseMirror-selectednode')).toHaveCount(1);
    await body.dispatchEvent('copy');
    await expect.poll(async () => (await logs(page, 'copies')).length).toBe(1);
    const range = (await logs(page, 'copies'))[0].range;
    if (kind === 'node')
      expect(range).toEqual({
        anchor: {
          blockKey: '22222222-2222-4222-8222-222222222222',
          kind: 'edge',
          side: 'before',
        },
        head: {
          blockKey: '33333333-3333-4333-8333-333333333333',
          kind: 'edge',
          side: 'before',
        },
      });
    else if (kind === 'all') {
      expect(range.anchor).toMatchObject({ kind: 'edge', side: 'before' });
      expect(range.head).toMatchObject({ kind: 'edge', side: 'after' });
    } else {
      expect(range.anchor).toEqual({
        blockKey: '33333333-3333-4333-8333-333333333333',
        kind: 'text',
        offset: 1,
      });
      expect(range.head).toEqual({
        blockKey: '11111111-1111-4111-8111-111111111111',
        kind: 'text',
        offset: 1,
      });
    }
    expect(await logs(page, 'edits')).toHaveLength(0);
    await expect(body).toHaveText('前文😀后文');
  });

test('Stop exposes Retry for a supported cancelled position and Retry preserves its ordered body', async ({
  page,
}) => {
  await mount(page, 'stopping-image');
  const body = page.getByRole('textbox', { name: '文章正文' });
  await expect(
    page.getByRole('status').filter({ hasText: '正在取得第1/1张图片…' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '重试正文图片' })).toHaveCount(
    0,
  );
  const before = await body.locator(':scope > p').allTextContents();
  expect(before).toEqual(['前文😀', '后文']);
  await page.getByRole('button', { name: '停止取图', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '重试正文图片' }),
  ).toBeEnabled();
  await expect(
    page.getByText('图片尚未完成，可重试或移除', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '保存修改', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '重试正文图片' }).click();
  await expect(page.getByRole('img')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '重试正文图片' })).toHaveCount(
    0,
  );
  expect(await body.locator(':scope > p').allTextContents()).toEqual(before);
  await expect(
    page.getByRole('button', { name: '保存修改', exact: true }),
  ).toBeEnabled();
});

for (const operation of ['paste', 'copy'] as const) {
  test(
    'operation thaw retains body focus and immediate Home typing after ' +
      operation,
    async ({ page }) => {
      await mount(page, 'held-focus');
      const body = page.getByRole('textbox', { name: '文章正文', exact: true });
      await expect(body).toBeEditable();
      await body.click();
      await body.press('Control+End');
      expect(
        await page.evaluate(() => ({
          text: getSelection()?.anchorNode?.textContent,
          offset: getSelection()?.anchorOffset,
        })),
      ).toEqual({ text: 'Omega paragraph', offset: 15 });
      await expect(body).toBeFocused();
      if (operation === 'paste') await paste(page, ' pasted');
      else {
        await page.keyboard.press('Control+Shift+Home');
        await body.dispatchEvent('copy');
      }
      await expect(body).toHaveAttribute('aria-readonly', 'true');
      const operationLog = operation === 'paste' ? 'pastes' : 'copies';
      await expect
        .poll(async () => (await logs(page, operationLog)).length)
        .toBe(1);
      expect((await logs(page, operationLog))[0].range).toEqual({
        anchor: {
          blockKey: '33333333-3333-4333-8333-333333333333',
          kind: 'text',
          offset: 15,
        },
        head: {
          blockKey:
            operation === 'paste'
              ? '33333333-3333-4333-8333-333333333333'
              : '11111111-1111-4111-8111-111111111111',
          kind: 'text',
          offset: operation === 'paste' ? 15 : 0,
        },
      });
      await page.evaluate(() => Reflect.get(window, 'releaseOperation')());
      await expect(body).toHaveAttribute('aria-readonly', 'false');
      expect
        .soft(
          await body.evaluate((el) => document.activeElement === el),
          'settled editor keeps operator focus',
        )
        .toBe(true);
      // Page keyboard deliberately does not refocus the editor for the operator.
      await page.keyboard.press('Control+Home');
      await page.keyboard.insertText('Checked ');
      await expect(body.locator(':scope > p')).toHaveText([
        'Checked Alpha paragraph',
        operation === 'paste' ? 'Omega paragraph pasted' : 'Omega paragraph',
      ]);
      await expect(page.getByText('输入已同步', { exact: true })).toBeVisible();
      const state = await page.evaluate(() =>
        Reflect.get(window, 'fixtureRead')(),
      );
      expect(state.draft.blocks).toEqual([
        {
          type: 'paragraph',
          blockKey: '11111111-1111-4111-8111-111111111111',
          text: 'Checked Alpha paragraph',
        },
        {
          type: 'image',
          blockKey: '22222222-2222-4222-8222-222222222222',
          imageToken: '22222222-2222-4222-8222-222222222222',
        },
        {
          type: 'paragraph',
          blockKey: '33333333-3333-4333-8333-333333333333',
          text:
            operation === 'paste'
              ? 'Omega paragraph pasted'
              : 'Omega paragraph',
        },
      ]);
    },
  );
}

test('rapid refocus Home keeps the newer native caret intent', async ({
  page,
}) => {
  await mount(page, 'held-focus');
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await expect(body).toBeEditable();
  await body.click();
  await page.keyboard.press('Control+End');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  // Advance the pinned observer's recent-click window, without delaying operator keys.
  await page.clock.runFor(301);
  await page.getByLabel('文章标题', { exact: true }).focus();
  await body.focus();
  await page.keyboard.press('Control+Home');
  await page.clock.runFor(20);
  expect(
    await page.evaluate(() => ({
      text: getSelection()?.anchorNode?.textContent,
      offset: getSelection()?.anchorOffset,
    })),
  ).toEqual({ text: 'Alpha paragraph', offset: 0 });
  await page.keyboard.insertText('Checked ');
  await expect(body.locator(':scope > p')).toHaveText([
    'Checked Alpha paragraph',
    'Omega paragraph',
  ]);
});

for (const destination of ['title', 'button', 'outside', 'tab'] as const) {
  test(
    'operation thaw respects operator focus moved to ' + destination,
    async ({ page }) => {
      await mount(page, 'held-focus');
      const body = page.getByRole('textbox', { name: '文章正文', exact: true });
      await expect(body).toBeEditable();
      await body.click();
      await page.keyboard.press('Control+End');
      // Title/application buttons are disabled by pending: move there before the
      // operation rather than pretending a disabled control can accept focus.
      if (destination === 'title') {
        const title = page.getByLabel('文章标题', { exact: true });
        await title.focus();
        await expect(title).toBeFocused();
      } else if (destination === 'button') {
        const button = page.getByRole('button', {
          name: '新建文章',
          exact: true,
        });
        await button.focus();
        await expect(button).toBeFocused();
      }
      await paste(page, ' pasted');
      await expect(body).toHaveAttribute('aria-readonly', 'true');
      const baseline = (await logs(page, 'edits')).length;
      // Frozen focus must not admit input while the typed bridge operation is pending.
      await page.keyboard.insertText('Forbidden');
      await expect(body.locator(':scope > p')).toHaveText([
        'Alpha paragraph',
        'Omega paragraph',
      ]);
      expect(await logs(page, 'edits')).toHaveLength(baseline);
      if (destination === 'outside') {
        await page.evaluate(() => {
          const outside = document.createElement('button');
          outside.textContent = 'Fixture outside';
          document.body.append(outside);
          outside.focus();
        });
      } else if (destination === 'tab') await page.keyboard.press('Tab');
      await page.evaluate(() =>
        Reflect.set(window, 'operatorFocus', document.activeElement),
      );
      expect(await body.evaluate((el) => document.activeElement === el)).toBe(
        false,
      );
      await page.evaluate(() => Reflect.get(window, 'releaseOperation')());
      await expect(body).toHaveAttribute('aria-readonly', 'false');
      expect(
        await page.evaluate(
          () => document.activeElement === Reflect.get(window, 'operatorFocus'),
        ),
      ).toBe(true);
      await expect(body.locator(':scope > p')).toHaveText([
        'Alpha paragraph',
        'Omega paragraph pasted',
      ]);
      const state = await page.evaluate(() =>
        Reflect.get(window, 'fixtureRead')(),
      );
      expect(state.draft.blocks[1]).toEqual({
        type: 'image',
        blockKey: '22222222-2222-4222-8222-222222222222',
        imageToken: '22222222-2222-4222-8222-222222222222',
      });
    },
  );
}

test('rapid refocus Shift Home preserves the newer cross-image replacement selection', async ({
  page,
}) => {
  await mount(page, 'held-focus');
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await expect(body).toBeEditable();
  await body.click();
  await page.keyboard.press('Control+End');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.runFor(301);
  await page.getByLabel('文章标题', { exact: true }).focus();
  await body.focus();
  await page.keyboard.press('Control+Shift+Home');
  await page.clock.runFor(20);
  expect(
    await page.evaluate(() => ({
      anchorText: getSelection()?.anchorNode?.textContent,
      anchorOffset: getSelection()?.anchorOffset,
      focusText: getSelection()?.focusNode?.textContent,
      focusOffset: getSelection()?.focusOffset,
    })),
  ).toEqual({
    anchorText: 'Omega paragraph',
    anchorOffset: 15,
    focusText: 'Alpha paragraph',
    focusOffset: 0,
  });
  await page.keyboard.insertText('Replacement');
  await expect(body.locator(':scope > p')).toHaveText(['Replacement']);
  await expect(page.getByRole('img')).toHaveCount(0);
});

test('ordinary refocus retains the prior caret across a projection before selection observation', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.pressSequentially('abcd');
  await expect(page.getByText('输入已同步', { exact: true })).toBeVisible();
  await page.getByLabel('文章标题', { exact: true }).focus();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.clock.runFor(301);
  await page.evaluate(() => {
    document.addEventListener(
      'selectionchange',
      (event) => {
        if (Reflect.get(window, 'holdRefocusObservation'))
          event.stopImmediatePropagation();
      },
      true,
    );
    Reflect.set(window, 'holdRefocusObservation', true);
  });
  await body.focus();
  // No navigation occurred: a projection must not admit the browser's focus reset as user intent.
  await page
    .getByRole('button', { name: '手动录入', exact: true })
    .dispatchEvent('click');
  await expect(
    page.getByRole('button', { name: '添加图片', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      text: getSelection()?.anchorNode?.textContent,
      offset: getSelection()?.anchorOffset,
    })),
  ).toEqual({ text: 'abcd', offset: 4 });
  await page.evaluate(() =>
    Reflect.set(window, 'holdRefocusObservation', false),
  );
  await page.keyboard.insertText('Checked');
  await page.clock.runFor(100);
  await expect(body).toHaveText('abcdChecked');
});

test('background body focus event cannot request focus from the foreground document', async ({
  page,
  context,
}) => {
  await mount(page, 'held-focus');
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await expect(body).toBeEditable();
  await body.click();
  await page.keyboard.press('Control+End');
  const foreground = await context.newPage();
  try {
    await foreground.goto('about:blank');
    await foreground.bringToFront();
    const [backgroundFocused, foregroundFocused] = await Promise.all([
      page.evaluate(() => document.hasFocus()),
      foreground.evaluate(() => document.hasFocus()),
    ]);
    test.skip(
      backgroundFocused && foregroundFocused,
      'UNSUPPORTED: real headless pages both report focus after foreground change; activation-negative proof needs a browser with deactivation',
    );
    expect(foregroundFocused).toBe(true);
    expect(backgroundFocused).toBe(false);
    await body.evaluate((el) => {
      const element = el as HTMLElement;
      const original = element.focus.bind(element);
      Reflect.set(window, 'backgroundFocusCalls', 0);
      element.focus = (options?: FocusOptions) => {
        Reflect.set(
          window,
          'backgroundFocusCalls',
          Number(Reflect.get(window, 'backgroundFocusCalls')) + 1,
        );
        return original(options);
      };
    });
    // Exercise the renderer callback with a synthetic event while real document
    // activation belongs to the other page; document.hasFocus is never replaced.
    await body.dispatchEvent('focus');
    expect(
      await page.evaluate(() => ({
        focused: document.hasFocus(),
        calls: Reflect.get(window, 'backgroundFocusCalls'),
      })),
    ).toEqual({ focused: false, calls: 0 });
    expect(await foreground.evaluate(() => document.hasFocus())).toBe(true);
    await expect(body.locator(':scope > p')).toHaveText([
      'Alpha paragraph',
      'Omega paragraph',
    ]);
  } finally {
    await foreground.close();
  }
});
