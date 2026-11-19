import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDraftHarness } from '../fixtures/draft-harness';
import { legacyFixtureSnapshotCapture } from '../fixtures/legacy-snapshot-capture';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createDraftController } from '../../src/application/draft-controller';
import { createBatchController } from '../../src/application/batch-controller';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { createJudongcheAdapter } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { JudongchePageError } from '../../src/infrastructure/platforms/judongche/production-state';
import { errors } from 'playwright-core';

async function live(
  context: BrowserContext,
  page: Page,
  last = false,
  uploadFailure = false,
  pauseBefore?:
    | 'probe'
    | 'entry'
    | 'bind-extra'
    | 'bind-closed'
    | 'bind-replaced'
    | 'bind-retired'
    | 'save401'
    | 'save403',
) {
  await denyExternalNetwork(context);
  const fixture = await installProductionFixture(context, {
    batchHistory: true,
    observedTrailingParagraphs: true,
    ...(uploadFailure ? { imageClose: 'unknown-dialog' as const } : {}),
  });
  let createAttempts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.endsWith('/article/create')
    )
      createAttempts++;
  });
  if (pauseBefore === 'save401' || pauseBefore === 'save403') {
    let first = true;
    await context.route(
      '**/motor/dealer_admin/go_api/article/create',
      (route) => {
        if (!first) return route.fallback();
        first = false;
        return route.fulfill({
          status: pauseBefore === 'save401' ? 401 : 403,
          json: { status: -1 },
        });
      },
    );
  }
  const h = await createDraftHarness(uploadFailure ? 1 : 0);
  legacyFixtureSnapshotCapture(h.snapshots);
  const repository = openDraftBatchRepository(
    h.path,
    resolve('src/infrastructure/persistence/migrations'),
  );
  let ready = true,
    generation = randomUUID(),
    opened = 0,
    closed = 0,
    invalidated = 0;
  const initialGeneration = generation;
  const session = {
    open: async () => {
      opened++;
      if (!ready) throw Error('retired health');
      return context;
    },
    current: () => (ready ? context : undefined),
    generation: () => generation,
    close: async () => {
      closed++;
      ready = false;
      generation = randomUUID();
    },
  };
  const adapter = createJudongcheAdapter(session, undefined, {
    manualReview: true,
    batchSubmissionReview: 'operator',
    ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
  });
  const execute = adapter.execute.bind(adapter);
  let writers = 0,
    maxWriters = 0,
    executions = 0;
  adapter.execute = async (task, hooks) => {
    executions++;
    const first = task.articleKey === h.articleKey;
    writers++;
    maxWriters = Math.max(maxWriters, writers);
    try {
      if (first && pauseBefore === 'entry')
        await page.evaluate(() =>
          document.body.insertAdjacentHTML(
            'beforeend',
            '<div id="t3-login">巨懂车欢迎您</div>',
          ),
        );
      return await execute(task, {
        ...hooks,
        checkpoint: async (stage) => {
          await hooks.checkpoint(stage);
          if (first && !uploadFailure && !pauseBefore && stage === 'cover')
            throw new JudongchePageError('CONTENT_MISMATCH');
        },
      });
    } finally {
      writers--;
    }
  };
  const preparation = createDraftPreparation({
    repository: h.articles,
    covers: h.articles,
    tasks: h.tasks,
    snapshots: h.snapshots,
    contentCapabilities: () => adapter.contentCapabilities(),
    newId: randomUUID,
  });
  const draft = createDraftController({
    // Equivalent to main -> invalidateOperation -> session.invalidateHealth:
    // a call really destroys readiness and generation, not just a counter.
    invalidateBrowserHealth: () => {
      invalidated++;
      ready = false;
      generation = randomUUID();
    },
    tasks: h.tasks,
    snapshots: h.snapshots,
    preparation,
    platform: adapter,
    newId: randomUUID,
    now: () => new Date().toISOString(),
    gate: () => 'ready',
    controlledPilot: { storeIdentity: '123456' },
  });
  const batch = createBatchController({
    repository,
    draft,
    preparation,
    articles: h.articles,
    snapshots: h.snapshots,
    newId: randomUUID,
    now: () => new Date().toISOString(),
    gate: () => 'ready',
  });
  let newPages = 0,
    homes = 0;
  context.on('page', () => newPages++);
  await page.goto(fixture.home);
  const openedSession = await draft.openDraftSession();
  const keys = [h.articleKey];
  if (!last) keys.push(await h.addArticle('Next live article'));
  const prepared = await batch.prepare({
    articleKeys: keys,
    bindingToken: openedSession.view.session.bindingToken!,
  });
  if (prepared.status !== 'ready') throw Error(JSON.stringify(prepared));
  let extraBeforeBind: Page | undefined;
  if (pauseBefore === 'probe' || pauseBefore?.startsWith('bind-')) {
    const executeReserved = draft.executeBatchTask.bind(draft);
    draft.executeBatchTask = async (...args) => {
      if (h.tasks.get(args[0])?.articleKey === h.articleKey) {
        if (pauseBefore === 'bind-extra')
          extraBeforeBind = await context.newPage();
        else if (pauseBefore === 'bind-closed') await page.close();
        else if (pauseBefore === 'bind-replaced') {
          extraBeforeBind = await context.newPage();
          await page.close();
        } else if (pauseBefore === 'bind-retired') generation = randomUUID();
        else
          await page.evaluate(() =>
            document.body.insertAdjacentHTML(
              'beforeend',
              '<div id="t3-login">巨懂车欢迎您</div>',
            ),
          );
      }
      return executeReserved(...args);
    };
  }
  const denialFinished = pauseBefore?.startsWith('save')
    ? page.waitForEvent('requestfinished', (request) =>
        request.url().endsWith('/article/create'),
      )
    : undefined;
  await batch.start({
    preparationId: prepared.preparation.preparationId,
    requestId: randomUUID(),
  });
  await batch.waitForIdle();
  await denialFinished;
  const paused = (await batch.getCurrent())!;
  expect(paused.state).toBe('paused');
  const taskId = paused.items[0].taskId!;
  const original = h.tasks.get(taskId)!;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && page.url() === fixture.home) homes++;
  });
  return {
    batch,
    draft,
    adapter,
    h,
    fixture,
    repository,
    original,
    extraBeforeBind,
    request: { batchId: paused.id, expectedRevision: paused.revision, taskId },
    stats: () => ({
      opened,
      closed,
      invalidated,
      newPages,
      homes,
      writers,
      maxWriters,
      executions,
      generation,
      initialGeneration,
      createAttempts,
    }),
    async dispose() {
      await batch.stopAndWait();
      repository.close();
      await h.close();
    },
  };
}

