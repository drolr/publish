import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright-core';
import { openMaintenancePage } from '../../src/infrastructure/automation/browser-maintenance';
it('opens only the fixed update target and blocks external requests', async () => {
  const page = Object.assign(new EventEmitter(), {
    goto: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    mainFrame: () => frame,
  });
  const frame = { url: () => 'edge://settings/help' };
  const context = Object.assign(new EventEmitter(), {
    pages: () => [],
    route: vi.fn(async (...args: unknown[]) => {
      void args;
    }),
    newPage: vi.fn(async () => page),
    on: vi.fn(),
  });
  await openMaintenancePage(
    context as unknown as BrowserContext,
    new AbortController().signal,
  );
  expect(page.goto).toHaveBeenCalledWith('edge://settings/help', {
    timeout: 5000,
  });
  const handler = context.route.mock.calls[0][1] as unknown as (
    route: unknown,
  ) => Promise<void>;
  const abort = vi.fn(async () => {}),
    go = vi.fn(async () => {});
  await handler({
    request: () => ({ url: () => 'https://example.com/' }),
    abort,
    continue: go,
  });
  expect(abort).toHaveBeenCalledOnce();
  expect(go).not.toHaveBeenCalled();
});
it('keeps its initial page open and closes attempted navigation away from help', async () => {
  let url = 'edge://settings/help';
  const frame = { url: () => url };
  const page = Object.assign(new EventEmitter(), {
    goto: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    mainFrame: () => frame,
  });
  const context = Object.assign(new EventEmitter(), {
    pages: () => [],
    route: vi.fn(async () => {}),
    newPage: vi.fn(async () => {
      context.emit('page', page);
      return page;
    }),
    close: vi.fn(async () => {}),
  });
  await openMaintenancePage(
    context as unknown as BrowserContext,
    new AbortController().signal,
  );
  expect(page.close).not.toHaveBeenCalled();
  url = 'edge://settings/help#about';
  page.emit('framenavigated', frame);
  expect(context.close).not.toHaveBeenCalled();
  url = 'about:blank';
  page.emit('framenavigated', frame);
  expect(context.close).toHaveBeenCalledOnce();
});
it('uses the fresh context initial page so no unguarded maintenance tab remains', async () => {
  const initial = Object.assign(new EventEmitter(), {
    goto: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    mainFrame: () => ({ url: () => 'edge://settings/help' }),
  });
  const context = Object.assign(new EventEmitter(), {
    route: vi.fn(async () => {}),
    pages: () => [initial],
    newPage: vi.fn(async () => {
      throw Error('should use initial page');
    }),
    close: vi.fn(async () => {}),
  });
  await openMaintenancePage(
    context as unknown as BrowserContext,
    new AbortController().signal,
  );
  expect(initial.goto).toHaveBeenCalledWith('edge://settings/help', {
    timeout: 5000,
  });
  expect(context.newPage).not.toHaveBeenCalled();
  initial.emit('close');
  expect(context.close).toHaveBeenCalledOnce();
});
