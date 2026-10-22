import type { DraftTask, ReasonCode } from '../contracts/draft-task';
import type { BatchItemState } from '../contracts/draft-batch';

export const batchLocalReasons: ReadonlySet<ReasonCode> = new Set([
  'INPUT_UNSUPPORTED',
  'TITLE_UNSUPPORTED',
  'IMAGE_FORMAT_UNSUPPORTED',
  'IMAGE_SIZE_UNSUPPORTED',
  'ASSET_UNAVAILABLE',
]);
export function classifyBatchTask(task: DraftTask): {
  state: BatchItemState;
  pause: boolean;
  reason: ReasonCode | null;
} {
  if (
    task.state === 'submission_recorded' &&
    !task.holdsPlatform &&
    task.saveAttempted &&
    task.possibleRemoteEffect &&
    task.stage === 'settled' &&
    task.evidence.submission &&
    !task.stopRequested
  )
    return { state: 'submission_recorded', pause: false, reason: task.reason };
  if (
    task.state === 'draft_saved' &&
    !task.holdsPlatform &&
    task.possibleRemoteEffect
  )
    return { state: 'draft_saved', pause: false, reason: null };
  if (
    task.state === 'failed' &&
    !task.holdsPlatform &&
    !task.possibleRemoteEffect &&
    task.reason !== null &&
    batchLocalReasons.has(task.reason)
  )
    return { state: 'failed', pause: false, reason: task.reason };
  if (
    task.state === 'stopped' &&
    !task.holdsPlatform &&
    !task.possibleRemoteEffect
  )
    return {
      state: 'stopped',
      pause: true,
      reason: task.reason ?? 'STOP_REQUESTED',
    };
  return {
    state: 'needs_human',
    pause: true,
    reason: task.reason ?? 'RESULT_AMBIGUOUS',
  };
}
export function batchCounts(items: ReadonlyArray<{ state: BatchItemState }>) {
  const count = (state: BatchItemState) =>
    items.filter((i) => i.state === state).length;
  return {
    total: items.length,
    saved: count('draft_saved'),
    attempted: count('submission_recorded'),
    failed: count('failed'),
    skipped: count('skipped'),
    pending: count('queued') + count('running'),
    needsHuman: count('needs_human'),
    stopped: count('stopped'),
  };
}
