import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      harness.handlers.set(channel, handler);
    },
    removeHandler(channel: string) {
      harness.handlers.delete(channel);
    },
  },
}));
import { registerStatusHandler } from '../../src/desktop/main/ipc';
it('registered privileged handler rejects arguments and wrong sender before querying', () => {
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  let closed: (() => void) | undefined;
  const window = {
    webContents: contents,
    once(_event: string, callback: () => void) {
      closed = callback;
    },
  };
  const query = vi.fn(() => ({
    state: 'ready' as const,
    appVersion: '0.1.0',
    schemaVersion: 14 as const,
  }));
  registerStatusHandler(window as unknown as BrowserWindow, frame.url, query);
  expect([...harness.handlers.keys()]).toEqual(['app:get-status']);
  const handler = harness.handlers.get('app:get-status')!;
  const event = { sender: contents, senderFrame: frame };
  expect(() => handler(event, { path: 'untrusted' })).toThrow(
    'Request rejected',
  );
  expect(() => handler({ ...event, sender: {} })).toThrow('Request rejected');
  expect(query).not.toHaveBeenCalled();
  expect(handler(event)).toEqual({
    state: 'ready',
    appVersion: '0.1.0',
    schemaVersion: 14,
  });
  closed!();
  expect(harness.handlers.size).toBe(0);
});
