import {
  DeleteArticleCommandSchema,
  DeleteArticleResultSchema,
  type ArticleDeletionApi,
  type DeleteArticleResult,
} from '../contracts/article-delete';
import { StorageIdSchema } from '../contracts/stored-article';
import type { ArticleDeletionRepository } from '../domain/ports/article-delete';

interface ArticleDeletionPorts {
  repository: ArticleDeletionRepository;
  gate(): 'ready' | 'busy' | 'unavailable';
  now(): string;
}
export function createArticleDeletion(
  ports: ArticleDeletionPorts,
): ArticleDeletionApi {
  function unavailable(operationId: string): DeleteArticleResult {
    return { status: 'unavailable', operationId };
  }
  function checkedResult(
    raw: unknown,
    operationId: string,
    articleKey?: string,
  ): DeleteArticleResult {
    const result = DeleteArticleResultSchema.parse(raw);
    if (
      result.operationId !== operationId ||
      (result.status === 'deleted' &&
        articleKey !== undefined &&
        result.articleKey !== articleKey)
    )
      return unavailable(operationId);
    return result;
  }
  return {
    async deleteArticle(raw) {
      const operationId = raw.operationId;
      try {
        const command = DeleteArticleCommandSchema.parse(raw);
        const state = ports.gate();
        if (state !== 'ready')
          return {
            status: state === 'busy' ? 'blocked' : 'unavailable',
            operationId,
          };
        // Repository transaction is synchronous: no writer can start between the trusted gate and commit.
        const result = checkedResult(
          ports.repository.deleteArticle(command, ports.now()),
          operationId,
          command.articleKey,
        );
        return result.status === 'not_started'
          ? unavailable(operationId)
          : result;
      } catch {
        return unavailable(operationId);
      }
    },
    async getArticleDeletionResult(operationId) {
      try {
        StorageIdSchema.parse(operationId);
        // Receipt inspection never consumes the write gate or starts/replays a delete.
        return checkedResult(
          ports.repository.readDeletionResult(operationId),
          operationId,
        );
      } catch {
        return unavailable(operationId);
      }
    },
  };
}
