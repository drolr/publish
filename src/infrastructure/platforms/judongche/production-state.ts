import { createHash } from 'node:crypto';
import type { Page, ElementHandle } from 'playwright-core';
import type { ReasonCode, StoreBinding } from '../../../contracts/draft-task';

/** Structural observations only. No attributes, text, style URLs or HTML leave the page. */
export type OverlayDiagnostic = {
  tag: string;
  widthRatio: number;
  heightRatio: number;
  pointerEventsNone: boolean;
  interactiveDescendants: number;
  childCount: number;
  hasBackgroundImage: boolean;
  hasText: boolean;
  hasShadowRoot: boolean;
  opacity: number;
};

export class JudongchePageError extends Error {
  constructor(
    readonly reason: ReasonCode,
    readonly check: string = 'guard-rejected',
    readonly overlay?: OverlayDiagnostic,
  ) {
    super(reason);
  }
}
/** Internal page-producer claim, never derived from exception text. A future
 * production producer needs evidence for every field; G1 supplies none today.
 * T5 independently rereads the unchanged editor/session/body before using it. */
export type CoverRequiredNoSaveProof = {
  explicitRejection: true;
  remoteRecordAbsent: true;
  noPendingSave: true;
  autosaveExcluded: true;
};
export class JudongcheCoverRequiredError extends JudongchePageError {
  constructor(readonly noSaveProof?: CoverRequiredNoSaveProof) {
    super('COVER_REQUIRED');
  }
}

/** Classify locally; never return the exception message or its page contents. */
export function exceptionCategory(error: unknown) {
  if (error instanceof JudongchePageError) return 'platform-guard';
  if (!(error instanceof Error)) return 'non-error';
  if (error.name === 'TimeoutError') return 'timeout';
  if (/strict mode violation/i.test(error.message)) return 'locator-not-unique';
  if (
    /Target .*closed|page.*closed|context.*closed|browser.*closed/i.test(
      error.message,
    )
  )
    return 'target-closed';
  if (/Execution context was destroyed/i.test(error.message))
    return 'navigation-interrupted';
  if (/not attached|detached from the DOM/i.test(error.message))
    return 'element-detached';
  return 'error';
}
export const fail = (reason: ReasonCode, check = 'guard-rejected'): never => {
  throw new JudongchePageError(reason, check);
};
export const origin = 'https://www.autoengine.com';
export const paths = {
  home: '/jdc/cps/home',
  editor: '/jdc/dealer/info/Article',
  list: '/jdc/dealer/info/contentPublish/content/index',
  marketing: '/jdc/dealer/info/contentPublish/sceneMarketing',
};
export function knownUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // Observed content-management article tab (2026-10-14). Keep this alias
    // exact: pageTab is not a general-purpose allowance on other pages.
    if (url.pathname === '/jdc/dealer/info/contentPublish/content/index-cps2') {
      const entries = [...url.searchParams.entries()];
      return (
        url.origin === origin &&
        !url.username &&
        !url.password &&
        !url.hash &&
        entries.length === 1 &&
        entries[0]?.[0] === 'pageTab' &&
        entries[0]?.[1] === '0'
      );
    }
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      ['/', ...Object.values(paths)].includes(url.pathname) &&
      [...url.searchParams.keys()].every((key) =>
        ['pgc_id', 'pgc_status'].includes(key),
      )
    );
  } catch {
    return false;
  }
}

