import { it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { DesktopApi } from '../../src/contracts/app-status';
import type { ManualArticleApi } from '../../src/contracts/manual-article';
const harness = vi.hoisted(() => ({
  api: undefined as DesktopApi | undefined,
  event: undefined as unknown,
  exposedName: '',
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  ready: [] as { channel: string; args: unknown[] }[],
}));
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: DesktopApi) => {
      harness.exposedName = name;
      harness.api = api;
    },
  },
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      harness.listeners.set(channel, listener),
    removeListener: (channel: string) => harness.listeners.delete(channel),
    send: (channel: string, ...args: unknown[]) =>
      harness.ready.push({ channel, args }),
    invoke: (channel: string, ...args: unknown[]) =>
      harness.handlers.get(channel)!(harness.event, ...args),
  },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      harness.handlers.set(name, handler),
    removeHandler: (name: string) => harness.handlers.delete(name),
  },
}));
import {
  registerManualHandlers,
  createManualDesktopApi,
} from '../../src/desktop/main/manual-ipc';
import { manualChannels } from '../../src/contracts/manual-article';
import { manualCloseChannels } from '../../src/contracts/editor-close';
it('typed close listener validates its fixed sender and payload, unsubscribes without a downgrade IPC', async () => {
  await import('../../src/desktop/preload/index');
  const electron = await import('electron');
  const received: unknown[] = [];
  const unsubscribe = harness.api!.onManualCloseRequest((request) =>
    received.push(request),
  );
  const callback = harness.listeners.get(manualCloseChannels.request)!;
  const request = { requestId: '00000000-0000-4000-8000-000000000001' };
  callback({ sender: {} }, request);
  callback({ sender: electron.ipcRenderer }, { ...request, path: 'private' });
  callback({ sender: electron.ipcRenderer }, request);
  expect(received).toEqual([request]);
  expect(harness.ready).toEqual([
    { channel: manualCloseChannels.ready, args: [] },
  ]);
  unsubscribe();
  unsubscribe();
  expect(harness.listeners.has(manualCloseChannels.request)).toBe(false);
  expect(harness.ready).toHaveLength(1);
});
it('checks every manual capability sender, frame, exact payload and response without leaking failures', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  let closed!: () => void;
  const window = {
    webContents: contents,
    once: (_event: string, fn: () => void) => {
      closed = fn;
    },
  };
  const payloads: Record<keyof ManualArticleApi, unknown[]> = {
    pickManualCoverImage: [{ sessionId: id, expectedCoverDraftRevision: 0 }],
    setManualCoverMode: [
      { sessionId: id, expectedCoverDraftRevision: 0 },
      'single',
    ],
    getManualCoverImage: [id, id],
    reconcileManualCoverSave: [id],
    openManualArticle: [id],
    applyManualEdit: [
      {
        sessionId: id,
        expectedDocumentRevision: 0,
        clientSequence: 1,
        commandId: id,
      },
      {
        bodyVersion: 2 as const,
        title: '',
        contentDeclaration: 'repost',
        blocks: [],
      },
    ],
    spliceManualPaste: [
      {
        sessionId: id,
        expectedDocumentRevision: 0,
        clientSequence: 1,
        commandId: id,
      },
      {
        anchor: { blockKey: id, kind: 'text', offset: 0 },
        head: { blockKey: id, kind: 'text', offset: 0 },
      },
      { html: '', plain: 'Text' },
    ],
    insertManualImage: [
      {
        sessionId: id,
        expectedDocumentRevision: 0,
        clientSequence: 1,
        commandId: id,
      },
      {
        anchor: { blockKey: id, kind: 'text', offset: 0 },
        head: { blockKey: id, kind: 'text', offset: 0 },
      },
    ],
    commitManualDocument: [
      { sessionId: id, expectedDocumentRevision: 0, operationId: id },
    ],
    closeManualEditor: [
      {
        sessionId: id,
        expectedDocumentRevision: 0,
        clientSequence: 1,
        commandId: id,
      },
      'discard',
    ],
    copyManualSelection: [
      {
        sessionId: id,
        expectedDocumentRevision: 0,
        clientSequence: 1,
        commandId: id,
      },
      {
        anchor: { blockKey: id, kind: 'text', offset: 0 },
        head: { blockKey: id, kind: 'text', offset: 0 },
      },
      false,
    ],
    getManualSaveResult: [id, id],
    respondManualClose: [id, id, 0, 'flushed'],
    startManualPaste: [
      { sessionId: id, expectedRevision: 0, commandId: id },
      { html: '', plain: 'text' },
    ],
    retryManualPasteImage: [
      { sessionId: id, expectedRevision: 0, commandId: id },
      id,
    ],
    beginManualArticle: [],
    getManualArticleState: [],
    updateManualDraft: [
      id,
      0,
      {
        bodyVersion: 2 as const,
        title: '',
        contentDeclaration: 'repost',
        blocks: [],
      },
    ],
    pickManualImage: [id, 0],
    getManualImage: [id, id],
    saveManualArticle: [id, 0],
    cancelManualOperation: [id, id],
    discardManualArticle: [id, 0],
  };
  const methods = Object.keys(manualChannels) as (keyof ManualArticleApi)[];
  const api = Object.fromEntries(
    methods.map((method) => [
      method,
      vi.fn(async () =>
        method === 'getManualArticleState'
          ? { state: 'idle', revision: 0 }
          : method === 'getManualSaveResult'
            ? { status: 'unavailable', operationId: id }
            : method === 'getManualImage' || method === 'getManualCoverImage'
              ? { status: 'unavailable' }
              : {
                  status: 'unavailable',
                  snapshot: { state: 'unavailable', revision: 0 },
                },
      ),
    ]),
  );
  registerManualHandlers(
    window as unknown as BrowserWindow,
    frame.url,
    api as unknown as ManualArticleApi,
  );
  expect(harness.handlers.size).toBe(23);
  for (const method of methods) {
    const handler = harness.handlers.get(manualChannels[method])!;
    const args = payloads[method];
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: frame.url } },
      { sender: contents, senderFrame: null },
    ])
      await expect(handler(event, ...args)).rejects.toThrow('Request rejected');
    await expect(
      handler({ sender: contents, senderFrame: frame }, ...args, {
        path: 'C:/private',
      }),
    ).rejects.toThrow('Request rejected');
    expect(api[method]).not.toHaveBeenCalled();
    await handler({ sender: contents, senderFrame: frame }, ...args);
    expect(api[method]).toHaveBeenCalledTimes(1);
    api[method].mockRejectedValueOnce(new Error('C:/private/image.png'));
    await expect(
      handler({ sender: contents, senderFrame: frame }, ...args),
    ).rejects.toThrow('Request unavailable');
  }
  closed();
  expect(harness.handlers.size).toBe(0);
});

