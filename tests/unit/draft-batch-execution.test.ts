import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDraftHarness,
  type DraftHarness,
} from '../fixtures/draft-harness';
const harnesses: DraftHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
  const h = await createDraftHarness();
  harnesses.push(h);
  const probe = h.control.probe;
  if (probe.status !== 'ready') throw Error('not ready');
  const article = h.articles.loadEditableArticle(h.articleKey)!;
  const cover = h.snapshots.captureCover(h.articles.loadCover(h.articleKey)!);
  const reserved = h.tasks.reserve({
    taskId: randomUUID(),
    preparationId: randomUUID(),
    snapshot: await h.snapshots.capture(article.article),
    store: probe.store,
    expectedArticleRevision: article.articleRevision,
    expectedCoverRevision: cover.coverRevision,
    coverSnapshot: cover,
    now: h.control.now,
  });
  if (reserved.status !== 'created') throw Error('not reserved');
  return { h, task: reserved.task, generation: probe.generation };
}
it('executes a freshly reserved batch task through the same durable checkpoints once', async () => {
  const { h, task, generation } = await setup();
  h.control.pauseAt = 'none';
  const result = await h.api.executeBatchTask(task.taskId, generation);
  expect(result.state).toBe('draft_saved');
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  await expect(
    h.api.executeBatchTask(task.taskId, generation),
  ).rejects.toThrow();
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});
it('rejects changed session generation before any batch remote action', async () => {
  const { h, task } = await setup();
  const result = await h.api.executeBatchTask(task.taskId, randomUUID());
  expect(result).toMatchObject({
    state: 'needs_human',
    reason: 'STALE_PREPARATION',
    possibleRemoteEffect: false,
  });
  expect(h.calls).not.toContain('execute');
});
it('a stop while verifying a reserved snapshot prevents any batch remote action', async () => {
  const { h, task, generation } = await setup();
  h.control.verify = async () => {
    h.api.requestStop();
  };
  const result = await h.api.executeBatchTask(task.taskId, generation);
  expect(result).toMatchObject({
    state: 'stopped',
    possibleRemoteEffect: false,
  });
  expect(h.calls).not.toContain('execute');
});
