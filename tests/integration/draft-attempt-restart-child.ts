import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import type { DraftTaskRepository } from '../../src/domain/ports/draft-task';

export const restartCheckpoints = [
  'before-save',
  'save-in-flight',
  'after-save-ambiguous',
  'submission-recorded',
] as const;
export type RestartCheckpoint = (typeof restartCheckpoints)[number];

/** Test-only durable checkpoint; no browser, Profile, network or remote write. */
export function checkpointAttempt(
  tasks: DraftTaskRepository,
  taskId: string,
  checkpoint: RestartCheckpoint,
  now: string,
) {
  let task = tasks.get(taskId)!;
  task = tasks.apply(taskId, task.revision, { type: 'begin' }, now);
  task = tasks.apply(
    taskId,
    task.revision,
    { type: 'before-effect', stage: 'body' },
    now,
  );
  const image = task.snapshot.article.assets[0];
  if (image)
    task = tasks.apply(
      taskId,
      task.revision,
      {
        type: 'evidence',
        evidence: {
          remote: null,
          cover: null,
          images: [
            {
              bodyIndex: 1,
              imageId: image.imageId,
              assetKey: image.assetKey,
              resourceKey: 'b'.repeat(64),
            },
          ],
        },
      },
      now,
    );
  if (checkpoint !== 'before-save')
    task = tasks.apply(taskId, task.revision, { type: 'before-save' }, now);
  if (checkpoint === 'after-save-ambiguous')
    task = tasks.apply(taskId, task.revision, { type: 'verify' }, now);
  if (checkpoint === 'submission-recorded')
    task = tasks.apply(
      taskId,
      task.revision,
      {
        type: 'record-submission',
        submission: { observation: 'acknowledged', attemptedAt: now },
      },
      now,
    );
  return task;
}

if (process.argv[2] === 'attempt-crash') {
  const [, , , database, migrations, taskId, checkpoint, now] = process.argv;
  if (!restartCheckpoints.includes(checkpoint as RestartCheckpoint))
    throw Error('Unknown owned test checkpoint');
  const tasks = openDraftTaskRepository(database, migrations);
  checkpointAttempt(tasks, taskId, checkpoint as RestartCheckpoint, now);
  // Deliberately bypass repository/controller shutdown after synchronous commits.
  process.exit(77);
}
