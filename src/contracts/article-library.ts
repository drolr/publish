import { z } from 'zod';
import { PersistedEditorBodyV2Schema } from './rich-text-body';
import {
  DeclarationKeysSchema,
  DeclarationChangeSchema,
  DeclarationReadResultSchema,
  DeclarationWriteResultSchema,
  type ArticleDeclarationApi,
} from './article-declaration';
import { IdentifierSchema, TitleSchema } from './article-package';
import { ArticleRevisionSchema } from './manual-edit';
import {
  StorageIdSchema,
  StoredArticleSchema,
  StoredAssetSchema,
} from './stored-article';

export const MembershipRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const PageNumberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const ArticleCursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  articleKey: StorageIdSchema,
  membershipRevision: MembershipRevisionSchema,
  pageNumber: PageNumberSchema.min(2),
});
export type ArticleCursor = z.infer<typeof ArticleCursorSchema>;
export const ArticleSummarySchema = z.strictObject({
  articleKey: StorageIdSchema,
  externalId: IdentifierSchema,
  title: z.string().refine((value) => {
    const parsed = TitleSchema.safeParse(value);
    return parsed.success && parsed.data === value;
  }),
  contentDeclaration: z.enum(['original', 'repost']),
  imageCount: z.number().int().min(0).max(200),
  createdAt: z.iso.datetime(),
  articleRevision: ArticleRevisionSchema,
});
export type ArticleSummary = z.infer<typeof ArticleSummarySchema>;
export const ArticlePageSchema = z.strictObject({
  items: z.array(ArticleSummarySchema).max(10),
  totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  membershipRevision: MembershipRevisionSchema,
  pageNumber: PageNumberSchema,
  totalPages: PageNumberSchema,
  nextCursor: ArticleCursorSchema.optional(),
});
export type ArticlePage = z.infer<typeof ArticlePageSchema>;
export const ArticlePreviewSchema = ArticleSummarySchema.extend({
  body: StoredArticleSchema.shape.body,
  editorBody: PersistedEditorBodyV2Schema,
  assets: z
    .array(
      z.strictObject({
        assetKey: StorageIdSchema,
        imageId: z.string().max(128),
        mime: StoredAssetSchema.shape.mime,
        width: StoredAssetSchema.shape.width,
        height: StoredAssetSchema.shape.height,
      }),
    )
    .max(200),
});
export type ArticlePreview = z.infer<typeof ArticlePreviewSchema>;
export const ImportOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('imported'),
    articleKey: StorageIdSchema,
    title: z.string().max(1024),
    warnings: z.array(z.string().max(300)).max(1),
  }),
  z.strictObject({
    status: z.enum(['already_exists', 'already_deleted']),
    articleKey: StorageIdSchema,
    title: z.string().max(1024),
  }),
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({
    status: z.literal('invalid'),
    issues: z
      .array(
        z.strictObject({
          message: z.string().max(300),
          position: z.string().max(60).optional(),
        }),
      )
      .max(50),
  }),
  z.strictObject({
    status: z.literal('failed'),
    code: z.enum([
      'IMAGE_UNAVAILABLE',
      'IMAGE_UNSUPPORTED',
      'IMAGE_INVALID',
      'IMAGE_LIMIT_EXCEEDED',
      'SOURCE_NOT_ALLOWED',
      'STORAGE_UNAVAILABLE',
      'RECOVERY_REQUIRED',
      'FILE_INVALID',
      'FILE_TOO_LARGE',
      'FILE_UNAVAILABLE',
    ]),
    message: z.string().max(300),
    imageIndex: z.number().int().min(0).max(199).optional(),
  }),
]);
export type ImportOutcome = z.infer<typeof ImportOutcomeSchema>;
export const ImportSnapshotSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('idle'),
    revision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    state: z.enum(['selecting', 'importing', 'stopping']),
    revision: z.number().int().nonnegative(),
    jobId: StorageIdSchema,
  }),
  z.strictObject({
    state: z.literal('finished'),
    revision: z.number().int().nonnegative(),
    jobId: StorageIdSchema,
    result: ImportOutcomeSchema,
  }),
]);
export type ImportSnapshot = z.infer<typeof ImportSnapshotSchema>;
export const StartImportSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['started', 'busy']),
    jobId: StorageIdSchema,
  }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export type StartImportResult = z.infer<typeof StartImportSchema>;
export const ListResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), page: ArticlePageSchema }),
  z.strictObject({ status: z.literal('stale_cursor') }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export type ListResult = z.infer<typeof ListResultSchema>;
export const PreviewResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), article: ArticlePreviewSchema }),
  z.strictObject({ status: z.enum(['not_found', 'unavailable', 'busy']) }),
]);
export type PreviewResult = z.infer<typeof PreviewResultSchema>;
export const ImageResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    mime: StoredAssetSchema.shape.mime,
    bytes: z
      .instanceof(Uint8Array)
      .refine(
        (bytes) => bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024,
      ),
  }),
  z.strictObject({ status: z.enum(['not_found', 'unavailable', 'busy']) }),
]);
export type ImageResult = z.infer<typeof ImageResultSchema>;
export interface ArticleLibraryApi extends ArticleDeclarationApi {
  startArticleImport(): Promise<StartImportResult>;
  getImportStatus(): Promise<ImportSnapshot>;
  cancelArticleImport(jobId: string): Promise<ImportSnapshot>;
  listArticles(cursor?: ArticleCursor): Promise<ListResult>;
  getArticlePreview(articleKey: string): Promise<PreviewResult>;
  getArticleImage(articleKey: string, assetKey: string): Promise<ImageResult>;
}
export const libraryChannels = {
  getArticleDeclarations: 'articles:declarations',
  setArticleDeclarations: 'articles:set-declarations',
  startArticleImport: 'articles:start-import',
  getImportStatus: 'articles:import-status',
  cancelArticleImport: 'articles:cancel-import',
  listArticles: 'articles:list',
  getArticlePreview: 'articles:preview',
  getArticleImage: 'articles:image',
} as const;
export const libraryRequests = {
  getArticleDeclarations: z.tuple([DeclarationKeysSchema]),
  setArticleDeclarations: z.tuple([DeclarationChangeSchema]),
  startArticleImport: z.tuple([]),
  getImportStatus: z.tuple([]),
  cancelArticleImport: z.tuple([StorageIdSchema]),
  listArticles: z.union([
    z.tuple([]),
    z.tuple([ArticleCursorSchema.optional()]),
  ]),
  getArticlePreview: z.tuple([StorageIdSchema]),
  getArticleImage: z.tuple([StorageIdSchema, StorageIdSchema]),
};
export const libraryResponses = {
  getArticleDeclarations: DeclarationReadResultSchema,
  setArticleDeclarations: DeclarationWriteResultSchema,
  startArticleImport: StartImportSchema,
  getImportStatus: ImportSnapshotSchema,
  cancelArticleImport: ImportSnapshotSchema,
  listArticles: ListResultSchema,
  getArticlePreview: PreviewResultSchema,
  getArticleImage: ImageResultSchema,
};
