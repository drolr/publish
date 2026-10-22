import { expect, it } from 'vitest';
import {
  DeleteArticleCommandSchema,
  DeleteArticleResultSchema,
} from '../../src/contracts/article-delete';
const command = {
  operationId: '11111111-1111-4111-8111-111111111111',
  articleKey: '22222222-2222-4222-8222-222222222222',
  expectedArticleRevision: 1,
};
it('strict delete command rejects caller digest and unsafe revisions', () => {
  expect(DeleteArticleCommandSchema.safeParse(command).success).toBe(true);
  for (const bad of [
    { ...command, payloadDigest: 'caller' },
    { ...command, expectedArticleRevision: 0 },
    { ...command, expectedArticleRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...command, operationId: 'bad' },
  ])
    expect(DeleteArticleCommandSchema.safeParse(bad).success).toBe(false);
});
it('delete outcomes require operation identity and committed article revision', () => {
  expect(
    DeleteArticleResultSchema.safeParse({
      status: 'deleted',
      operationId: command.operationId,
      articleKey: command.articleKey,
      articleRevision: 2,
    }).success,
  ).toBe(true);
  for (const status of [
    'conflict',
    'blocked',
    'not_found',
    'unavailable',
    'not_started',
  ])
    expect(
      DeleteArticleResultSchema.safeParse({
        status,
        operationId: command.operationId,
      }).success,
    ).toBe(true);
  for (const bad of [
    { status: 'deleted', operationId: command.operationId },
    {
      status: 'blocked',
      operationId: command.operationId,
      articleKey: command.articleKey,
    },
    { status: 'not_started' },
  ])
    expect(DeleteArticleResultSchema.safeParse(bad).success).toBe(false);
});
