import { it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  browserHealthChannels,
  type BrowserHealthApi,
} from '../../src/contracts/browser-health';
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
import { registerBrowserHealthHandlers } from '../../src/desktop/main/browser-health-ipc';
it('validates fixed empty browser commands, source identity, responses and cleanup', async () => {
  const frame = { url: 'file:///app/index.html' },
    contents = { mainFrame: undefined as unknown };
  contents.mainFrame = frame;
  let closed!: () => void;
  const window = {
    webContents: contents,
    once: (_: string, fn: () => void) => {
      closed = fn;
    },
  };
  const view = {
    status: 'unchecked',
    version: null,
    stage: null,
    reason: null,
  };
  const api = {
    getBrowserHealth: vi.fn(async () => view),
    checkBrowserHealth: vi.fn(async () => ({ status: 'blocked', view })),
    openBrowserUpdate: vi.fn(async () => ({ status: 'blocked', view })),
  };
  registerBrowserHealthHandlers(
    window as unknown as BrowserWindow,
    frame.url,
    api as BrowserHealthApi,
  );
  expect(harness.handlers.size).toBe(3);
  for (const method of Object.keys(
    browserHealthChannels,
  ) as (keyof BrowserHealthApi)[]) {
    const handler = harness.handlers.get(browserHealthChannels[method])!;
    const event = { sender: contents, senderFrame: frame };
    for (const bad of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: frame.url } },
      { sender: contents, senderFrame: null },
    ])
      await expect(handler(bad)).rejects.toThrow('Request rejected');
    frame.url = 'https://example.invalid';
    await expect(handler(event)).rejects.toThrow('Request rejected');
    frame.url = 'file:///app/index.html';
    for (const injection of [
      'edge://settings/help',
      { path: 'C:/private' },
      '--no-sandbox',
    ])
      await expect(handler(event, injection)).rejects.toThrow(
        'Request rejected',
      );
    expect(api[method]).not.toHaveBeenCalled();
    await handler(event);
    api[method].mockResolvedValueOnce({ privatePath: 'private' } as never);
    await expect(handler(event)).rejects.toThrow('Request unavailable');
  }
  closed();
  expect(harness.handlers.size).toBe(0);
});
