import { afterEach, expect, it, vi } from 'vitest';
import {
  createDraftHarness,
  type DraftHarness,
} from '../fixtures/draft-harness';
const harnesses: DraftHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
it('explicit stop releases an ambiguous save without erasing evidence or replaying it', async () => {
  const h = await createDraftHarness(0);
  harnesses.push(h);
  h.control.pauseAt = 'none';
  h.control.outcome = { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
  const session = await h.api.openDraftSession();
  const prepared = await h.api.prepareDraft(
    h.articleKey,
    session.view.session.bindingToken!,
  );
  if (prepared.status !== 'ready') throw Error('not ready');
  await h.api.startDraft(prepared.preparation.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const old = (await h.api.getDraftState()).task!;
  expect(old.possibleRemoteEffect).toBe(true);
  await h.api.stopForRestart();
  expect(h.api.isBlocked()).toBe(false);
  const retained = h.tasks.get(old.taskId)!;
  expect(retained.state).toBe('stopped_by_user');
  expect(retained.saveAttempted).toBe(true);
  expect(retained.possibleRemoteEffect).toBe(true);
  expect(retained.holdsPlatform).toBe(false);
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  const reopened = await h.api.openDraftSession();
  expect(
    (
      await h.api.prepareDraft(
        h.articleKey,
        reopened.view.session.bindingToken!,
      )
    ).status,
  ).toBe('ready');
  const fresh = await h.restart();
  expect(fresh.isBlocked()).toBe(false);
  expect(h.tasks.get(old.taskId)?.saveAttempted).toBe(true);
});

it('keeps admission closed until the stopped writer really exits', async () => {
  const h = await createDraftHarness(0);
  harnesses.push(h);
  h.control.pauseAt = 'after-body';
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.calls).toContain('fill'));
  const stopping = h.api.stopForRestart();
  await vi.waitFor(() => expect(h.calls).toContain('close'));
  expect(h.api.isBlocked()).toBe(true);
  expect(h.tasks.occupied()).toBeDefined();
  h.releaseExecute();
  await stopping;
  expect(h.api.isActive()).toBe(false);
  expect(h.api.isBlocked()).toBe(false);
  expect(h.calls).not.toContain('save');
  expect(h.tasks.latest()?.state).toBe('stopped_by_user');
});
it('does not release admission if the owned browser cannot be closed', async () => {
  const h = await createDraftHarness(0);
  harnesses.push(h);
  h.control.pauseAt = 'none';
  h.control.outcome = { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  h.platform.closeSession = async () => {
    throw Error('cannot close');
  };
  await expect(h.api.stopForRestart()).rejects.toThrow();
  expect(h.tasks.occupied()).toBeDefined();
});

it('browser close rejection without a task remains a platform blocker until an explicit successful stop', async () => {
  const { createOperationControl } =
    await import('../../src/application/operation-control');
  const h = await createDraftHarness(0);
  harnesses.push(h);
  expect((await h.api.getDraftState()).task).toBeNull();
  let reject = true;
  h.platform.closeSession = async () => {
    if (reject) throw Error('close rejected');
  };
  const c = createOperationControl({
    draft: {
      requestStop: h.api.requestStop,
      settle: h.api.stopForRestart,
      state: () =>
        h.api.isActive()
          ? 'active'
          : h.api.isBlocked()
            ? 'needs_review'
            : 'idle',
    },
  });
  await c.requestStopAll();
  await vi.waitFor(async () =>
    expect((await c.getOperationControlState()).phase).toBe('needs_review'),
  );
  expect(c.hasUnresolvedStop()).toBe(true);
  h.control.gate = 'busy'; // Composition's separate unresolved-stop platform gate.
  expect((await h.api.openDraftSession()).status).toBe('blocked');
  reject = false;
  await c.requestStopAll();
  await vi.waitFor(async () =>
    expect((await c.getOperationControlState()).phase).toBe('stopped'),
  );
  expect(c.hasUnresolvedStop()).toBe(false);
  h.control.gate = 'ready';
  expect((await h.api.openDraftSession()).status).toBe('ok');
  expect(h.calls).not.toContain('save');
});
it('a hung browser close without a task retains admission past the 15 second observation', async () => {
  const { createOperationControl } =
    await import('../../src/application/operation-control');
  const h = await createDraftHarness(0);
  harnesses.push(h);
  let resolve!: () => void;
  h.platform.closeSession = () =>
    new Promise<void>((r) => {
      resolve = r;
    });
  const c = createOperationControl({
    draft: {
      requestStop: h.api.requestStop,
      settle: h.api.stopForRestart,
      state: () =>
        h.api.isActive()
          ? 'active'
          : h.api.isBlocked()
            ? 'needs_review'
            : 'idle',
    },
  });
  vi.useFakeTimers();
  try {
    await c.requestStopAll();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await c.getOperationControlState()).phase).toBe('stopping');
    expect(c.hasUnresolvedStop()).toBe(true);
    expect(
      (
        await h.api.prepareDraft(
          h.articleKey,
          (await h.api.getDraftState()).session.bindingToken!,
        )
      ).status,
    ).toBe('blocked');
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect((await c.getOperationControlState()).phase).toBe('stopped');
    expect(h.calls).not.toContain('save');
  } finally {
    vi.useRealTimers();
  }
});
