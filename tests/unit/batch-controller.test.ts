import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createBatchController } from '../../src/application/batch-controller';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { createDraftHarness } from '../fixtures/draft-harness';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

for (const stage of ['editor', 'body', 'cover', 'save'] as const)
  it(`stop at the ${stage} checkpoint prevents that action and all following articles`, async () => {
    const { api, h, prepare } = await setup();
    h.control.pauseAt = 'none';
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => (reached = resolve));
    const paused = new Promise<void>((resolve) => (release = resolve));
    h.control.afterCheckpoint = async (current) => {
      if (current === stage) {
        reached();
        await paused;
      }
    };
    const offered = await prepare();
    await api.start({
      preparationId: offered.preparationId,
      requestId: randomUUID(),
    });
    await entered;
    api.requestStop();
    release();
    await api.waitForIdle();
    expect(h.calls.filter((x) => x === 'execute')).toHaveLength(1);
    expect(h.calls).not.toContain(
      stage === 'editor' ? 'enter' : stage === 'body' ? 'fill' : stage,
    );
    expect(h.calls).not.toContain('save');
    expect((await api.getCurrent())?.stopRequested).toBe(true);
  });
async function setup() {
  const h = await createDraftHarness(0);
  const repo = openDraftBatchRepository(
    h.path,
    resolve('src/infrastructure/persistence/migrations'),
  );
  const api = createBatchController({
    repository: repo,
    draft: h.api,
    preparation: h.preparation,
    articles: h.articles,
    snapshots: h.snapshots,
    newId: randomUUID,
    now: () => h.control.now,
    gate: () => 'ready',
  });
  cleanup.push(async () => {
    h.releaseExecute();
    await api.waitForIdle();
    repo.close();
    await h.close();
  });
  const keys = [h.articleKey, await h.addArticle(), await h.addArticle()];
  const prepare = async () => {
    const session = await h.api.getDraftState();
    const result = await api.prepare({
      articleKeys: keys,
      bindingToken: session.session.bindingToken!,
    });
    if (result.status !== 'ready')
      throw Error('batch not prepared: ' + result.reason);
    return result.preparation;
  };
  return { h, repo, api, keys, prepare };
}
it('runs three selected articles in order, never in parallel, and preserves an idempotent start', async () => {
  const { h, api, keys, prepare } = await setup();
  const prepared = await prepare();
  expect(prepared.items.map((i) => i.articleKey)).toEqual(keys);
  const request = {
    preparationId: prepared.preparationId,
    requestId: randomUUID(),
  };
  h.control.pauseAt = 'none';
  const first = await api.start(request);
  const second = await api.start(request);
  expect(second.view?.id).toBe(first.view?.id);
  await api.waitForIdle();
  expect(await api.getCurrent()).toMatchObject({
    state: 'completed',
    counts: { saved: 3, total: 3 },
  });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(3);
});
it('stops a paused first article without starting the remaining articles', async () => {
  const { h, api, prepare } = await setup();
  const prepared = await prepare();
  const started = await api.start({
    preparationId: prepared.preparationId,
    requestId: randomUUID(),
  });
  const stopped = api.stop({ batchId: started.view!.id });
  h.releaseExecute();
  await stopped;
  await api.waitForIdle();
  const view = await api.getCurrent();
  expect(view!.stopRequested).toBe(true);
  expect(view!.counts.saved).toBe(0);
  expect(h.calls.filter((c) => c === 'execute').length).toBeLessThanOrEqual(1);
});
it('an unknown platform failure pauses the batch and keeps following articles queued', async () => {
  const { h, api, prepare } = await setup();
  const prepared = await prepare();
  h.control.pauseAt = 'none';
  h.control.outcome = { status: 'blocked', reason: 'PAGE_CHANGED' };
  await api.start({
    preparationId: prepared.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  expect(await api.getCurrent()).toMatchObject({
    state: 'paused',
    counts: { needsHuman: 1, pending: 2 },
  });
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
});
it('expired preparations never create a persisted batch or start the platform', async () => {
  const { h, api, repo, prepare } = await setup();
  const prepared = await prepare();
  h.control.now = '2026-09-23T00:03:00.000Z';
  expect(
    await api.start({
      preparationId: prepared.preparationId,
      requestId: randomUUID(),
    }),
  ).toMatchObject({ status: 'blocked', reason: 'STALE_PREPARATION' });
  expect(repo.getCurrent()).toBeNull();
  expect(h.calls).not.toContain('execute');
});

it('a request identity cannot be reused with another preparation', async () => {
  const { api, h, prepare } = await setup();
  const selected = await prepare();
  h.control.pauseAt = 'none';
  const requestId = randomUUID();
  await api.start({ preparationId: selected.preparationId, requestId });
  expect(
    await api.start({ preparationId: randomUUID(), requestId }),
  ).toMatchObject({ status: 'blocked', reason: 'INPUT_UNSUPPORTED' });
});

it('a missing asset before the second remote execution fails only that article and continues', async () => {
  const { api, h, prepare } = await setup();
  const selected = await prepare();
  h.control.pauseAt = 'none';
  let checks = 0;
  h.control.verify = async () => {
    if (++checks === 5)
      throw Object.assign(new Error('local fixture'), {
        code: 'ASSET_UNAVAILABLE',
      });
  };
  await api.start({
    preparationId: selected.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  expect(await api.getCurrent()).toMatchObject({
    state: 'completed',
    counts: { saved: 2, failed: 1 },
  });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(2);
});

it('preserves every local preflight failure in a non-executable summary', async () => {
  const { api, h, keys } = await setup();
  h.snapshots.capture = async () => {
    throw Object.assign(Error('fixture'), { code: 'ASSET_UNAVAILABLE' });
  };
  const session = await h.api.getDraftState();
  const offered = await api.prepare({
    articleKeys: keys,
    bindingToken: session.session.bindingToken!,
  });
  expect(offered).toMatchObject({
    status: 'ready',
    preparation: {
      items: keys.map((articleKey) => ({
        articleKey,
        state: 'failed',
        reason: 'ASSET_UNAVAILABLE',
      })),
    },
  });
  if (offered.status !== 'ready') throw Error('missing summary');
  expect(
    await api.start({
      preparationId: offered.preparation.preparationId,
      requestId: randomUUID(),
    }),
  ).toMatchObject({ status: 'blocked', reason: 'STALE_PREPARATION' });
  expect(h.calls).not.toContain('execute');
});

for (const reason of [
  'LOGIN_REQUIRED',
  'VERIFICATION_REQUIRED',
  'PAGE_CHANGED',
] as const)
  it(`pauses before the next article after ${reason}`, async () => {
    const { api, h, prepare } = await setup();
    const offered = await prepare();
    h.control.pauseAt = 'none';
    h.control.check = async () => {
      if (h.calls.includes('save'))
        h.control.probe = { status: 'blocked', reason };
    };
    await api.start({
      preparationId: offered.preparationId,
      requestId: randomUUID(),
    });
    await api.waitForIdle();
    expect(await api.getCurrent()).toMatchObject({
      state: 'paused',
      counts: { saved: 1, needsHuman: 1, pending: 1 },
    });
    expect(h.calls.filter((x) => x === 'save')).toHaveLength(1);
    expect(h.calls.filter((x) => x === 'execute')).toHaveLength(1);
  });
for (const change of ['store', 'generation'] as const)
  it(`rejects summary after ${change} changes without reserving a batch`, async () => {
    const { api, h, prepare, repo } = await setup();
    const offered = await prepare();
    if (h.control.probe.status !== 'ready') throw Error('fixture');
    h.control.probe =
      change === 'store'
        ? {
            ...h.control.probe,
            store: {
              ...h.control.probe.store,
              storeKey: '9'.repeat(64),
              identity: { source: 'visible-shop-link', value: 'other-store' },
            },
          }
        : { ...h.control.probe, generation: randomUUID() };
    expect(
      await api.start({
        preparationId: offered.preparationId,
        requestId: randomUUID(),
      }),
    ).toMatchObject({ status: 'blocked' });
    expect(repo.getCurrent()).toBeNull();
    expect(h.calls).not.toContain('execute');
  });
it('a global stop during start verification invalidates the in-flight preparation', async () => {
  const { api, h, prepare, repo } = await setup();
  const offered = await prepare();
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>((r) => (entered = r)),
    pause = new Promise<void>((r) => (release = r));
  h.control.verify = async () => {
    entered();
    await pause;
  };
  const flight = api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await enteredPromise;
  api.requestStop();
  release();
  expect(await flight).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(repo.getCurrent()).toBeNull();
  expect(h.calls).not.toContain('execute');
});
it('a global stop during summary preparation cannot leave a late executable seed', async () => {
  const { api, h, keys, repo } = await setup();
  const session = await h.api.getDraftState();
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>((r) => (entered = r)),
    pause = new Promise<void>((r) => (release = r));
  const capture = h.snapshots.capture.bind(h.snapshots);
  h.snapshots.capture = async (article) => {
    entered();
    await pause;
    return capture(article);
  };
  const flight = api.prepare({
    articleKeys: keys,
    bindingToken: session.session.bindingToken!,
  });
  await enteredPromise;
  api.requestStop();
  release();
  expect(await flight).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(repo.getCurrent()).toBeNull();
  expect(h.calls).not.toContain('execute');
});
it('already-saved articles remain skipped and cannot be submitted as a new all-saved batch', async () => {
  const { api, h, keys, prepare } = await setup();
  h.control.pauseAt = 'none';
  const offered = await prepare();
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  await h.api.checkDraftSession();
  const session = await h.api.getDraftState();
  const again = await api.prepare({
    articleKeys: keys,
    bindingToken: session.session.bindingToken!,
  });
  expect(again).toMatchObject({
    status: 'ready',
    preparation: {
      items: keys.map((articleKey) => ({ articleKey, state: 'skipped' })),
    },
  });
  if (again.status !== 'ready') throw Error('fixture');
  expect(
    await api.start({
      preparationId: again.preparation.preparationId,
      requestId: randomUUID(),
    }),
  ).toMatchObject({ status: 'blocked', reason: 'STALE_PREPARATION' });
  expect(h.calls.filter((x) => x === 'save')).toHaveLength(3);
});
it('save completed before batch settlement failure is recovered without replay', async () => {
  const { api, h, prepare, repo } = await setup();
  h.control.pauseAt = 'none';
  const offered = await prepare();
  const settle = repo.settleItem;
  repo.settleItem = () => {
    throw Error('fixture settlement failure');
  };
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  expect(await api.getCurrent()).toMatchObject({ state: 'paused' });
  expect(h.calls.filter((x) => x === 'save')).toHaveLength(1);
  repo.settleItem = settle;
  repo.recover(h.control.now);
  expect(repo.getCurrent()).toMatchObject({
    state: 'interrupted',
    counts: { saved: 1, pending: 2 },
    stopRequested: true,
  });
  const current = repo.getCurrent()!;
  expect(
    repo.reserveNext(current.id, current.revision, h.control.now),
  ).toBeNull();
  await api.finish({ batchId: current.id });
  expect(await api.getCurrent()).toMatchObject({
    state: 'stopped',
    counts: { saved: 1, stopped: 2 },
  });
  expect(h.calls.filter((x) => x === 'save')).toHaveLength(1);
});
it('stop persistence failure retains an in-memory admission latch', async () => {
  const { api, h, prepare, repo } = await setup();
  const offered = await prepare();
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  const stop = repo.requestStop;
  repo.requestStop = () => {
    throw Error('fixture stop persistence');
  };
  api.requestStop();
  h.releaseExecute();
  await api.waitForIdle();
  expect(api.isBlocked()).toBe(true);
  expect(h.calls).not.toContain('save');
  repo.requestStop = stop;
  expect(
    await api.prepare({
      articleKeys: [h.articleKey],
      bindingToken: randomUUID(),
    }),
  ).toMatchObject({ status: 'blocked', reason: 'STORAGE_UNAVAILABLE' });
});

it('a mixed saved and new selection skips saved articles and counts only new saves', async () => {
  const { api, h, keys, prepare } = await setup();
  h.control.pauseAt = 'none';
  const offered = await prepare();
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  const freshKey = await h.addArticle('Fresh article');
  await h.api.checkDraftSession();
  const session = await h.api.getDraftState();
  const mixed = await api.prepare({
    articleKeys: [keys[0], freshKey, keys[1]],
    bindingToken: session.session.bindingToken!,
  });
  expect(mixed).toMatchObject({
    status: 'ready',
    preparation: {
      items: [
        { articleKey: keys[0], state: 'skipped' },
        { articleKey: freshKey, state: 'queued' },
        { articleKey: keys[1], state: 'skipped' },
      ],
    },
  });
  if (mixed.status !== 'ready') throw Error('fixture summary');
  await api.start({
    preparationId: mixed.preparation.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  expect(await api.getCurrent()).toMatchObject({
    state: 'completed',
    counts: { total: 3, skipped: 2, saved: 1, pending: 0 },
  });
  expect(h.calls.filter((x) => x === 'save')).toHaveLength(4);
});

it('an unresolved article continues blocking new batches after the batch is finished', async () => {
  const { api, h, keys, prepare } = await setup();
  h.control.pauseAt = 'none';
  h.control.outcome = { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
  const offered = await prepare();
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  const current = await api.getCurrent();
  expect(current?.state).toBe('paused');
  await api.finish({ batchId: current!.id });
  const session = await h.api.getDraftState();
  expect(
    await api.prepare({
      articleKeys: keys,
      bindingToken: session.session.bindingToken ?? randomUUID(),
    }),
  ).toMatchObject({ status: 'blocked', reason: 'PLATFORM_BUSY' });
  expect(h.calls.filter((x) => x === 'execute')).toHaveLength(1);
});

it('finishes an explicitly stopped ambiguous batch and permits fresh preparation without replay', async () => {
  const { h, api, prepare } = await setup();
  h.control.pauseAt = 'none';
  h.control.outcome = { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
  const offered = await prepare();
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  expect((await api.getCurrent())?.state).toBe('paused');
  await api.stopForRestart();
  expect(api.isBlocked()).toBe(false);
  expect(h.api.isBlocked()).toBe(false);
  expect((await api.getCurrent())?.state).toBe('stopped');
  expect((await api.getCurrent())?.counts.needsHuman).toBe(1);
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  await h.api.openDraftSession();
  expect(
    (await prepare()).items.filter((i) => i.state === 'queued'),
  ).toHaveLength(3);
});

it.each(['acknowledged', 'rejected', 'unknown'] as const)(
  'a settled %s submission is skipped without blocking a fresh article or replaying the old one',
  async (observation) => {
    const { api, h, keys, prepare } = await setup();
    h.control.pauseAt = 'none';
    // The verified-draft harness normally enters the readback stage. Operator
    // submissions finish at save, so keep all real checkpoints except readback.
    const execute = h.platform.execute.bind(h.platform);
    h.platform.execute = (task, hooks) =>
      execute(task, { ...hooks, verifying: async () => {} });
    const submission = { observation, attemptedAt: h.control.now };
    h.control.outcome = {
      status: 'submission_recorded',
      submission,
      evidence: { remote: null, images: [], cover: null },
    };
    const first = await prepare();
    await api.start({
      preparationId: first.preparationId,
      requestId: randomUUID(),
    });
    await api.waitForIdle();
    const original = h.tasks.findIdentity(
      keys[0],
      h.tasks.latest()!.store.storeKey,
    )!;
    expect(original).toMatchObject({
      state: 'submission_recorded',
      stage: 'settled',
      holdsPlatform: false,
      saveAttempted: true,
    });
    const session = (await h.api.checkDraftSession()).view.session;
    const onlyOld = await api.prepare({
      articleKeys: [keys[0]],
      bindingToken: session.bindingToken!,
    });
    expect(onlyOld).toMatchObject({
      status: 'ready',
      preparation: {
        items: [{ articleKey: keys[0], state: 'skipped', submission }],
      },
    });
    if (onlyOld.status !== 'ready') throw Error('missing old-item summary');
    expect(
      await api.start({
        preparationId: onlyOld.preparation.preparationId,
        requestId: randomUUID(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'STALE_PREPARATION' });
    expect(h.calls.filter((c) => c === 'save')).toHaveLength(3);
    const freshKey = await h.addArticle('New after operator submission');
    const mixed = await api.prepare({
      articleKeys: [keys[0], freshKey],
      bindingToken: session.bindingToken!,
    });
    expect(mixed).toMatchObject({
      status: 'ready',
      preparation: {
        items: [
          { articleKey: keys[0], state: 'skipped', submission },
          { articleKey: freshKey, state: 'queued' },
        ],
      },
    });
    if (mixed.status !== 'ready') throw Error('missing mixed summary');
    await api.start({
      preparationId: mixed.preparation.preparationId,
      requestId: randomUUID(),
    });
    await api.waitForIdle();
    expect(await api.getCurrent()).toMatchObject({
      state: 'completed',
      counts: { total: 2, skipped: 1, attempted: 1, saved: 0, pending: 0 },
      items: [
        { state: 'skipped', submission },
        { state: 'submission_recorded', submission },
      ],
    });
    expect(h.calls.filter((c) => c === 'save')).toHaveLength(4);
    expect(h.tasks.get(original.taskId)).toEqual(original);
  },
);

it('A fails safely, B completes, then repaired A gets a fresh task without changing old evidence', async () => {
  const { api, h, keys } = await setup();
  h.control.pauseAt = 'none';
  const token = (await h.api.getDraftState()).session.bindingToken!;
  const initial = await api.prepare({
    articleKeys: keys.slice(0, 2),
    bindingToken: token,
  });
  if (initial.status !== 'ready') throw Error('no preparation');
  let checks = 0;
  h.control.verify = async () => {
    if (++checks === 3)
      throw Object.assign(Error('fixture'), { code: 'ASSET_UNAVAILABLE' });
  };
  await api.start({
    preparationId: initial.preparation.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  expect(await api.getCurrent()).toMatchObject({
    state: 'completed',
    items: [{ state: 'failed' }, { state: 'draft_saved' }],
  });
  const failed = h.tasks.findLatestIdentity(
    keys[0],
    h.tasks.latest()!.store.storeKey,
  )!;
  expect(failed).toMatchObject({
    state: 'failed',
    holdsPlatform: false,
    saveAttempted: false,
  });
  h.control.verify = async () => {};
  const nextToken = (await h.api.checkDraftSession()).view.session
    .bindingToken!;
  const next = await api.prepare({
    articleKeys: [keys[0]],
    bindingToken: nextToken,
  });
  expect(next).toMatchObject({
    status: 'ready',
    preparation: { items: [{ state: 'queued' }] },
  });
  if (next.status !== 'ready') throw Error('no fresh preparation');
  await api.start({
    preparationId: next.preparation.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  const fresh = h.tasks.findLatestIdentity(keys[0], failed.store.storeKey)!;
  expect(fresh.taskId).not.toBe(failed.taskId);
  expect(fresh).toMatchObject({ state: 'draft_saved', saveAttempted: true });
  expect(h.tasks.get(failed.taskId)).toEqual(failed);
  expect(h.calls.filter((call) => call === 'save')).toHaveLength(2);
});
it('an explicit same-snapshot attempt is independent and duplicate starts keep its one save budget', async () => {
  const { api, h, keys } = await setup();
  h.control.pauseAt = 'none';
  const token = (await h.api.getDraftState()).session.bindingToken!;
  const first = await api.prepare({
    articleKeys: [keys[0]],
    bindingToken: token,
  });
  if (first.status !== 'ready') throw Error('not prepared');
  await api.start({
    preparationId: first.preparation.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  const old = h.tasks.latest()!;
  const freshToken = (await h.api.checkDraftSession()).view.session
    .bindingToken!;
  const next = await api.prepare({
    articleKeys: [keys[0]],
    newAttemptArticleKeys: [keys[0]],
    bindingToken: freshToken,
  });
  expect(next).toMatchObject({
    status: 'ready',
    preparation: { items: [{ state: 'queued' }] },
  });
  if (next.status !== 'ready') throw Error('not prepared');
  const input = {
    preparationId: next.preparation.preparationId,
    requestId: randomUUID(),
  };
  const a = await api.start(input),
    b = await api.start(input);
  expect(a.view?.id).toBe(b.view?.id);
  await api.waitForIdle();
  expect(h.tasks.latest()!.taskId).not.toBe(old.taskId);
  expect(h.tasks.get(old.taskId)).toEqual(old);
  expect(h.calls.filter((call) => call === 'save')).toHaveLength(2);
});

it('a skipped article changed during final session validation invalidates the entire mixed summary', async () => {
  const { api, h, keys } = await setup();
  h.control.pauseAt = 'none';
  const bindingToken = (await h.api.getDraftState()).session.bindingToken!;
  const first = await api.prepare({ articleKeys: [keys[0]], bindingToken });
  if (first.status !== 'ready') throw Error('not prepared');
  await api.start({
    preparationId: first.preparation.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  const token = (await h.api.checkDraftSession()).view.session.bindingToken!;
  const mixed = await api.prepare({
    articleKeys: keys.slice(0, 2),
    bindingToken: token,
  });
  if (mixed.status !== 'ready') throw Error('not prepared');
  let changed = false;
  const load = h.articles.loadEditableArticle.bind(h.articles);
  vi.spyOn(h.articles, 'loadEditableArticle').mockImplementation((key) => {
    const current = load(key);
    return current && key === keys[0] && changed
      ? { ...current, articleRevision: current.articleRevision + 1 }
      : current;
  });
  h.control.check = async () => {
    changed = true;
  };
  expect(
    await api.start({
      preparationId: mixed.preparation.preparationId,
      requestId: randomUUID(),
    }),
  ).toMatchObject({ status: 'blocked', reason: 'STALE_PREPARATION' });
  expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
});
