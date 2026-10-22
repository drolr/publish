import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { DesktopApi } from '../../src/contracts/app-status';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  invoke: vi.fn(),
  expose: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: h.expose },
  ipcRenderer: { invoke: h.invoke },
  ipcMain: {
    handle: (c: string, f: (...args: unknown[]) => Promise<unknown>) =>
      h.handlers.set(c, f),
    removeHandler: (c: string) => h.handlers.delete(c),
  },
}));
const view = {
  revision: 1,
  phase: 'stopping' as const,
  owners: [{ scope: 'draft' as const, state: 'active' as const }],
};
it('stop IPC bypasses busy admission but rejects foreign frames and all arguments', async () => {
  const { registerOperationControlHandlers } =
    await import('../../src/desktop/main/operation-control-ipc');
  const frame = { url: 'file:///app/index.html' },
    contents = { mainFrame: frame };
  let closed!: () => void;
  const window = {
    webContents: contents,
    once: (_: string, cb: () => void) => {
      closed = cb;
    },
  };
  const api = {
    requestStopAll: vi.fn(async () => view),
    getOperationControlState: vi.fn(async () => view),
  };
  registerOperationControlHandlers(
    window as unknown as BrowserWindow,
    frame.url,
    api,
  );
  expect([...h.handlers.keys()].sort()).toEqual([
    'operations:state',
    'operations:stop-all',
  ]);
  const stop = h.handlers.get('operations:stop-all')!;
  await expect(stop({ sender: {}, senderFrame: frame })).rejects.toThrow(
    'Request rejected',
  );
  await expect(
    stop({ sender: contents, senderFrame: { ...frame } }),
  ).rejects.toThrow('Request rejected');
  await expect(
    stop({ sender: contents, senderFrame: frame }, { taskId: 'arbitrary' }),
  ).rejects.toThrow('Request rejected');
  expect(api.requestStopAll).not.toHaveBeenCalled();
  expect(await stop({ sender: contents, senderFrame: frame })).toEqual(view);
  api.requestStopAll.mockRejectedValueOnce(Error('private-path'));
  await expect(stop({ sender: contents, senderFrame: frame })).rejects.toThrow(
    'Request unavailable',
  );
  closed();
  expect(h.handlers.size).toBe(0);
});
it('preload exposes only named stop and query and validates both directions', async () => {
  await import('../../src/desktop/preload/index');
  const api = h.expose.mock.calls.at(-1)![1] as DesktopApi;
  for (const method of [
    'requestStopAll',
    'getOperationControlState',
  ] as const) {
    const f = api[method] as (...args: unknown[]) => Promise<unknown>;
    expect(f).toBeTypeOf('function');
    await expect(f('path')).rejects.toThrow('Request rejected');
    h.invoke.mockResolvedValueOnce(view);
    expect(await f()).toEqual(view);
    h.invoke.mockResolvedValueOnce({ ...view, privatePath: 'secret' });
    await expect(f()).rejects.toThrow('Request unavailable');
  }
  expect('invoke' in api).toBe(false);
});