/** E40 and the fail-closed safety rules. Article text is never a safety signal. */
export async function assertSafe(
  page: Page,
  imageDialog = false,
  verifiedSelectionModal?: ElementHandle<Element>,
): Promise<void> {
  if (!knownUrl(page.url())) fail('PAGE_CHANGED', 'url-not-allowed');
  if (await page.getByText('巨懂车欢迎您', { exact: true }).isVisible())
    fail('LOGIN_REQUIRED');
  const state = await page.evaluate(
    ({ allowImage, verifiedSelectionModal }) => {
      const visible = (e: Element) =>
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility === 'visible';
      const leaves = Array.from(document.querySelectorAll('body *')).filter(
        (e) =>
          visible(e) &&
          !e.children.length &&
          !e.closest('[contenteditable],textarea,input'),
      );
      if (
        leaves.some((e) =>
          /验证码|安全验证|身份验证|账号异常|帐号异常|风险提示|安全提示|人机验证/.test(
            e.textContent || '',
          ),
        )
      )
        return 'VERIFICATION_REQUIRED';
      if (
        leaves.some((e) =>
          /暂无权限|无权限访问|权限不足/.test(e.textContent || ''),
        )
      )
        return 'PERMISSION_DENIED';
      if (Array.from(document.querySelectorAll('iframe')).some(visible))
        return 'visible-iframe';
      const dialogs = Array.from(
        document.querySelectorAll(
          '[role="dialog"],[aria-modal="true"],.ant-modal',
        ),
      ).filter(visible);
      const filelessOwnedUpload = (dialog: Element) => {
        if (
          dialog !== verifiedSelectionModal ||
          dialog.querySelectorAll('input[type=file]').length !== 0
        )
          return false;
        const elements = Array.from(dialog.querySelectorAll('*')).filter(
          visible,
        );
        const leaf = (text: string) =>
          elements.filter(
            (n) => !n.childElementCount && n.textContent?.trim() === text,
          ).length === 1;
        const buttons = (text: string) =>
          elements.filter(
            (n) => n.tagName === 'BUTTON' && n.textContent?.trim() === text,
          ).length === 1;
        return (
          leaf('上传图片') &&
          leaf('上传完成，可以拖拽调整图片顺序') &&
          buttons('确定') &&
          buttons('取消') &&
          dialog.querySelectorAll('img').length === 1
        );
      };
      const image =
        allowImage &&
        dialogs.length === 1 &&
        (dialogs[0]!.querySelectorAll('input[type=file]').length === 1 ||
          filelessOwnedUpload(dialogs[0]!))
          ? dialogs[0]!
          : null;
      if (dialogs.some((dialog) => dialog !== image)) return 'unknown-dialog';
      // Unrecognized blocking overlays must not be clicked through.
      const overlay = Array.from(document.querySelectorAll('body *')).find(
        (e) => {
          if (
            !visible(e) ||
            (allowImage &&
              e.closest('[role="dialog"],[aria-modal="true"],.ant-modal'))
          )
            return false;
          // Only the unique approved image dialog's own structural wrapper or
          // empty Arco backdrop is permitted. Unrelated overlays remain unknown.
          if (
            image &&
            (e.contains(image) ||
              (e.classList.contains('arco-modal-mask') &&
                !e.textContent?.trim() &&
                !e.querySelector('input,button,a,[role="button"]') &&
                e.parentElement ===
                  image.closest('.arco-modal-wrapper')?.parentElement))
          )
            return false;
          const s = getComputedStyle(e),
            r = e.getBoundingClientRect();
          // Observed 2026-09-28: a full-viewport, empty background-only div
          // cannot intercept input. Size alone must not classify it as a dialog.
          // Content, descendants, semantic controls and solid masks still stop.
          if (
            e.tagName === 'DIV' &&
            s.pointerEvents === 'none' &&
            e.childElementCount === 0 &&
            !e.textContent?.trim() &&
            !e.shadowRoot &&
            !e.matches('[role],[aria-modal],[tabindex],[contenteditable]') &&
            s.backgroundImage !== 'none' &&
            ['transparent', 'rgba(0, 0, 0, 0)'].includes(s.backgroundColor)
          )
            return false;
          return (
            s.position === 'fixed' &&
            r.width > innerWidth * 0.7 &&
            r.height > innerHeight * 0.7
          );
        },
      );
      if (overlay) {
        const style = getComputedStyle(overlay);
        const rect = overlay.getBoundingClientRect();
        const tag = overlay.tagName.toLowerCase();
        const details: OverlayDiagnostic = {
          tag: ['div', 'section', 'main', 'aside', 'span'].includes(tag)
            ? tag
            : 'other',
          widthRatio: Math.round((rect.width / innerWidth) * 100) / 100,
          heightRatio: Math.round((rect.height / innerHeight) * 100) / 100,
          pointerEventsNone: style.pointerEvents === 'none',
          interactiveDescendants: Math.min(
            10000,
            overlay.querySelectorAll(
              'input,button,a,select,textarea,[role="button"],[contenteditable],[tabindex]',
            ).length,
          ),
          childCount: Math.min(10000, overlay.childElementCount),
          hasBackgroundImage: style.backgroundImage !== 'none',
          hasText: !!overlay.textContent?.trim(),
          hasShadowRoot: !!overlay.shadowRoot,
          opacity: Number(style.opacity),
        };
        return { check: 'blocking-overlay', overlay: details };
      }
      return null;
    },
    { allowImage: imageDialog, verifiedSelectionModal },
  );
  if (state) {
    if (typeof state === 'object')
      throw new JudongchePageError('PAGE_CHANGED', state.check, state.overlay);
    if (state === 'VERIFICATION_REQUIRED' || state === 'PERMISSION_DENIED')
      fail(state);
    fail('PAGE_CHANGED', state);
  }
}

