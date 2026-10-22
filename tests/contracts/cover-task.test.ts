import { expect, it } from 'vitest';
import {
  CoverReportSchema,
  CoverPlanSchema,
} from '../../src/contracts/cover-task';
import { CoverTaskSnapshotSchema } from '../../src/contracts/article-cover';
import {
  DraftTaskSchema,
  ReserveInputSchema,
  PreparationViewSchema,
} from '../../src/contracts/draft-task';
import { makeDraftTask } from '../fixtures/draft-task';
const task = makeDraftTask();
const snapshot = {
  version: 1 as const,
  articleKey: task.articleKey,
  coverRevision: 0,
  mode: 'none' as const,
  assets: [],
  digest: 'a'.repeat(64),
};
const report = {
  phase: 'not_configured',
  requestedMode: 'none',
  expectedCount: 0,
  confirmedItems: [],
  reason: null,
  updatedAt: task.createdAt,
};
it('shares the existing snapshot validator and keeps legacy tasks unchanged', () => {
  expect(CoverTaskSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(DraftTaskSchema.parse(task)).toEqual(task);
  expect(
    DraftTaskSchema.parse({
      ...task,
      coverPlan: { policy: 'local-upload-v1', snapshot, report },
    }).coverPlan?.snapshot.mode,
  ).toBe('none');
});
it('rejects forged counts, incomplete confirmation, private errors and foreign article binding', () => {
  for (const change of [
    { expectedCount: 1 },
    { phase: 'confirmed' },
    { phase: 'failed' },
    { reason: 'C:/private/path' },
    {
      confirmedItems: [
        {
          position: 0,
          assetKey: task.taskId,
          sha256: 'a'.repeat(64),
          resourceKey: 'b'.repeat(64),
        },
      ],
    },
  ])
    expect(CoverReportSchema.safeParse({ ...report, ...change }).success).toBe(
      false,
    );
  expect(
    CoverPlanSchema.safeParse({
      policy: 'local-upload-v1',
      snapshot,
      report: {
        ...report,
        requestedMode: 'single',
        expectedCount: 1,
        phase: 'pending',
      },
    }).success,
  ).toBe(false);
  expect(
    DraftTaskSchema.safeParse({
      ...task,
      coverPlan: {
        policy: 'local-upload-v1',
        snapshot: { ...snapshot, articleKey: task.taskId },
        report,
      },
    }).success,
  ).toBe(false);
});
it('reserve fields must be paired and bound to the body article and cover revision', () => {
  const input = {
    expectedArticleRevision: 1,
    taskId: task.taskId,
    preparationId: task.preparationId,
    snapshot: task.snapshot,
    store: task.store,
    now: task.createdAt,
  };
  expect(ReserveInputSchema.safeParse(input).success).toBe(true);
  expect(
    ReserveInputSchema.safeParse({
      ...input,
      expectedCoverRevision: 0,
      coverSnapshot: snapshot,
    }).success,
  ).toBe(true);
  for (const change of [
    { expectedCoverRevision: 0 },
    { coverSnapshot: snapshot },
    { expectedCoverRevision: 1, coverSnapshot: snapshot },
    {
      expectedCoverRevision: 0,
      coverSnapshot: { ...snapshot, articleKey: task.taskId },
    },
  ])
    expect(ReserveInputSchema.safeParse({ ...input, ...change }).success).toBe(
      false,
    );
});

it('reports a platform cover-required failure for an unconfigured task instead of inventing upload success', () => {
  expect(
    CoverReportSchema.safeParse({
      ...report,
      phase: 'failed',
      reason: 'COVER_REQUIRED',
    }).success,
  ).toBe(true);
});

it('new preparation reports the captured local strategy and legacy DTOs remain readable', () => {
  const legacy = {
    preparationId: task.preparationId,
    articleKey: task.articleKey,
    title: task.snapshot.article.title,
    storeName: task.store.displayName,
    bodyImageCount: 0,
    contentDeclaration: 'repost',
    mode: 'draft',
    coverPolicy: 'manual-after-draft',
  };
  expect(PreparationViewSchema.safeParse(legacy).success).toBe(true);
  expect(
    PreparationViewSchema.safeParse({
      ...legacy,
      coverPolicy: 'local-upload-v1',
      coverSummary: { mode: 'none', imageCount: 0, images: [] },
    }).success,
  ).toBe(true);
  expect(
    PreparationViewSchema.safeParse({
      ...legacy,
      coverPolicy: 'local-upload-v1',
    }).success,
  ).toBe(false);
});