import {
  command,
  flush,
  id,
  manualFixture,
  session,
} from '../helpers/manual-desktop';
import { WebPasteFailure } from '../../src/domain/web-paste-error';

it('paste_ipc_rejects_untrusted_sender_and_payload and reply_never_contains_source through the real controller', async () => {
  // Removing the production paste/retry bindings must prevent admission/retry.
  let requests = 0;
  const { manual } = manualFixture({
    converter: {
      convert: async () => ({
        version: 2 as const,
        warnings: [],
        blocks: [
          {
            type: 'paragraph',
            content: [{ type: 'text' as const, text: 'Body', marks: [] }],
          },
          {
            type: 'image',
            source: 'https://private.invalid/secret?token=private',
          },
        ],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async () => {
        if (++requests === 1) throw new WebPasteFailure('IMAGE_NETWORK');
        return {
          imageToken: id(90),
          mime: 'image/png',
          width: 1,
          height: 1,
          byteSize: 1,
        };
      },
    },
  });
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  registerManualHandlers(
    { webContents: contents, once: () => {} } as unknown as BrowserWindow,
    frame.url,
    createManualDesktopApi(manual),
  );
  const event = { sender: contents, senderFrame: frame };
  const initial = session(
    (
      (await harness.handlers.get('manual:begin')!(event)) as Awaited<
        ReturnType<ManualArticleApi['beginManualArticle']>
      >
    ).snapshot,
  );
  const paste = harness.handlers.get('manual:paste')!;
  const input = {
    html: '<p data-private="raw-secret">Body</p>',
    plain: 'Body',
  };
  const original = command(initial);
  await expect(
    paste({ ...event, sender: {} }, original, input),
  ).rejects.toThrow('Request rejected');
  await expect(
    paste(event, original, { ...input, path: 'C:/private-source' }),
  ).rejects.toThrow('Request rejected');
  expect(manual.getManualArticleState()).toEqual(initial);
  const started = await paste(event, original, input);
  expect(started).toMatchObject({
    status: 'started',
    snapshot: { state: 'pasting' },
  });
  await flush();
  const partial = session(manual.getManualArticleState());
  expect(partial.candidates).toMatchObject([
    { state: 'failed', reason: 'IMAGE_NETWORK', retryable: true },
  ]);
  expect(partial.draft.blocks.map((block) => block.type)).toEqual([
    'paragraph',
    'image-pending',
  ]);
  const retry = harness.handlers.get('manual:retry-image')!;
  const retryCommand = command(partial);
  await expect(
    retry(
      { ...event, senderFrame: { ...frame } },
      retryCommand,
      partial.candidates[0].candidateId,
    ),
  ).rejects.toThrow('Request rejected');
  await expect(
    retry(
      event,
      { ...retryCommand, url: 'private' },
      partial.candidates[0].candidateId,
    ),
  ).rejects.toThrow('Request rejected');
  expect(session(manual.getManualArticleState()).nextPasteCommandId).toBe(
    partial.nextPasteCommandId,
  );
  const retried = await retry(
    event,
    retryCommand,
    partial.candidates[0].candidateId,
  );
  expect(retried).toMatchObject({
    status: 'started',
    snapshot: { state: 'retrying' },
  });
  await flush();
  const finished = await harness.handlers.get('manual:state')!(event);
  expect(finished).toMatchObject({
    state: 'editing',
    candidates: [],
    images: [{ imageToken: id(90) }],
  });
  for (const reply of [started, partial, retried, finished]) {
    const serialized = JSON.stringify(reply);
    for (const source of [
      'raw-secret',
      '<p',
      'private.invalid',
      'private-source',
      'token=private',
    ])
      expect(serialized).not.toContain(source);
  }
});

it('startup-unavailable production bindings reject every manual write and keep read-only status', async () => {
  const api = createManualDesktopApi(undefined);
  const cmd = { sessionId: id(1), expectedRevision: 0, commandId: id(4) };
  const replies = await Promise.all([
    api.beginManualArticle(),
    api.startManualPaste(cmd, { html: '', plain: 'Body' }),
    api.retryManualPasteImage(cmd, id(5)),
    api.updateManualDraft(id(1), 0, {
      bodyVersion: 2 as const,
      title: '',
      contentDeclaration: 'repost',
      blocks: [],
    }),
    api.pickManualImage(id(1), 0),
    api.saveManualArticle(id(1), 0),
    api.cancelManualOperation(id(1), id(9)),
    api.discardManualArticle(id(1), 0),
  ]);
  for (const reply of replies)
    expect(reply).toEqual({
      status: 'unavailable',
      snapshot: { state: 'unavailable', revision: 0 },
    });
  expect(await api.getManualArticleState()).toEqual({
    state: 'unavailable',
    revision: 0,
  });
  expect(await api.getManualImage(id(1), id(2))).toEqual({
    status: 'unavailable',
  });
});
it('real preload exposes only fixed typed capabilities and routes paste to the actual controller', async () => {
  const { manual } = manualFixture();
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  harness.event = { sender: contents, senderFrame: frame };
  registerManualHandlers(
    { webContents: contents, once: () => {} } as unknown as BrowserWindow,
    frame.url,
    createManualDesktopApi(manual),
  );
  await import('../../src/desktop/preload/index');
  expect(harness.exposedName).toBe('desktopApi');
  const api = harness.api!;
  expect(Object.isFrozen(api)).toBe(true);
  expect(Object.keys(api).sort()).toEqual(
    [
      'pickManualCoverImage',
      'setManualCoverMode',
      'getManualCoverImage',
      'reconcileManualCoverSave',
      'finishHandledTask',
      'getUploadWaitSettings',
      'saveUploadWaitSettings',
      'getBrowserHealth',
      'checkBrowserHealth',
      'openBrowserUpdate',
      'batch',
      'requestStopAll',
      'getOperationControlState',
      'getArticleCover',
      'copyCoverImage',
      'beginCoverEdit',
      'getCoverEditState',
      'setCoverDraft',
      'pickCoverImages',
      'getCoverImage',
      'saveCoverEdit',
      'getCoverSaveResult',
      'closeCoverEdit',
      'deleteArticle',
      'getArticleDeletionResult',
      'openManualArticle',
      'applyManualEdit',
      'spliceManualPaste',
      'insertManualImage',
      'commitManualDocument',
      'closeManualEditor',
      'copyManualSelection',
      'getManualSaveResult',
      'respondManualClose',
      'onManualCloseRequest',
      'onOpenUploadSettings',
      'openDraftSession',
      'checkDraftSession',
      'closeDraftSession',
      'prepareDraft',
      'startDraft',
      'getDraftState',
      'stopDraft',
      'reconcileDraft',
      'prepareTaskClosure',
      'confirmTaskClosure',
      'openSavedDraft',
      'startManualPaste',
      'retryManualPasteImage',
      'beginManualArticle',
      'getManualArticleState',
      'updateManualDraft',
      'pickManualImage',
      'getManualImage',
      'saveManualArticle',
      'cancelManualOperation',
      'discardManualArticle',
      'getArticleDeclarations',
      'setArticleDeclarations',
      'startArticleImport',
      'getImportStatus',
      'cancelArticleImport',
      'listArticles',
      'getArticlePreview',
      'getArticleImage',
      'getAppStatus',
    ].sort(),
  );
  const first = session((await api.beginManualArticle()).snapshot);
  await expect(
    Reflect.apply(api.startManualPaste, api, [
      command(first),
      { html: '', plain: 'Body', path: 'C:/private' },
    ]),
  ).rejects.toThrow();
  expect(manual.getManualArticleState()).toEqual(first);
  expect(
    (
      await api.startManualPaste(command(first), {
        html: '<p>Body</p>',
        plain: 'Body',
      })
    ).status,
  ).toBe('started');
  await flush();
  expect(session(await api.getManualArticleState()).draft.blocks).toEqual([
    {
      blockKey: expect.any(String),
      type: 'paragraph',
      content: [{ type: 'text' as const, text: 'Body', marks: [] }],
    },
  ]);
});
it('strict paste response rejects unexpected raw HTML/source fields with a safe error', async () => {
  const { manual, begin } = manualFixture();
  const first = await begin();
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  const api = createManualDesktopApi(manual);
  registerManualHandlers(
    { webContents: contents, once: () => {} } as unknown as BrowserWindow,
    frame.url,
    {
      ...api,
      startManualPaste: async (...args) => ({
        ...(await api.startManualPaste(...args)),
        html: '<script>private</script>',
        source: 'C:/private',
      }),
    },
  );
  await expect(
    harness.handlers.get('manual:paste')!(
      { sender: contents, senderFrame: frame },
      command(first),
      { html: '', plain: 'Body' },
    ),
  ).rejects.toThrow('Request unavailable');
  await flush();
});

it('actual typed preload/main V2 edit path roundtrips rich tree and rejects nested privilege/key forgery', async () => {
  const { manual } = manualFixture();
  const frame = { url: 'file:///app/index.html' },
    contents = { mainFrame: frame };
  harness.event = { sender: contents, senderFrame: frame };
  registerManualHandlers(
    { webContents: contents, once: () => {} } as unknown as BrowserWindow,
    frame.url,
    createManualDesktopApi(manual),
  );
  await import('../../src/desktop/preload/index');
  const api = harness.api!,
    initial = session((await api.beginManualArticle()).snapshot);
  const cmd = {
    sessionId: initial.sessionId,
    expectedDocumentRevision: 0,
    clientSequence: 1,
    commandId: initial.nextEditCommandId,
  };
  const rich = {
    ...initial.draft,
    title: 'Bridge',
    blocks: [
      {
        type: 'list' as const,
        kind: 'ordered' as const,
        start: 9,
        blockKey: id(501),
        items: [
          {
            type: 'paragraph' as const,
            blockKey: id(502),
            content: [
              {
                type: 'text' as const,
                text: 'A😀B',
                marks: ['bold' as const, 'italic' as const],
              },
            ],
          },
        ],
      },
    ],
  };
  const forged = {
    ...rich,
    blocks: [
      {
        ...rich.blocks[0],
        items: [{ ...rich.blocks[0].items[0], path: 'C:/private' }],
      },
    ],
  };
  await expect(
    Reflect.apply(api.applyManualEdit, api, [cmd, forged]),
  ).rejects.toThrow();
  await expect(
    harness.handlers.get('manual:edit')!(harness.event, cmd, forged),
  ).rejects.toThrow('Request rejected');
  const duplicate = {
    ...rich,
    blocks: [
      {
        ...rich.blocks[0],
        items: [{ ...rich.blocks[0].items[0], blockKey: id(501) }],
      },
    ],
  };
  await expect(
    harness.handlers.get('manual:edit')!(harness.event, cmd, duplicate),
  ).rejects.toThrow('Request rejected');
  expect(session(manual.getManualArticleState()).documentRevision).toBe(0);
  const reply = await api.applyManualEdit(cmd, rich);
  expect(reply.status).toBe('ok');
  expect(session(reply.snapshot).draft).toEqual(rich);
  expect(session(await api.getManualArticleState()).dirty).toBe(true);
  const changed = session(reply.snapshot);
  await api.closeManualEditor(
    {
      sessionId: changed.sessionId,
      expectedDocumentRevision: changed.documentRevision,
      clientSequence: changed.nextClientSequence,
      commandId: changed.nextEditCommandId,
    },
    'discard',
  );
  const next = session((await api.beginManualArticle()).snapshot);
  expect((await api.applyManualEdit(cmd, rich)).status).toBe('conflict');
  expect(session(await api.getManualArticleState()).sessionId).toBe(
    next.sessionId,
  );
  expect(session(await api.getManualArticleState()).draft).toEqual(next.draft);
});
