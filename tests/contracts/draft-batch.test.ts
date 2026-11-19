import { expect, it } from 'vitest';
import {
  BatchPrepareInputSchema,
  BatchStartInputSchema,
} from '../../src/contracts/draft-batch';
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
it('accepts an ordered unique selection and rejects empty or duplicate article identities', () => {
  expect(
    BatchPrepareInputSchema.parse({
      articleKeys: [other, id],
      bindingToken: id,
    }).articleKeys,
  ).toEqual([other, id]);
  for (const articleKeys of [[], [id, id], ['not-an-id']]) {
    expect(
      BatchPrepareInputSchema.safeParse({ articleKeys, bindingToken: id })
        .success,
    ).toBe(false);
  }
});
it('does not allow renderer to smuggle a store or a snapshot into a start command', () => {
  expect(
    BatchStartInputSchema.safeParse({ preparationId: id, requestId: other })
      .success,
  ).toBe(true);
  expect(
    BatchStartInputSchema.safeParse({
      preparationId: id,
      requestId: other,
      store: {},
    }).success,
  ).toBe(false);
});

it('accepts only unique new-attempt identities belonging to the frozen selection', () => {
  expect(
    BatchPrepareInputSchema.safeParse({
      articleKeys: [id],
      bindingToken: id,
      newAttemptArticleKeys: [id],
    }).success,
  ).toBe(true);
  for (const keys of [[id, id], [other]])
    expect(
      BatchPrepareInputSchema.safeParse({
        articleKeys: [id],
        bindingToken: id,
        newAttemptArticleKeys: keys,
      }).success,
    ).toBe(false);
});

it('recovery contract validates current task identity, CAS revision and explicit untouched-queue intent', async () => {
  const { BatchRecoveryInputSchema } =
    await import('../../src/contracts/draft-batch');
  expect(
    BatchRecoveryInputSchema.parse({
      batchId: id,
      expectedRevision: 0,
      taskId: other,
    }).taskId,
  ).toBe(other);
  expect(
    BatchRecoveryInputSchema.parse({
      batchId: id,
      expectedRevision: 1,
      taskId: null,
    }).taskId,
  ).toBeNull();
  for (const input of [
    { batchId: id, expectedRevision: -1, taskId: other },
    { batchId: id, expectedRevision: 0.5, taskId: other },
    { batchId: id, expectedRevision: 1 },
    { batchId: id, expectedRevision: 1, taskId: 'private-path' },
    { batchId: id, expectedRevision: 1, taskId: other, bypassBusy: true },
  ])
    expect(BatchRecoveryInputSchema.safeParse(input).success).toBe(false);
});
