import { upgradeEditorBody } from '../domain/rich-text-body';
import {
  ArticleCursorSchema,
  ListResultSchema,
  ArticlePreviewSchema,
  ImageResultSchema,
  type ArticleCursor,
  type ListResult,
  type PreviewResult,
  type ImageResult,
} from '../contracts/article-library';
import {
  StorageIdSchema,
  StoredArticleSchema,
} from '../contracts/stored-article';
import type {
  ArticleRepository,
  AssetStore,
} from '../domain/ports/article-import';
import type { ArticleRevisionRepository } from '../domain/ports/article-revision';
export function createArticleLibrary(
  repository: ArticleRepository,
  assets: AssetStore,
  revisions: Pick<ArticleRevisionRepository, 'loadEditableArticle'>,
) {
  let imageBusy = false;
  let previewBusy = false;
  return {
    async listArticles(cursor?: ArticleCursor): Promise<ListResult> {
      try {
        if (!repository.list) return { status: 'unavailable' };
        return ListResultSchema.parse(
          repository.list(
            cursor === undefined
              ? undefined
              : ArticleCursorSchema.parse(cursor),
          ),
        );
      } catch {
        return { status: 'unavailable' };
      }
    },
    async getArticlePreview(articleKey: string): Promise<PreviewResult> {
      if (previewBusy) return { status: 'busy' };
      previewBusy = true;
      try {
        const found = revisions.loadEditableArticle(
          StorageIdSchema.parse(articleKey),
        );
        if (!found) return { status: 'not_found' };
        const article = StoredArticleSchema.parse(found.article);
        await assets.verify(article);
        return {
          status: 'ok',
          article: ArticlePreviewSchema.parse({
            articleKey: article.articleKey,
            articleRevision: found.articleRevision,
            externalId: article.externalId,
            title: article.title,
            contentDeclaration: article.contentDeclaration,
            createdAt: article.createdAt,
            imageCount: article.assets.length,
            body: article.body,
            editorBody: upgradeEditorBody(found.editorBody, article.body),
            assets: article.assets.map(
              ({ assetKey, imageId, mime, width, height }) => ({
                assetKey,
                imageId,
                mime,
                width,
                height,
              }),
            ),
          }),
        };
      } catch {
        return { status: 'unavailable' };
      } finally {
        previewBusy = false;
      }
    },
    async getArticleImage(
      articleKey: string,
      assetKey: string,
    ): Promise<ImageResult> {
      if (imageBusy) return { status: 'busy' };
      imageBusy = true;
      try {
        StorageIdSchema.parse(assetKey);
        const found = revisions.loadEditableArticle(
          StorageIdSchema.parse(articleKey),
        );
        if (!found) return { status: 'not_found' };
        const article = StoredArticleSchema.parse(found.article);
        const asset = article.assets.find((a) => a.assetKey === assetKey);
        if (!asset) return { status: 'not_found' };
        if (!assets.readImage) return { status: 'unavailable' };
        return ImageResultSchema.parse({
          status: 'ok',
          mime: asset.mime,
          bytes: await assets.readImage(article, assetKey),
        });
      } catch {
        return { status: 'unavailable' };
      } finally {
        imageBusy = false;
      }
    },
  };
}
