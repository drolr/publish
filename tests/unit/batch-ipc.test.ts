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
it('batch bridge is frozen and rejects invalid requests and private responses', async () => {
  await import('../../src/desktop/preload/index');
  const api = (h.expose.mock.calls.at(-1)![1] as DesktopApi).batch;
  expect(api).toBeDefined();
  expect(Object.isFrozen(api)).toBe(true);
  expect(Object.keys(api).sort()).toEqual([
    'archiveFinishedBatch',
    'finish',
    'getCurrent',
    'prepare',
    'skipCurrentAndContinue',
    'start',
    'stop',
  ]);
  for (const method of Object.keys(api) as (keyof typeof api)[]) {
    const call = api[method] as (...args: unknown[]) => Promise<unknown>;
    await expect(call('invalid')).rejects.toThrow('Request rejected');
  }
  expect(h.invoke).not.toHaveBeenCalled();
  h.invoke.mockResolvedValueOnce(null);
  expect(await api.getCurrent()).toBeNull();
  expect(h.invoke).toHaveBeenLastCalledWith('batch:state');
  h.invoke.mockResolvedValueOnce({ privatePath: 'secret' });
  await expect(api.getCurrent()).rejects.toThrow('Request unavailable');
});
it('batch handlers guard sender, frame, payload, response and close cleanup', async () => {
  const { registerBatchHandlers } =
    await import('../../src/desktop/main/batch-ipc');
  const frame = { url: 'file:///app/index.html' },
    contents = { mainFrame: frame };
  let closed!: () => void;
  const window = {
    webContents: contents,
    once: (_: string, cb: () => void) => {
      closed = cb;
    },
  };
  const getCurrent = vi.fn(async (): Promise<unknown> => null);
  const blocked = async () => ({
    status: 'blocked' as const,
    reason: 'TASK_BUSY' as const,
    view: null,
  });
  registerBatchHandlers(window as unknown as BrowserWindow, frame.url, {
    getCurrent,
    prepare: blocked,
    start: blocked,
    stop: blocked,
    finish: blocked,
    archiveFinishedBatch: blocked,
  } as unknown as DesktopApi['batch']);
  expect([...h.handlers.keys()].sort()).toEqual([
    'batch:archive-finished',
    'batch:finish',
    'batch:prepare',
    'batch:skip-current-and-continue',
    'batch:start',
    'batch:state',
    'batch:stop',
  ]);
  const archive = h.handlers.get('batch:archive-finished')!;
  await expect(
    archive(
      { sender: {}, senderFrame: frame },
      { batchId: '11111111-1111-4111-8111-111111111111' },
    ),
  ).rejects.toThrow('Request rejected');
  await expect(
    archive(
      { sender: contents, senderFrame: frame },
      { batchId: '11111111-1111-4111-8111-111111111111', deleteRemote: true },
    ),
  ).rejects.toThrow('Request rejected');
  const call = h.handlers.get('batch:state')!;
  await expect(call({ sender: {}, senderFrame: frame })).rejects.toThrow(
    'Request rejected',
  );
  await expect(
    call({ sender: contents, senderFrame: { ...frame } }),
  ).rejects.toThrow('Request rejected');
  await expect(
    call({ sender: contents, senderFrame: frame }, {}),
  ).rejects.toThrow('Request rejected');
  expect(getCurrent).not.toHaveBeenCalled();
  expect(await call({ sender: contents, senderFrame: frame })).toBeNull();
  getCurrent.mockResolvedValueOnce({ privatePath: 'secret' });
  await expect(call({ sender: contents, senderFrame: frame })).rejects.toThrow(
    'Request unavailable',
  );
  getCurrent.mockRejectedValueOnce(Error('secret'));
  await expect(call({ sender: contents, senderFrame: frame })).rejects.toThrow(
    'Request unavailable',
  );
  closed();
  expect(h.handlers.size).toBe(0);
});