for (const action of [
  'saved',
  'abandoned',
  'already-home',
  'home-no-greeting',
  'last',
  'unknown-upload',
] as const)
  test(`live skip ${action} preserves the exact Page/Context and resumes once`, async ({
    context,
    page,
  }) => {
    test.setTimeout(90000);
    const s = await live(
      context,
      page,
      action === 'last',
      action === 'unknown-upload',
    );
    try {
      // Manual abandonment may leave failed images and arbitrary body formatting.
      // These are not activity and must not become content-equality gates.
      await page
        .locator('[role=dialog]')
        .evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
      await page.locator('#body').evaluate((body) => {
        body.innerHTML =
          '<p>Manually changed body</p><img src="/fixture/broken">';
      });
      if (action === 'saved') {
        const response = page.waitForResponse(
          '**/motor/dealer_admin/go_api/article/create',
        );
        const finished = page.waitForEvent('requestfinished', (request) =>
          request.url().endsWith('/article/create'),
        );
        await page.getByRole('button', { name: '存草稿', exact: true }).click();
        await response;
        await finished;
      }
      if (action === 'already-home') await page.goto(s.fixture.home);
      if (action === 'home-no-greeting')
        await context.route(s.fixture.home, (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<div>Home</div><div class="arco-spin-loading"><span role="progressbar">Other module</span></div>',
          }),
        );
      const before = s.stats();
      const skipped = await s.batch.skipCurrentAndContinue(s.request);
      expect(skipped, JSON.stringify(skipped)).toMatchObject({ status: 'ok' });
      await s.batch.waitForIdle();
      const stats = s.stats();
      expect(stats).toMatchObject({
        closed: 0,
        invalidated: 0,
        opened: 1,
        newPages: 0,
        writers: 0,
        maxWriters: 1,
        executions: action === 'last' ? 1 : 2,
        generation: stats.initialGeneration,
      });
      // Next article's ordinary successful save also returns home once.
      expect(stats.homes - before.homes).toBe(
        (action === 'already-home' ? 0 : 1) + (action === 'last' ? 0 : 1),
      );
      expect(context.pages()).toEqual([page]);
      expect(page.isClosed()).toBe(false);
      expect(s.h.tasks.get(s.request.taskId)).toMatchObject({
        state: 'stopped_by_user',
        reason: s.original.reason,
        possibleRemoteEffect: s.original.possibleRemoteEffect,
        saveAttempted: s.original.saveAttempted,
        evidence: s.original.evidence,
      });
      expect(
        (await s.batch.getCurrent())!.items.map((item) => item.state),
      ).toEqual(
        action === 'last' ? ['skipped'] : ['skipped', 'submission_recorded'],
      );
      expect(s.fixture.saves()).toBe(
        action === 'saved' ? 2 : action === 'last' ? 0 : 1,
      );
      expect(s.fixture.undoes()).toBe(0);
      expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
        status: 'blocked',
      });
    } finally {
      await s.dispose();
    }
  });

