import { z } from 'zod';
import { StorageIdSchema } from './stored-article';
import { ArticleRevisionSchema } from './manual-edit';
export const ArticleDeletionTimeSchema = z.iso.datetime();
export const DeleteArticleCommandSchema = z.strictObject({
  operationId: StorageIdSchema,
  articleKey: StorageIdSchema,
  expectedArticleRevision: ArticleRevisionSchema,
});
export type DeleteArticleCommand = z.infer<typeof DeleteArticleCommandSchema>;
export const DeleteArticleResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('deleted'),
    operationId: StorageIdSchema,
    articleKey: StorageIdSchema,
    articleRevision: ArticleRevisionSchema,
  }),
  z.strictObject({
    status: z.enum([
      'conflict',
      'blocked',
      'not_found',
      'unavailable',
      'not_started',
    ]),
    operationId: StorageIdSchema,
  }),
]);
export type DeleteArticleResult = z.infer<typeof DeleteArticleResultSchema>;
export interface ArticleDeletionApi {
  deleteArticle(command: DeleteArticleCommand): Promise<DeleteArticleResult>;
  getArticleDeletionResult(operationId: string): Promise<DeleteArticleResult>;
}

export const articleDeletionChannels = {
  deleteArticle: 'articles:delete',
  getArticleDeletionResult: 'articles:delete-result',
} as const;
export const articleDeletionRequests = {
  deleteArticle: z.tuple([DeleteArticleCommandSchema]),
  getArticleDeletionResult: z.tuple([StorageIdSchema]),
};
export const articleDeletionResponses = {
  deleteArticle: DeleteArticleResultSchema,
  getArticleDeletionResult: DeleteArticleResultSchema,
};
