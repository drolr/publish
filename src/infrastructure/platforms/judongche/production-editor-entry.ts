import type { Page, Request } from 'playwright-core';
import { fail, origin } from './production-state';

export const createPath = '/motor/dealer_admin/go_api/article/create';

/** Bounded live state only: completed requests are not retained. */
function observeCreateSaves(page: Page) {
  const inflight = new Set<Request>();
  const checking = new Set<Request>();
  const pending = new Map<Request, { denied: 401 | 403 | null }>();
  let sequence = 0;
  let denied401 = 0;
  let denied403 = 0;
  let retired = 0;
  let disposed = false;
  const created = (request: Request) => {
    const url = new URL(request.url());
    if (
      url.origin !== origin ||
      url.pathname !== createPath ||
      request.method() !== 'POST'
    )
      return;
    inflight.add(request);
    checking.add(request);
    const record = { denied: null as 401 | 403 | null };
    pending.set(request, record);
    void request.response().then(
      (response) => {
        if (disposed) return;
        const status = response?.status();
        if (status === 401 || status === 403) {
          record.denied = status;
          if (status === 401) denied401 = ++sequence;
          else denied403 = ++sequence;
        }
        checking.delete(request);
        if (!inflight.has(request)) pending.delete(request);
      },
      () => {
        checking.delete(request);
        if (!inflight.has(request)) pending.delete(request);
      },
    );
  };
  const ended = (request: Request) => {
    inflight.delete(request);
    if (!checking.has(request)) pending.delete(request);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    page.off('request', created);
    page.off('requestfinished', ended);
    page.off('requestfailed', ended);
    page.off('close', dispose);
    inflight.clear();
    checking.clear();
    pending.clear();
  };
  page.on('request', created);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  page.on('close', dispose);
  const assertObserved = () => {
    if (disposed) fail('PAGE_CHANGED', 'editor-entry-observation-ended');
  };
  const assertNoPending = () => {
    if (inflight.size || checking.size)
      fail('RESULT_AMBIGUOUS', 'editor-entry-save-pending');
  };
  return {
    page,
    dispose,
    isActive: () => !disposed,
    assertIdle() {
      assertObserved();
      if (denied401 > retired)
        fail('LOGIN_REQUIRED', 'editor-entry-save-login');
      if (denied403 > retired)
        fail('PERMISSION_DENIED', 'editor-entry-save-permission');
      assertNoPending();
    },
    captureHandledDenials() {
      assertObserved();
      const boundary = sequence;
      // A response classified before the click is still NEW for this handoff
      // if its request had not ended. Keep these finite active-record references
      // through drain; a late 401/403 cannot be retired as settled history.
      const activeAtCapture = [...pending.values()];
      const assertIdle = () => {
        assertObserved();
        if (
          denied401 > boundary ||
          activeAtCapture.some((record) => record.denied === 401)
        )
          fail('LOGIN_REQUIRED', 'handoff-new-save-login');
        if (
          denied403 > boundary ||
          activeAtCapture.some((record) => record.denied === 403)
        )
          fail('PERMISSION_DENIED', 'handoff-new-save-permission');
        assertNoPending();
      };
      return {
        assertIdle,
        retire() {
          assertIdle();
          retired = Math.max(retired, boundary);
        },
      };
    },
  };
}

/** One entry-to-first-write owner. Every observed denial stays strict. */
export function observeEditorEntrySave(page: Page) {
  const observation = observeCreateSaves(page);
  return {
    page: observation.page,
    dispose: observation.dispose,
    isActive: observation.isActive,
    assertIdle: observation.assertIdle,
  };
}

/** Page lifetime owner; only explicit handled-task handoffs can retire history. */
export const observeLiveSaves = observeCreateSaves;

/** Exact existing save-control predicate, including uniqueness for entry admission. */
export async function entrySaveBusy(page: Page, requireUnique = true) {
  return page
    .getByRole('button', { name: '存草稿', exact: true })
    .evaluateAll((nodes, unique) => {
      if (unique && nodes.length !== 1) return true;
      return nodes.some(
        (node) =>
          (unique && !node.getClientRects().length) ||
          node.getAttribute('aria-busy') === 'true' ||
          node.classList.contains('arco-btn-loading'),
      );
    }, requireUnique);
}
