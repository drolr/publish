import { expect, it, vi } from 'vitest';
import type { ArticleDeletionRepository } from '../../src/domain/ports/article-delete';
import type { DeleteArticleResult } from '../../src/contracts/article-delete';
const operationId = '00000000-0000-4000-8000-000000000001';
const articleKey = '00000000-0000-4000-8000-000000000002';
const command = { operationId, articleKey, expectedArticleRevision: 1 };
async function setup(
  gate: () => 'ready' | 'busy' | 'unavailable' = () => 'ready',
) {
  const module = await import('../../src/application/article-delete').catch(
    () => undefined,
  );
  expect(module?.createArticleDeletion).toBeTypeOf('function');
  const deleted: DeleteArticleResult = {
    status: 'deleted',
    operationId,
    articleKey,
    articleRevision: 2,
  };
  const repository = {
    deleteArticle: vi.fn(() => deleted),
    readDeletionResult: vi.fn((): DeleteArticleResult => deleted),
    isArticleDeleted: vi.fn(() => false),
    findExternalState: vi.fn(),
  } satisfies ArticleDeletionRepository;
  return {
    api: module!.createArticleDeletion({
      repository,
      gate,
      now: () => '2026-10-09T00:00:00.000Z',
    }),
    repository,
    deleted,
  };
}
it('lost_delete_reply queries a committed receipt without another delete or gate', async () => {
  const gate = vi.fn(() => 'ready' as const);
  const { api, repository, deleted } = await setup(gate);
  repository.deleteArticle.mockImplementationOnce(() => {
    throw new Error('lost reply C:/private');
  });
  expect(await api.deleteArticle(command)).toEqual({
    status: 'unavailable',
    operationId,
  });
  gate.mockClear();
  expect(await api.getArticleDeletionResult(operationId)).toEqual(deleted);
  expect(repository.deleteArticle).toHaveBeenCalledOnce();
  expect(repository.readDeletionResult).toHaveBeenCalledWith(operationId);
  expect(gate).not.toHaveBeenCalled();
});
it.each(['busy', 'unavailable'] as const)(
  'gate_busy_or_unknown: %s denies deletion',
  async (state) => {
    const { api, repository } = await setup(() => state);
    expect(await api.deleteArticle(command)).toEqual({
      status: state === 'busy' ? 'blocked' : 'unavailable',
      operationId,
    });
    expect(repository.deleteArticle).not.toHaveBeenCalled();
  },
);
it('validates commands and correlates repository responses before returning them', async () => {
  const { api, repository, deleted } = await setup();
  expect(
    await api.deleteArticle({
      ...command,
      path: 'C:/private',
    } as typeof command),
  ).toEqual({ status: 'unavailable', operationId });
  expect(repository.deleteArticle).not.toHaveBeenCalled();
  expect(await api.deleteArticle(command)).toEqual(deleted);
  expect(repository.deleteArticle).toHaveBeenCalledWith(
    command,
    '2026-10-09T00:00:00.000Z',
  );
  repository.deleteArticle.mockReturnValue({
    ...deleted,
    articleKey: operationId,
  });
  expect(await api.deleteArticle(command)).toEqual({
    status: 'unavailable',
    operationId,
  });
  repository.readDeletionResult.mockReturnValue({
    status: 'not_started',
    operationId,
  });
  expect(await api.getArticleDeletionResult(operationId)).toEqual({
    status: 'not_started',
    operationId,
  });
  expect(repository.deleteArticle).toHaveBeenCalledTimes(2);
  repository.readDeletionResult.mockReturnValue({
    status: 'blocked',
    operationId: articleKey,
  });
  expect(await api.getArticleDeletionResult(operationId)).toEqual({
    status: 'unavailable',
    operationId,
  });
});
it('fails closed on a throwing gate and never writes for an invalid receipt query', async () => {
  const { api, repository } = await setup(() => {
    throw new Error('unknown');
  });
  expect(await api.deleteArticle(command)).toEqual({
    status: 'unavailable',
    operationId,
  });
  expect(repository.deleteArticle).not.toHaveBeenCalled();
  expect(await api.getArticleDeletionResult('C:/arbitrary')).toEqual({
    status: 'unavailable',
    operationId: 'C:/arbitrary',
  });
  expect(repository.readDeletionResult).not.toHaveBeenCalled();
});
