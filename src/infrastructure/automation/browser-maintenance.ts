import type { BrowserContext, Page } from 'playwright-core';
import { bounded, BrowserHealthFailure } from './browser-health-check';
const updateUrl = 'edge://settings/help';
const allowed = (url: string) =>
  url === updateUrl || url.startsWith(updateUrl + '#');
export async function openMaintenancePage(
  context: BrowserContext,
  signal: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void context.close().catch(() => undefined);
  };
  context.on('close', () => {
    closing = true;
  });
  try {
    await bounded(
      async () => {
        await context.route('**/*', (route) =>
          allowed(route.request().url()) ? route.continue() : route.abort(),
        );
        const guard = (page: Page) => {
          page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame() && !allowed(frame.url())) close();
          });
        };
        // A persistent context normally already has a blank page. Own that page too.
        const page = context.pages()[0] ?? (await context.newPage());
        for (const extra of context.pages()) {
          if (extra !== page) await extra.close();
        }
        context.on('page', (extra) => {
          guard(extra);
          void extra.close().catch(close);
        });
        guard(page);
        page.on('close', close);
        await page.goto(updateUrl, { timeout: 5000 });
      },
      5000,
      controller,
      'update',
    );
  } catch (error) {
    throw error instanceof BrowserHealthFailure
      ? error
      : new BrowserHealthFailure('update', 'update_unavailable', 'unavailable');
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
