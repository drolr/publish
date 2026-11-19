import { DraftViewSchema } from '../../src/contracts/draft-task';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createDraftHarness,
  deferred,
  type DraftHarness,
} from '../fixtures/draft-harness';
const harnesses: DraftHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
  const h = await createDraftHarness();
  harnesses.push(h);
  return h;
}

it.each([1, 2, 4])(
  'controlled single article uses selected summary and image occurrences (count=%s)',
  async (count) => {
    const title = `Selected article ${count}`;
    const contentDeclaration = count === 4 ? 'original' : 'repost';
    const h = await createDraftHarness(count, { title, contentDeclaration });
    harnesses.push(h);
    if (h.control.probe.status !== 'ready') throw Error('not ready');
    h.control.controlledPilot = {
      reviewedTitle: 'Historical recovery title',
      reviewedTaskId: 'old-task',
      storeIdentity: h.control.probe.store.identity.value,
    };
    const api = await h.restart();
    const opened = await api.openDraftSession();
    const prepared = await api.prepareDraft(
      h.articleKey,
      opened.view.session.bindingToken!,
    );
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') throw Error('not prepared');
    expect(prepared.preparation).toMatchObject({
      title,
      bodyImageCount: count,
      contentDeclaration,
      manualReview: true,
    });
    expect(
      (await api.startDraft(prepared.preparation.preparationId)).status,
    ).toBe('ok');
    h.releaseExecute();
    await vi.waitFor(() => expect(api.isActive()).toBe(false));
    expect(h.tasks.latest()?.state).toBe('draft_saved');
    expect(h.tasks.latest()?.snapshot.article.title).toBe(title);
    expect(h.tasks.latest()?.snapshot.article.contentDeclaration).toBe(
      contentDeclaration,
    );
    expect(
      h.tasks.latest()?.snapshot.article.body.filter((b) => b.type === 'image'),
    ).toHaveLength(count);
    expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  },
);

it('changing the selected summary rejects the previous preparation without execution', async () => {
  const h = await setup();
  if (h.control.probe.status !== 'ready') throw Error('not ready');
  h.control.controlledPilot = {
    storeIdentity: h.control.probe.store.identity.value,
  };
  const api = await h.restart();
  const opened = await api.openDraftSession();
  const first = await api.prepareDraft(
    h.articleKey,
    opened.view.session.bindingToken!,
  );
  const other = await h.addArticle();
  const selected = await api.prepareDraft(
    other,
    opened.view.session.bindingToken!,
  );
  if (first.status !== 'ready' || selected.status !== 'ready')
    throw Error('not prepared');
  expect(selected.preparation).toMatchObject({
    title: 'Another article',
    bodyImageCount: 0,
    manualReview: true,
  });
  expect(await api.startDraft(first.preparation.preparationId)).toMatchObject({
    status: 'blocked',
    reason: 'STALE_PREPARATION',
  });
  expect(h.calls).not.toContain('execute');
  expect(h.tasks.latest()).toBeUndefined();
});

it('a new summary during asset validation cannot start the previously selected article', async () => {
  const h = await setup();
  if (h.control.probe.status !== 'ready') throw Error('not ready');
  h.control.controlledPilot = {
    storeIdentity: h.control.probe.store.identity.value,
  };
  const api = await h.restart();
  const opened = await api.openDraftSession();
  const first = await api.prepareDraft(
    h.articleKey,
    opened.view.session.bindingToken!,
  );
  if (first.status !== 'ready') throw Error('not prepared');
  const pending = deferred();
  let validating = false;
  h.control.verify = async () => {
    validating = true;
    await pending.promise;
  };
  const starting = api.startDraft(first.preparation.preparationId);
  await vi.waitFor(() => expect(validating).toBe(true));
  const selected = await api.prepareDraft(
    await h.addArticle(),
    opened.view.session.bindingToken!,
  );
  expect(selected.status).toBe('ready');
  pending.release();
  expect(await starting).toMatchObject({
    status: 'blocked',
    reason: 'STALE_PREPARATION',
  });
  expect(h.calls).not.toContain('execute');
});

async function closureSetup(failureStage = 'editor') {
  const h = await setup();
  h.control.afterCheckpoint = async (stage) => {
    if (stage === failureStage) throw new Error('page changed');
  };
  await h.api.startDraft(h.preparationId);
  h.releaseExecute();
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const task = h.tasks.occupied()!;
  h.platform.checkAbsence = vi.fn(async (value) => ({
    status: 'absent' as const,
    proof: {
      taskId: value.taskId,
      revision: value.revision,
      snapshotDigest: value.snapshot.digest,
      storeKey: value.store.storeKey,
      generation:
        h.control.probe.status === 'ready' ? h.control.probe.generation : '',
      checkedAt: h.control.now,
    },
  }));
  h.calls.length = 0;
  return { h, task };
}

