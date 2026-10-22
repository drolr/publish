import { z } from 'zod';
import { validateArticlePackage } from './article-package';

export { STORAGE_SCHEMA_VERSION } from './storage-version';
export const StorageIdSchema = z.uuid();
export const ImportAttemptSchema = z.strictObject({
  importId: StorageIdSchema,
  articleKey: StorageIdSchema,
  externalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  startedAt: z.iso.datetime(),
  status: z.enum(['preparing', 'cleanup_required', 'needs_review']),
});
export const StoredAssetSchema = z
  .strictObject({
    assetKey: StorageIdSchema,
    imageId: z.string(),
    relativePath: z.string(),
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    width: z.number().int().positive().max(10000),
    height: z.number().int().positive().max(10000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((asset, ctx) => {
    if (asset.width * asset.height > 25000000)
      ctx.addIssue({ code: 'custom', message: 'Invalid dimensions' });
  });
export const StoredArticleSchema = z
  .strictObject({
    articleKey: StorageIdSchema,
    externalId: z.string(),
    importId: StorageIdSchema,
    title: z.string(),
    body: z
      .array(
        z.discriminatedUnion('type', [
          z.strictObject({ type: z.literal('paragraph'), text: z.string() }),
          z.strictObject({ type: z.literal('image'), image_id: z.string() }),
        ]),
      )
      .max(1000),
    contentDeclaration: z.enum(['original', 'repost']),
    createdAt: z.iso.datetime(),
    assets: z.array(StoredAssetSchema).max(200),
  })
  .superRefine((article, ctx) => {
    const checked = validateArticlePackage({
      schema_version: 1,
      article_id: article.externalId,
      title: article.title,
      body: article.body,
      content_declaration: article.contentDeclaration,
      images: article.assets.map((asset) => ({
        image_id: asset.imageId,
        source: { type: 'local', path: 'verified.jpg' },
      })),
    });
    if (!checked.ok || (checked.ok && checked.article.title !== article.title))
      ctx.addIssue({ code: 'custom', message: 'Invalid stored article' });
    const keys = new Set<string>();
    let total = 0;
    for (const asset of article.assets) {
      const extension = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
      }[asset.mime];
      if (
        keys.has(asset.assetKey) ||
        asset.relativePath !==
          `${article.articleKey}/${asset.assetKey}.${extension}`
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid asset identity' });
      keys.add(asset.assetKey);
      total += asset.byteSize;
    }
    if (total > 200 * 1024 * 1024)
      ctx.addIssue({ code: 'custom', message: 'Invalid asset total' });
  });
export type StoredAsset = z.output<typeof StoredAssetSchema>;
export type StoredArticle = z.output<typeof StoredArticleSchema>;
