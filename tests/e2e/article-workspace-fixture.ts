import { installCoverBridge } from './cover-renderer-fixture';
import { test, type Page } from '@playwright/test';
import webpack from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ManualDraft } from '../../src/contracts/manual-article';
import type {
  DocumentCommand,
  SaveCommand,
} from '../../src/contracts/manual-edit';
import type { DeleteArticleCommand } from '../../src/contracts/article-delete';
test.beforeAll(async () => {
  await new Promise<void>((done, reject) =>
    webpack(
      {
        mode: 'development',
        entry: resolve('src/renderer/main.tsx'),
        output: {
          path: resolve('.tmp/workspace-renderer'),
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
export async function mount(
  page: Page,
  unknown = false,
  delayedSave = false,
  conflictSave = false,
  unknownEdit = false,
  mismatchedProof = false,
  count = 2,
  coverOptions = {},
) {
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!['/', '/app.js', '/app.css'].includes(path)) return route.abort();
    await route.fulfill(
      path === '/'
        ? {
            contentType: 'text/html; charset=utf-8',
            body: '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
          }
        : {
            contentType: path.endsWith('js')
              ? 'text/javascript; charset=utf-8'
              : 'text/css; charset=utf-8',
            body: fsRead(path),
          },
    );
  });
  function fsRead(path: string) {
    return readFileSync(resolve('.tmp/workspace-renderer', path.slice(1)));
  }
  await page.addInitScript(
    ({
      unknown,
      delayedSave,
      conflictSave,
      unknownEdit,
      mismatchedProof,
      count,
    }) => {
      let state = JSON.parse('{"state":"idle","revision":0}'),
        revision = 1,
        prepared = JSON.parse('null');
      const ids = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ];
      const articles = Array.from({ length: count }, (_, i) => ({
        articleKey:
          ids[i] ??
          '11111111-1111-4111-8111-' + String(i + 1).padStart(12, '0'),
        externalId: 'a' + i,
        title: '文章' + (i + 1),
        contentDeclaration: 'repost',
        imageCount: 0,
        articleRevision: 1,
        createdAt: '2026-10-08T00:00:00.000Z',
        body: [{ type: 'paragraph', text: '已保存正文' + (i + 1) }],
        assets: [],
      }));
      let closeListener: ((request: { requestId: string }) => void) | undefined;
      const logs: Array<[string, ...unknown[]]> = [];
      let stopView = {
        revision: 0,
        phase: 'idle',
        owners: [] as Array<{ scope: string; state: string }>,
      };
      let saving = false;
      let flushStop: ((flushed: boolean) => void) | undefined;
      Object.assign(window, {
        workspaceLog: () => logs,
        workspaceState: () => state,
        workspaceClose: () => closeListener?.({ requestId: ids[1] }),
      });
      const reply = () => ({ status: 'ok', snapshot: structuredClone(state) });
      const ticket = (c: DocumentCommand) => {
        if (
          c.commandId !== state.nextEditCommandId ||
          c.clientSequence !== state.nextClientSequence ||
          c.expectedDocumentRevision !== state.documentRevision
        )
          throw Error('stale');
        state.nextEditCommandId = crypto.randomUUID();
        state.nextClientSequence++;
      };
      Object.assign(window, {
        desktopApi: {
          getOperationControlState: async () => structuredClone(stopView),
          requestStopAll: async () => {
            stopView = {
              revision: stopView.revision + 1,
              phase: 'stopping',
              owners: [{ scope: 'manual', state: 'active' }],
            };
            prepared = null;
            while (saving)
              await new Promise((resolve) => setTimeout(resolve, 20));
            const flushed =
              !('sessionId' in state) ||
              (await new Promise<boolean>((resolve) => {
                flushStop = resolve;
                closeListener?.({ requestId: ids[1] });
              }));
            if (flushed && !state.dirty) {
              state = { state: 'idle', revision: state.revision + 1 };
              stopView = {
                revision: stopView.revision + 1,
                phase: 'stopped',
                owners: [{ scope: 'manual', state: 'idle' }],
              };
            } else {
              stopView = {
                revision: stopView.revision + 1,
                phase: 'needs_review',
                owners: [{ scope: 'manual', state: 'needs_review' }],
              };
            }
            return structuredClone(stopView);
          },
          startDraft: async (id: string) => {
            if (
              !prepared ||
              prepared.preparationId !== id ||
              state.state !== 'idle'
            )
              throw Error('no fresh preparation');
            logs.push(['start', id, state.state]);
            prepared = null;
            return {
              status: 'ok',
              view: {
                session: {
                  status: 'ready',
                  bindingToken: ids[0],
                  storeName: '测试门店',
                  reason: null,
                },
                task: null,
                preparation: null,
              },
            };
          },
          getAppStatus: async () => ({
            state: 'ready',
            appVersion: '1',
            schemaVersion: 14,
          }),
          getImportStatus: async () => ({ state: 'idle', revision: 0 }),
          listArticles: async (cursor?: { pageNumber: number }) => ({
            status: 'ok',
            page: {
              items: articles.slice(
                ((cursor?.pageNumber ?? 1) - 1) * 10,
                (cursor?.pageNumber ?? 1) * 10,
              ),
              totalCount: articles.length,
              membershipRevision: 0,
              pageNumber: cursor?.pageNumber ?? 1,
              totalPages: Math.max(1, Math.ceil(articles.length / 10)),
              ...((cursor?.pageNumber ?? 1) * 10 < articles.length
                ? {
                    nextCursor: {
                      articleKey:
                        articles[(cursor?.pageNumber ?? 1) * 10 - 1].articleKey,
                      createdAt: articles[0].createdAt,
                      membershipRevision: 0,
                      pageNumber: (cursor?.pageNumber ?? 1) + 1,
                    },
                  }
                : {}),
            },
          }),
          getArticleDeclarations: async () => ({
            status: 'ok',
            items: articles,
          }),
          deleteArticle: async (command: DeleteArticleCommand) => {
            logs.push(['delete', command]);
            const index = articles.findIndex(
              (a) => a.articleKey === command.articleKey,
            );
            if (
              articles[index].articleRevision !==
              command.expectedArticleRevision
            )
              return { status: 'conflict', operationId: command.operationId };
            articles.splice(index, 1);
            return {
              status: 'deleted',
              operationId: command.operationId,
              articleKey: command.articleKey,
              articleRevision: command.expectedArticleRevision + 1,
            };
          },
          setArticleDeclarations: async (change: { declaration: string }) => {
            articles[0].contentDeclaration = change.declaration;
            revision++;
            logs.push(['declaration', revision]);
            return {
              status: 'updated',
              items: [articles[0]],
              changedCount: 1,
              unchangedCount: 0,
            };
          },
          getArticlePreview: async (key: string) => ({
            status: 'ok',
            article: articles.find((a) => a.articleKey === key),
          }),
          getManualArticleState: async () => structuredClone(state),
          onManualCloseRequest: (
            listener: (request: { requestId: string }) => void,
          ) => {
            closeListener = listener;
            return () => {
              closeListener = undefined;
            };
          },
          respondManualClose: async (
            _r: string,
            _s: string,
            _d: number,
            status: string,
          ) => {
            logs.push(['native', status]);
            flushStop?.(status === 'flushed');
            flushStop = undefined;
            return reply();
          },
          openManualArticle: async (key: string) => {
            logs.push(['open', key]);
            const a = articles.find((a) => a.articleKey === key)!;
            state = {
              state: 'selecting',
              operationKind: 'open',
              revision: state.revision + 1,
              sessionId: crypto.randomUUID(),
              externalId: a.externalId,
              target: {
                kind: 'existing',
                articleKey: key,
                externalId: a.externalId,
                importId: key,
                baseArticleRevision: revision,
              },
              documentRevision: 0,
              nextClientSequence: 19,
              nextEditCommandId: crypto.randomUUID(),
              nextSaveOperationId: crypto.randomUUID(),
              nextPasteCommandId: crypto.randomUUID(),
              acknowledgedEdit: null,
              dirty: false,
              candidates: [],
              images: [],
              draft: {
                title: a.title,
                contentDeclaration: a.contentDeclaration,
                blocks: [
                  { type: 'paragraph', blockKey: key, text: a.body[0].text },
                ],
              },
            };
            setTimeout(() => {
              state = {
                ...state,
                state: 'editing',
                revision: state.revision + 1,
              };
            }, 200);
            return reply();
          },
          beginManualArticle: async () => {
            logs.push(['begin']);
            state = {
              ...state,
              state: 'editing',
              revision: state.revision + 1,
              sessionId: crypto.randomUUID(),
              target: { kind: 'new' },
              draft: { title: '', contentDeclaration: 'repost', blocks: [] },
              dirty: false,
            };
            return reply();
          },
          applyManualEdit: async (c: DocumentCommand, draft: ManualDraft) => {
            logs.push(['edit', draft]);
            if (unknownEdit) throw Error('unknown acknowledgement');
            ticket(c);
            state = {
              ...state,
              draft,
              dirty: true,
              documentRevision: state.documentRevision + 1,
              revision: state.revision + 1,
              acknowledgedEdit: {
                commandId: c.commandId,
                clientSequence: c.clientSequence,
              },
            };
            return reply();
          },
          commitManualDocument: async (c: SaveCommand) => {
            logs.push(['save', c]);
            if (conflictSave) {
              state = {
                ...state,
                result: {
                  status: 'failed',
                  code: 'RECOVERY_REQUIRED',
                  message: '文章已由其他操作更新',
                },
                issues: [{ message: '请核对后放弃当前编辑' }],
              };
              return { status: 'conflict', snapshot: structuredClone(state) };
            }
            if (unknown) throw Error('lost');
            saving = true;
            if (delayedSave) await new Promise((r) => setTimeout(r, 400));
            revision++;
            logs.push(['save-settled']);
            saving = false;
            const isNew = state.target.kind === 'new';
            let a = articles.find(
              (a) => a.articleKey === state.target.articleKey,
            );
            if (isNew) {
              a = {
                ...articles[0],
                articleKey: crypto.randomUUID(),
                externalId: crypto.randomUUID(),
                body: [{ type: 'paragraph', text: '' }],
              };
              articles.push(a);
            }
            if (!a) throw Error('missing article');
            a.title = state.draft.title;
            a.articleRevision = revision;
            a.body[0].text = state.draft.blocks[0].text;
            state = {
              ...state,
              revision: state.revision + 1,
              dirty: false,
              state: isNew ? 'finished' : state.state,
              target: isNew
                ? state.target
                : { ...state.target, baseArticleRevision: revision },
              saveOutcome: {
                kind: isNew ? 'created' : 'updated',
                articleKey: a.articleKey,
                articleRevision: revision,
                operationId: c.operationId,
              },
              nextSaveOperationId: crypto.randomUUID(),
            };
            return reply();
          },
          getManualSaveResult: async (_s: string, operationId: string) => {
            logs.push(['lookup', operationId]);
            return {
              status: conflictSave ? 'not_started' : 'needs_review',
              operationId: mismatchedProof ? crypto.randomUUID() : operationId,
            };
          },
          closeManualEditor: async (c: DocumentCommand, choice: string) => {
            ticket(c);
            logs.push(['close', choice]);
            if (choice === 'discard')
              state = { state: 'idle', revision: state.revision + 1 };
            return reply();
          },
          getDraftState: async () => ({
            session: {
              status: 'ready',
              bindingToken: ids[0],
              storeName: '测试门店',
              reason: null,
            },
            preparation: prepared,
            task: null,
          }),
          prepareDraft: async (key: string) => {
            logs.push(['prepare', key, revision, state.state]);
            prepared = {
              preparationId: crypto.randomUUID(),
              articleKey: key,
              title: articles[0].title,
              bodyImageCount: 0,
              contentDeclaration: articles.find(
                (article) => article.articleKey === key,
              )!.contentDeclaration,
              storeName: '测试门店',
              mode: 'draft',
              coverPolicy: 'manual-after-draft',
            };
            return { status: 'ready', preparation: prepared };
          },
        },
      });
    },
    { unknown, delayedSave, conflictSave, unknownEdit, mismatchedProof, count },
  );
  await installCoverBridge(page, coverOptions);
  await page.goto('http://localhost');
  await page.getByRole('button', { name: /文章1 文章编号/ }).click();
}
export const body = (page: Page) =>
  page.getByRole('textbox', { name: '文章正文' });
