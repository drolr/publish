import { expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { writeProbeLog } from '../../src/desktop/main/probe-log';
import { createDraftHarness } from './draft-harness';
import { legacyFixtureSnapshotCapture } from './legacy-snapshot-capture';
import { installProductionFixture } from './judongche-production';
import { denyExternalNetwork } from '../e2e/network-policy';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createDraftController } from '../../src/application/draft-controller';
import { createBatchController } from '../../src/application/batch-controller';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';

export type OperatorObservation =
  'acknowledged' | 'rejected' | 'unknown' | 'pending';

/** Real adapter/controllers/repositories; only the merchant network is invented. */
export async function operatorSettlement(
  context: BrowserContext,
  page: Page,
  observation: OperatorObservation,
  stopAt?:
    'returned' | 'settling' | 'before-click' | 'in-flight' | 'write-failure',
) {
  await denyExternalNetwork(context);
  const fixture = await installProductionFixture(context, {
    batchHistory: true,
  });
  let stop = () => {};
  let requests = 0;
  const requestTitles: string[] = [];
  const actions: string[] = [];
  let actionsAtStop: string[] | undefined;
  const requestStop = () => {
    actionsAtStop = [...actions];
    stop();
  };
  let parsed = false;
  let checksAfterParse = 0;
  context.on('response', (response) => {
    if (!response.url().endsWith('/article/create')) return;
    const json = response.json.bind(response);
    response.json = async () => {
      const value: unknown = await json();
      parsed = true;
      return value;
    };
  });
  await context.route(
    '**/motor/dealer_admin/go_api/article/create',
    async (route) => {
      requests++;
      requestTitles.push(route.request().postDataJSON().title);
      if (stopAt === 'in-flight') {
        requestStop();
        return;
      }
      if (observation === 'pending') return;
      await route.fulfill({
        status: 200,
        json:
          observation === 'unknown'
            ? {}
            : { status: observation === 'rejected' ? 5000 : 0 },
      });
    },
  );
  context.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.endsWith('/Article') ||
      path.endsWith('/home') ||
      path.endsWith('/article/create') ||
      path.includes('/upload')
    )
      actions.push(path);
  });
  const h = await createDraftHarness(0, {
    title: 'Durable operator result',
    contentDeclaration: 'repost',
  });
  const apply = h.tasks.apply.bind(h.tasks);
  if (stopAt === 'write-failure')
    h.tasks.apply = (...args) => {
      if (args[2].type === 'evidence' && args[2].evidence.submission)
        throw Error('synthetic durable observation failure');
      return apply(...args);
    };
  const migrations = resolve('src/infrastructure/persistence/migrations');
  let repository = openDraftBatchRepository(h.path, migrations);
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => '11111111-1111-4111-8111-111111111111',
    close: async () => {},
  };
  const diagnostics: unknown[] = [];
  const pages = createJudongchePages(
    session,
    (event) => {
      diagnostics.push(event);
      const task = h.tasks.latest();
      writeProbeLog(
        dirname(h.path),
        event,
        task ? { taskId: task.taskId } : null,
      );
    },
    {
      manualReview: true,
      batchSubmissionReview: 'operator',
      ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
    },
  );
  const save = pages.saveForOperatorReview!;
  let observationWrites = 0;
  pages.saveForOperatorReview = async (...args) => {
    if (stopAt === 'before-click') requestStop();
    const result = await save(
      () => {
        // First check returns the parsed payload from operatorWait; the next
        // occurs after saveOnce records its status, inside the quiet period.
        if (stopAt === 'settling' && parsed && ++checksAfterParse === 2)
          requestStop();
        return args[0]();
      },
      async (observed) => {
        observationWrites++;
        await args[1]?.(observed);
      },
    );
    if (stopAt === 'returned') requestStop();
    return result;
  };
  const adapter = createAdapterWithPages(session, pages);
  legacyFixtureSnapshotCapture(h.snapshots);
  const preparation = createDraftPreparation({
    contentCapabilities: () => adapter.contentCapabilities(),
    repository: h.articles,
    covers: h.articles,
    tasks: h.tasks,
    snapshots: h.snapshots,
    newId: randomUUID,
  });
  const draft = createDraftController({
    invalidateBrowserHealth: () => {},
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
  stop = () => batch.requestStop();
  try {
    await page.goto(fixture.home);
    const opened = await draft.openDraftSession();
    const second = await h.addArticle('Untouched following article');
    const offered = await batch.prepare({
      articleKeys: [h.articleKey, second],
      bindingToken: opened.view.session.bindingToken!,
    });
    expect(offered.status).toBe('ready');
    if (offered.status !== 'ready') throw Error('fixture not ready');
    await batch.start({
      preparationId: offered.preparation.preparationId,
      requestId: randomUUID(),
    });
    await batch.waitForIdle();
    const beforeProbe = (await batch.getCurrent())!;
    const original = h.tasks.get(beforeProbe.items[0].taskId!)!;
    const diagnosticTask = h.tasks.latest()!;
    const firstPath = join(
      dirname(h.path),
      `judongche-first-failure-${diagnosticTask.taskId}-execution.json`,
    );
    const first = existsSync(firstPath)
      ? readFileSync(firstPath, 'utf8')
      : null;
    // A readonly refresh after settlement cannot change the durable result.
    await pages.probe();
    expect(h.tasks.get(original.taskId)).toEqual(original);
    if (first) {
      expect(readFileSync(firstPath, 'utf8')).toBe(first);
      const execution = JSON.parse(first);
      const probe = JSON.parse(
        readFileSync(join(dirname(h.path), 'judongche-probe.json'), 'utf8'),
      );
      expect(execution.task.taskId).toBe(diagnosticTask.taskId);
      expect(probe.task.taskId).toBe(diagnosticTask.taskId);
      expect(Date.parse(probe.observedAt)).toBeGreaterThanOrEqual(
        Date.parse(execution.observedAt),
      );
    }
    repository.close();
    repository = openDraftBatchRepository(h.path, migrations);
    const view = repository.get(beforeProbe.id)!;
    const tasks = openDraftTaskRepository(h.path, migrations);
    let task;
    try {
      task = tasks.get(original.taskId)!;
    } finally {
      tasks.close();
    }
    expect(task).toEqual(original);
    expect(view).toEqual(beforeProbe);
    return {
      view,
      task,
      requests,
      requestTitles,
      actions,
      actionsAtStop,
      diagnostics,
      observationWrites,
      firstFailurePreserved: first !== null,
    };
  } finally {
    await batch.stopAndWait();
    repository.close();
    await h.close();
  }
}
