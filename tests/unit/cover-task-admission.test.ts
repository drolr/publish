import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { draftHarness } from '../fixtures/draft-adapter';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { initialCoverReport } from '../../src/domain/cover-task';
import { coverConfigurationDigest } from '../../src/infrastructure/persistence/article-cover-repository';
import type { BrowserSession } from '../../src/infrastructure/automation/browser-session';
const session: BrowserSession = {
  open: async () => {
    throw Error('browser must not open');
  },
  current: () => undefined,
  generation: () => 'fixture',
  close: async () => {},
};
it.each(['single', 'triple'] as const)(
  'unsupported local %s policy never runs the historical manual-cover path',
  async (mode) => {
    const h = draftHarness();
    const operationId = randomUUID();
    const assets = Array.from({ length: mode === 'single' ? 1 : 3 }, () => {
      const assetKey = randomUUID();
      return {
        assetKey,
        mime: 'image/png' as const,
        width: 1,
        height: 1,
        byteSize: 1,
        sha256: 'a'.repeat(64),
        relativePath:
          h.task.articleKey + '/' + operationId + '/' + assetKey + '.png',
      };
    });
    const snapshot = {
      version: 1 as const,
      articleKey: h.task.articleKey,
      coverRevision: 1,
      mode,
      assets,
      digest: coverConfigurationDigest(h.task.articleKey, 1, mode, assets),
    };
    const task = {
      ...h.task,
      coverPlan: {
        policy: 'local-upload-v1' as const,
        snapshot,
        report: initialCoverReport(snapshot, h.task.updatedAt),
      },
    };
    expect(
      await createAdapterWithPages(session, h.pages).execute(task, h.hooks),
    ).toEqual({ status: 'blocked', reason: 'INPUT_UNSUPPORTED' });
    expect(h.calls).toEqual([]);
    expect(h.durable()).toMatchObject({
      saveAttempted: false,
      possibleRemoteEffect: false,
    });
  },
);
it('existing legacy manual task still uses its original one-save behavior', async () => {
  const h = draftHarness();
  expect(
    await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks),
  ).toMatchObject({ status: 'verified' });
  expect(h.calls.filter((v) => v === 'save')).toHaveLength(1);
});