for (const hazard of [
  'upload',
  'save',
  'pending-create',
  'login',
  'verification',
  'permission',
  'unknown-page',
] as const)
  test(`live skip pauses for fresh ${hazard} activity or unsafe state`, async ({
    context,
    page,
  }) => {
    const s = await live(context, page);
    let release: (() => void) | undefined;
    try {
      if (hazard === 'pending-create') {
        const hold = new Promise<void>((done) => {
          release = done;
        });
        await context.route(
          '**/motor/dealer_admin/go_api/article/create',
          async (route) => {
            await hold;
            await route.fallback();
          },
        );
        const request = page.waitForRequest(
          '**/motor/dealer_admin/go_api/article/create',
        );
        await page.getByRole('button', { name: '存草稿', exact: true }).click();
        await request;
      } else if (hazard === 'unknown-page')
        await page.goto(
          'https://www.autoengine.com/jdc/dealer/info/contentPublish/sceneMarketing',
        );
      else
        await page.evaluate((hazard) => {
          if (hazard === 'save')
            document.querySelector('#save')!.setAttribute('aria-busy', 'true');
          else
            (hazard === 'upload'
              ? document.querySelector('#body')!
              : document.body
            ).insertAdjacentHTML(
              'beforeend',
              hazard === 'upload'
                ? '<progress></progress>'
                : `<div>${hazard === 'login' ? '巨懂车欢迎您' : hazard === 'permission' ? '暂无权限' : '安全验证'}</div>`,
            );
        }, hazard);
      const expected =
        hazard === 'login'
          ? 'LOGIN_REQUIRED'
          : hazard === 'verification'
            ? 'VERIFICATION_REQUIRED'
            : hazard === 'permission'
              ? 'PERMISSION_DENIED'
              : hazard === 'unknown-page'
                ? 'PAGE_CHANGED'
                : 'RESULT_AMBIGUOUS';
      expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
        status: 'blocked',
        reason: expected,
      });
      expect(s.stats()).toMatchObject({
        homes: 0,
        executions: 1,
        closed: 0,
        newPages: 0,
        invalidated: 0,
      });
      expect(s.h.tasks.get(s.request.taskId)?.holdsPlatform).toBe(true);
    } finally {
      release?.();
      await s.dispose();
    }
  });

