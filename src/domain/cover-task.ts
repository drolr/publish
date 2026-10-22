import {
  CoverReportSchema,
  reportMatchesSnapshot,
  type CoverReport,
} from '../contracts/cover-task';
import type { DraftTask } from '../contracts/draft-task';
import type { CoverTaskSnapshot } from '../contracts/article-cover';
export function effectiveCoverPolicy(
  task: DraftTask,
): DraftTask['coverPolicy'] | 'local-upload-v1' {
  return task.coverPlan?.policy ?? task.coverPolicy;
}
export function initialCoverReport(
  snapshot: CoverTaskSnapshot,
  now: string,
): CoverReport {
  return CoverReportSchema.parse({
    phase: snapshot.mode === 'none' ? 'not_configured' : 'pending',
    requestedMode: snapshot.mode,
    expectedCount: snapshot.assets.length,
    confirmedItems: [],
    reason: null,
    updatedAt: now,
  });
}
export function reduceCoverReport(
  task: DraftTask,
  input: CoverReport,
  now: string,
): CoverReport {
  const report = CoverReportSchema.parse(input);
  const plan = task.coverPlan;
  if (
    !plan ||
    !reportMatchesSnapshot(plan.snapshot, report) ||
    Date.parse(report.updatedAt) < Date.parse(plan.report.updatedAt) ||
    Date.parse(report.updatedAt) > Date.parse(now) ||
    !['running', 'needs_human', 'interrupted'].includes(task.state) ||
    !task.possibleRemoteEffect ||
    !['cover', 'save', 'verify', 'settled'].includes(task.stage)
  )
    throw Error('Invalid cover report transition');
  if (plan.report.phase === 'confirmed' && report.phase !== 'confirmed') {
    // A crash may persist final cover proof before body settlement. Only a
    // fresh read-only recovery warning may revise that pre-terminal result;
    // it grants no upload/save authority and preserves the facts checked below.
    const reopenedWarning =
      task.saveAttempted &&
      ['interrupted', 'needs_human'].includes(task.state) &&
      ['verify', 'settled'].includes(task.stage) &&
      ((report.phase === 'failed' && report.reason === 'COVER_MISMATCH') ||
        (report.phase === 'needs_human' &&
          report.reason === 'PAGE_UNVERIFIED'));
    if (!reopenedWarning) throw Error('Invalid cover report transition');
  }
  if (
    ['failed', 'needs_human'].includes(plan.report.phase) &&
    ['pending', 'uploading'].includes(report.phase)
  )
    throw Error('Invalid cover report transition');
  if (
    report.phase === 'uploading' &&
    (task.state !== 'running' ||
      task.stopRequested ||
      task.saveAttempted ||
      task.stage !== 'cover')
  )
    throw Error('Invalid cover report transition');
  if (
    report.phase === 'confirmed' &&
    (!task.saveAttempted || !['verify', 'settled'].includes(task.stage))
  )
    throw Error('Invalid cover report transition');
  for (const previous of plan.report.confirmedItems) {
    const current = report.confirmedItems.find(
      (i) => i.position === previous.position,
    );
    if (
      !current ||
      current.assetKey !== previous.assetKey ||
      current.sha256 !== previous.sha256 ||
      current.resourceKey !== previous.resourceKey
    )
      throw Error('Invalid cover report transition');
  }
  return report;
}
