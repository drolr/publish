import { defineConfig } from '@playwright/test';
// Playwright 1.63 forces color in workers. Do not pass a conflicting NO_COLOR
// to those workers; this changes formatting only and retains all warnings.
delete process.env.NO_COLOR;
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  workers: 1,
  reporter: 'list',
  use: { serviceWorkers: 'block', launchOptions: { chromiumSandbox: true } },
});