test('manual closure of the paused upload modal retires unknown history on retry', async ({
  context,
  page,
}) => {
  const s = await live(context, page, false, true);
  try {
    expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
      status: 'blocked',
      reason: 'PAGE_CHANGED',
    });
    expect(s.stats()).toMatchObject({ homes: 0, executions: 1, closed: 0 });
    await page
      .locator('[role=dialog]')
      .evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
    expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
      status: 'ok',
    });
    await s.batch.waitForIdle();
    expect(s.stats()).toMatchObject({
      homes: 2,
      executions: 2,
      closed: 0,
      invalidated: 0,
      newPages: 0,
    });
    expect(s.h.tasks.get(s.request.taskId)).toMatchObject({
      state: 'stopped_by_user',
      reason: s.original.reason,
      evidence: s.original.evidence,
    });
  } finally {
    await s.dispose();
  }
});

for (const boundary of ['timeout-arrived', 'stop-after-home'] as const)
  test(`home handoff reconciles ${boundary} without replay or extra browser`, async ({
    context,
    page,
  }) => {
    const s = await live(context, page);
    const goto = page.goto.bind(page);
    let handoffHomes = 0;
    page.goto = new Proxy(goto, {
      async apply(target, receiver, args) {
        const value = await Reflect.apply(target, receiver, args);
        if (args[0] === s.fixture.home && ++handoffHomes === 1) {
          if (boundary === 'timeout-arrived')
            throw new errors.TimeoutError(
              'Synthetic after navigation completed',
            );
          s.batch.requestStop();
        }
        return value;
      },
    });
    try {
      expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
        status: boundary === 'timeout-arrived' ? 'ok' : 'blocked',
        ...(boundary === 'stop-after-home' ? { reason: 'STOP_REQUESTED' } : {}),
      });
      await s.batch.waitForIdle();
      expect(s.stats()).toMatchObject({
        homes: boundary === 'timeout-arrived' ? 2 : 1,
        executions: boundary === 'timeout-arrived' ? 2 : 1,
        closed: 0,
        newPages: 0,
      });
      expect(handoffHomes).toBe(boundary === 'timeout-arrived' ? 2 : 1);
      if (boundary === 'stop-after-home')
        expect(s.h.tasks.get(s.request.taskId)?.holdsPlatform).toBe(true);
    } finally {
      page.goto = goto;
      await s.dispose();
    }
  });

test('lost live primary cannot silently reopen or take startup recovery', async ({
  context,
  page,
}) => {
  const s = await live(context, page);
  try {
    await page.close();
    expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
      status: 'blocked',
      reason: 'PAGE_CHANGED',
    });
    expect(s.stats()).toMatchObject({
      homes: 0,
      executions: 1,
      opened: 1,
      closed: 0,
      newPages: 0,
    });
    expect(s.h.tasks.get(s.request.taskId)?.holdsPlatform).toBe(true);
  } finally {
    await s.dispose();
  }
});

for (const phase of ['probe', 'entry'] as const)
  test(`R1 original queued session remains handoff-capable after ${phase} login pause`, async ({
    context,
    page,
  }) => {
    const s = await live(context, page, false, false, phase);
    try {
      expect(s.original).toMatchObject({
        state: 'needs_human',
        reason: 'LOGIN_REQUIRED',
        saveAttempted: false,
        possibleRemoteEffect: false,
      });
      await page.locator('#t3-login').evaluate((node) => node.remove());
      expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
        status: 'ok',
      });
      await s.batch.waitForIdle();
      expect(s.stats()).toMatchObject({
        opened: 1,
        closed: 0,
        invalidated: 0,
        newPages: 0,
        generation: s.stats().initialGeneration,
        maxWriters: 1,
        executions: phase === 'probe' ? 1 : 2,
      });
      expect(context.pages()).toEqual([page]);
      expect(s.h.tasks.get(s.request.taskId)).toMatchObject({
        state: 'stopped_by_user',
        reason: 'LOGIN_REQUIRED',
        saveAttempted: false,
        evidence: s.original.evidence,
      });
      expect(
        (await s.batch.getCurrent())!.items.map((item) => item.state),
      ).toEqual(['skipped', 'submission_recorded']);
    } finally {
      await s.dispose();
    }
  });