it('manual closure requires two fresh checks and one human token, with no execution or replay', async () => {
  const { h, task } = await closureSetup();
  const prepared = await h.api.prepareTaskClosure(task.taskId);
  expect(prepared.status).toBe('ok');
  if (prepared.status !== 'ok' || !prepared.closure)
    throw new Error('missing confirmation');
  expect(h.tasks.occupied()).toBeDefined();
  expect(await h.api.confirmTaskClosure(prepared.closure.token)).toMatchObject({
    status: 'ok',
    view: {
      task: { state: 'closed_without_save', possibleRemoteEffect: true },
    },
  });
  expect(h.platform.checkAbsence).toHaveBeenCalledTimes(2);
  expect(h.tasks.occupied()).toBeUndefined();
  expect((await h.api.confirmTaskClosure(prepared.closure.token)).status).toBe(
    'blocked',
  );
  expect((await h.api.startDraft(h.preparationId)).view.task?.state).toBe(
    'closed_without_save',
  );
  expect(h.calls).not.toContain('execute');
});
it('owner-reviewed pre-entry case closes with an explicit audit basis and no remote search', async () => {
  const { h, task } = await closureSetup();
  h.control.controlledPilot = {
    reviewedTitle: task.snapshot.article.title,
    reviewedTaskId: task.taskId,
    storeIdentity: task.store.identity.value,
  };
  h.platform.checkAbsence = vi.fn(async () => ({
    status: 'blocked' as const,
    reason: 'RESULT_AMBIGUOUS' as const,
  }));
  const api = await h.restart();
  const prepared = await api.prepareTaskClosure(task.taskId);
  if (prepared.status !== 'ok' || !prepared.closure)
    throw Error('missing confirmation');
  expect(prepared.closure.basis).toBe('owner-reviewed-before-entry');
  expect(await api.confirmTaskClosure(prepared.closure.token)).toMatchObject({
    status: 'ok',
    view: { task: { state: 'closed_without_save', preEntryReviewed: true } },
  });
  expect(h.platform.checkAbsence).not.toHaveBeenCalled();
  expect(h.calls).not.toContain('execute');
  const reopened = await h.restart();
  expect((await reopened.getDraftState()).task?.state).toBe(
    'closed_without_save',
  );
});
it('a different task cannot consume the owner-reviewed pre-entry exception', async () => {
  const { h, task } = await closureSetup();
  h.control.controlledPilot = {
    reviewedTitle: task.snapshot.article.title,
    reviewedTaskId: 'not-this-task',
    storeIdentity: task.store.identity.value,
  };
  h.platform.checkAbsence = vi.fn(async () => ({
    status: 'blocked' as const,
    reason: 'RESULT_AMBIGUOUS' as const,
  }));
  const api = await h.restart();
  expect((await api.prepareTaskClosure(task.taskId)).status).toBe('blocked');
  expect(h.tasks.occupied()?.taskId).toBe(task.taskId);
});
it('approved empty-editor recovery records its own basis without search or replay', async () => {
  const { h, task } = await closureSetup();
  h.control.controlledPilot = {
    reviewedTitle: task.snapshot.article.title,
    reviewedTaskId: 'older-before-entry-task',
    reviewedEmptyEditorTaskId: task.taskId,
    storeIdentity: task.store.identity.value,
  };
  h.platform.checkAbsence = vi.fn(async () => ({
    status: 'blocked' as const,
    reason: 'RESULT_AMBIGUOUS' as const,
  }));
  const api = await h.restart();
  const prepared = await api.prepareTaskClosure(task.taskId);
  expect(prepared.status).toBe('ok');
  if (prepared.status !== 'ok' || !prepared.closure)
    throw Error('missing confirmation');
  expect(prepared.closure.basis).toBe('owner-reviewed-empty-editor');
  expect(await api.confirmTaskClosure(prepared.closure.token)).toMatchObject({
    status: 'ok',
    view: {
      task: {
        state: 'closed_without_save',
        possibleRemoteEffect: true,
        preEntryReviewed: false,
        emptyEditorReviewed: true,
      },
    },
  });
  expect(h.platform.checkAbsence).not.toHaveBeenCalled();
  expect(h.calls).not.toContain('execute');
  expect((await api.confirmTaskClosure(prepared.closure.token)).status).toBe(
    'blocked',
  );
  expect((await (await h.restart()).getDraftState()).task).toMatchObject({
    state: 'closed_without_save',
    emptyEditorReviewed: true,
  });
});

