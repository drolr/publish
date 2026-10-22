import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { denyExternalNetwork } from './network-policy';
test('local toolchain fixture is readable and external network is blocked', async ({
  page,
  context,
}) => {
  await denyExternalNetwork(context);
  await page.setContent(
    readFileSync('tests/fixtures/toolchain/index.html', 'utf8'),
  );
  await expect(page.getByRole('main', { name: '工具链测试' })).toContainText(
    '本地测试页面',
  );
  const blocked = page.waitForEvent('requestfailed', {
    predicate: (request) =>
      request.url().startsWith('https://example.invalid/'),
  });
  await page.evaluate(() =>
    fetch('https://example.invalid/test').catch(() => null),
  );
  expect((await blocked).failure()?.errorText).toMatch(
    /^net::ERR_BLOCKED_BY_CLIENT(?:\.Inspector)?$/,
  );
});
