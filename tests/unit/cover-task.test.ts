import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { makeDraftTask } from '../fixtures/draft-task';
import type {
  SnapshotPort,
  DraftTaskRepository,
} from '../../src/domain/ports/draft-task';

it('stale_cover_preparation rejects a cover changed while the body is captured', async () => {
  const task = makeDraftTask();
  let revision = 0;
  const configuration = () => ({
    articleKey: task.articleKey,
    coverRevision: revision,
    mode: 'none' as const,
    assets: [],
    configurationDigest: String(revision).repeat(64),
    saveOperationId: revision ? randomUUID() : null,
    committedAt: revision ? task.createdAt : null,
  });
  const snapshots = {
    capture: async () => {
      revision++;
      return task.snapshot;
    },
    captureCover: (c: ReturnType<typeof configuration>) => ({
      version: 1,
      articleKey: c.articleKey,
      coverRevision: c.coverRevision,
      mode: c.mode,
      assets: c.assets,
      digest: c.configurationDigest,
    }),
  } as unknown as SnapshotPort;
  const service = createDraftPreparation({
    contentCapabilities: () => ({
      revision: 'judongche-rich-unknown-v1',
      features: {},
    }),
    repository: {
      loadEditableArticle: () => ({
        article: task.snapshot.article,
        articleRevision: 1,
        editorBody: null,
      }),
    },
    covers: { loadCover: configuration },
    snapshots,
    tasks: {
      findLatestIdentity: () => undefined,
    } as unknown as DraftTaskRepository,
    newId: randomUUID,
  } as Parameters<typeof createDraftPreparation>[0]);
  const binding = service.offer({
    status: 'ready',
    store: task.store,
    generation: randomUUID(),
  });
  expect(await service.prepare(task.articleKey, binding.bindingToken!)).toEqual(
    { status: 'blocked', reason: 'STALE_PREPARATION' },
  );
});

