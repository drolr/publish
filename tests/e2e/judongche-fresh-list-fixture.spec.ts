import { test, expect } from '@playwright/test';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { createJudongcheAdapter } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { draftHarness } from '../fixtures/draft-adapter';
import { reduceTask } from '../../src/domain/draft-task';

for (const fault of ['none', 'business-failure', 'incomplete'] as const) {
  test(`fresh draft list ignores stale terminal and preserves response guards: ${fault}`, async ({
    context,
    page,
  }) => {
    await denyExternalNetwork(context);
    const fixture = await installProductionFixture(context, {
      fullDraftReview: 'unique',
      staleDraftList: true,
    });
    await page.goto(fixture.home);
    const h = draftHarness();
    const session = {
      open: async () => context,
      current: () => context,
      generation: () => 'fresh-list',
      close: async () => {},
    };
    const options = {
      manualReview: true,
      ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
    };
    const adapter = createJudongcheAdapter(session, undefined, options);
    const probe = await adapter.checkSession();
    if (probe.status !== 'ready') throw Error('session');
    h.task.store = probe.store;
    h.durable().store = probe.store;
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason: 'MANUAL_REVIEW_REQUIRED',
    });
    const task = reduceTask(
      h.durable(),
      {
        type: 'settle',
        state: 'needs_human',
        reason: 'MANUAL_REVIEW_REQUIRED',
      },
      h.task.updatedAt,
    );
    if (fault !== 'none')
      await context.route('**/marketing/article/list?**', async (route) => {
        await route.fulfill({
          json: {
            status: fault === 'business-failure' ? 5000 : 0,
            data: { count: 1, has_more: true, list: [] },
          },
        });
      });
    const reader = createJudongcheAdapter(session, undefined, {
      ...options,
      reviewedSavedTask: {
        taskId: task.taskId,
        title: task.snapshot.article.title,
        recordKey: '501',
      },
    });
    expect((await reader.reconcile(task)).status).toBe(
      fault === 'none' ? 'verified' : 'blocked',
    );
    expect(fixture.saves()).toBe(1);
  });
}

for (const missingReads of [1, 99]) {
  test(
    'accepted save waits for bounded draft visibility: ' + missingReads,
    async ({ context, page }) => {
      await denyExternalNetwork(context);
      const fixture = await installProductionFixture(context, {
        fullDraftReview: 'unique',
        invisibleDraftListReads: missingReads,
      });
      await page.goto(fixture.home);
      const h = draftHarness();
      const session = {
        open: async () => context,
        current: () => context,
        generation: () => 'visibility',
        close: async () => {},
      };
      const adapter = createJudongcheAdapter(session, undefined, {
        manualReview: true,
        ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
      });
      const probe = await adapter.checkSession();
      if (probe.status !== 'ready') throw Error('session');
      h.task.store = probe.store;
      h.durable().store = probe.store;
      await adapter.execute(h.task, h.hooks);
      const task = reduceTask(
        h.durable(),
        {
          type: 'settle',
          state: 'needs_human',
          reason: 'MANUAL_REVIEW_REQUIRED',
        },
        h.task.updatedAt,
      );
      expect((await adapter.reconcile(task)).status).toBe(
        missingReads === 1 ? 'verified' : 'blocked',
      );
      expect(fixture.draftListReads()).toBe(missingReads === 1 ? 2 : 3);
      expect(fixture.saves()).toBe(1);
    },
  );
}
