import { expect, it, vi } from 'vitest';
import { createDraftHarness } from '../fixtures/draft-harness';
it('recovers a durable interrupted reservation without opening or replaying and retains identity after readonly release', async () => {
  const h = await createDraftHarness();
  try {
    await h.api.startDraft(h.preparationId);
    await h.api.stopDraft(h.tasks.occupied()!.taskId);
    h.releaseExecute();
    await h.api.stopAndWait();
    const task = h.tasks.latest()!;
    const before = [...h.calls];
    const api = await h.restart();
    expect(h.calls).toEqual(before);
    expect(await api.startDraft(h.preparationId)).toMatchObject({
      status: 'ok',
      view: { task: { taskId: task.taskId } },
    });
    expect(
      h.tasks.findIdentity(task.articleKey, task.store.storeKey)?.taskId,
    ).toBe(task.taskId);
  } finally {
    await h.close();
  }
});

it.each(['reserved', 'editor', 'body', 'save', 'verify'] as const)(
  'recovers persisted %s without replay and releases only on conclusive readonly checks',
  async (stage) => {
    const h = await createDraftHarness();
    try {
      // Seed precisely the durable state left by abrupt process death. A new
      // repository connection/controller is used for actual recovery.
      const article = h.tasks.latest();
      expect(article).toBeUndefined();
      const opened = await h.api.checkDraftSession();
      const prepared = await h.api.prepareDraft(
        h.articleKey,
        opened.view.session.bindingToken!,
      );
      expect(prepared.status).toBe('ready');
      if (prepared.status !== 'ready')
        throw Error('Expected current preparation');
      const preparationId = prepared.preparation.preparationId;
      h.control.pauseAt = 'before-editor';
      const started = await h.api.startDraft(preparationId);
      const reserved = h.tasks.findPreparation(preparationId);
      expect(reserved).toMatchObject({ preparationId, holdsPlatform: true });
      expect(started).toMatchObject({
        status: 'ok',
        view: {
          task: {
            taskId: reserved!.taskId,
            state: 'running',
            stage: 'reserved',
          },
        },
      });
      const original = h.tasks.apply.bind(h.tasks);
      // Lose the first checkpoint write; the old controller drains without any
      // side effect and leaves a durable in-flight record, rather than replaying.
      h.tasks.apply = () => {
        throw new Error('simulated power loss');
      };
      h.releaseExecute();
      await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
      h.tasks.apply = original;
      let task = h.tasks.occupied()!;
      if (stage !== 'reserved')
        task = h.tasks.apply(
          task.taskId,
          task.revision,
          { type: 'before-effect', stage: 'editor' },
          task.updatedAt,
        );
      if (stage === 'body')
        task = h.tasks.apply(
          task.taskId,
          task.revision,
          { type: 'before-effect', stage: 'body' },
          task.updatedAt,
        );
      if (stage === 'save' || stage === 'verify')
        task = h.tasks.apply(
          task.taskId,
          task.revision,
          { type: 'before-save' },
          task.updatedAt,
        );
      if (stage === 'verify')
        task = h.tasks.apply(
          task.taskId,
          task.revision,
          { type: 'verify' },
          task.updatedAt,
        );
      const before = [...h.calls];
      const api = await h.restart();
      expect(h.calls).toEqual(before);
      expect((await api.getDraftState()).task).toMatchObject({
        state: 'interrupted',
        platformPaused: true,
        stage,
      });
      h.control.reconcile = { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
      await api.reconcileDraft(task.taskId);
      if (stage === 'reserved') {
        expect(h.tasks.get(task.taskId)).toMatchObject({
          state: 'failed',
          holdsPlatform: false,
        });
        expect(h.calls).not.toContain('reconcile');
      } else {
        expect(h.tasks.occupied()).toMatchObject({
          state: 'needs_human',
          taskId: task.taskId,
        });
        h.control.reconcile = h.control.outcome;
        await api.reconcileDraft(task.taskId);
        expect(h.tasks.occupied()).toBeUndefined();
        expect(h.tasks.get(task.taskId)?.state).toBe('draft_saved');
      }
      expect(h.calls.filter((v) => v === 'execute')).toHaveLength(1);
      expect(h.calls).not.toContain('save');
      expect(
        h.tasks.findIdentity(task.articleKey, task.store.storeKey)?.taskId,
      ).toBe(task.taskId);
      expect(await api.startDraft(task.preparationId)).toMatchObject({
        status: 'ok',
        view: { task: { taskId: task.taskId } },
      });
    } finally {
      await h.close();
    }
  },
);
