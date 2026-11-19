import { describe, expect, it } from 'vitest';
import {
  AdapterOutcomeSchema,
  DraftTaskSchema,
} from '../../src/contracts/draft-task';
import { reduceTask } from '../../src/domain/draft-task';
import { batchCounts, classifyBatchTask } from '../../src/domain/draft-batch';
import { makeDraftTask } from '../fixtures/draft-task';

describe('operator-reviewed batch submission', () => {
  const now = '2026-10-16T10:00:00.000Z';
  const submission = { observation: 'unknown' as const, attemptedAt: now };
  it('records a submission without inventing a verified remote draft', () => {
    const task = makeDraftTask({
      state: 'running',
      stage: 'save',
      possibleRemoteEffect: true,
      saveAttempted: true,
      updatedAt: now,
    });
    const next = reduceTask(
      task,
      { type: 'record-submission', submission },
      now,
    );
    expect(next).toMatchObject({
      state: 'submission_recorded',
      stage: 'settled',
      holdsPlatform: false,
      saveAttempted: true,
      evidence: { remote: null, submission },
    });
    expect(DraftTaskSchema.safeParse(next).success).toBe(true);
    expect(classifyBatchTask(next)).toMatchObject({
      state: 'submission_recorded',
      pause: false,
    });
    expect(
      batchCounts([{ state: classifyBatchTask(next).state }]),
    ).toMatchObject({ total: 1, attempted: 1, saved: 0, needsHuman: 0 });
    expect(() => reduceTask(next, { type: 'before-save' }, now)).toThrow();
  });
  it.each(['acknowledged', 'rejected', 'unknown'] as const)(
    'accepts %s only as unverified submission evidence',
    (observation) => {
      const result = AdapterOutcomeSchema.parse({
        status: 'submission_recorded',
        evidence: { remote: null, images: [], cover: null },
        submission: { observation, attemptedAt: now },
      });
      expect(result.status).toBe('submission_recorded');
    },
  );
  it('cannot release a task without a save attempt, after stop, or with future observation', () => {
    const task = makeDraftTask({
      state: 'running',
      stage: 'save',
      possibleRemoteEffect: true,
      saveAttempted: true,
      updatedAt: now,
    });
    for (const overrides of [
      { saveAttempted: false },
      { stopRequested: true },
      { state: 'needs_human' as const },
    ])
      expect(() =>
        reduceTask(
          { ...task, ...overrides },
          { type: 'record-submission', submission },
          now,
        ),
      ).toThrow();
    expect(() =>
      reduceTask(
        task,
        {
          type: 'record-submission',
          submission: {
            ...submission,
            attemptedAt: '2026-10-17T10:00:00.000Z',
          },
        },
        now,
      ),
    ).toThrow();
    expect(
      DraftTaskSchema.safeParse({
        ...task,
        state: 'submission_recorded',
        stage: 'settled',
        holdsPlatform: false,
      }).success,
    ).toBe(false);
  });
  it('preserves a stopped submission observation as immutable evidence without releasing the task', () => {
    const task = makeDraftTask({
      state: 'running',
      stage: 'save',
      saveAttempted: true,
      possibleRemoteEffect: true,
      stopRequested: true,
      updatedAt: now,
    });
    const observed = reduceTask(
      task,
      { type: 'evidence', evidence: { ...task.evidence, submission } },
      now,
    );
    expect(() =>
      reduceTask(
        { ...task, saveAttempted: false },
        { type: 'evidence', evidence: { ...task.evidence, submission } },
        now,
      ),
    ).toThrow();
    expect(observed).toMatchObject({
      state: 'running',
      stopRequested: true,
      holdsPlatform: true,
      evidence: { submission },
    });
    expect(() =>
      reduceTask(
        observed,
        {
          type: 'evidence',
          evidence: {
            ...observed.evidence,
            submission: { ...submission, observation: 'acknowledged' },
          },
        },
        now,
      ),
    ).toThrow();
    const settled = reduceTask(
      observed,
      { type: 'settle', state: 'needs_human', reason: 'STOP_REQUESTED' },
      now,
    );
    expect(settled).toMatchObject({
      state: 'needs_human',
      holdsPlatform: true,
      stopRequested: true,
      evidence: { submission },
    });
    expect(classifyBatchTask(settled)).toEqual({
      state: 'needs_human',
      pause: true,
      reason: 'STOP_REQUESTED',
    });
  });
});
