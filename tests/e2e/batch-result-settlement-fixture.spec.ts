import { test, expect } from '@playwright/test';
import { operatorSettlement } from '../fixtures/operator-settlement';

for (const observation of ['acknowledged', 'rejected', 'unknown'] as const)
  test(`operator response survives stop after returned observation: ${observation}`, async ({
    context,
    page,
  }) => {
    const result = await operatorSettlement(
      context,
      page,
      observation,
      'returned',
    );
    expect(result.task).toMatchObject({
      state: 'needs_human',
      reason: 'STOP_REQUESTED',
      stopRequested: true,
      saveAttempted: true,
      holdsPlatform: true,
      evidence: { submission: { observation } },
    });
    expect(result.view.items[0].submission).toMatchObject({ observation });
    expect(result.view.items[1].taskId).toBeNull();
    expect(result.requests).toBe(1);
    expect(result.observationWrites).toBe(1);
    expect(result.actions).toEqual(result.actionsAtStop);
  });

for (const observation of ['acknowledged', 'rejected', 'unknown'] as const)
  test(`operator parsed response survives stop during quiet period: ${observation}`, async ({
    context,
    page,
  }) => {
    const result = await operatorSettlement(
      context,
      page,
      observation,
      'settling',
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        saveObservation: {
          responseReceived: true,
          httpStatus: 200,
          businessStatus:
            observation === 'unknown'
              ? null
              : observation === 'rejected'
                ? 5000
                : 0,
        },
      }),
    );
    expect(result.task).toMatchObject({
      state: 'needs_human',
      reason: 'STOP_REQUESTED',
      stopRequested: true,
      saveAttempted: true,
      evidence: { submission: { observation } },
    });
    expect(result.view.items[1].taskId).toBeNull();
    expect(result.requests).toBe(1);
    expect(result.observationWrites).toBe(1);
    expect(result.actions).toEqual(result.actionsAtStop);
  });

for (const observation of [
  'acknowledged',
  'rejected',
  'unknown',
  'pending',
] as const)
  test(`operator HTTP200 result is durable after readonly probe and repository reopen: ${observation}`, async ({
    context,
    page,
  }) => {
    const result = await operatorSettlement(context, page, observation);
    expect(result.task).toMatchObject({
      saveAttempted: true,
      possibleRemoteEffect: true,
    });
    if (observation === 'pending') {
      expect(result.task).toMatchObject({
        state: 'needs_human',
        reason: 'RESULT_AMBIGUOUS',
      });
      expect(result.task.evidence.submission).toBeUndefined();
      expect(result.view.items[1].taskId).toBeNull();
      expect(result.requests).toBe(1);
      expect(result.observationWrites).toBe(0);
    } else {
      expect(result.task).toMatchObject({
        state: 'submission_recorded',
        evidence: { submission: { observation } },
      });
      expect(result.view.items[0].submission).toEqual(
        result.task.evidence.submission,
      );
      expect(result.view.counts).toMatchObject({ attempted: 2, saved: 0 });
      expect(result.requests).toBe(2);
      expect(result.requestTitles).toEqual([
        'Durable operator result',
        'Untouched following article',
      ]);
      expect(result.observationWrites).toBe(2);
    }
    if (observation !== 'acknowledged')
      expect(result.firstFailurePreserved).toBe(true);
  });

for (const boundary of ['before-click', 'in-flight'] as const)
  test(`operator stop ${boundary} prevents new navigation and following reservation`, async ({
    context,
    page,
  }) => {
    const result = await operatorSettlement(
      context,
      page,
      'acknowledged',
      boundary,
    );
    expect(result.task).toMatchObject({
      state: 'needs_human',
      reason: 'STOP_REQUESTED',
      stopRequested: true,
      saveAttempted: true,
    });
    expect(result.task.evidence.submission).toBeUndefined();
    expect(result.requests).toBe(boundary === 'before-click' ? 0 : 1);
    expect(result.view.items[1].taskId).toBeNull();
    expect(result.actions).toEqual(result.actionsAtStop);
    expect(result.observationWrites).toBe(0);
  });

test('operator observation persistence failure never replays save or starts following work', async ({
  context,
  page,
}) => {
  const result = await operatorSettlement(
    context,
    page,
    'acknowledged',
    'write-failure',
  );
  expect(result.task.saveAttempted).toBe(true);
  expect(result.task.evidence.submission).toBeUndefined();
  expect(result.task.state).not.toBe('submission_recorded');
  expect(result.requests).toBe(1);
  expect(result.observationWrites).toBe(1);
  expect(result.view.items[1].taskId).toBeNull();
  expect(
    result.actions.filter((action) => action.endsWith('/home')),
  ).toHaveLength(1);
});
