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
export function setupContinuousFixture() {
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
}
export async function mount(
  page: Page,
  scenario = 'normal',
  runtimeMethods?: string[],
) {
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
          bodyVersion: 2,
          title: '',
          contentDeclaration: 'repost',
          blocks: [{ type: 'paragraph', blockKey: id, content: [] }],
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
          {
            type: 'paragraph',
            blockKey: id,
            content: [{ type: 'text', text: '前文😀', marks: [] }],
          },
          { type: 'image', blockKey: imageKey, imageToken: imageKey },
          {
            type: 'paragraph',
            blockKey: lastKey,
            content: [{ type: 'text', text: '后文', marks: [] }],
          },
        ];
        state.images = [image()];
        if (scenario === 'held-focus') {
          state.draft.blocks[0].content[0].text = 'Alpha paragraph';
          state.draft.blocks[2].content[0].text = 'Omega paragraph';
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
          schemaVersion: 15,
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
              ? a.content
                  .map((run) => run.text)
                  .join('')
                  .slice(0, range.anchor.offset)
              : '';
          const suffix =
            h?.type === 'paragraph' && range.head.kind === 'text'
              ? h.content
                  .map((run) => run.text)
                  .join('')
                  .slice(range.head.offset)
              : '';
          const replacement = [
            {
              type: 'paragraph' as const,
              blockKey:
                a?.type === 'paragraph' && range.anchor.kind === 'text'
                  ? a.blockKey
                  : crypto.randomUUID(),
              content: [
                {
                  type: 'text',
                  text: prefix + (input.plain ?? '') + suffix,
                  marks: [],
                },
              ],
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
  if (runtimeMethods)
    await page.addInitScript((methods) => {
      const api = Reflect.get(window, 'desktopApi');
      for (const method of methods)
        Reflect.set(api, method, (...args: unknown[]) =>
          Reflect.get(window, 'manualRuntimeCall')(method, args),
        );
    }, runtimeMethods);
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
export async function logs(page: Page, name: string) {
  return page.evaluate(
    (name) => JSON.parse(sessionStorage.getItem(name) ?? '[]'),
    name,
  );
}
export async function paste(page: Page, plain: string, html = '') {
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
