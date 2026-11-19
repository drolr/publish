import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { observeLiveSaves } from '../../src/infrastructure/platforms/judongche/production-editor-entry';
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

it('capability changes after summary reject start without reserving a batch', async () => {
  const { h, api, repo, prepare } = await setup();
  const offered = await prepare();
  h.control.capabilities.revision = 'fixture-v2';
  expect(
    await api.start({
      preparationId: offered.preparationId,
      requestId: randomUUID(),
    }),
  ).toMatchObject({ status: 'blocked', reason: 'STALE_PREPARATION' });
  expect(repo.getCurrent()).toBeNull();
  expect(h.calls).not.toContain('execute');
});
it('capability changes between articles pause the batch before the second writer', async () => {
  const { h, api, prepare } = await setup();
  const offered = await prepare();
  h.control.pauseAt = 'none';
  h.control.afterCheckpoint = async (stage) => {
    if (stage === 'save') h.control.capabilities.revision = 'fixture-v2';
  };
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  expect(h.calls.filter((x) => x === 'execute')).toHaveLength(1);
  expect(await api.getCurrent()).toMatchObject({ state: 'paused' });
});
it('one unsupported format blocks batch preparation instead of silently degrading the item', async () => {
  const { h, api, keys } = await setup();
  const load = h.articles.loadEditableArticle.bind(h.articles);
  vi.spyOn(h.articles, 'loadEditableArticle').mockImplementation((key) => {
    const a = load(key);
    if (a && key === keys[1])
      a.editorBody = {
        version: 2,
        blocks: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Other body', marks: ['italic'] }],
          },
        ],
      };
    return a;
  });
  const session = await h.api.getDraftState();
  const prepared = await api.prepare({
    articleKeys: keys,
    bindingToken: session.session.bindingToken!,
  });
  expect(prepared).toMatchObject({
    status: 'blocked',
    reason: 'FORMAT_UNSUPPORTED',
  });
  expect(h.calls).not.toContain('execute');
});

it('manually skips the paused middle item once and continues only frozen queued work', async () => {
  const { h, api, prepare } = await setup();
  h.control.pauseAt = 'none';
  let executions = 0;
  const original = h.platform.execute;
  const verified = h.control.outcome;
  h.platform.execute = async (task, hooks) => {
    executions++;
    h.control.outcome =
      executions === 2
        ? { status: 'blocked', reason: 'RESULT_AMBIGUOUS' }
        : verified;
    return original(task, hooks);
  };
  const offered = await prepare();
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  const paused = (await api.getCurrent())!;
  expect(paused.items.map((i) => i.state)).toEqual([
    'draft_saved',
    'needs_human',
    'queued',
  ]);
  const taskId = paused.items[1].taskId!;
  const prior = h.tasks.get(taskId)!;
  expect(prior.saveAttempted).toBe(true);
  const request = {
    batchId: paused.id,
    expectedRevision: paused.revision,
    taskId,
  };
  expect((await api.skipCurrentAndContinue(request)).status).toBe('ok');
  await api.waitForIdle();
  expect((await api.getCurrent())!.items.map((i) => i.state)).toEqual([
    'draft_saved',
    'skipped',
    'draft_saved',
  ]);
  expect(h.tasks.get(taskId)).toMatchObject({
    state: 'stopped_by_user',
    saveAttempted: true,
    reason: prior.reason,
    evidence: prior.evidence,
  });
  expect((await api.skipCurrentAndContinue(request)).status).toBe('blocked');
  expect(executions).toBe(3);
});

it('keeps the paused identity retryable after a recovery browser open failure', async () => {
  const { h, api, prepare } = await setup();
  h.control.pauseAt = 'none';
  h.control.outcome = { status: 'blocked', reason: 'PAGE_CHANGED' };
  const offered = await prepare();
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  const paused = (await api.getCurrent())!;
  const request = {
    batchId: paused.id,
    expectedRevision: paused.revision,
    taskId: paused.items[0].taskId!,
  };
  const probe = h.control.probe;
  h.control.probe = { status: 'blocked', reason: 'LOGIN_REQUIRED' };
  expect(await api.skipCurrentAndContinue(request)).toMatchObject({
    status: 'blocked',
    reason: 'LOGIN_REQUIRED',
  });
  expect(await api.getCurrent()).toEqual(paused);
  h.control.probe = probe;
  h.control.outcome = {
    status: 'verified',
    evidence: {
      cover: null,
      images: [],
      remote: {
        recordKey: 'offline-record',
        editUrl: 'https://example.test/edit/offline-record',
      },
    },
  };
  expect((await api.skipCurrentAndContinue(request)).status).toBe('ok');
  await api.waitForIdle();
  expect((await api.getCurrent())!.counts).toMatchObject({
    skipped: 1,
    saved: 2,
  });
});