it.each(['editor', 'body'])(
  'approved unsaved-body recovery preserves partial-effect history and only closes after human confirmation (%s)',
  async (stage) => {
    const { h, task } = await closureSetup(stage);
    h.control.controlledPilot = {
      reviewedTitle: task.snapshot.article.title,
      reviewedTaskId: 'older-before-entry-task',
      reviewedUnsavedBodyTaskId: task.taskId,
      storeIdentity: task.store.identity.value,
    };
    h.platform.checkAbsence = async () => ({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    const api = await h.restart();
    const prepared = await api.prepareTaskClosure(task.taskId);
    expect(prepared.status).toBe('ok');
    if (prepared.status !== 'ok' || !prepared.closure)
      throw Error('missing confirmation');
    expect(prepared.closure.basis).toBe('owner-reviewed-unsaved-body');
    expect(h.tasks.occupied()?.taskId).toBe(task.taskId);
    expect(await api.confirmTaskClosure(prepared.closure.token)).toMatchObject({
      status: 'ok',
      view: {
        task: {
          state: 'closed_without_save',
          possibleRemoteEffect: true,
          unsavedBodyReviewed: true,
          emptyEditorReviewed: false,
        },
      },
    });
    expect(h.tasks.get(task.taskId)).toMatchObject({
      snapshot: task.snapshot,
      possibleRemoteEffect: true,
      saveAttempted: false,
      reason: 'PAGE_CHANGED',
      evidence: task.evidence,
      holdsPlatform: false,
    });
    expect((await api.confirmTaskClosure(prepared.closure.token)).status).toBe(
      'blocked',
    );
    expect((await (await h.restart()).getDraftState()).task).toMatchObject({
      state: 'closed_without_save',
      unsavedBodyReviewed: true,
    });
    expect(h.calls).not.toContain('execute');
    expect(h.calls).not.toContain('save');
  },
);

it.each(['task', 'title', 'store', 'save', 'image', 'remote'] as const)(
  'unsaved-body approval retains the lock for mismatched %s evidence',
  async (mismatch) => {
    const { h, task } = await closureSetup(
      mismatch === 'save' ? 'save' : 'body',
    );
    h.control.controlledPilot = {
      reviewedTitle:
        mismatch === 'title' ? 'different title' : task.snapshot.article.title,
      reviewedTaskId: 'older-before-entry-task',
      reviewedUnsavedBodyTaskId:
        mismatch === 'task' ? 'other-task' : task.taskId,
      storeIdentity:
        mismatch === 'store' ? 'other-store' : task.store.identity.value,
    };
    if (mismatch === 'image' || mismatch === 'remote')
      h.tasks.apply(
        task.taskId,
        task.revision,
        {
          type: 'evidence',
          evidence: {
            cover: null,
            remote:
              mismatch === 'remote'
                ? {
                    recordKey: 'already-exists',
                    editUrl: 'https://example.test/edit/exists',
                  }
                : null,
            images:
              mismatch === 'image'
                ? [
                    {
                      bodyIndex: 1,
                      imageId: 'image',
                      assetKey: task.snapshot.article.assets[0].assetKey,
                      resourceKey: 'b'.repeat(64),
                    },
                  ]
                : [],
          },
        },
        h.control.now,
      );
    h.platform.checkAbsence = async () => ({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    const api = await h.restart();
    expect((await api.prepareTaskClosure(task.taskId)).status).toBe('blocked');
    expect(h.tasks.occupied()?.taskId).toBe(task.taskId);
    expect(h.calls).not.toContain('execute');
    expect(h.calls).not.toContain('save');
  },
);

it.each(['task', 'title', 'store', 'image'] as const)(
  'empty-editor recovery retains the lock for mismatched %s evidence',
  async (mismatch) => {
    const { h, task } = await closureSetup();
    h.control.controlledPilot = {
      reviewedTitle:
        mismatch === 'title' ? 'different title' : task.snapshot.article.title,
      reviewedTaskId: 'older-before-entry-task',
      reviewedEmptyEditorTaskId:
        mismatch === 'task' ? 'other-task' : task.taskId,
      storeIdentity:
        mismatch === 'store' ? 'other-store' : task.store.identity.value,
    };
    if (mismatch === 'image')
      h.tasks.apply(
        task.taskId,
        task.revision,
        {
          type: 'evidence',
          evidence: {
            remote: null,
            cover: null,
            images: [
              {
                bodyIndex: 1,
                imageId: 'image',
                assetKey: task.snapshot.article.assets[0].assetKey,
                resourceKey: 'b'.repeat(64),
              },
            ],
          },
        },
        h.control.now,
      );
    h.platform.checkAbsence = vi.fn(async () => ({
      status: 'blocked' as const,
      reason: 'RESULT_AMBIGUOUS' as const,
    }));
    const api = await h.restart();
    expect((await api.prepareTaskClosure(task.taskId)).status).toBe('blocked');
    expect(h.tasks.occupied()?.taskId).toBe(task.taskId);
    expect(h.calls).not.toContain('execute');
  },
);
it('new human closure after shutdown preserves the historical stop without resuming execution', async () => {
  const { h, task } = await closureSetup();
  await h.api.stopAndWait();
  const api = await h.restart();
  expect(h.tasks.get(task.taskId)?.stopRequested).toBe(true);
  const prepared = await api.prepareTaskClosure(task.taskId);
  if (prepared.status !== 'ok' || !prepared.closure)
    throw new Error('missing confirmation');
  expect(await api.confirmTaskClosure(prepared.closure.token)).toMatchObject({
    status: 'ok',
    view: { task: { state: 'closed_without_save', stopRequested: true } },
  });
  expect(h.calls).not.toContain('execute');
});

it.each([
  'expired',
  'generation',
  'revision',
  'stop',
  'nonzero',
  'saved',
] as const)('manual closure retains lock after %s', async (failure) => {
  const { h, task } = await closureSetup();
  const prepared = await h.api.prepareTaskClosure(task.taskId);
  if (prepared.status !== 'ok' || !prepared.closure)
    throw new Error('missing confirmation');
  if (failure === 'expired') h.control.now = '2026-09-23T00:02:01.000Z';
  if (failure === 'generation' && h.control.probe.status === 'ready')
    h.control.probe.generation = 'changed';
  if (failure === 'revision')
    h.tasks.apply(
      task.taskId,
      task.revision,
      { type: 'settle', state: 'needs_human', reason: 'PAGE_CHANGED' },
      h.control.now,
    );
  if (failure === 'stop') {
    h.platform.checkAbsence = vi.fn(async () => {
      await h.api.stopDraft(task.taskId);
      return { status: 'blocked', reason: 'STOP_REQUESTED' } as const;
    });
  }
  if (failure === 'nonzero')
    h.platform.checkAbsence = vi.fn(
      async () => ({ status: 'blocked', reason: 'RESULT_AMBIGUOUS' }) as const,
    );
  if (failure === 'saved')
    vi.spyOn(h.tasks, 'get').mockImplementation(() => ({
      ...task,
      saveAttempted: true,
    }));
  expect((await h.api.confirmTaskClosure(prepared.closure.token)).status).toBe(
    'blocked',
  );
  expect(h.tasks.occupied()).toBeDefined();
  expect(h.calls).not.toContain('execute');
});

it('durably deduplicates concurrent starts and stops before any effect', async () => {
  const h = await setup();
  await Promise.all([
    h.api.startDraft(h.preparationId),
    h.api.startDraft(h.preparationId),
  ]);
  expect(h.calls.filter((v) => v === 'execute')).toHaveLength(1);
  const before = await h.api.getDraftState();
  expect(before.task?.state).toBe('running');
  await h.api.stopDraft(before.task!.taskId);
  h.releaseExecute();
  await h.api.stopAndWait();
  expect(h.calls).not.toContain('save');
  expect((await h.api.getDraftState()).task?.state).toBe('stopped');
});

it('latches a failed stop write before the adapter resumes and never reports success', async () => {
  const h = await setup();
  await h.api.startDraft(h.preparationId);
  const task = h.tasks.occupied()!;
  vi.spyOn(h.tasks, 'apply').mockImplementationOnce(() => {
    throw new Error('private db path');
  });
  expect(await h.api.stopDraft(task.taskId)).toMatchObject({
    status: 'blocked',
    reason: 'STORAGE_UNAVAILABLE',
  });
  h.releaseExecute();
  await h.api.stopAndWait();
  expect(h.calls).not.toContain('enter');
  expect(await h.api.getDraftState()).toMatchObject({
    task: {
      reason: 'STORAGE_UNAVAILABLE',
      platformPaused: true,
      canOpenDraft: false,
    },
  });
  expect(h.tasks.occupied()).toBeDefined();
});

it('closes admission while an asset preflight is awaiting and waits for it', async () => {
  const h = await setup();
  const hold = deferred();
  h.control.verify = () => hold.promise;
  const start = h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.calls).toContain('check'));
  let completed = false;
  const stopping = h.api.stopAndWait().then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  hold.release();
  await Promise.all([start, stopping]);
  expect(h.calls).not.toContain('execute');
  expect(h.tasks.latest()).toBeUndefined();
});

it.each(['editor', 'body', 'cover', 'save'] as const)(
  'failed %s checkpoint blocks the actual next effect despite adapter error sanitization',
  async (stage) => {
    const h = await setup();
    h.control.pauseAt = `before-${stage}`;
    await h.api.startDraft(h.preparationId);
    const original = h.tasks.apply.bind(h.tasks);
    vi.spyOn(h.tasks, 'apply').mockImplementation(
      (id, revision, event, now) => {
        if (
          (event.type === 'before-effect' && event.stage === stage) ||
          (stage === 'save' && event.type === 'before-save')
        )
          throw new Error('private database failure');
        return original(id, revision, event, now);
      },
    );
    h.releaseExecute();
    await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
    expect(h.calls).not.toContain(
      stage === 'editor' ? 'enter' : stage === 'body' ? 'fill' : stage,
    );
    expect(h.calls).not.toContain('save');
    expect(h.tasks.occupied()?.state).toBe('running');
    expect(await h.api.getDraftState()).toMatchObject({
      task: { reason: 'STORAGE_UNAVAILABLE', canOpenDraft: false },
    });
  },
);

it.each(['editor', 'body', 'cover', 'save'] as const)(
  'stop after durable %s checkpoint blocks the not-yet-issued effect and retains uncertainty',
  async (stage) => {
    const h = await setup();
    h.control.pauseAt = `checkpoint-${stage}`;
    await h.api.startDraft(h.preparationId);
    await vi.waitFor(() => expect(h.tasks.occupied()?.stage).toBe(stage));
    await h.api.stopDraft(h.tasks.occupied()!.taskId);
    h.releaseExecute();
    await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
    expect(h.calls).not.toContain(
      stage === 'editor' ? 'enter' : stage === 'body' ? 'fill' : stage,
    );
    expect(h.tasks.occupied()?.state).toBe('needs_human');
    expect(h.tasks.occupied()?.possibleRemoteEffect).toBe(true);
  },
);

it('runtime stop retains the issued save and does not rewrite a later successful task', async () => {
  const h = await setup();
  h.control.pauseAt = 'after-save';
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.calls).toContain('save'));
  const id = h.tasks.occupied()!.taskId;
  h.api.requestStop();
  expect(h.api.isActive()).toBe(true);
  expect(h.tasks.get(id)).toMatchObject({
    saveAttempted: true,
    stopRequested: true,
  });
  h.releaseExecute();
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const saved = h.tasks.get(id);
  expect(saved?.state).toBe('draft_saved');
  h.api.requestStop();
  expect(h.tasks.get(id)).toEqual(saved);
  expect(h.calls.filter((v) => v === 'save')).toHaveLength(1);
});
it('allows readonly verification after an issued save races with stop, and never sends a second save', async () => {
  const h = await setup();
  h.control.pauseAt = 'after-save';
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.calls).toContain('save'));
  const task = h.tasks.occupied()!;
  await h.api.stopDraft(task.taskId);
  h.releaseExecute();
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  expect(h.tasks.get(task.taskId)).toMatchObject({
    state: 'draft_saved',
    stopRequested: true,
    holdsPlatform: false,
  });
  expect(h.calls.filter((v) => v === 'save')).toHaveLength(1);
  expect(h.calls).toContain('verify-result');
  expect(await h.api.stopDraft(task.taskId)).toMatchObject({ status: 'ok' });
  expect(await h.api.reconcileDraft(task.taskId)).toMatchObject({
    status: 'ok',
  });
  expect(h.calls).not.toContain('reconcile');
});
it('retains a returned operator observation when stop already reached the controller', async () => {
  const h = await setup();
  h.control.pauseAt = 'after-save';
  h.control.outcome = {
    status: 'submission_recorded',
    submission: { observation: 'rejected', attemptedAt: h.control.now },
    evidence: { remote: null, images: [], cover: null },
  };
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.calls).toContain('save'));
  h.api.requestStop();
  h.releaseExecute();
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const task = h.tasks.latest()!;
  expect(task).toMatchObject({
    state: 'needs_human',
    stopRequested: true,
    holdsPlatform: true,
    reason: 'STOP_REQUESTED',
    evidence: { submission: { observation: 'rejected' } },
  });
  expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
  h.api.requestStop();
  expect(h.tasks.get(task.taskId)).toEqual(task);
});

