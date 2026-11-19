import { snapshotImageCount } from '../contracts/draft-task';
import {
  DraftTaskSchema,
  TaskEventSchema,
  type DraftTask,
  type TaskEvent,
  type DraftEvidence,
} from '../contracts/draft-task';
import { effectiveCoverPolicy, reduceCoverReport } from './cover-task';
function invalid(): never {
  throw new Error('Invalid task transition');
}
export function canCloseWithoutSave(
  task: DraftTask,
  reviewedBody = false,
): boolean {
  return (
    ['needs_human', 'interrupted'].includes(task.state) &&
    task.holdsPlatform &&
    !task.saveAttempted &&
    !task.evidence.remote &&
    !task.evidence.cover &&
    (task.evidence.images.length === 0 || reviewedBody)
  );
}
export function canCloseAfterReview(task: DraftTask): boolean {
  return (
    ['needs_human', 'interrupted'].includes(task.state) &&
    task.stage === 'settled' &&
    task.holdsPlatform &&
    task.saveAttempted &&
    task.possibleRemoteEffect &&
    !task.evidence.remote &&
    task.reason !== null
  );
}
function mergeEvidence(
  previous: DraftEvidence,
  incoming: DraftEvidence,
): DraftEvidence {
  const remote = previous.remote ?? incoming.remote;
  if (
    previous.remote &&
    incoming.remote &&
    (previous.remote.recordKey !== incoming.remote.recordKey ||
      previous.remote.editUrl !== incoming.remote.editUrl)
  )
    invalid();
  const cover = previous.cover ?? incoming.cover;
  if (
    previous.cover &&
    incoming.cover &&
    previous.cover.resourceKey !== incoming.cover.resourceKey
  )
    invalid();
  const images = [...previous.images];
  for (const image of incoming.images) {
    const existing = images.find((item) => item.bodyIndex === image.bodyIndex);
    if (existing) {
      if (
        existing.imageId !== image.imageId ||
        existing.assetKey !== image.assetKey ||
        existing.resourceKey !== image.resourceKey
      )
        invalid();
    } else images.push(image);
  }
  const coverAbort = previous.coverAbort ?? incoming.coverAbort;
  if (
    previous.submission &&
    incoming.submission &&
    (previous.submission.observation !== incoming.submission.observation ||
      previous.submission.attemptedAt !== incoming.submission.attemptedAt)
  )
    invalid();
  const submission = previous.submission ?? incoming.submission;
  return {
    remote,
    cover,
    images,
    ...(coverAbort ? { coverAbort } : {}),
    ...(submission ? { submission } : {}),
  };
}
export function reduceTask(
  input: DraftTask,
  inputEvent: TaskEvent,
  now: string,
): DraftTask {
  const task = DraftTaskSchema.parse(input);
  const event = TaskEventSchema.parse(inputEvent);
  if (
    [
      'draft_saved',
      'submission_recorded',
      'failed',
      'stopped',
      'closed_without_save',
      'closed_after_review',
      'stopped_by_user',
    ].includes(task.state) &&
    !(
      event.type === 'release-after-stop' &&
      ['failed', 'stopped'].includes(task.state)
    )
  )
    invalid();
  const next: DraftTask = {
    ...task,
    revision: task.revision + 1,
    updatedAt: now,
  };
  switch (event.type) {
    case 'record-submission':
      if (
        task.state !== 'running' ||
        task.stage !== 'save' ||
        !task.saveAttempted ||
        !task.possibleRemoteEffect ||
        task.stopRequested ||
        task.evidence.remote ||
        Date.parse(event.submission.attemptedAt) > Date.parse(now)
      )
        invalid();
      next.state = 'submission_recorded';
      next.stage = 'settled';
      next.holdsPlatform = false;
      next.reason =
        event.submission.observation === 'acknowledged'
          ? null
          : 'RESULT_AMBIGUOUS';
      next.evidence = { ...task.evidence, submission: event.submission };
      break;
    case 'release-after-stop':
      if (
        (!task.stopRequested && !['failed', 'stopped'].includes(task.state)) ||
        !['needs_human', 'interrupted', 'queued', 'failed', 'stopped'].includes(
          task.state,
        )
      )
        invalid();
      next.state = 'stopped_by_user';
      next.stopRequested = true;
      next.stage = 'settled';
      next.holdsPlatform = false;
      break;
    case 'cover_report':
      if (!task.coverPlan) invalid();
      next.coverPlan = {
        ...task.coverPlan,
        report: reduceCoverReport(task, event.report, now),
      };
      break;
    case 'close-after-review':
    case 'close-without-save': {
      const proof = event.proof;
      if (
        !(event.type === 'close-after-review'
          ? canCloseAfterReview(task)
          : canCloseWithoutSave(
              task,
              proof.basis === 'owner-reviewed-unsaved-body',
            )) ||
        proof.taskId !== task.taskId ||
        proof.revision !== task.revision ||
        proof.snapshotDigest !== task.snapshot.digest ||
        proof.storeKey !== task.store.storeKey ||
        Date.parse(proof.checkedAt) < Date.parse(event.confirmedAt) ||
        Date.parse(now) < Date.parse(proof.checkedAt) ||
        Date.parse(now) - Date.parse(event.confirmedAt) > 120000
      )
        invalid();
      next.state =
        event.type === 'close-after-review'
          ? 'closed_after_review'
          : 'closed_without_save';
      next.stage = 'settled';
      next.holdsPlatform = false;
      break;
    }
    case 'begin':
      if (task.state !== 'queued' || task.stopRequested) invalid();
      next.state = 'running';
      break;
    case 'before-effect': {
      if (task.state !== 'running' || task.stopRequested) invalid();
      const stages = [
        'reserved',
        'editor',
        'body',
        'cover',
        'save',
        'verify',
        'settled',
      ];
      if (stages.indexOf(event.stage) < stages.indexOf(task.stage)) invalid();
      next.stage = event.stage;
      next.possibleRemoteEffect = true;
      break;
    }
    case 'before-save':
      if (
        task.state !== 'running' ||
        task.stopRequested ||
        task.saveAttempted ||
        ['verify', 'settled'].includes(task.stage)
      )
        invalid();
      next.stage = 'save';
      next.possibleRemoteEffect = true;
      next.saveAttempted = true;
      break;
    case 'evidence':
      if (
        !['running', 'needs_human', 'interrupted'].includes(task.state) ||
        !task.possibleRemoteEffect ||
        (event.evidence.submission &&
          (!task.saveAttempted ||
            event.evidence.remote ||
            Date.parse(event.evidence.submission.attemptedAt) >
              Date.parse(now)))
      )
        invalid();
      next.evidence = mergeEvidence(task.evidence, event.evidence);
      break;
    case 'verify':
      if (task.state !== 'running' || !task.possibleRemoteEffect) invalid();
      next.stage = 'verify';
      break;
    case 'stop':
      next.stopRequested = true;
      break;
    case 'recover':
      if (task.state !== 'queued' && task.state !== 'running') invalid();
      next.state = 'interrupted';
      next.reason = 'INTERRUPTED';
      next.holdsPlatform = true;
      break;
    case 'settle':
      if (event.state === 'draft_saved') {
        if (
          !task.possibleRemoteEffect ||
          !(
            task.stage === 'verify' ||
            task.state === 'interrupted' ||
            task.state === 'needs_human'
          ) ||
          !task.evidence.remote ||
          (effectiveCoverPolicy(task) === 'store-material-first' &&
            !task.evidence.cover) ||
          event.reason !== null
        )
          invalid();
        const imageCount = snapshotImageCount(task.snapshot);
        if (task.evidence.images.length !== imageCount) invalid();
        next.holdsPlatform = false;
      } else if (event.state === 'failed' || event.state === 'stopped') {
        if (task.possibleRemoteEffect) invalid();
        next.holdsPlatform = false;
      } else next.holdsPlatform = true;
      next.state = event.state;
      next.stage = 'settled';
      next.reason = event.reason;
      break;
  }
  return DraftTaskSchema.parse(next);
}
