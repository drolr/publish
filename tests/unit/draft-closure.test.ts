import { expect, it } from 'vitest';
import { reduceTask } from '../../src/domain/draft-task';
import { makeDraftTask } from '../fixtures/draft-task';

const task = makeDraftTask({
  state: 'needs_human',
  stage: 'settled',
  possibleRemoteEffect: true,
  reason: 'PAGE_CHANGED',
});
const now = '2026-09-29T00:00:00.000Z';
const proof = {
  taskId: task.taskId,
  revision: task.revision,
  snapshotDigest: task.snapshot.digest,
  storeKey: task.store.storeKey,
  generation: 'session-1',
  checkedAt: now,
};
it('manual closure preserves historical flags and only releases an eligible task', () => {
  const closed = reduceTask(
    task,
    { type: 'close-without-save', proof, confirmedAt: now },
    now,
  );
  expect(closed).toMatchObject({
    state: 'closed_without_save',
    holdsPlatform: false,
    possibleRemoteEffect: true,
    saveAttempted: false,
    reason: 'PAGE_CHANGED',
    evidence: task.evidence,
    snapshot: task.snapshot,
  });
  expect(() => reduceTask(closed, { type: 'begin' }, now)).toThrow();
});
it('manual closure rejects saved, evidenced, running and mismatched proofs', () => {
  for (const changed of [
    { saveAttempted: true },
    { state: 'running' as const },
    {
      evidence: {
        ...task.evidence,
        remote: { recordKey: '1', editUrl: 'https://example.test/edit/1' },
      },
    },
  ]) {
    expect(() =>
      reduceTask(
        { ...task, ...changed },
        { type: 'close-without-save', proof, confirmedAt: now },
        now,
      ),
    ).toThrow();
  }
  expect(() =>
    reduceTask(
      task,
      {
        type: 'close-without-save',
        proof: { ...proof, revision: 1 },
        confirmedAt: now,
      },
      now,
    ),
  ).toThrow();
  expect(() =>
    reduceTask(
      task,
      { type: 'settle', state: 'failed', reason: 'PAGE_CHANGED' },
      now,
    ),
  ).toThrow();
});