it.each(['evidence', 'settle'] as const)(
  'result %s write failure does not report verified success',
  async (type) => {
    const h = await setup();
    h.control.pauseAt = 'after-save';
    await h.api.startDraft(h.preparationId);
    await vi.waitFor(() => expect(h.calls).toContain('save'));
    const original = h.tasks.apply.bind(h.tasks);
    vi.spyOn(h.tasks, 'apply').mockImplementation(
      (id, revision, event, now) => {
        if (event.type === type) throw new Error('secret path');
        return original(id, revision, event, now);
      },
    );
    h.releaseExecute();
    await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
    expect((await h.api.getDraftState()).task).toMatchObject({
      state: 'running',
      reason: 'STORAGE_UNAVAILABLE',
      platformPaused: true,
      canOpenDraft: false,
    });
    expect(h.tasks.occupied()).toBeDefined();
  },
);

it('invalidates a preparation if session generation changes during asset validation', async () => {
  const h = await setup();
  const hold = deferred();
  h.control.verify = () => hold.promise;
  const start = h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.calls).toContain('check'));
  if (h.control.probe.status !== 'ready') throw new Error('fixture');
  h.control.probe = {
    ...h.control.probe,
    generation: '77777777-7777-4777-8777-777777777777',
  };
  hold.release();
  expect(await start).toMatchObject({
    status: 'blocked',
    reason: 'STALE_PREPARATION',
    view: { preparation: null },
  });
  expect(h.calls).not.toContain('execute');
  expect(h.tasks.latest()).toBeUndefined();
});