/** E54: current-login badge and the name must belong to the same store card.
 * No account name is compiled into the adapter. Ambiguous header/menu stops. */
export type MenuObservation = {
  point: 'before-hover' | 'after-hover' | 'badge-visible' | 'failure';
  entryCount: number;
  entryVisible: boolean;
  entryHovered: boolean;
  entryCenterHit: boolean;
  badgeCount: number;
  visibleBadges: number;
  documentFocused: boolean;
  documentVisible: boolean;
  documentChanged: boolean;
};

export async function confirmMenuStore(
  page: Page,
  expected: string,
  diagnostic?: {
    step(value: string): void;
    failure(error: unknown): void;
    observation?(value: MenuObservation): void;
  },
): Promise<void> {
  diagnostic?.step('menu-safety');
  await assertSafe(page);
  let opened = false;
  let account = '';
  let documentEpoch: number | undefined;
  async function observe(point: MenuObservation['point']) {
    if (!diagnostic?.observation) return;
    try {
      const { epoch, ...state } = await page.evaluate((name) => {
        const visible = (e: Element) =>
          e.getClientRects().length > 0 &&
          getComputedStyle(e).visibility === 'visible';
        const entries = Array.from(
          document.querySelectorAll('header *,[role="banner"] *'),
        ).filter((e) => !e.children.length && e.textContent?.trim() === name);
        const entry = entries.length === 1 ? entries[0] : undefined;
        const rect = entry?.getBoundingClientRect();
        const hit = rect
          ? document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            )
          : null;
        const badges = Array.from(document.querySelectorAll('body *')).filter(
          (e) => !e.children.length && e.textContent?.trim() === '当前登录',
        );
        return {
          epoch: performance.timeOrigin,
          entryCount: Math.min(entries.length, 100),
          entryVisible: !!entry && visible(entry),
          entryHovered: !!entry?.matches(':hover'),
          entryCenterHit:
            !!entry && !!hit && (entry === hit || entry.contains(hit)),
          badgeCount: Math.min(badges.length, 100),
          visibleBadges: Math.min(badges.filter(visible).length, 100),
          documentFocused: document.hasFocus(),
          documentVisible: document.visibilityState === 'visible',
        };
      }, account);
      documentEpoch ??= epoch;
      diagnostic.observation({
        point,
        ...state,
        documentChanged: epoch !== documentEpoch,
      });
    } catch {
      /* Observation cannot change the safety result. */
    }
  }
  if (!(await page.getByText('当前登录', { exact: true }).isVisible())) {
    diagnostic?.step('menu-banner');
    const banner = page.getByRole('banner');
    await banner.waitFor({ state: 'visible', timeout: 10000 });
    if ((await banner.count()) !== 1) fail('STORE_UNCONFIRMED');
    diagnostic?.step('menu-account-candidates');
    const candidates = await banner.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return Array.from(node.querySelectorAll('*'))
        .filter((e) => {
          const r = e.getBoundingClientRect(),
            t = (e.textContent || '').trim();
          return (
            !e.children.length &&
            r.width > 0 &&
            r.left > box.left + box.width * 0.7 &&
            t.length > 0 &&
            !/^(会话|帮助中心|通知|功能引导|\d+\+?)$/.test(t) &&
            !e.closest('a')
          );
        })
        .map((e) => (e.textContent || '').trim());
    });
    if (candidates.length !== 1) fail('STORE_UNCONFIRMED');
    account = candidates[0]!;
    await observe('before-hover');
    const entry = banner.getByText(account, { exact: true });
    diagnostic?.step('menu-account-leave');
    // One initial entry transition, never a retry after an ambiguous outcome.
    await banner.hover({ position: { x: 1, y: 1 }, timeout: 5000 });
    await entry
      .and(page.locator(':hover'))
      .waitFor({ state: 'hidden', timeout: 5000 });
    diagnostic?.step('menu-account-open');
    // Owner-confirmed hover menu. A click can toggle the menu after mouse entry.
    const hoverDocument = {
      url: page.url(),
      epoch: await page.evaluate(() => performance.timeOrigin),
    };
    let acknowledged = true;
    try {
      await entry.hover({ timeout: 5000 });
    } catch (error) {
      if (exceptionCategory(error) !== 'timeout') throw error;
      diagnostic?.step('menu-account-timeout-evidence');
      const badge = page.getByText('当前登录', { exact: true });
      if (
        page.url() !== hoverDocument.url ||
        (await page.evaluate(() => performance.timeOrigin)) !==
          hoverDocument.epoch ||
        (await badge.count()) !== 1 ||
        !(await badge.isVisible())
      )
        throw error;
      await assertSafe(page);
      acknowledged = false;
    }
    await observe('after-hover');
    if (acknowledged) {
      diagnostic?.step('menu-account-hover-state');
      await entry
        .and(page.locator(':hover'))
        .waitFor({ state: 'visible', timeout: 5000 });
    }
    opened = true;
  }
  try {
    diagnostic?.step('menu-current-login-badge');
    await page
      .getByText('当前登录', { exact: true })
      .waitFor({ state: 'visible', timeout: 5000 });
    await observe('badge-visible');
    diagnostic?.step('menu-open-safety');
    await assertSafe(page);
    diagnostic?.step('menu-store-card');
    const matches = await page.evaluate((name) => {
      const visible = (e: Element) =>
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility === 'visible';
      const leaves = Array.from(document.querySelectorAll('body *')).filter(
        (e) => !e.children.length && visible(e),
      );
      const badges = leaves.filter((e) => e.textContent?.trim() === '当前登录');
      const names = leaves.filter((e) => e.textContent?.trim() === name);
      if (
        badges.length !== 1 ||
        names.length !== 1 ||
        !leaves.some((e) => e.textContent?.trim() === '全部业务')
      )
        return false;
      let node: Element | null = badges[0]!;
      for (
        let depth = 0;
        node && depth < 6;
        depth++, node = node.parentElement
      ) {
        if (!node.contains(names[0]!)) continue;
        const text = node.textContent || '';
        return (
          (text.match(/角色/g) || []).length === 1 &&
          !/全部业务|退出登录/.test(text)
        );
      }
      return false;
    }, expected);
    if (!matches) fail('STORE_CHANGED');
  } catch (error) {
    await observe('failure');
    diagnostic?.failure(error);
    throw error;
  } finally {
    if (opened && account) {
      diagnostic?.step('menu-account-close');
      await page
        .getByRole('banner')
        .hover({ position: { x: 1, y: 1 }, timeout: 5000 });
      await page
        .getByText('当前登录', { exact: true })
        .waitFor({ state: 'hidden', timeout: 5000 });
    }
  }
}

export function storeBinding(id: string, name: string): StoreBinding {
  return {
    storeKey: createHash('sha256')
      .update('judongche:dealer_id\0')
      .update(id)
      .digest('hex'),
    displayName: name,
    identity: { source: 'visible-shop-link', value: id },
  };
}
