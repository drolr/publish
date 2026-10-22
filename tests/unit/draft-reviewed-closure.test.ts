import { expect, it } from 'vitest';
import { reduceTask } from '../../src/domain/draft-task';
import { makeDraftTask } from '../fixtures/draft-task';

const now = '2026-10-13T07:00:00.000Z';
const task = makeDraftTask({
  state: 'needs_human',
  stage: 'settled',
  saveAttempted: true,
  possibleRemoteEffect: true,
  reason: 'RESULT_AMBIGUOUS',
});
const proof = {
  taskId: task.taskId,
  revision: task.revision,
  snapshotDigest: task.snapshot.digest,
  storeKey: task.store.storeKey,
  generation: 'session-1',
  checkedAt: now,
  basis: 'owner-reviewed-ambiguous-save' as const,
};
it('reviewed ambiguous closure preserves attempted save and evidence without claiming success or allowing replay', () => {
  const closed = reduceTask(
    task,
    { type: 'close-after-review', proof, confirmedAt: now },
    now,
  );
  expect(closed).toEqual({
    ...task,
    state: 'closed_after_review',
    holdsPlatform: false,
    revision: 1,
    updatedAt: now,
  });
  expect(() => reduceTask(closed, { type: 'begin' }, now)).toThrow();
  expect(() =>
    reduceTask(
      task,
      { type: 'settle', state: 'failed', reason: 'RESULT_AMBIGUOUS' },
      now,
    ),
  ).toThrow();
});
it('reviewed ambiguous closure rejects missing basis, stale identity, and unattempted or active tasks', () => {
  for (const changed of [
    { revision: 1 },
    { taskId: '55555555-5555-4555-8555-555555555555' },
    { snapshotDigest: 'f'.repeat(64) },
    { storeKey: 'f'.repeat(64) },
    { basis: undefined },
  ]) {
    expect(() =>
      reduceTask(
        task,
        {
          type: 'close-after-review',
          proof: { ...proof, ...changed },
          confirmedAt: now,
        } as never,
        now,
      ),
    ).toThrow();
  }
  for (const changed of [
    { saveAttempted: false },
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
        { type: 'close-after-review', proof, confirmedAt: now },
        now,
      ),
    ).toThrow();
  }
});
it('reviewed closure retains all three ordered body-image evidence records', () => {
  const imageTask = structuredClone(task);
  for (let index = 0; index < 3; index++) {
    const assetKey = `00000000-0000-4000-8000-00000000000${index}`;
    const imageId = `image-${index}`;
    imageTask.snapshot.article.body.push({ type: 'image', image_id: imageId });
    imageTask.snapshot.article.assets.push({
      assetKey,
      imageId,
      relativePath: `${imageTask.articleKey}/${assetKey}.jpg`,
      mime: 'image/jpeg',
      byteSize: 1,
      width: 1,
      height: 1,
      sha256: 'a'.repeat(64),
    });
    imageTask.evidence.images.push({
      bodyIndex: index + 1,
      imageId,
      assetKey,
      resourceKey: String(index + 1).repeat(64),
    });
  }
  const original = structuredClone(imageTask);
  const closed = reduceTask(
    imageTask,
    { type: 'close-after-review', proof, confirmedAt: now },
    now,
  );
  expect(closed.evidence).toEqual(original.evidence);
  expect(closed.evidence.images).toHaveLength(3);
  expect(closed.snapshot).toEqual(original.snapshot);
  expect(imageTask).toEqual(original);
});