it('rechecks the external gate after asset validation', async () => {
  const h = await setup();
  const hold = deferred();
  h.control.verify = () => hold.promise;
  const start = h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.calls).toContain('check'));
  h.control.gate = 'busy';
  hold.release();
  expect(await start).toMatchObject({
    status: 'blocked',
    reason: 'PLATFORM_BUSY',
  });
  expect(h.tasks.latest()).toBeUndefined();
});

it('waits for an in-flight session command and rejects its stale result on shutdown', async () => {
  const h = await setup();
  const hold = deferred();
  h.control.check = () => hold.promise;
  const check = h.api.checkDraftSession();
  let done = false;
  const shutdown = h.api.stopAndWait().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  hold.release();
  expect(await check).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  await shutdown;
  expect(await h.api.openDraftSession()).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
});

it('concurrent first opens share initialization and expose opening until the single probe settles', async () => {
  const h = await setup();
  const api = await h.restart();
  h.calls.length = 0;
  const hold = deferred();
  h.platform.openSession = async () => {
    h.calls.push('open');
    await hold.promise;
    return h.control.probe;
  };
  const first = api.openDraftSession();
  const second = api.openDraftSession();
  const during = await api.getDraftState();
  hold.release();
  const replies = await Promise.all([first, second]);
  expect(during.session.status).toBe('opening');
  expect(replies[0]).toEqual(replies[1]);
  expect(replies[0]).toMatchObject({
    status: 'ok',
    view: { session: { status: 'ready' } },
  });
  expect(h.calls.filter((call) => call === 'open')).toHaveLength(1);
});

it.each(['close', 'stop'] as const)(
  'a pending first open cannot become ready after %s',
  async (action) => {
    const h = await setup();
    const api = await h.restart();
    const hold = deferred();
    h.platform.openSession = async () => {
      await hold.promise;
      return h.control.probe;
    };
    const first = api.openDraftSession();
    const second = api.openDraftSession();
    const stopping =
      action === 'close' ? api.closeDraftSession() : api.stopAndWait();
    hold.release();
    expect(await first).toMatchObject({
      status: 'blocked',
      reason: 'STOP_REQUESTED',
    });
    expect(await second).toMatchObject({
      status: 'blocked',
      reason: 'STOP_REQUESTED',
    });
    await stopping;
    expect((await api.getDraftState()).session.status).not.toBe('ready');
  },
);

it.each([
  'LOGIN_REQUIRED',
  'VERIFICATION_REQUIRED',
  'PAGE_CHANGED',
  'BROWSER_UNAVAILABLE',
] as const)(
  'first open retains %s without automatically retrying',
  async (reason) => {
    const h = await setup();
    h.calls.length = 0;
    h.platform.openSession = async () => {
      h.calls.push('open');
      if (reason === 'BROWSER_UNAVAILABLE') throw Error('unavailable');
      return { status: 'blocked', reason };
    };
    const opened = await h.api.openDraftSession();
    expect(opened).toMatchObject({
      status: 'blocked',
      reason,
      view: { session: { status: 'blocked', reason, bindingToken: null } },
    });
    expect((await h.api.getDraftState()).session.status).toBe('blocked');
    expect(h.calls).toEqual(['open']);
  },
);

it.each(['request-stop', 'busy', 'unavailable'] as const)(
  'pending open retires opening when admission changes: %s',
  async (change) => {
    const h = await setup();
    const api = await h.restart();
    const hold = deferred();
    h.platform.openSession = async () => {
      await hold.promise;
      return h.control.probe;
    };
    const opening = api.openDraftSession();
    if (change === 'request-stop') api.requestStop();
    else h.control.gate = change;
    hold.release();
    const reason =
      change === 'request-stop'
        ? 'STOP_REQUESTED'
        : change === 'busy'
          ? 'PLATFORM_BUSY'
          : 'STORAGE_UNAVAILABLE';
    expect(await opening).toMatchObject({
      status: 'blocked',
      reason,
      view: { session: { status: 'blocked', reason } },
    });
    expect((await api.getDraftState()).session.status).toBe('blocked');
  },
);

it('safety failures before first input retain platform occupation', async () => {
  const h = await setup();
  h.platform.execute = async () => ({
    status: 'blocked',
    reason: 'VERIFICATION_REQUIRED',
  });
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  expect(h.tasks.occupied()).toMatchObject({
    state: 'needs_human',
    possibleRemoteEffect: false,
    reason: 'VERIFICATION_REQUIRED',
  });
});

it('a proved local input failure before first effect releases the platform', async () => {
  const h = await setup();
  h.platform.execute = async () => ({
    status: 'blocked',
    reason: 'ASSET_UNAVAILABLE',
  });
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  expect(h.tasks.latest()).toMatchObject({
    state: 'failed',
    holdsPlatform: false,
  });
});

