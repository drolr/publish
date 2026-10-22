import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  invoke: vi.fn(),
  expose: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: h.expose },
  ipcRenderer: { invoke: h.invoke },
  ipcMain: {
    handle: (c: string, hnd: (...args: unknown[]) => Promise<unknown>) =>
      h.handlers.set(c, hnd),
    removeHandler: (c: string) => h.handlers.delete(c),
  },
}));
it('ten narrow methods reject forged sender/path/extra fields and release on window close', async () => {
  const m = await import('../../src/desktop/main/article-cover-ipc').catch(
    () => undefined,
  );
  expect(m?.registerArticleCoverHandlers).toBeTypeOf('function');
  const frame = { url: 'file:///app/index.html' },
    contents = { mainFrame: frame };
  let closed!: () => void;
  const window = {
    webContents: contents,
    once: (_e: string, cb: () => void) => {
      closed = cb;
    },
  };
  const methods = [
    'getArticleCover',
    'beginCoverEdit',
    'getCoverEditState',
    'setCoverDraft',
    'pickCoverImages',
    'copyCoverImage',
    'getCoverImage',
    'saveCoverEdit',
    'getCoverSaveResult',
    'closeCoverEdit',
  ];
  const api = Object.fromEntries(
    methods.map((k) => [
      k,
      vi.fn(async () => ({ status: 'unavailable', notice: null })),
    ]),
  );
  m!.registerArticleCoverHandlers(
    window as unknown as BrowserWindow,
    frame.url,
    api as unknown as import('../../src/contracts/article-cover').ArticleCoverApi,
  );
  expect([...h.handlers.keys()].sort()).toEqual(
    [
      'get',
      'begin',
      'state',
      'draft',
      'pick',
      'copy',
      'image',
      'save',
      'save-result',
      'close',
    ]
      .map((k) => 'articles:cover:' + k)
      .sort(),
  );
  const handler = h.handlers.get('articles:cover:state')!;
  await expect(handler({ sender: {}, senderFrame: frame })).rejects.toThrow(
    'Request rejected',
  );
  await expect(
    handler({ sender: contents, senderFrame: { ...frame } }),
  ).rejects.toThrow('Request rejected');
  await expect(
    handler({ sender: contents, senderFrame: frame }, 'C:/private'),
  ).rejects.toThrow('Request rejected');
  await expect(
    h.handlers.get('articles:cover:pick')!(
      { sender: contents, senderFrame: frame },
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        expectedDraftRevision: 0,
        path: 'C:/private',
      },
      [0],
    ),
  ).rejects.toThrow('Request rejected');
  await expect(
    h.handlers.get('articles:cover:copy')!(
      { sender: contents, senderFrame: frame },
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        expectedDraftRevision: 0,
      },
      {
        kind: 'stored',
        articleKey: '00000000-0000-4000-8000-000000000001',
        coverRevision: 1,
        assetKey: '00000000-0000-4000-8000-000000000001',
        path: 'C:/private',
      },
    ),
  ).rejects.toThrow('Request rejected');
  expect(api.copyCoverImage).not.toHaveBeenCalled();
  expect(api.getCoverEditState).not.toHaveBeenCalled();
  expect(await handler({ sender: contents, senderFrame: frame })).toEqual({
    status: 'unavailable',
    notice: null,
  });
  closed();
  expect(h.handlers.size).toBe(0);
});

it('preload exposes only ten named cover functions and validates each direction', async () => {
  await import('../../src/desktop/preload/index');
  const api = h.expose.mock.calls.at(
    -1,
  )![1] as import('../../src/contracts/app-status').DesktopApi;
  const id = '00000000-0000-4000-8000-000000000001',
    cmd = { sessionId: id, expectedDraftRevision: 0 };
  const cases = [
    ['getArticleCover', [id], { status: 'unavailable' }],
    ['beginCoverEdit', [id], { status: 'unavailable', notice: null }],
    ['getCoverEditState', [], { status: 'unavailable', notice: null }],
    [
      'setCoverDraft',
      [cmd, { mode: 'none', imageTokens: [] }],
      { status: 'unavailable', notice: null },
    ],
    ['pickCoverImages', [cmd, [0]], { status: 'unavailable', notice: null }],
    [
      'copyCoverImage',
      [cmd, { kind: 'stored', articleKey: id, coverRevision: 1, assetKey: id }],
      { status: 'unavailable', notice: null },
    ],
    [
      'getCoverImage',
      [{ kind: 'session', sessionId: id, imageToken: id }],
      { status: 'unavailable' },
    ],
    [
      'saveCoverEdit',
      [{ ...cmd, operationId: id }],
      { status: 'failed', operationId: id },
    ],
    ['getCoverSaveResult', [id], { status: 'not_started', operationId: id }],
    ['closeCoverEdit', [id], { status: 'unavailable', notice: null }],
  ] as const;
  for (const [name, args, response] of cases) {
    const method = api[name] as (...args: unknown[]) => Promise<unknown>;
    expect(method).toBeTypeOf('function');
    const before = h.invoke.mock.calls.length;
    await expect(method(...args, 'C:/arbitrary')).rejects.toThrow(
      'Request rejected',
    );
    expect(h.invoke).toHaveBeenCalledTimes(before);
    h.invoke.mockResolvedValueOnce(response);
    expect(await method(...args)).toEqual(response);
    h.invoke.mockResolvedValueOnce({ ...response, path: 'C:/private' });
    await expect(method(...args)).rejects.toThrow('Request unavailable');
  }
  expect('invoke' in api).toBe(false);
  expect('readFile' in api).toBe(false);
});