test('R2 original Page observer survives an extra tab and covers manual create during the blockage', async ({
  context,
  page,
}) => {
  const s = await live(context, page);
  let release!: () => void;
  const hold = new Promise<void>((done) => {
    release = done;
  });
  const extra = await context.newPage();
  let finished: Promise<unknown> | undefined;
  try {
    expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
      status: 'blocked',
      reason: 'PAGE_CHANGED',
    });
    await context.route(
      '**/motor/dealer_admin/go_api/article/create',
      async (route) => {
        await hold;
        await route.fallback();
      },
    );
    const started = page.waitForRequest(
      '**/motor/dealer_admin/go_api/article/create',
    );
    finished = page.waitForEvent('requestfinished', (request) =>
      request.url().endsWith('/article/create'),
    );
    await page.getByRole('button', { name: '存草稿', exact: true }).click();
    await started;
    await extra.close();
    expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(s.stats()).toMatchObject({ homes: 0, closed: 0, executions: 1 });
    release();
    await finished;
    expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
      status: 'ok',
    });
    await s.batch.waitForIdle();
    expect(context.pages()).toEqual([page]);
    expect(s.stats()).toMatchObject({
      opened: 1,
      closed: 0,
      invalidated: 0,
      homes: 2,
      executions: 2,
      maxWriters: 1,
      newPages: 1,
    });
  } finally {
    release();
    await finished?.catch(() => {});
    if (!extra.isClosed()) await extra.close();
    await s.dispose();
  }
});

test('R1 extra tab before queued binding can be closed and skipped on the original Page', async ({
  context,
  page,
}) => {
  const s = await live(context, page, false, false, 'bind-extra');
  try {
    expect(s.original).toMatchObject({
      state: 'needs_human',
      reason: 'PAGE_CHANGED',
      possibleRemoteEffect: false,
      saveAttempted: false,
    });
    expect(s.extraBeforeBind).toBeTruthy();
    await s.extraBeforeBind!.close();
    expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
      status: 'ok',
    });
    await s.batch.waitForIdle();
    expect(context.pages()).toEqual([page]);
    expect(s.stats()).toMatchObject({
      opened: 1,
      closed: 0,
      invalidated: 0,
      newPages: 1,
      maxWriters: 1,
      executions: 1,
    });
    expect(s.h.tasks.get(s.request.taskId)).toMatchObject({
      state: 'stopped_by_user',
      reason: 'PAGE_CHANGED',
      evidence: s.original.evidence,
    });
  } finally {
    if (!s.extraBeforeBind!.isClosed()) await s.extraBeforeBind!.close();
    await s.dispose();
  }
});

for (const fault of ['bind-closed', 'bind-replaced', 'bind-retired'] as const)
  test(`R1 historical binding refuses ${fault} without adopting another Page`, async ({
    context,
    page,
  }) => {
    const s = await live(context, page, false, false, fault);
    try {
      expect(s.original).toMatchObject({
        state: 'needs_human',
        reason: 'PAGE_CHANGED',
        possibleRemoteEffect: false,
        saveAttempted: false,
      });
      expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
        status: 'blocked',
        reason: 'INPUT_UNSUPPORTED',
      });
      expect(s.stats()).toMatchObject({
        opened: 1,
        closed: 0,
        invalidated: 0,
        homes: 0,
        executions: 0,
      });
      expect(
        (await s.batch.getCurrent())!.items.map((item) => item.state),
      ).toEqual(['needs_human', 'queued']);
    } finally {
      if (s.extraBeforeBind && !s.extraBeforeBind.isClosed())
        await s.extraBeforeBind.close();
      await s.dispose();
    }
  });