it('terminal stop is idempotent and does not invent a stop request on an already saved draft', async () => {
  const h = await setup();
  h.releaseExecute();
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.tasks.latest()?.state).toBe('draft_saved'));
  const before = await h.api.getDraftState();
  await h.api.stopDraft(before.task!.taskId);
  expect(await h.api.getDraftState()).toEqual(before);
});

it('a late original preparation returns its original task even when another article occupies the platform', async () => {
  const h = await setup();
  h.releaseExecute();
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.tasks.latest()?.state).toBe('draft_saved'));
  const original = h.tasks.latest()!;
  const article = await h.addArticle();
  const session = await h.api.checkDraftSession();
  const prepared = await h.api.prepareDraft(
    article,
    session.view.session.bindingToken!,
  );
  if (prepared.status !== 'ready') throw new Error('fixture');
  h.platform.execute = async () => ({
    status: 'blocked',
    reason: 'VERIFICATION_REQUIRED',
  });
  await h.api.startDraft(prepared.preparation.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  expect(h.tasks.occupied()?.articleKey).toBe(article);
  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'ok',
    view: { task: { taskId: original.taskId } },
  });
});

it('closing a session cannot reopen admission after an overlapping shutdown request', async () => {
  const h = await setup();
  const hold = deferred();
  h.platform.closeSession = async () => {
    h.calls.push('closing');
    await hold.promise;
  };
  const close = h.api.closeDraftSession();
  await vi.waitFor(() => expect(h.calls).toContain('closing'));
  let finished = false;
  const shutdown = h.api.stopAndWait().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  hold.release();
  await Promise.all([close, shutdown]);
  expect(await h.api.openDraftSession()).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
});

it('denies a second article while a paused task occupies SQLite', async () => {
  const h = await setup();
  h.platform.execute = async () => ({
    status: 'blocked',
    reason: 'VERIFICATION_REQUIRED',
  });
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const original = h.tasks.occupied()!;
  const article = await h.addArticle();
  const session = await h.api.checkDraftSession();
  const prepared = await h.api.prepareDraft(
    article,
    session.view.session.bindingToken!,
  );
  if (prepared.status !== 'ready') throw new Error('fixture');
  expect(
    await h.api.startDraft(prepared.preparation.preparationId),
  ).toMatchObject({ status: 'blocked', reason: 'PLATFORM_BUSY' });
  expect(h.tasks.occupied()?.taskId).toBe(original.taskId);
  expect(
    h.tasks.findPreparation(prepared.preparation.preparationId),
  ).toBeUndefined();
});

it('a failed begin write never launches the platform and leaves the reservation recoverable', async () => {
  const h = await setup();
  vi.spyOn(h.tasks, 'apply').mockImplementationOnce(() => {
    throw new Error('private path');
  });
  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'blocked',
    reason: 'STORAGE_UNAVAILABLE',
  });
  expect(h.calls).not.toContain('execute');
  expect(h.tasks.occupied()?.state).toBe('queued');
});

it('does not return image bytes for upload after stop arrives during asset reading', async () => {
  const h = await setup();
  const hold = deferred();
  h.snapshots.readImage = async () => {
    h.calls.push('read-image');
    await hold.promise;
    return new Uint8Array([1]);
  };
  h.platform.execute = async (task, hooks) => {
    try {
      await hooks.readImage(task.snapshot.article.assets[0].assetKey);
      h.calls.push('upload');
    } catch {
      return { status: 'blocked', reason: 'STOP_REQUESTED' };
    }
    return h.control.outcome;
  };
  await h.api.startDraft(h.preparationId);
  expect(h.calls).toContain('read-image');
  await h.api.stopDraft(h.tasks.occupied()!.taskId);
  hold.release();
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  expect(h.calls).not.toContain('upload');
  expect(h.tasks.latest()?.state).toBe('stopped');
});

it('missing required image evidence cannot be promoted to a saved draft', async () => {
  const h = await setup();
  if (h.control.outcome.status !== 'verified') throw new Error('fixture');
  h.control.outcome = {
    status: 'verified',
    evidence: { ...h.control.outcome.evidence, images: [] },
  };
  h.releaseExecute();
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  expect(h.tasks.occupied()).toBeDefined();
  expect((await h.api.getDraftState()).task).toMatchObject({
    canOpenDraft: false,
    reason: 'STORAGE_UNAVAILABLE',
  });
});

it('safe output schemas exclude raw platform errors and private task evidence', async () => {
  const h = await setup();
  h.platform.execute = async () => {
    throw new Error('cookie=secret; C:/private');
  };
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const view = await h.api.getDraftState();
  expect(DraftViewSchema.safeParse(view).success).toBe(true);
  expect(view.task?.reason).toBe('PAGE_CHANGED');
  expect(JSON.stringify(view)).not.toMatch(
    /secret|private|recordKey|storeKey|editUrl|snapshot/,
  );
});

it('asset failure in preflight never reserves or executes a task', async () => {
  const h = await setup();
  h.control.verify = async () => {
    throw { code: 'ASSET_UNAVAILABLE', path: 'secret' };
  };
  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'blocked',
    reason: 'ASSET_UNAVAILABLE',
  });
  expect(h.tasks.latest()).toBeUndefined();
  expect(h.calls).not.toContain('execute');
});

it('openSavedDraft checks the current store before navigating the saved internal reference', async () => {
  const h = await setup();
  h.releaseExecute();
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.tasks.latest()?.state).toBe('draft_saved'));
  const id = h.tasks.latest()!.taskId;
  if (h.control.probe.status !== 'ready') throw new Error('fixture');
  const original = h.control.probe;
  h.control.probe = {
    ...original,
    store: { ...original.store, storeKey: 'c'.repeat(64) },
  };
  expect(await h.api.openSavedDraft(id)).toMatchObject({
    status: 'blocked',
    reason: 'STORE_CHANGED',
  });
  expect(h.calls).not.toContain('open-verified');
  h.control.probe = original;
  expect(await h.api.openSavedDraft(id)).toMatchObject({ status: 'ok' });
  expect(h.calls).toContain('open-verified');
});

