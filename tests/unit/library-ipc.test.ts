import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { ArticleLibraryApi } from '../../src/contracts/article-library';
const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) => harness.handlers.set(channel, handler),
    removeHandler: (channel: string) => harness.handlers.delete(channel),
  },
}));
import { registerLibraryHandlers } from '../../src/desktop/main/library-ipc';
it('validates every new privileged method before invoking services and sanitizes failures', async () => {
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  let closed!: () => void;
  const window = {
    webContents: contents,
    once: (_event: string, cb: () => void) => {
      closed = cb;
    },
  };
  const api = {
    startArticleImport: vi.fn(async () => ({ status: 'unavailable' })),
    getImportStatus: vi.fn(async () => ({ state: 'idle', revision: 0 })),
    cancelArticleImport: vi.fn(async () => ({ state: 'idle', revision: 0 })),
    listArticles: vi.fn(async () => ({ status: 'unavailable' })),
    getArticlePreview: vi.fn(async () => ({ status: 'unavailable' })),
    getArticleImage: vi.fn(async () => ({ status: 'unavailable' })),
    getArticleDeclarations: vi.fn(async () => ({ status: 'unavailable' })),
    setArticleDeclarations: vi.fn(async () => ({ status: 'unavailable' })),
  };
  registerLibraryHandlers(
    window as unknown as BrowserWindow,
    frame.url,
    api as ArticleLibraryApi,
  );
  expect(harness.handlers.size).toBe(8);
  for (const handler of harness.handlers.values()) {
    await expect(
      handler({ sender: contents, senderFrame: frame }, { path: 'C:/secret' }),
    ).rejects.toThrow('Request rejected');
    await expect(handler({ sender: {}, senderFrame: frame })).rejects.toThrow(
      'Request rejected',
    );
    await expect(
      handler({ sender: contents, senderFrame: { url: frame.url } }),
    ).rejects.toThrow('Request rejected');
  }
  for (const call of Object.values(api)) expect(call).not.toHaveBeenCalled();
  const key = '00000000-0000-4000-8000-000000000001';
  const change = {
    targets: [{ articleKey: key, expectedDeclaration: 'repost' }],
    declaration: 'original',
  };
  for (const [channel, payload] of [
    ['articles:declarations', [key]],
    ['articles:set-declarations', change],
  ] as const) {
    const declarationHandler = harness.handlers.get(channel)!;
    await expect(
      declarationHandler({ sender: {}, senderFrame: frame }, payload),
    ).rejects.toThrow('Request rejected');
    await expect(
      declarationHandler(
        { sender: contents, senderFrame: { url: frame.url } },
        payload,
      ),
    ).rejects.toThrow('Request rejected');
    expect(
      await declarationHandler(
        { sender: contents, senderFrame: frame },
        payload,
      ),
    ).toEqual({ status: 'unavailable' });
  }
  const write = harness.handlers.get('articles:set-declarations')!;
  for (const invalid of [
    { ...change, path: 'C:/secret' },
    { ...change, declaration: 'auto' },
    { ...change, targets: [] },
    { ...change, targets: [...change.targets, ...change.targets] },
  ])
    await expect(
      write({ sender: contents, senderFrame: frame }, invalid),
    ).rejects.toThrow('Request rejected');
  expect(api.setArticleDeclarations).toHaveBeenCalledTimes(1);
  api.setArticleDeclarations.mockRejectedValue(new Error('C:/secret.sqlite'));
  await expect(
    write({ sender: contents, senderFrame: frame }, change),
  ).rejects.toThrow('Request unavailable');
  const handler = harness.handlers.get('articles:list')!;
  expect(await handler({ sender: contents, senderFrame: frame })).toEqual({
    status: 'unavailable',
  });
  api.listArticles.mockRejectedValue(new Error('C:/sensitive.sqlite'));
  await expect(
    handler({ sender: contents, senderFrame: frame }),
  ).rejects.toThrow('Request unavailable');
  closed();
  expect(harness.handlers.size).toBe(0);
});
