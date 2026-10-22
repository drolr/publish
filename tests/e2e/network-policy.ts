import type { BrowserContext } from '@playwright/test';
export async function denyExternalNetwork(context: BrowserContext) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      return route.continue();
    return route.abort('blockedbyclient');
  });
}
