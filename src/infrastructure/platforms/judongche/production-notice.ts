import type { Page } from 'playwright-core';
import {
  assertSafe,
  JudongchePageError,
  origin,
  paths,
} from './production-state';

// Observed 2026-10-16: a dismiss-only inventory reminder, not verification.
// No inventory link is opened and no merchant configuration is changed.
const noticeText =
  '通知公告' +
  '您有门店实车信息配置缺失，会影响现车等im线索，需尽快配置' +
  '懂车帝实车信息管理页面由于关联ai小懂，并展示于门店车系页/im页面，现需维护门店现车、展车、试驾车信息，14天未更新自动标黄，30天未更新暂停Al使用，未维护页面点无需更新即可，或一键配置即可配置完毕进行展示。' +
  '关闭去看看';

export async function assertEntrySafe(
  page: Page,
  beforeClose: () => void = () => {},
): Promise<void> {
  try {
    await assertSafe(page);
    return;
  } catch (error) {
    if (
      !(error instanceof JudongchePageError) ||
      error.check !== 'unknown-dialog' ||
      page.url() !== origin + paths.editor
    )
      throw error;
    const dialogs = page.locator(
      '[role="dialog"]:visible,[aria-modal="true"]:visible,.ant-modal:visible',
    );
    if ((await dialogs.count()) !== 1) throw error;
    const notice = dialogs.first();
    const matches = await notice.evaluate(
      (node, text) =>
        node.textContent?.replace(/\s+/g, '') === text &&
        node.querySelectorAll('button').length === 2 &&
        Array.from(node.querySelectorAll('button'))
          .map((b) => b.textContent?.trim())
          .join('|') === '关闭|去看看' &&
        node.querySelectorAll(
          'input,textarea,select,iframe,[contenteditable],a',
        ).length === 0,
      noticeText,
    );
    if (!matches) throw error;
    // Check again immediately before the sole close action; safety warnings
    // added while inspecting the notice still block rather than being dismissed.
    try {
      await assertSafe(page);
    } catch (current) {
      if (
        !(current instanceof JudongchePageError) ||
        current.check !== 'unknown-dialog'
      )
        throw current;
    }
    beforeClose();
    await notice
      .getByRole('button', { name: '关闭', exact: true })
      .click({ timeout: 3000 });
    await notice.waitFor({ state: 'hidden', timeout: 3000 });
    beforeClose();
    await assertSafe(page);
  }
}
