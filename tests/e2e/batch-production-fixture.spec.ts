import { legacyFixtureSnapshotCapture } from '../fixtures/legacy-snapshot-capture';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDraftHarness } from '../fixtures/draft-harness';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createDraftController } from '../../src/application/draft-controller';
import { createBatchController } from '../../src/application/batch-controller';
import { createJudongcheAdapter } from '../../src/infrastructure/platforms/judongche/draft-adapter';

test.beforeEach(async ({ context }) => denyExternalNetwork(context));
for (const fault of ['none', 'second-save', 'stop-after-save'] as const)
  test(`real batch controllers and adapter handle ${fault} sequentially`, async ({
    context,
    page,
  }) => {
    const fixture = await installProductionFixture(context, {
      fullDraftReview: 'unique',
      batchHistory: true,
      staleDraftList: fault === 'none',
      saveFailureAt: fault === 'second-save' ? 2 : undefined,
      afterSave: () => {
        if (fault === 'stop-after-save') stopBatch?.();
      },
    });
    const h = await createDraftHarness(1, {
      title: '第一篇批次测试文章',
      contentDeclaration: 'original',
    });
    const repository = openDraftBatchRepository(
      h.path,
      resolve('src/infrastructure/persistence/migrations'),
    );
    const session = {
      open: async () => context,
      current: () => context,
      generation: () => '11111111-1111-4111-8111-111111111111',
      close: async () => {},
    };
    const diagnostics: unknown[] = [];
    const adapter = createJudongcheAdapter(
      session,
      (event) => diagnostics.push(event),
      {
        manualReview: true,
        automaticDraftReview: true,
        ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
      },
    );
    let active = 0,
      peak = 0;
    const platform: typeof adapter = {
      ...adapter,
      execute: async (...args) => {
        active++;
        peak = Math.max(peak, active);
        try {
          return await adapter.execute(...args);
        } finally {
          active--;
        }
      },
    };
    // evidenceV1: preserve legacy production-page regression; V2 remains closed.
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
      platform,
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
    const stopBatch = () => batch.requestStop();
    try {
      await page.goto(fixture.home);
      const opened = await draft.openDraftSession();
      expect(opened.status).toBe('ok');
      const keys = [
        h.articleKey,
        await h.addArticle('第二篇批次测试文章'),
        await h.addArticle('第三篇批次测试文章'),
      ];
      const offered = await batch.prepare({
        articleKeys: keys,
        bindingToken: opened.view.session.bindingToken!,
      });
      expect(offered.status).toBe('ready');
      if (offered.status !== 'ready') return;
      await batch.start({
        preparationId: offered.preparation.preparationId,
        requestId: randomUUID(),
      });
      await batch.waitForIdle();
      const view = await batch.getCurrent();
      if (fault === 'none') {
        expect(view, JSON.stringify(diagnostics.slice(-5))).toMatchObject({
          state: 'completed',
          counts: { saved: 3, total: 3 },
          items: keys.map((articleKey) => ({
            articleKey,
            state: 'draft_saved',
          })),
        });
        expect(fixture.saves()).toBe(3);
        expect(fixture.savedArticles().map((item) => item.recordKey)).toEqual([
          '501',
          '502',
          '503',
        ]);
        expect(fixture.savedArticles().map((item) => item.title)).toEqual([
          '第一篇批次测试文章',
          '第二篇批次测试文章',
          '第三篇批次测试文章',
        ]);
      } else {
        expect(view, JSON.stringify(diagnostics.slice(-5))).toMatchObject({
          state: 'paused',
          counts: {
            saved: fault === 'second-save' ? 1 : 0,
            pending: fault === 'second-save' ? 1 : 2,
            needsHuman: 1,
          },
        });
        expect(fixture.saves()).toBe(fault === 'second-save' ? 2 : 1);
      }
      expect(peak).toBe(1);
      expect(fixture.uploads()).toBe(1);
      expect(context.pages()).toHaveLength(1);
    } finally {
      await batch.stopAndWait();
      repository.close();
      await h.close();
    }
  });
