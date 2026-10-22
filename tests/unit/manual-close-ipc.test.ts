import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { ManualState } from '../../src/contracts/manual-article';
const h = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    on: (name: string, fn: (...args: unknown[]) => void) =>
      h.listeners.set(name, fn),
    removeListener: (name: string) => h.listeners.delete(name),
  },
}));
import { registerManualCloseHandlers } from '../../src/desktop/main/manual-close-ipc';
import { manualCloseChannels } from '../../src/contracts/editor-close';
afterEach(() => {
  vi.useRealTimers();
  h.listeners.clear();
});
const id = '00000000-0000-4000-8000-000000000001';
function setup() {
  const frame = { url: 'file:///app/index.html' },
    send = vi.fn();
  const contents = { mainFrame: frame, send };
  let current = {
    state: 'editing',
    sessionId: id,
    documentRevision: 4,
  } as ManualState;
  let closed!: () => void;
  const protocol = registerManualCloseHandlers(
    {
      webContents: contents,
      once: (_: string, fn: () => void) => {
        closed = fn;
      },
    } as unknown as BrowserWindow,
    frame.url,
    () => current,
    () => id,
  );
  const ready = (...args: unknown[]) =>
    h.listeners.get(manualCloseChannels.ready)!(
      { sender: contents, senderFrame: frame },
      ...args,
    );
  return {
    protocol,
    ready,
    frame,
    contents,
    send,
    closed: () => closed(),
    setState: (sessionId: string, documentRevision: number) => {
      current = {
        state: 'editing',
        sessionId,
        documentRevision,
      } as ManualState;
    },
  };
}
it('ready validates exact origin/frame/arguments, enabled protocol never downgrades', async () => {
  const f = setup();
  expect(await f.protocol.requestFlush()).toBe(true);
  const ready = h.listeners.get(manualCloseChannels.ready)!;
  ready({ sender: {}, senderFrame: f.frame });
  ready({ sender: f.contents, senderFrame: { url: f.frame.url } });
  f.ready({ arbitrary: true });
  expect(f.protocol.enabled()).toBe(false);
  f.ready();
  expect(f.protocol.enabled()).toBe(true);
  const waiting = f.protocol.requestFlush();
  expect(f.send).toHaveBeenCalledWith(manualCloseChannels.request, {
    requestId: id,
  });
  expect(f.protocol.respond(id, id, 3, 'flushed')).toBe(false);
  expect(f.protocol.respond(id, 'foreign', 4, 'flushed')).toBe(false);
  expect(f.protocol.respond('foreign', id, 4, 'flushed')).toBe(false);
  expect(f.protocol.respond(id, id, 4, 'blocked')).toBe(true);
  expect(await waiting).toMatchObject({
    status: 'blocked',
    sessionId: id,
    documentRevision: 4,
  });
  expect(f.protocol.enabled()).toBe(true);
  expect(f.protocol.respond(id, id, 4, 'flushed')).toBe(false);
});
it('timeout and closed-window cancel only the pending request, keeping the protocol latch', async () => {
  vi.useFakeTimers();
  const f = setup();
  f.ready();
  const waiting = f.protocol.requestFlush();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await waiting).toBe(false);
  expect(f.protocol.enabled()).toBe(true);
  expect(f.protocol.respond(id, id, 4, 'flushed')).toBe(false);
  const second = f.protocol.requestFlush();
  f.closed();
  expect(await second).toBe(false);
});
it('matched blocked result carries request proof that a newer request or window closure retires', async () => {
  const f = setup();
  f.ready();
  const pending = f.protocol.requestFlush();
  f.protocol.respond(id, id, 4, 'blocked');
  const proof = await pending;
  expect(proof).toMatchObject({
    requestId: id,
    sessionId: id,
    documentRevision: 4,
    status: 'blocked',
  });
  expect(f.protocol.isCurrentBlocked(proof)).toBe(true);
  const next = f.protocol.requestFlush();
  expect(f.protocol.isCurrentBlocked(proof)).toBe(false);
  f.closed();
  await next;
});
it('a mismatched current session retires blocked proof permanently', async () => {
  const f = setup();
  f.ready();
  const waiting = f.protocol.requestFlush();
  f.protocol.respond(id, id, 4, 'blocked');
  const proof = await waiting;
  f.setState('foreign', 4);
  expect(f.protocol.isCurrentBlocked(proof)).toBe(false);
  f.setState(id, 4);
  expect(f.protocol.isCurrentBlocked(proof)).toBe(false);
});