it('close waits for readonly settlement of an already issued save', async () => {
  const h = await setup();
  h.control.pauseAt = 'after-save';
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.calls).toContain('save'));
  const close = h.api.closeDraftSession();
  await Promise.resolve();
  expect(h.calls).not.toContain('close');
  h.releaseExecute();
  await close;
  expect(h.tasks.latest()?.state).toBe('draft_saved');
  expect(h.calls.indexOf('close')).toBeGreaterThan(
    h.calls.indexOf('verify-result'),
  );
  expect((await h.api.getDraftState()).session.status).toBe('closed');
});

it('a durable stop takes precedence over a concurrent proved local failure before effects', async () => {
  const h = await setup();
  const hold = deferred();
  h.platform.execute = async () => {
    await hold.promise;
    return { status: 'blocked', reason: 'ASSET_UNAVAILABLE' };
  };
  await h.api.startDraft(h.preparationId);
  await h.api.stopDraft(h.tasks.occupied()!.taskId);
  hold.release();
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  expect(h.tasks.latest()).toMatchObject({
    state: 'stopped',
    holdsPlatform: false,
  });
});

it('unknown cover capture revokes existing preparation and latches admission with zero reserve', async () => {
  const h = await setup();
  vi.spyOn(h.snapshots, 'captureCover').mockImplementationOnce(() => {
    throw Error('unknown cover storage');
  });
  const opened = await h.api.checkDraftSession();
  expect(
    await h.api.prepareDraft(h.articleKey, opened.view.session.bindingToken!),
  ).toEqual({ status: 'blocked', reason: 'STORAGE_UNAVAILABLE' });
  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'blocked',
    reason: 'STORAGE_UNAVAILABLE',
  });
  expect(h.tasks.latest()).toBeUndefined();
  expect(h.calls).not.toContain('execute');
});
it('every new controller task has local-upload-v1 even for an unconfigured article', async () => {
  const h = await setup();
  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'ok',
  });
  expect(h.tasks.latest()).toMatchObject({
    coverPlan: {
      policy: 'local-upload-v1',
      snapshot: { mode: 'none', coverRevision: 0 },
      report: { phase: 'not_configured' },
    },
  });
});
it('exact reviewed save attempt requires two-stage confirmation, preserves evidence and never executes', async () => {
  const { h, task } = await closureSetup('save');
  if (h.control.probe.status !== 'ready') throw Error('not ready');
  const approval = {
    taskId: task.taskId,
    revision: task.revision,
    snapshotDigest: task.snapshot.digest,
    title: task.snapshot.article.title,
    storeKey: task.store.storeKey,
  };
  h.control.controlledPilot = {
    storeIdentity: task.store.identity.value,
    reviewedAmbiguousSave: approval,
  };
  const api = await h.restart();
  h.control.reconcile = { status: 'blocked', reason: 'CONTENT_MISMATCH' };
  expect((await api.reconcileDraft(task.taskId)).status).toBe('blocked');
  expect(h.tasks.get(task.taskId)).toEqual(task);
  const prepared = await api.prepareTaskClosure(task.taskId);
  expect(prepared.status).toBe('ok');
  if (prepared.status !== 'ok' || !prepared.closure)
    throw Error('missing confirmation');
  expect(prepared.closure.basis).toBe('owner-reviewed-ambiguous-save');
  expect(h.tasks.occupied()?.saveAttempted).toBe(true);
  expect(await api.confirmTaskClosure(prepared.closure.token)).toMatchObject({
    status: 'ok',
    view: {
      task: { state: 'closed_after_review', possibleRemoteEffect: true },
    },
  });
  expect(h.tasks.get(task.taskId)).toMatchObject({
    saveAttempted: true,
    evidence: task.evidence,
    reason: task.reason,
  });
  expect(h.calls).not.toContain('execute');
  expect(h.calls).not.toContain('save');
  expect(h.platform.checkAbsence).not.toHaveBeenCalled();
  expect((await api.confirmTaskClosure(prepared.closure.token)).status).toBe(
    'blocked',
  );
});
it('ambiguous task without exact reviewed revision remains locked', async () => {
  const { h, task } = await closureSetup('save');
  h.control.controlledPilot = {
    storeIdentity: task.store.identity.value,
    reviewedAmbiguousSave: {
      taskId: task.taskId,
      revision: task.revision + 1,
      snapshotDigest: task.snapshot.digest,
      title: task.snapshot.article.title,
      storeKey: task.store.storeKey,
    },
  };
  const api = await h.restart();
  expect((await api.prepareTaskClosure(task.taskId)).status).toBe('blocked');
  expect(h.tasks.occupied()?.taskId).toBe(task.taskId);
});