async function pausedBatch(position = 0) {
  const fixture = await setup();
  const { h, api, prepare } = fixture;
  h.control.pauseAt = 'none';
  const verified = h.control.outcome;
  const execute = h.platform.execute;
  let count = 0;
  h.platform.execute = async (task, hooks) => {
    h.control.outcome =
      count++ === position
        ? { status: 'blocked', reason: 'RESULT_AMBIGUOUS' }
        : verified;
    return execute(task, hooks);
  };
  const offered = await prepare();
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  const view = (await api.getCurrent())!;
  return {
    ...fixture,
    request: {
      batchId: view.id,
      expectedRevision: view.revision,
      taskId: view.items[position].taskId!,
    },
  };
}
it('live manual skip keeps browser health, generation and session without reopening', async () => {
  const { api, h, request } = await pausedBatch();
  const before = h.calls.slice();
  const invalidations = h.control.healthInvalidations;
  const handoff = vi.fn(async () => h.control.probe);
  Object.assign(h.platform, { returnHomeAfterHandledTask: handoff });
  expect(await api.skipCurrentAndContinue(request)).toMatchObject({
    status: 'ok',
  });
  await api.waitForIdle();
  expect(handoff).toHaveBeenCalledOnce();
  expect(h.control.healthInvalidations).toBe(invalidations);
  expect(h.calls.filter((c) => c === 'close')).toEqual(
    before.filter((c) => c === 'close'),
  );
  expect(h.calls.filter((c) => c === 'open')).toEqual(
    before.filter((c) => c === 'open'),
  );
  expect((await api.getCurrent())!.counts).toMatchObject({
    skipped: 1,
    saved: 2,
  });
});
it('missing live handoff support fails closed without falling back to startup recovery', async () => {
  const { api, h, request } = await pausedBatch();
  delete h.platform.returnHomeAfterHandledTask;
  const before = h.calls.slice();
  expect(await api.skipCurrentAndContinue(request)).toMatchObject({
    status: 'blocked',
    reason: 'INPUT_UNSUPPORTED',
  });
  expect(h.calls).toEqual(before);
  expect(h.tasks.get(request.taskId)?.holdsPlatform).toBe(true);
});
it('lost live page remains a live failure and never opens a replacement browser', async () => {
  const { api, h, request } = await pausedBatch();
  const opens = h.calls.filter((c) => c === 'open').length;
  vi.spyOn(h.platform, 'returnHomeAfterHandledTask').mockResolvedValue({
    status: 'blocked',
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(await api.skipCurrentAndContinue(request)).toMatchObject({
    status: 'blocked',
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(h.calls.filter((c) => c === 'open')).toHaveLength(opens);
});
it('does not bind an unreserved task or a queued task with a forged generation', async () => {
  const { h, api, prepare } = await setup();
  const bind = vi.fn();
  h.platform.bindTaskForContinuation = bind;
  await expect(
    h.api.executeBatchTask(randomUUID(), randomUUID(), 'fixture-v1'),
  ).rejects.toThrow('Batch task is not newly reserved');
  expect(bind).not.toHaveBeenCalled();
  const executeReserved = h.api.executeBatchTask.bind(h.api);
  h.api.executeBatchTask = (taskId, _generation, capability) =>
    executeReserved(taskId, randomUUID(), capability);
  const prepared = await prepare();
  await api.start({
    preparationId: prepared.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  expect(bind).not.toHaveBeenCalled();
  const task = h.tasks.latest()!;
  expect(task).toMatchObject({
    state: 'needs_human',
    reason: 'STALE_PREPARATION',
    possibleRemoteEffect: false,
  });
  expect(
    await h.api.releaseHandledTaskForContinuation(task.taskId, () => false),
  ).toMatchObject({ status: 'blocked', reason: 'INPUT_UNSUPPORTED' });
  expect(h.calls).not.toContain('handoff');
});
it('shutdown waits for the entire continuation flight and prevents release after cancellation', async () => {
  const { h, request } = await pausedBatch();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const hold = new Promise<void>((done) => {
    release = done;
  });
  vi.spyOn(h.platform, 'returnHomeAfterHandledTask').mockImplementation(
    async () => {
      entered();
      await hold;
      return h.control.probe;
    },
  );
  const handoff = h.api.releaseHandledTaskForContinuation(
    request.taskId,
    () => false,
  );
  await reached;
  let drained = false;
  const shutdown = h.api.stopAndWait().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  expect(await handoff).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  await shutdown;
  expect(h.tasks.get(request.taskId)?.holdsPlatform).toBe(true);
});
it('an explicit restart during continuation still closes the browser after draining', async () => {
  const { h, request } = await pausedBatch();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const hold = new Promise<void>((done) => {
    release = done;
  });
  vi.spyOn(h.platform, 'returnHomeAfterHandledTask').mockImplementation(
    async () => {
      entered();
      await hold;
      return h.control.probe;
    },
  );
  const handoff = h.api.releaseHandledTaskForContinuation(
    request.taskId,
    () => false,
  );
  await reached;
  const stop = h.api.stopForRestart();
  release();
  await stop;
  expect(await handoff).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(h.calls.filter((c) => c === 'close')).toHaveLength(1);
  expect(h.tasks.get(request.taskId)?.state).toBe('stopped_by_user');
});
for (const outcome of ['blocked', 'verified'] as const)
  it(`task-local quiesce drains the old writer and its late ${outcome} evidence before handoff`, async () => {
    const { h, api, repo, prepare } = await setup();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((done) => {
      entered = done;
    });
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const evidence = {
      remote: {
        recordKey: 'late-old-record',
        editUrl: 'https://example.test/edit/late-old-record',
      },
      images: [],
      cover: null,
    };
    h.platform.execute = async (task, hooks) => {
      await hooks.checkpoint('body');
      const current = h.tasks.get(task.taskId)!;
      h.tasks.apply(
        task.taskId,
        current.revision,
        { type: 'settle', state: 'needs_human', reason: 'RESULT_AMBIGUOUS' },
        h.control.now,
      );
      entered();
      await hold;
      await hooks.evidence(evidence);
      return outcome === 'verified'
        ? { status: 'verified', evidence }
        : { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
    };
    const handoff = vi.spyOn(h.platform, 'returnHomeAfterHandledTask');
    const reserve = repo.reserveNext.bind(repo);
    let reserves = 0;
    vi.spyOn(repo, 'reserveNext').mockImplementation((...args) =>
      ++reserves === 1 ? reserve(...args) : null,
    );
    const offered = await prepare();
    await api.start({
      preparationId: offered.preparationId,
      requestId: randomUUID(),
    });
    await reached;
    const old = h.tasks.latest()!;
    const invalidations = h.control.healthInvalidations;
    const flight = h.api.releaseHandledTaskForContinuation(
      old.taskId,
      () => false,
    );
    await Promise.resolve();
    expect(handoff).not.toHaveBeenCalled();
    expect(h.tasks.get(old.taskId)?.stopRequested).toBe(true);
    release();
    expect(await flight).toMatchObject({
      status: outcome === 'verified' ? 'blocked' : 'ready',
      ...(outcome === 'verified' ? { reason: 'RESULT_AMBIGUOUS' } : {}),
    });
    await api.waitForIdle();
    expect(h.tasks.get(old.taskId)).toMatchObject({
      state: outcome === 'verified' ? 'draft_saved' : 'stopped_by_user',
      evidence,
    });
    expect(handoff).toHaveBeenCalledTimes(outcome === 'verified' ? 0 : 1);
    expect(h.control.healthInvalidations).toBe(invalidations);
  });
function restartedBatch(
  h: Awaited<ReturnType<typeof createDraftHarness>>,
  repo: ReturnType<typeof openDraftBatchRepository>,
  draft = h.api,
) {
  return createBatchController({
    repository: repo,
    draft,
    preparation: h.preparation,
    articles: h.articles,
    snapshots: h.snapshots,
    newId: randomUUID,
    now: () => h.control.now,
    gate: () => 'ready',
  });
}
for (const status of [401, 403] as const)
  it(`captures the explicit skip boundary before writer drain delivers a new ${status}`, async () => {
    const { h, api, prepare } = await setup();
    const page = new EventEmitter();
    const observer = observeLiveSaves(page as unknown as Page);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((done) => {
      entered = done;
    });
    const hold = new Promise<void>((done) => {
      release = done;
    });
    h.platform.execute = async (task, hooks) => {
      await hooks.checkpoint('body');
      h.tasks.apply(
        task.taskId,
        h.tasks.get(task.taskId)!.revision,
        { type: 'settle', state: 'needs_human', reason: 'RESULT_AMBIGUOUS' },
        h.control.now,
      );
      entered();
      await hold;
      return { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
    };
    const captures: boolean[] = [];
    h.platform.captureHandledTaskContinuation = (task) => {
      captures.push(task.stopRequested);
      const boundary = observer.captureHandledDenials();
      return async () => {
        boundary.assertIdle();
        boundary.retire();
        return h.control.probe;
      };
    };
    const prepared = await prepare();
    await api.start({
      preparationId: prepared.preparationId,
      requestId: randomUUID(),
    });
    await reached;
    const task = h.tasks.latest()!;
    const continuing = h.api.releaseHandledTaskForContinuation(
      task.taskId,
      () => false,
    );
    expect(captures).toEqual([false]);
    const request = {
      url: () =>
        'https://www.autoengine.com/motor/dealer_admin/go_api/article/create',
      method: () => 'POST',
      response: async () => ({ status: () => status }),
    } as unknown as Request;
    page.emit('request', request);
    page.emit('requestfinished', request);
    await Promise.resolve();
    release();
    expect(await continuing).toMatchObject({
      status: 'blocked',
      reason: status === 401 ? 'LOGIN_REQUIRED' : 'PERMISSION_DENIED',
    });
    await api.waitForIdle();
    expect(h.tasks.get(task.taskId)).toMatchObject({
      state: 'needs_human',
      holdsPlatform: true,
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(
      await h.api.releaseHandledTaskForContinuation(task.taskId, () => false),
    ).toMatchObject({ status: 'ready' });
    expect(captures).toEqual([false, true]);
    expect(h.tasks.get(task.taskId)).toMatchObject({
      state: 'stopped_by_user',
      reason: 'RESULT_AMBIGUOUS',
      evidence: task.evidence,
    });
    observer.dispose();
  });
it('finishes the last skipped item without reopening a browser or editor', async () => {
  const { api, h, request } = await pausedBatch(2);
  const opens = h.calls.filter((c) => c === 'open').length;
  expect((await api.skipCurrentAndContinue(request)).status).toBe('ok');
  await api.waitForIdle();
  expect(await api.getCurrent()).toMatchObject({
    state: 'completed',
    counts: { saved: 2, skipped: 1 },
  });
  expect(h.calls.filter((c) => c === 'open')).toHaveLength(opens);
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(3);
});
it('retains the item after handoff failure and permits explicit cleanup retry', async () => {
  const { api, h, request } = await pausedBatch();
  const close = vi
    .spyOn(h.platform, 'returnHomeAfterHandledTask')
    .mockResolvedValueOnce({
      status: 'blocked',
      reason: 'BROWSER_UNAVAILABLE',
    });
  expect(await api.skipCurrentAndContinue(request)).toMatchObject({
    status: 'blocked',
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect((await api.getCurrent())!.items[0].state).toBe('needs_human');
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
  close.mockRestore();
  expect((await api.skipCurrentAndContinue(request)).status).toBe('ok');
  await api.waitForIdle();
  expect((await api.getCurrent())!.counts.skipped).toBe(1);
});
it('rejects concurrent clicks and gives a stop during recovery precedence', async () => {
  const { api, h, request } = await pausedBatch();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => (entered = r)),
    wait = new Promise<void>((r) => (release = r));
  vi.spyOn(h.platform, 'returnHomeAfterHandledTask').mockImplementation(
    async () => {
      entered();
      await wait;
      return h.control.probe;
    },
  );
  const recovery = api.skipCurrentAndContinue(request);
  await reached;
  expect(await api.skipCurrentAndContinue(request)).toMatchObject({
    status: 'blocked',
    reason: 'PLATFORM_BUSY',
  });
  api.requestStop();
  release();
  expect(await recovery).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
  expect((await api.getCurrent())!.items.slice(1).map((i) => i.state)).toEqual([
    'stopped',
    'stopped',
  ]);
});
for (const boundary of ['before-commit', 'after-commit'] as const)
  it(`stop ${boundary} of manual skip preserves history and reserves no next task`, async () => {
    const { api, h, repo, request } = await pausedBatch();
    const original = h.tasks.get(request.taskId)!;
    const callsBefore = h.calls.filter((call) => call === 'execute').length;
    if (boundary === 'before-commit') {
      const release = h.api.releaseHandledTaskForContinuation.bind(h.api);
      vi.spyOn(h.api, 'releaseHandledTaskForContinuation').mockImplementation(
        async (taskId, cancelled) => {
          const result = await release(taskId, cancelled);
          api.requestStop();
          return result;
        },
      );
    } else {
      const commit = repo.skipCurrentAndContinue.bind(repo);
      vi.spyOn(repo, 'skipCurrentAndContinue').mockImplementation(
        (input, now) => {
          const result = commit(input, now);
          api.requestStop();
          return result;
        },
      );
    }
    await api.skipCurrentAndContinue(request);
    await api.waitForIdle();
    const after = (await api.getCurrent())!;
    expect(after.stopRequested).toBe(true);
    expect(after.items[0].state).toBe(
      boundary === 'after-commit' ? 'skipped' : 'needs_human',
    );
    expect(after.items.slice(1).map((item) => item.taskId)).toEqual([
      null,
      null,
    ]);
    expect(h.calls.filter((call) => call === 'execute')).toHaveLength(
      callsBefore,
    );
    expect(h.tasks.get(request.taskId)).toMatchObject({
      state: 'stopped_by_user',
      evidence: original.evidence,
      reason: original.reason,
      snapshot: original.snapshot,
    });
    await h.restart();
    expect(repo.get(after.id)).toEqual(after);
    expect(h.tasks.get(request.taskId)?.evidence).toEqual(original.evidence);
  });
it('rejects a mismatched task identity before closing any browser', async () => {
  const { api, h, request } = await pausedBatch();
  const closes = h.calls.filter((c) => c === 'close').length;
  expect(
    await api.skipCurrentAndContinue({ ...request, taskId: randomUUID() }),
  ).toMatchObject({ status: 'blocked', reason: 'STALE_PREPARATION' });
  expect(h.calls.filter((c) => c === 'close')).toHaveLength(closes);
});
for (const changed of ['article', 'cover', 'asset'] as const)
  it(`refuses recovery for a stale frozen ${changed} without replacing snapshots`, async () => {
    const { api, h, keys, request } = await pausedBatch();
    if (changed === 'article') {
      const load = h.articles.loadEditableArticle.bind(h.articles);
      vi.spyOn(h.articles, 'loadEditableArticle').mockImplementation((key) => {
        const article = load(key);
        return article && key === keys[1]
          ? { ...article, articleRevision: article.articleRevision + 1 }
          : article;
      });
    } else if (changed === 'cover') await h.setSingleCover(keys[1]);
    else
      h.control.verify = async () => {
        throw { code: 'ASSET_UNAVAILABLE' };
      };
    expect(await api.skipCurrentAndContinue(request)).toMatchObject({
      status: 'blocked',
      reason: changed === 'asset' ? 'ASSET_UNAVAILABLE' : 'STALE_PREPARATION',
    });
    expect((await api.getCurrent())!.items.map((i) => i.state)).toEqual([
      'needs_human',
      'queued',
      'queued',
    ]);
    expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
  });
it('does not reserve remaining work when the skip transaction fails', async () => {
  const { api, h, repo, request } = await pausedBatch();
  const fail = vi
    .spyOn(repo, 'skipCurrentAndContinue')
    .mockImplementationOnce(() => {
      throw Error('fixture storage');
    });
  expect(await api.skipCurrentAndContinue(request)).toMatchObject({
    status: 'blocked',
    reason: 'STORAGE_UNAVAILABLE',
  });
  expect((await api.getCurrent())!.items.map((i) => i.state)).toEqual([
    'needs_human',
    'queued',
    'queued',
  ]);
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
  fail.mockRestore();
  expect((await api.skipCurrentAndContinue(request)).status).toBe('ok');
  await api.waitForIdle();
});
it('restart requires explicit skip and never replays the paused task', async () => {
  const { api, h, repo } = await pausedBatch();
  const draft = await h.restart();
  const next = restartedBatch(h, repo, draft);
  const view = (await next.getCurrent())!;
  expect(view.state).toBe('interrupted');
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
  expect(
    (
      await next.skipCurrentAndContinue({
        batchId: view.id,
        expectedRevision: view.revision,
        taskId: view.items[0].taskId!,
      })
    ).status,
  ).toBe('ok');
  await next.waitForIdle();
  expect((await next.getCurrent())!.items.map((i) => i.state)).toEqual([
    'skipped',
    'draft_saved',
    'draft_saved',
  ]);
  await api.waitForIdle();
});
it('recovers untouched queue after a crash between skip commit and next reservation', async () => {
  const { api, h, repo, request } = await pausedBatch();
  await h.api.releaseHandledTask(request.taskId);
  repo.skipCurrentAndContinue(request, h.control.now);
  const draft = await h.restart();
  const next = restartedBatch(h, repo, draft);
  const view = (await next.getCurrent())!;
  expect(view.items.map((i) => i.state)).toEqual([
    'skipped',
    'queued',
    'queued',
  ]);
  expect(
    (
      await next.skipCurrentAndContinue({
        batchId: view.id,
        expectedRevision: view.revision,
        taskId: null,
      })
    ).status,
  ).toBe('ok');
  await next.waitForIdle();
  expect((await next.getCurrent())!.counts).toMatchObject({
    skipped: 1,
    saved: 2,
  });
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(3);
  await api.waitForIdle();
});
it('recovers an interrupted batch before its first task was reserved', async () => {
  const { api, h, repo, prepare } = await setup();
  const offered = await prepare();
  vi.spyOn(repo, 'reserveNext').mockReturnValueOnce(null);
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await api.waitForIdle();
  const draft = await h.restart();
  h.control.pauseAt = 'none';
  const next = restartedBatch(h, repo, draft);
  const view = (await next.getCurrent())!;
  expect(view.items.every((i) => i.taskId === null)).toBe(true);
  expect(
    (
      await next.skipCurrentAndContinue({
        batchId: view.id,
        expectedRevision: view.revision,
        taskId: null,
      })
    ).status,
  ).toBe('ok');
  await next.waitForIdle();
  expect((await next.getCurrent())!.counts.saved).toBe(3);
});
it('does not turn an intentional stop into restart permission', async () => {
  const { api, h, repo, request } = await pausedBatch();
  await api.stop({ batchId: request.batchId });
  await h.restart();
  const next = restartedBatch(h, repo);
  const view = (await next.getCurrent())!;
  expect(view.reason).toBe('STOP_REQUESTED');
  expect(
    (
      await next.skipCurrentAndContinue({
        ...request,
        expectedRevision: view.revision,
      })
    ).status,
  ).toBe('blocked');
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
});
it('does not recover while the original writer is still executing', async () => {
  const { api, h, prepare } = await setup();
  const offered = await prepare();
  await api.start({
    preparationId: offered.preparationId,
    requestId: randomUUID(),
  });
  await vi.waitFor(() => expect(h.calls).toContain('execute'));
  const view = (await api.getCurrent())!;
  expect(
    await api.skipCurrentAndContinue({
      batchId: view.id,
      expectedRevision: view.revision,
      taskId: view.items[0].taskId!,
    }),
  ).toMatchObject({ status: 'blocked', reason: 'PLATFORM_BUSY' });
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
  api.requestStop();
  h.releaseExecute();
  await api.waitForIdle();
});
