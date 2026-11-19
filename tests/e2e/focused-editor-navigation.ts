import { expect, type Page } from '@playwright/test';
/** T7 clean navigation is view-only: assert the canonical editor session is retained. */
export async function returnToArticlePool(page: Page) {
  const back = page.getByRole('button', { name: '返回文章池', exact: true });
  if (!(await back.isVisible())) return;
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.desktopApi
          .getManualArticleState()
          .then((s) => s.state === 'editing' && !s.dirty),
      ),
    )
    .toBe(true);
  const before = await page.evaluate(() =>
    window.desktopApi.getManualArticleState(),
  );
  await back.click();
  await expect(
    page.getByRole('button', { name: '新建文章', exact: true }),
  ).toBeVisible();
  if ('sessionId' in before) {
    expect(before.dirty).toBe(false);
    const after = await page.evaluate(() =>
      window.desktopApi.getManualArticleState(),
    );
    expect(after).toMatchObject({
      state: 'editing',
      sessionId: before.sessionId,
      dirty: false,
      draft: before.draft,
    });
  }
}
