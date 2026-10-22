import { z } from 'zod';
import {
  CoverModeSchema,
  CoverTaskSnapshotSchema,
  CoverImageDescriptionSchema,
  type CoverTaskSnapshot,
} from './article-cover';
import { DigestSchema } from './article-revision';
import { StorageIdSchema } from './stored-article';
export { CoverTaskSnapshotSchema } from './article-cover';
export type { CoverTaskSnapshot } from './article-cover';
export const CoverReportReasonSchema = z.enum([
  'IMAGE_UNAVAILABLE',
  'UPLOAD_REJECTED',
  'UPLOAD_INCOMPLETE',
  'LIBRARY_OPTION_UNVERIFIED',
  'COVER_MISMATCH',
  'COVER_REQUIRED',
  'PAGE_UNVERIFIED',
]);
export const CoverReportSchema = z
  .strictObject({
    phase: z.enum([
      'not_configured',
      'pending',
      'uploading',
      'confirmed',
      'failed',
      'needs_human',
    ]),
    requestedMode: CoverModeSchema,
    expectedCount: z.number().int().min(0).max(3),
    confirmedItems: z
      .array(
        z.strictObject({
          position: z.number().int().min(0).max(2),
          assetKey: StorageIdSchema,
          sha256: DigestSchema,
          resourceKey: DigestSchema,
        }),
      )
      .max(3),
    reason: CoverReportReasonSchema.nullable(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((r, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: 'custom', message: 'Invalid cover report' });
    const count =
      r.requestedMode === 'none' ? 0 : r.requestedMode === 'single' ? 1 : 3;
    if (r.expectedCount !== count || r.confirmedItems.length > count) invalid();
    if (
      r.confirmedItems.some(
        (i, n) =>
          i.position >= count ||
          (n > 0 && i.position <= r.confirmedItems[n - 1].position),
      )
    )
      invalid();
    if (
      new Set(r.confirmedItems.map((i) => i.assetKey)).size !==
      r.confirmedItems.length
    )
      invalid();
    if (
      r.phase === 'failed' || r.phase === 'needs_human'
        ? r.reason === null
        : r.reason !== null
    )
      invalid();
    if (
      r.requestedMode === 'none'
        ? !['not_configured', 'failed', 'needs_human'].includes(r.phase)
        : r.phase === 'not_configured'
    )
      invalid();
    if (r.phase === 'confirmed' && r.confirmedItems.length !== count) invalid();
  });
export type CoverReport = z.output<typeof CoverReportSchema>;
export function reportMatchesSnapshot(
  snapshot: CoverTaskSnapshot,
  report: CoverReport,
): boolean {
  return (
    report.requestedMode === snapshot.mode &&
    report.expectedCount === snapshot.assets.length &&
    report.confirmedItems.every(
      (i) =>
        snapshot.assets[i.position]?.assetKey === i.assetKey &&
        snapshot.assets[i.position]?.sha256 === i.sha256,
    )
  );
}
export const CoverPlanSchema = z
  .strictObject({
    policy: z.literal('local-upload-v1'),
    snapshot: CoverTaskSnapshotSchema,
    report: CoverReportSchema,
  })
  .refine((p) => reportMatchesSnapshot(p.snapshot, p.report));
export type CoverPlan = z.output<typeof CoverPlanSchema>;
export const CoverSummarySchema = z
  .strictObject({
    mode: CoverModeSchema,
    imageCount: z.number().int().min(0).max(3),
    images: z.array(CoverImageDescriptionSchema).max(3),
  })
  .refine(
    (s) =>
      s.imageCount === s.images.length &&
      s.imageCount === (s.mode === 'none' ? 0 : s.mode === 'single' ? 1 : 3),
  );
export type CoverSummary = z.output<typeof CoverSummarySchema>;
export const CoverReportViewSchema = z.strictObject({
  phase: CoverReportSchema.shape.phase,
  requestedMode: CoverModeSchema,
  expectedCount: z.number().int().min(0).max(3),
  confirmedCount: z.number().int().min(0).max(3),
  reason: CoverReportReasonSchema.nullable(),
  updatedAt: z.iso.datetime(),
});
export function coverSummary(snapshot: CoverTaskSnapshot): CoverSummary {
  return {
    mode: snapshot.mode,
    imageCount: snapshot.assets.length,
    images: snapshot.assets.map(({ assetKey, mime, width, height }) => ({
      assetKey,
      mime,
      width,
      height,
    })),
  };
}
export function coverReportView(report: CoverReport) {
  const { confirmedItems, ...safe } = report;
  return { ...safe, confirmedCount: confirmedItems.length };
}
