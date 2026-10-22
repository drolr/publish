import type {
  OperationControlApi,
  OperationControlView,
  OperationOwnerState,
  OperationScope,
} from '../contracts/operation-control';

export interface OperationOwner {
  requestStop(): void;
  settle?(): Promise<void>;
  state(): OperationOwnerState;
}

/** Signals every owner, then awaits owner-controlled release without erasing evidence. */
export function createOperationControl(
  owners: Partial<Record<OperationScope, OperationOwner>>,
): OperationControlApi & {
  isStopping(): boolean;
  hasUnresolvedStop(): boolean;
} {
  let requested = false;
  let waiting = false;
  let review = false;
  let revision = 0;
  let previous = '';
  const settling = new Set<OperationScope>();
  const failures = new Set<OperationScope>();
  const entries = Object.entries(owners) as Array<
    [OperationScope, OperationOwner]
  >;
  function view(): OperationControlView {
    const states = entries.map(([scope, owner]) => {
      let state: OperationOwnerState;
      try {
        state = settling.has(scope) ? 'active' : owner.state();
        if (state !== 'active' && failures.has(scope)) state = 'needs_review';
      } catch {
        failures.add(scope);
        state = 'needs_review';
      }
      return { scope, state };
    });
    const active = states.some((s) => s.state === 'active');
    if (requested && !waiting && active) requested = false;
    const phase = !requested
      ? failures.size > 0 || review
        ? 'needs_review'
        : 'idle'
      : active
        ? 'stopping'
        : states.some((s) => s.state === 'needs_review')
          ? 'needs_review'
          : 'stopped';
    if (requested && !active) {
      waiting = false;
      review = phase === 'needs_review';
    }
    const fingerprint = JSON.stringify({ phase, owners: states });
    if (fingerprint !== previous) {
      revision++;
      previous = fingerprint;
    }
    return { revision, phase, owners: states };
  }
  return {
    hasUnresolvedStop: () =>
      failures.size > 0 || ['stopping', 'needs_review'].includes(view().phase),
    isStopping: () => requested && view().phase === 'stopping',
    getOperationControlState: async () => view(),
    requestStopAll() {
      const before = view();
      if (requested && before.phase === 'stopping')
        return Promise.resolve(before);
      requested = true;
      waiting = true;
      review = false;
      // Signal all owners before yielding; one failure cannot prevent another stop.
      for (const [scope, owner] of entries) {
        try {
          owner.requestStop();
          failures.delete(scope);
        } catch {
          failures.add(scope);
        }
      }
      for (const [scope, owner] of entries) {
        if (!owner.settle || failures.has(scope)) continue;
        settling.add(scope);
        void Promise.resolve()
          .then(() => owner.settle!())
          .catch(() => {
            failures.add(scope);
          })
          .finally(() => settling.delete(scope));
      }
      return Promise.resolve(view());
    },
  };
}
