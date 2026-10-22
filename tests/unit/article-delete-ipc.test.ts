import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  expose: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) => h.handlers.set(channel, handler),
    removeHandler: (channel: string) => h.handlers.delete(channel),
  },
  contextBridge: { exposeInMainWorld: h.expose },
  ipcRenderer: { invoke: h.invoke },
}));
const operationId = '00000000-0000-4000-8000-000000000001';
const command = {
  operationId,
  articleKey: '00000000-0000-4000-8000-000000000002',
  expectedArticleRevision: 1,
};
it('rejects sender, subframe, path and additional fields before deletion; closes both handlers', async () => {
  const module =
    await import('../../src/desktop/main/article-delete-ipc').catch(
      () => undefined,
    );
  expect(module?.registerArticleDeletionHandlers).toBeTypeOf('function');
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  let closed!: () => void;
  const window = {
    webContents: contents,
    once: (_event: string, callback: () => void) => {
      closed = callback;
    },
  };
  const api = {
    deleteArticle: vi.fn(async () => ({
      status: 'blocked' as const,
      operationId,
    })),
    getArticleDeletionResult: vi.fn(async () => ({
      status: 'not_started' as const,
      operationId,
    })),
  };
  module!.registerArticleDeletionHandlers(
    window as unknown as BrowserWindow,
    frame.url,
    api,
  );
  expect([...h.handlers.keys()].sort()).toEqual([
    'articles:delete',
    'articles:delete-result',
  ]);
  const trusted = { sender: contents, senderFrame: frame };
  for (const [channel, payload] of [
    ['articles:delete', command],
    ['articles:delete-result', operationId],
  ] as const) {
    const handler = h.handlers.get(channel)!;
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { ...frame } },
    ])
      await expect(handler(event, payload)).rejects.toThrow('Request rejected');
    await expect(handler(trusted, payload, 'C:/arbitrary')).rejects.toThrow(
      'Request rejected',
    );
    await expect(handler(trusted, 'C:/arbitrary')).rejects.toThrow(
      'Request rejected',
    );
  }
  const write = h.handlers.get('articles:delete')!;
  await expect(
    write(trusted, { ...command, path: 'C:/arbitrary' }),
  ).rejects.toThrow('Request rejected');
  expect(api.deleteArticle).not.toHaveBeenCalled();
  expect(api.getArticleDeletionResult).not.toHaveBeenCalled();
  expect(await write(trusted, command)).toEqual({
    status: 'blocked',
    operationId,
  });
  expect(
    await h.handlers.get('articles:delete-result')!(trusted, operationId),
  ).toEqual({ status: 'not_started', operationId });
  api.deleteArticle.mockRejectedValue(new Error('C:/private.sqlite'));
  await expect(write(trusted, command)).rejects.toThrow('Request unavailable');
  api.getArticleDeletionResult.mockResolvedValue({
    status: 'not_started',
    operationId,
    path: 'C:/private',
  } as { status: 'not_started'; operationId: string });
  await expect(
    h.handlers.get('articles:delete-result')!(trusted, operationId),
  ).rejects.toThrow('Request unavailable');
  closed();
  expect(h.handlers.size).toBe(0);
});
it('preload exposes two named methods with strict request and response validation', async () => {
  await import('../../src/desktop/preload/index');
  const api = h.expose.mock.calls[0][1] as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  expect(api.deleteArticle).toBeTypeOf('function');
  expect(api.getArticleDeletionResult).toBeTypeOf('function');
  expect(Object.isFrozen(api)).toBe(true);
  await expect(
    api.deleteArticle({ ...command, path: 'C:/arbitrary' }),
  ).rejects.toThrow('Request rejected');
  await expect(
    api.getArticleDeletionResult(operationId, 'extra'),
  ).rejects.toThrow('Request rejected');
  expect(h.invoke).not.toHaveBeenCalled();
  h.invoke.mockResolvedValue({ status: 'blocked', operationId });
  expect(await api.deleteArticle(command)).toEqual({
    status: 'blocked',
    operationId,
  });
  expect(h.invoke).toHaveBeenLastCalledWith('articles:delete', command);
  h.invoke.mockResolvedValue({ status: 'not_started', operationId });
  expect(await api.getArticleDeletionResult(operationId)).toEqual({
    status: 'not_started',
    operationId,
  });
  expect(h.invoke).toHaveBeenLastCalledWith(
    'articles:delete-result',
    operationId,
  );
  h.invoke.mockResolvedValue({
    status: 'not_started',
    operationId,
    path: 'C:/private',
  });
  await expect(api.getArticleDeletionResult(operationId)).rejects.toThrow(
    'Request unavailable',
  );
});