import {
  CoverReportSchema,
  type CoverReport,
} from '../../src/contracts/cover-task';
import {
  effectiveCoverPolicy,
  initialCoverReport,
} from '../../src/domain/cover-task';
import { DraftTaskSchema } from '../../src/contracts/draft-task';
import { reduceTask } from '../../src/domain/draft-task';
import type { CoverTaskSnapshot } from '../../src/contracts/article-cover';
function coverTask(mode: 'single' | 'triple' = 'single') {
  const task = makeDraftTask({
    state: 'running',
    stage: 'cover',
    possibleRemoteEffect: true,
  });
  const op = randomUUID();
  const assets = Array.from({ length: mode === 'single' ? 1 : 3 }, (_, i) => {
    const assetKey = randomUUID();
    return {
      assetKey,
      mime: 'image/png' as const,
      width: 1,
      height: 1,
      relativePath: task.articleKey + '/' + op + '/' + assetKey + '.png',
      byteSize: 1,
      sha256: String(i + 1).repeat(64),
    };
  });
  const snapshot: CoverTaskSnapshot = {
    version: 1,
    articleKey: task.articleKey,
    coverRevision: 1,
    mode,
    assets,
    digest: 'c'.repeat(64),
  };
  return {
    ...task,
    coverPlan: {
      policy: 'local-upload-v1' as const,
      snapshot,
      report: initialCoverReport(snapshot, task.updatedAt),
    },
  };
}
function linkedReport(
  task: ReturnType<typeof coverTask>,
  phase: CoverReport['phase'] = 'confirmed',
): CoverReport {
  return {
    phase,
    requestedMode: task.coverPlan.snapshot.mode,
    expectedCount: task.coverPlan.snapshot.assets.length,
    confirmedItems: task.coverPlan.snapshot.assets.map((a, position) => ({
      position,
      assetKey: a.assetKey,
      sha256: a.sha256,
      resourceKey: String(position + 5).repeat(64),
    })),
    reason: null,
    updatedAt: task.updatedAt,
  };
}
it('uses the explicit local policy while preserving both historical policies', () => {
  expect(effectiveCoverPolicy(coverTask())).toBe('local-upload-v1');
  expect(effectiveCoverPolicy(makeDraftTask())).toBe('manual-after-draft');
  expect(
    effectiveCoverPolicy(
      makeDraftTask({ coverPolicy: 'store-material-first' }),
    ),
  ).toBe('store-material-first');
});
it('retains ordered partial associations and confirms only at verification', () => {
  let task = coverTask('triple');
  const pending = {
    ...linkedReport(task, 'pending'),
    confirmedItems: [
      linkedReport(task).confirmedItems[0],
      linkedReport(task).confirmedItems[2],
    ],
  };
  expect(CoverReportSchema.safeParse(pending).success).toBe(true);
  task = reduceTask(
    task,
    { type: 'cover_report', report: pending },
    task.updatedAt,
  ) as typeof task;
  expect(task.revision).toBe(1);
  expect(task.coverPlan.report.confirmedItems.map((i) => i.position)).toEqual([
    0, 2,
  ]);
  task = reduceTask(
    task,
    { type: 'before-save' },
    task.updatedAt,
  ) as typeof task;
  task = reduceTask(task, { type: 'verify' }, task.updatedAt) as typeof task;
  const confirmed = reduceTask(
    task,
    { type: 'cover_report', report: linkedReport(task) },
    task.updatedAt,
  );
  expect(confirmed.coverPlan?.report.phase).toBe('confirmed');
  expect(() =>
    reduceTask(
      confirmed,
      { type: 'cover_report', report: { ...linkedReport(task, 'pending') } },
      task.updatedAt,
    ),
  ).toThrow();
});
it('rejects forged associations, early final success, stale times, resource rebinding and late uploading', () => {
  const task = coverTask();
  const good = linkedReport(task);
  for (const report of [
    good,
    {
      ...good,
      phase: 'pending' as const,
      confirmedItems: [{ ...good.confirmedItems[0], assetKey: randomUUID() }],
    },
    {
      ...good,
      phase: 'pending' as const,
      confirmedItems: [{ ...good.confirmedItems[0], sha256: 'e'.repeat(64) }],
    },
    {
      ...good,
      phase: 'pending' as const,
      updatedAt: '2026-09-22T00:00:00.000Z',
    },
  ])
    expect(() =>
      reduceTask(task, { type: 'cover_report', report }, task.updatedAt),
    ).toThrow();
  const associated = reduceTask(
    task,
    { type: 'cover_report', report: { ...good, phase: 'pending' } },
    task.updatedAt,
  );
  expect(() =>
    reduceTask(
      associated,
      {
        type: 'cover_report',
        report: {
          ...good,
          phase: 'pending',
          confirmedItems: [
            { ...good.confirmedItems[0], resourceKey: 'e'.repeat(64) },
          ],
        },
      },
      task.updatedAt,
    ),
  ).toThrow();
  expect(() =>
    reduceTask(
      { ...task, stopRequested: true },
      { type: 'cover_report', report: { ...good, phase: 'uploading' } },
      task.updatedAt,
    ),
  ).toThrow();
  expect(() =>
    reduceTask(
      makeDraftTask({
        state: 'running',
        stage: 'cover',
        possibleRemoteEffect: true,
      }),
      { type: 'cover_report', report: { ...good, phase: 'pending' } },
      task.updatedAt,
    ),
  ).toThrow();
});

it('cannot confirm at a verification checkpoint before the one save attempt', () => {
  const task = coverTask();
  const verifying = reduceTask(task, { type: 'verify' }, task.updatedAt);
  expect(() =>
    reduceTask(
      verifying,
      { type: 'cover_report', report: linkedReport(task) },
      task.updatedAt,
    ),
  ).toThrow();
});

it('stored task contract rejects a forged final report before any save or verification', () => {
  const task = coverTask();
  expect(
    DraftTaskSchema.safeParse({
      ...task,
      coverPlan: { ...task.coverPlan, report: linkedReport(task) },
    }).success,
  ).toBe(false);
  expect(
    DraftTaskSchema.safeParse({
      ...task,
      state: 'queued',
      stage: 'reserved',
      possibleRemoteEffect: false,
      coverPlan: {
        ...task.coverPlan,
        report: { ...linkedReport(task, 'pending') },
      },
    }).success,
  ).toBe(false);
});

