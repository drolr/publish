import type {
  DeleteArticleCommand,
  DeleteArticleResult,
} from '../../contracts/article-delete';
import type { StoredArticle } from '../../contracts/stored-article';
export interface ArticleDeletionRepository {
  deleteArticle(
    command: DeleteArticleCommand,
    now: string,
  ): DeleteArticleResult;
  readDeletionResult(operationId: string): DeleteArticleResult;
  isArticleDeleted(articleKey: string): boolean;
  findExternalState(
    externalId: string,
  ): { kind: 'active' | 'deleted'; article: StoredArticle } | undefined;
}