for (const status of [401, 403] as const)
  for (const action of ['abandoned', 'saved'] as const)
    test(`denial history ${status} permits explicit ${action} after fresh manual recovery`, async ({
      context,
      page,
    }) => {
      const s = await live(
        context,
        page,
        false,
        false,
        status === 401 ? 'save401' : 'save403',
      );
      try {
        const reason = status === 401 ? 'LOGIN_REQUIRED' : 'PERMISSION_DENIED';
        expect(s.original).toMatchObject({
          state: 'needs_human',
          reason,
          saveAttempted: true,
          possibleRemoteEffect: true,
        });
        await page.evaluate(
          (message) =>
            document.body.insertAdjacentHTML(
              'beforeend',
              `<div id="denial-visible">${message}</div>`,
            ),
          status === 401 ? '巨懂车欢迎您' : '暂无权限',
        );
        expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
          status: 'blocked',
          reason,
        });
        expect(s.stats()).toMatchObject({
          homes: 0,
          executions: 1,
          createAttempts: 1,
        });
        await page.locator('#denial-visible').evaluate((node) => node.remove());
        if (action === 'saved') {
          const finished = page.waitForEvent('requestfinished', (request) =>
            request.url().endsWith('/article/create'),
          );
          await page
            .getByRole('button', { name: '存草稿', exact: true })
            .click();
          await finished;
        }
        const skipped = await s.batch.skipCurrentAndContinue(s.request);
        expect(skipped, JSON.stringify(skipped)).toMatchObject({
          status: 'ok',
        });
        await s.batch.waitForIdle();
        expect(s.stats()).toMatchObject({
          opened: 1,
          closed: 0,
          invalidated: 0,
          newPages: 0,
          homes: 2,
          executions: 2,
          generation: s.stats().initialGeneration,
          createAttempts: action === 'saved' ? 3 : 2,
        });
        expect(context.pages()).toEqual([page]);
        expect(s.h.tasks.get(s.request.taskId)).toMatchObject({
          state: 'stopped_by_user',
          reason,
          evidence: s.original.evidence,
          saveAttempted: s.original.saveAttempted,
          possibleRemoteEffect: s.original.possibleRemoteEffect,
        });
      } finally {
        await s.dispose();
      }
    });

for (const status of [401, 403] as const)
  for (const arrival of [
    'pending-before-click',
    'created-after-click',
  ] as const)
    test(`denial boundary ${arrival} ${status} blocks after the captured skip even when transport finishes`, async ({
      context,
      page,
    }) => {
      const s = await live(context, page);
      let releaseResponse!: () => void,
        releaseHandoff!: () => void,
        captured!: () => void;
      const responseHold = new Promise<void>((done) => {
        releaseResponse = done;
      });
      const handoffHold = new Promise<void>((done) => {
        releaseHandoff = done;
      });
      const captureReached = new Promise<void>((done) => {
        captured = done;
      });
      const capture = s.adapter.captureHandledTaskContinuation!.bind(s.adapter);
      s.adapter.captureHandledTaskContinuation = (task) => {
        const proceed = capture(task);
        captured();
        return async (cancelled) => {
          await handoffHold;
          return proceed(cancelled);
        };
      };
      await context.route(
        '**/motor/dealer_admin/go_api/article/create',
        async (route) => {
          await responseHold;
          await route.fulfill({ status, json: { status: -1 } });
        },
      );
      let finished: Promise<unknown> | undefined;
      const save = async () => {
        finished = page.waitForEvent('requestfinished', (request) =>
          request.url().endsWith('/article/create'),
        );
        const started = page.waitForRequest(
          '**/motor/dealer_admin/go_api/article/create',
        );
        await page.getByRole('button', { name: '存草稿', exact: true }).click();
        await started;
      };
      let skip: ReturnType<typeof s.batch.skipCurrentAndContinue> | undefined;
      try {
        if (arrival === 'pending-before-click') await save();
        skip = s.batch.skipCurrentAndContinue(s.request);
        await captureReached;
        expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
          status: 'blocked',
          reason: 'PLATFORM_BUSY',
        });
        if (arrival === 'created-after-click') await save();
        releaseResponse();
        await finished;
        releaseHandoff();
        expect(await skip).toMatchObject({
          status: 'blocked',
          reason: status === 401 ? 'LOGIN_REQUIRED' : 'PERMISSION_DENIED',
        });
        expect(s.stats()).toMatchObject({
          homes: 0,
          executions: 1,
          opened: 1,
          closed: 0,
          newPages: 0,
          createAttempts: 1,
        });
        expect(s.h.tasks.get(s.request.taskId)).toMatchObject({
          state: 'needs_human',
          holdsPlatform: true,
          reason: s.original.reason,
          evidence: s.original.evidence,
        });
      } finally {
        releaseResponse();
        releaseHandoff();
        await finished?.catch(() => {});
        await skip;
        await s.dispose();
      }
    });