function confirmedBeforeSettlement() {
  const task = coverTask('triple');
  const saved = reduceTask(task, { type: 'before-save' }, task.updatedAt);
  const verifying = reduceTask(saved, { type: 'verify' }, task.updatedAt);
  return reduceTask(
    verifying,
    { type: 'cover_report', report: linkedReport(task) },
    task.updatedAt,
  );
}
it.each(['interrupted', 'needs_human'] as const)(
  'recovered %s confirmed cover accepts only fresh independent reopen warnings',
  (state) => {
    for (const stage of ['verify', 'settled'] as const)
      for (const [phase, reason] of [
        ['failed', 'COVER_MISMATCH'],
        ['needs_human', 'PAGE_UNVERIFIED'],
      ] as const) {
        const confirmed = confirmedBeforeSettlement();
        const now = '2026-09-23T00:00:00.001Z';
        const task = { ...confirmed, state, stage };
        const report = {
          ...task.coverPlan!.report,
          phase,
          reason,
          updatedAt: now,
        };
        const next = reduceTask(task, { type: 'cover_report', report }, now);
        expect(next.coverPlan?.report).toEqual(report);
        expect(next.coverPlan?.report.confirmedItems).toEqual(
          confirmed.coverPlan!.report.confirmedItems,
        );
        expect(next.coverPlan?.snapshot).toEqual(confirmed.coverPlan!.snapshot);
        expect(next.saveAttempted).toBe(true);
        expect(next.holdsPlatform).toBe(true);
      }
  },
);
it('confirmed report rejects unwarranted downgrade, late work, terminal events and altered association/time facts', () => {
  const confirmed = confirmedBeforeSettlement();
  const now = '2026-09-23T00:00:00.001Z';
  const recovered = reduceTask(confirmed, { type: 'recover' }, now);
  const warning = {
    ...recovered.coverPlan!.report,
    phase: 'failed' as const,
    reason: 'COVER_MISMATCH' as const,
    updatedAt: now,
  };
  const reports: CoverReport[] = [
    { ...warning, phase: 'pending', reason: null },
    { ...warning, phase: 'uploading', reason: null },
    { ...warning, reason: 'UPLOAD_REJECTED' },
    { ...warning, reason: 'LIBRARY_OPTION_UNVERIFIED' },
    { ...warning, phase: 'needs_human', reason: 'COVER_REQUIRED' },
    { ...warning, phase: 'failed', reason: 'PAGE_UNVERIFIED' },
    { ...warning, phase: 'needs_human', reason: 'COVER_MISMATCH' },
    { ...warning, confirmedItems: warning.confirmedItems.slice(0, 2) },
    {
      ...warning,
      confirmedItems: warning.confirmedItems.map((i, n) =>
        n ? i : { ...i, resourceKey: 'e'.repeat(64) },
      ),
    },
    { ...warning, updatedAt: '2026-09-22T00:00:00.000Z' },
    { ...warning, updatedAt: '2026-09-23T00:00:00.002Z' },
  ];
  for (const report of reports)
    expect(() =>
      reduceTask(recovered, { type: 'cover_report', report }, now),
    ).toThrow();
  expect(() =>
    reduceTask(confirmed, { type: 'cover_report', report: warning }, now),
  ).toThrow();
  expect(() =>
    reduceTask(
      { ...recovered, stage: 'save' },
      { type: 'cover_report', report: warning },
      now,
    ),
  ).toThrow();
  expect(() =>
    reduceTask(
      { ...recovered, saveAttempted: false },
      { type: 'cover_report', report: warning },
      now,
    ),
  ).toThrow();
  const terminal = reduceTask(
    {
      ...confirmed,
      evidence: {
        ...confirmed.evidence,
        remote: {
          recordKey: 'saved',
          editUrl:
            'https://www.autoengine.com/jdc/dealer/info/Article?pgc_id=saved',
        },
      },
    },
    { type: 'settle', state: 'draft_saved', reason: null },
    now,
  );
  expect(() =>
    reduceTask(terminal, { type: 'cover_report', report: warning }, now),
  ).toThrow();
});