it.each([undefined, 0, 1, 2])(
  'unsaved image recovery requires the exact reviewed image count (%s)',
  async (count) => {
    const { h, task } = await closureSetup('body');
    const images = [
      {
        bodyIndex: 1,
        imageId: 'image',
        assetKey: task.snapshot.article.assets[0].assetKey,
        resourceKey: 'b'.repeat(64),
      },
    ];
    h.tasks.apply(
      task.taskId,
      task.revision,
      { type: 'evidence', evidence: { remote: null, cover: null, images } },
      h.control.now,
    );
    h.control.controlledPilot = {
      reviewedTitle: task.snapshot.article.title,
      reviewedUnsavedBodyTaskId: task.taskId,
      reviewedUnsavedBodyImageCount: count,
      storeIdentity: task.store.identity.value,
    };
    h.platform.checkAbsence = async () => ({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    const api = await h.restart();
    const before = h.tasks.get(task.taskId)!;
    const prepared = await api.prepareTaskClosure(task.taskId);
    if (count !== 1) {
      expect(prepared.status).toBe('blocked');
      expect(h.tasks.occupied()?.taskId).toBe(task.taskId);
      return;
    }
    expect(prepared.status).toBe('ok');
    if (prepared.status !== 'ok' || !prepared.closure)
      throw Error('missing confirmation');
    expect(prepared.closure.basis).toBe('owner-reviewed-unsaved-body');
    expect(h.tasks.occupied()?.taskId).toBe(task.taskId);
    expect((await api.confirmTaskClosure(prepared.closure.token)).status).toBe(
      'ok',
    );
    expect(h.tasks.get(task.taskId)).toMatchObject({
      state: 'closed_without_save',
      saveAttempted: false,
      evidence: before.evidence,
      snapshot: before.snapshot,
      reason: before.reason,
      possibleRemoteEffect: true,
      holdsPlatform: false,
    });
    expect((await (await h.restart()).getDraftState()).task?.state).toBe(
      'closed_without_save',
    );
    expect(h.calls).not.toContain('execute');
    expect(h.calls).not.toContain('save');
  },
);

it('normal single-entry selection retires the previous summary even without a controlled pilot', async () => {
  const h = await setup();
  const token = (await h.api.getDraftState()).session.bindingToken!;
  const latest = await h.api.prepareDraft(h.articleKey, token, 'new_attempt');
  expect(latest.status).toBe('ready');
  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'blocked',
    reason: 'STALE_PREPARATION',
  });
  expect(h.calls).not.toContain('execute');
});

it('close and every explicit stop invalidate browser health before asynchronous settlement', async () => {
  const h = await setup();
  const before = h.control.healthInvalidations;
  h.api.requestStop();
  expect(h.control.healthInvalidations).toBe(before + 1);
  await h.api.stopDraft('missing');
  expect(h.control.healthInvalidations).toBe(before + 2);
  await h.api.closeDraftSession();
  expect(h.control.healthInvalidations).toBeGreaterThan(before + 2);
});

it('manually finishes a stuck single task and admits a different article through the normal path', async () => {
  const h = await setup();
  h.control.pauseAt = 'none';
  const verified = h.control.outcome;
  h.control.outcome = { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const task = h.tasks.latest()!;
  expect(task.state).toBe('needs_human');
  const bad = await h.api.finishHandledTask({
    taskId: task.taskId,
    expectedRevision: task.revision - 1,
  });
  expect(bad).toMatchObject({ status: 'blocked', reason: 'STALE_PREPARATION' });
  expect(
    (
      await h.api.finishHandledTask({
        taskId: task.taskId,
        expectedRevision: task.revision,
      })
    ).status,
  ).toBe('ok');
  expect(h.tasks.get(task.taskId)).toMatchObject({
    state: 'stopped_by_user',
    saveAttempted: true,
    reason: task.reason,
    evidence: task.evidence,
  });
  expect(h.api.isBlocked()).toBe(false);
  if (verified.status !== 'verified') throw Error('fixture');
  h.control.outcome = {
    ...verified,
    evidence: { ...verified.evidence, images: [] },
  };
  const other = await h.addArticle('Single next article');
  const opened = await h.api.openDraftSession();
  const prepared = await h.api.prepareDraft(
    other,
    opened.view.session.bindingToken!,
  );
  if (prepared.status !== 'ready') throw Error('not prepared');
  expect(
    (await h.api.startDraft(prepared.preparation.preparationId)).status,
  ).toBe('ok');
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  expect(h.tasks.latest()).toMatchObject({
    articleKey: other,
    state: 'draft_saved',
  });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(2);
});
it('never releases a different latest task through the bound cleanup entry', async () => {
  const h = await setup();
  await expect(
    h.api.releaseHandledTask('11111111-1111-4111-8111-111111111111'),
  ).rejects.toThrow('INPUT_UNSUPPORTED');
  expect(h.calls).not.toContain('close');
});
it('manual single-task cleanup waits for close and cannot deadlock on its own command', async () => {
  const h = await setup();
  h.control.pauseAt = 'none';
  h.control.outcome = { status: 'blocked', reason: 'PAGE_CHANGED' };
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const task = h.tasks.latest()!;
  const close = deferred();
  vi.spyOn(h.platform, 'closeSession').mockImplementation(() => close.promise);
  const flight = h.api.finishHandledTask({
    taskId: task.taskId,
    expectedRevision: task.revision,
  });
  expect(h.tasks.get(task.taskId)?.holdsPlatform).toBe(true);
  expect((await h.api.openDraftSession()).status).toBe('blocked');
  close.release();
  expect((await flight).status).toBe('ok');
  expect(h.tasks.get(task.taskId)?.holdsPlatform).toBe(false);
});

it('shutdown waits for manually handled cleanup and its durable release before storage can close', async () => {
  const h = await setup();
  h.control.pauseAt = 'none';
  h.control.outcome = { status: 'blocked', reason: 'PAGE_CHANGED' };
  await h.api.startDraft(h.preparationId);
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const task = h.tasks.latest()!;
  const close = deferred();
  vi.spyOn(h.platform, 'closeSession').mockImplementation(() => close.promise);
  const release = h.api.finishHandledTask({
    taskId: task.taskId,
    expectedRevision: task.revision,
  });
  expect(h.api.isActive()).toBe(true);
  let stopped = false;
  const shutdown = h.api.stopAndWait().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(h.tasks.get(task.taskId)?.holdsPlatform).toBe(true);
  close.release();
  await shutdown;
  expect((await release).status).toBe('ok');
  expect(h.tasks.get(task.taskId)?.state).toBe('stopped_by_user');
  expect(h.api.isActive()).toBe(false);
  expect(h.api.isBlocked()).toBe(true); // shutdown admission stays closed
});
