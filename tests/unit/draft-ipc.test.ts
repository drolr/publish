import { it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { draftChannels, type DraftApi } from '../../src/contracts/draft-task';
const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      harness.handlers.set(name, handler),
    removeHandler: (name: string) => harness.handlers.delete(name),
  },
}));
import { registerDraftHandlers } from '../../src/desktop/main/draft-ipc';
it('guards all draft capabilities before invocation and sanitizes invalid outputs', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  let closed!: () => void;
  const window = {
    webContents: contents,
    once: (_: string, fn: () => void) => {
      closed = fn;
    },
  };
  const view = {
    session: {
      status: 'closed',
      bindingToken: null,
      storeName: null,
      reason: null,
    },
    preparation: null,
    task: null,
  };
  const methods = Object.keys(draftChannels) as (keyof DraftApi)[];
  const payloads: Record<keyof DraftApi, unknown[]> = {
    finishHandledTask: [{ taskId: id, expectedRevision: 0 }],
    openDraftSession: [],
    checkDraftSession: [],
    closeDraftSession: [],
    prepareDraft: [id, id],
    startDraft: [id],
    getDraftState: [],
    stopDraft: [id],
    reconcileDraft: [id],
    prepareTaskClosure: [id],
    confirmTaskClosure: [id],
    openSavedDraft: [id],
  };
  const api = Object.fromEntries(
    methods.map((method) => [
      method,
      vi.fn(async (): Promise<unknown> =>
        method === 'getDraftState'
          ? view
          : method === 'prepareDraft'
            ? { status: 'blocked', reason: 'PAGE_CHANGED' }
            : { status: 'ok', view },
      ),
    ]),
  );
  registerDraftHandlers(
    window as unknown as BrowserWindow,
    frame.url,
    api as unknown as DraftApi,
  );
  expect(harness.handlers.size).toBe(12);
  for (const method of methods) {
    const handler = harness.handlers.get(draftChannels[method])!;
    const event = { sender: contents, senderFrame: frame };
    for (const bad of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: frame.url } },
      { sender: contents, senderFrame: null },
    ])
      await expect(handler(bad, ...payloads[method])).rejects.toThrow(
        'Request rejected',
      );
    frame.url = 'https://example.invalid';
    await expect(handler(event, ...payloads[method])).rejects.toThrow(
      'Request rejected',
    );
    frame.url = 'file:///app/index.html';
    for (const injected of ['https://example.invalid', { path: 'C:/private' }])
      await expect(
        handler(event, ...payloads[method], injected),
      ).rejects.toThrow('Request rejected');
    expect(api[method]).not.toHaveBeenCalled();
    await handler(event, ...payloads[method]);
    expect(api[method]).toHaveBeenCalledTimes(1);
    api[method].mockRejectedValueOnce(new Error('C:/private/profile'));
    await expect(handler(event, ...payloads[method])).rejects.toThrow(
      'Request unavailable',
    );
    api[method].mockResolvedValueOnce({ ...view, privatePath: 'C:/private' });
    await expect(handler(event, ...payloads[method])).rejects.toThrow(
      'Request unavailable',
    );
  }
  const prepareHandler = harness.handlers.get(draftChannels.prepareDraft)!;
  await prepareHandler(
    { sender: contents, senderFrame: frame },
    id,
    id,
    'new_attempt',
  );
  expect(api.prepareDraft).toHaveBeenLastCalledWith(id, id, 'new_attempt');
  await expect(
    prepareHandler({ sender: contents, senderFrame: frame }, id, id, 'retry'),
  ).rejects.toThrow('Request rejected');
  closed();
  expect(harness.handlers.size).toBe(0);
});
