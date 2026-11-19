import {
  BrowserHealthViewSchema,
  BrowserHealthResultSchema,
  type BrowserHealthApi,
  type BrowserHealthView,
  type BrowserHealthResult,
} from '../contracts/browser-health';
import type { BrowserHealthRuntime } from '../domain/ports/browser-health';
const unchecked = (): BrowserHealthView => ({
  status: 'unchecked',
  version: null,
  stage: null,
  reason: null,
});
export function createBrowserHealthController(deps: {
  runtime: BrowserHealthRuntime;
  admission: () => BrowserHealthView['reason'];
  operationEpoch: () => number;
  invalidateOperation: () => void;
}): BrowserHealthApi & { dispose(): void } {
  let view = unchecked();
  let disposed = false,
    pending = false,
    maintenance = false;
  let observedEpoch = deps.operationEpoch();
  const unsubscribe = deps.runtime.subscribeHealth((value) => {
    if (disposed) return;
    const parsed = BrowserHealthViewSchema.safeParse(value);
    if (!parsed.success) return;
    const next = parsed.data;
    if (next.status === 'unchecked') {
      observedEpoch = deps.operationEpoch();
      if (!deps.runtime.isOccupied()) maintenance = false;
      view = next;
      return;
    }
    if (observedEpoch !== deps.operationEpoch()) return;
    // Diagnostic success is committed only after the runtime has released ownership.
    // Business-open success is emitted by the same runtime after binding its owner.
    if (next.status === 'passed' && !deps.runtime.hasBusinessSession()) return;
    if (next.status === 'update_open') {
      if (!deps.runtime.isOccupied()) return;
      maintenance = true;
    }
    view = next;
  });
  const blocked = (
    reason: BrowserHealthView['reason'],
  ): BrowserHealthResult => ({
    status: 'blocked',
    view: { status: 'busy', version: view.version, stage: null, reason },
  });
  function admission() {
    try {
      return (
        deps.admission() ??
        (deps.runtime.hasBusinessSession()
          ? 'business_open'
          : deps.runtime.isOccupied()
            ? maintenance
              ? 'maintenance_open'
              : 'ownership_unconfirmed'
            : pending
              ? 'ownership_unconfirmed'
              : null)
      );
    } catch {
      return 'task_busy' as const;
    }
  }
  async function operate(update: boolean): Promise<BrowserHealthResult> {
    const reason = admission();
    if (disposed || reason) return blocked(reason ?? 'task_busy');
    pending = true;
    let epoch = deps.operationEpoch();
    try {
      deps.invalidateOperation();
      epoch = deps.operationEpoch();
      observedEpoch = epoch;
      view = {
        status: 'checking',
        version: null,
        stage: update ? 'update' : 'launch',
        reason: null,
      };
      const result = BrowserHealthResultSchema.parse(
        await (update ? deps.runtime.openUpdate() : deps.runtime.checkHealth()),
      );
      if (disposed || epoch !== deps.operationEpoch())
        return blocked('task_busy');
      if (result.status === 'ok') {
        const occupied = deps.runtime.isOccupied();
        if (
          update
            ? result.view.status !== 'update_open' || !occupied
            : result.view.status !== 'passed' ||
              occupied ||
              deps.runtime.hasBusinessSession()
        ) {
          view = {
            status: 'check_failed',
            version: null,
            stage: 'cleanup',
            reason: 'ownership_unconfirmed',
          };
          return { status: 'blocked', view: { ...view } };
        }
        maintenance = update;
      }
      view = result.view;
      return { ...result, view: { ...view } };
    } catch {
      if (disposed || epoch !== deps.operationEpoch())
        return blocked('task_busy');
      view = {
        status: 'unavailable',
        version: null,
        stage: update ? 'update' : 'launch',
        reason: update ? 'update_unavailable' : null,
      };
      return { status: 'blocked', view: { ...view } };
    } finally {
      pending = false;
    }
  }
  function projection(): BrowserHealthView {
    if (disposed) return { ...view };
    const reason = admission();
    if (view.status === 'checking' && (pending || deps.runtime.isOccupied()))
      return { ...view };
    if (view.status === 'update_open' && deps.runtime.isOccupied())
      return { ...view };
    return reason ? blocked(reason).view : { ...view };
  }
  return {
    getBrowserHealth: async () => projection(),
    checkBrowserHealth: () => operate(false),
    openBrowserUpdate: () => operate(true),
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}