for (const status of [401, 403] as const)
  test(`denial history ${status} is retired without poisoning the following task's explicit skip`, async ({
    context,
    page,
  }) => {
    const s = await live(
      context,
      page,
      false,
      false,
      status === 401 ? 'save401' : 'save403',
    );
    const execute = s.adapter.execute.bind(s.adapter);
    s.adapter.execute = (task, hooks) =>
      execute(task, {
        ...hooks,
        checkpoint: async (stage) => {
          await hooks.checkpoint(stage);
          if (task.articleKey !== s.original.articleKey && stage === 'cover')
            throw new JudongchePageError('CONTENT_MISMATCH');
        },
      });
    try {
      expect(await s.batch.skipCurrentAndContinue(s.request)).toMatchObject({
        status: 'ok',
      });
      await s.batch.waitForIdle();
      const next = (await s.batch.getCurrent())!;
      expect(next.items.map((item) => item.state)).toEqual([
        'skipped',
        'needs_human',
      ]);
      const second = s.h.tasks.get(next.items[1]!.taskId!)!;
      expect(second.reason).toBe('CONTENT_MISMATCH');
      expect(s.stats().createAttempts).toBe(1);
      expect(
        await s.batch.skipCurrentAndContinue({
          batchId: next.id,
          expectedRevision: next.revision,
          taskId: second.taskId,
        }),
      ).toMatchObject({ status: 'ok' });
      await s.batch.waitForIdle();
      expect(
        (await s.batch.getCurrent())!.items.map((item) => item.state),
      ).toEqual(['skipped', 'skipped']);
      expect(s.stats()).toMatchObject({
        opened: 1,
        closed: 0,
        newPages: 0,
        invalidated: 0,
        homes: 2,
        createAttempts: 1,
      });
      expect(s.h.tasks.get(second.taskId)).toMatchObject({
        state: 'stopped_by_user',
        reason: 'CONTENT_MISMATCH',
        evidence: second.evidence,
      });
      expect(s.h.tasks.get(s.original.taskId)).toMatchObject({
        state: 'stopped_by_user',
        reason: s.original.reason,
        evidence: s.original.evidence,
      });
    } finally {
      await s.dispose();
    }
  });

for (const fault of [
  'cancelled',
  'primary-closed',
  'primary-replaced',
] as const)
  test(`denial capability ${fault} prevents history retirement and navigation`, async ({
    context,
    page,
  }) => {
    const s = await live(context, page, false, false, 'save401');
    let release!: () => void, captured!: () => void;
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const reached = new Promise<void>((done) => {
      captured = done;
    });
    const capture = s.adapter.captureHandledTaskContinuation!.bind(s.adapter);
    s.adapter.captureHandledTaskContinuation = (task) => {
      const proceed = capture(task);
      captured();
      return async (cancelled) => {
        await hold;
        return proceed(cancelled);
      };
    };
    let skip: ReturnType<typeof s.batch.skipCurrentAndContinue> | undefined;
    let replacement: Page | undefined;
    try {
      skip = s.batch.skipCurrentAndContinue(s.request);
      await reached;
      if (fault === 'cancelled') s.batch.requestStop();
      else {
        if (fault === 'primary-replaced') replacement = await context.newPage();
        await page.close();
      }
      release();
      expect(await skip).toMatchObject({
        status: 'blocked',
        reason: fault === 'cancelled' ? 'STOP_REQUESTED' : 'PAGE_CHANGED',
      });
      expect(s.stats()).toMatchObject({
        homes: 0,
        executions: 1,
        opened: 1,
        createAttempts: 1,
      });
      expect(s.h.tasks.get(s.original.taskId)).toMatchObject({
        state: 'needs_human',
        holdsPlatform: true,
        reason: s.original.reason,
        evidence: s.original.evidence,
        saveAttempted: true,
      });
    } finally {
      release();
      await skip;
      if (replacement && !replacement.isClosed()) await replacement.close();
      await s.dispose();
    }
  });
