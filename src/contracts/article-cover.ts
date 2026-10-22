import { z } from 'zod';
import { StorageIdSchema } from './stored-article';
import { DigestSchema } from './article-revision';
import { ArticleRevisionSchema } from './manual-edit';
import { RevisionSchema } from './web-paste';
export const CoverModeSchema = z.enum(['none', 'single', 'triple']);
export type CoverMode = z.output<typeof CoverModeSchema>;
export const COVER_IMAGE_MAX_BYTES = 10_000_000;
export const CoverMimeSchema = z.enum(['image/jpeg', 'image/png']);
export const CoverImageDescriptionSchema = z
  .strictObject({
    assetKey: StorageIdSchema,
    mime: CoverMimeSchema,
    width: z.number().int().positive().max(10000),
    height: z.number().int().positive().max(10000),
  })
  .refine((a) => a.width * a.height <= 25_000_000);
export const StoredCoverAssetSchema = CoverImageDescriptionSchema.safeExtend({
  relativePath: z
    .string()
    .regex(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.(png|jpg)$/),
  byteSize: z.number().int().positive().max(COVER_IMAGE_MAX_BYTES),
  sha256: DigestSchema,
}).refine(
  (a) =>
    a.relativePath.split('/').at(-1) ===
    a.assetKey + '.' + (a.mime === 'image/png' ? 'png' : 'jpg'),
);
export type StoredCoverAsset = z.output<typeof StoredCoverAssetSchema>;
export const CoverConfigurationSchema = z
  .strictObject({
    articleKey: StorageIdSchema,
    coverRevision: RevisionSchema,
    mode: CoverModeSchema,
    assets: z.array(StoredCoverAssetSchema).max(3),
    configurationDigest: DigestSchema,
    saveOperationId: StorageIdSchema.nullable(),
    committedAt: z.iso.datetime().nullable(),
  })
  .refine((c) => exactCoverCount(c.mode, c.assets.length))
  .refine(
    (c) => new Set(c.assets.map((a) => a.assetKey)).size === c.assets.length,
  )
  .refine((c) =>
    c.coverRevision === 0
      ? c.mode === 'none' &&
        c.saveOperationId === null &&
        c.committedAt === null
      : c.saveOperationId !== null && c.committedAt !== null,
  )
  .refine((c) =>
    c.assets.every(
      (a) =>
        a.relativePath ===
        c.articleKey +
          '/' +
          c.saveOperationId +
          '/' +
          a.assetKey +
          '.' +
          (a.mime === 'image/png' ? 'png' : 'jpg'),
    ),
  );
export type StoredCoverConfiguration = z.output<
  typeof CoverConfigurationSchema
>;
export const CoverDraftSchema = z
  .strictObject({
    mode: CoverModeSchema,
    imageTokens: z.array(StorageIdSchema).max(3),
  })
  .refine(
    (d) =>
      d.imageTokens.length <=
      (d.mode === 'none' ? 0 : d.mode === 'single' ? 1 : 3),
  )
  .refine((d) => new Set(d.imageTokens).size === d.imageTokens.length);
export type CoverDraft = z.output<typeof CoverDraftSchema>;
export const CoverEditCommandSchema = z.strictObject({
  sessionId: StorageIdSchema,
  expectedDraftRevision: RevisionSchema,
});
export type CoverEditCommand = z.output<typeof CoverEditCommandSchema>;
export const CoverSaveCommandSchema = CoverEditCommandSchema.extend({
  operationId: StorageIdSchema,
});
export type CoverSaveCommand = z.output<typeof CoverSaveCommandSchema>;
export const CoverSaveReceiptSchema = z.strictObject({
  operationId: StorageIdSchema,
  articleKey: StorageIdSchema,
  coverRevision: ArticleRevisionSchema,
  configurationDigest: DigestSchema,
});
export type CoverSaveReceipt = z.output<typeof CoverSaveReceiptSchema>;
export const CoverSaveResultSchema = z.union([
  z.strictObject({
    status: z.literal('committed'),
    receipt: CoverSaveReceiptSchema,
  }),
  z.strictObject({
    status: z.enum([
      'pending',
      'not_started',
      'failed',
      'conflict',
      'blocked',
      'unavailable',
      'needs_review',
    ]),
    operationId: StorageIdSchema,
  }),
]);
export type CoverSaveResult = z.output<typeof CoverSaveResultSchema>;
export const CoverSaveIntentSchema = z.strictObject({
  operationId: StorageIdSchema,
  articleKey: StorageIdSchema,
  sessionId: StorageIdSchema,
  expectedArticleRevision: ArticleRevisionSchema,
  expectedCoverRevision: RevisionSchema.refine(
    (v) => v < Number.MAX_SAFE_INTEGER,
  ),
  draftRevision: RevisionSchema,
  mode: CoverModeSchema,
  payloadDigest: DigestSchema,
  startedAt: z.iso.datetime(),
});
export type CoverSaveIntent = z.output<typeof CoverSaveIntentSchema>;
export const OwnedCoverFileSchema = StoredCoverAssetSchema.safeExtend({
  ownerNonce: StorageIdSchema,
  fileIdentity: z.string().min(1).max(512),
  complete: z.boolean(),
});
export type OwnedCoverFile = z.output<typeof OwnedCoverFileSchema>;
export const CoverAssetJournalSchema = z.strictObject({
  operationId: StorageIdSchema,
  articleKey: StorageIdSchema,
  ownerNonce: StorageIdSchema,
  files: z.array(OwnedCoverFileSchema).max(3),
});
export type CoverAssetJournal = z.output<typeof CoverAssetJournalSchema>;
export const CoverOperationStatusSchema = z.enum([
  'preparing',
  'committed',
  'failed',
  'cleanup_required',
  'needs_review',
]);
export const CoverOperationSchema = CoverSaveIntentSchema.extend({
  status: CoverOperationStatusSchema,
  ownedFiles: z.array(OwnedCoverFileSchema).max(3),
  committedCoverRevision: ArticleRevisionSchema.nullable(),
  committedAt: z.iso.datetime().nullable(),
  cleanupComplete: z.boolean(),
})
  .refine(
    (op) => (op.committedAt === null) === (op.committedCoverRevision === null),
  )
  .refine(
    (op) => op.status !== 'committed' || op.committedCoverRevision !== null,
  )
  .refine(
    (op) =>
      op.committedCoverRevision === null ||
      op.committedCoverRevision === op.expectedCoverRevision + 1,
  )
  .refine(
    (op) =>
      op.ownedFiles.length <=
      (op.mode === 'none' ? 0 : op.mode === 'single' ? 1 : 3),
  )
  .refine(
    (op) =>
      new Set(op.ownedFiles.map((f) => f.assetKey)).size ===
      op.ownedFiles.length,
  )
  .refine((op) => new Set(op.ownedFiles.map((f) => f.ownerNonce)).size <= 1)
  .refine((op) =>
    op.ownedFiles.every(
      (f) =>
        f.relativePath ===
        op.articleKey +
          '/' +
          op.operationId +
          '/' +
          f.assetKey +
          '.' +
          (f.mime === 'image/png' ? 'png' : 'jpg'),
    ),
  );
export type CoverOperation = z.output<typeof CoverOperationSchema>;
export const CoverOperationPatchSchema = z.strictObject({
  status: CoverOperationStatusSchema.optional(),
  ownedFiles: z.array(OwnedCoverFileSchema).max(3).optional(),
  cleanupComplete: z.boolean().optional(),
});
export type CoverOperationPatch = z.output<typeof CoverOperationPatchSchema>;
export interface CoverImageSource {
  readonly bytes: Uint8Array;
}
export const CoverViewSchema = z
  .strictObject({
    articleKey: StorageIdSchema,
    coverRevision: RevisionSchema,
    mode: CoverModeSchema,
    images: z.array(CoverImageDescriptionSchema).max(3),
  })
  .refine((c) => exactCoverCount(c.mode, c.images.length))
  .refine(
    (c) => new Set(c.images.map((i) => i.assetKey)).size === c.images.length,
  )
  .refine((c) => c.coverRevision > 0 || c.mode === 'none');
export const CoverReadResultSchema = z.union([
  z.strictObject({ status: z.literal('ok'), configuration: CoverViewSchema }),
  z.strictObject({ status: z.enum(['not_found', 'unavailable']) }),
]);
export type CoverReadResult = z.output<typeof CoverReadResultSchema>;
export const CoverNoticeSchema = z
  .enum([
    'busy',
    'conflict',
    'blocked',
    'image_invalid',
    'cancelled',
    'saved',
    'needs_review',
  ])
  .nullable();
export const CoverImageFailureSchema = z.strictObject({
  position: z.number().int().min(0).max(2),
  reason: z.enum([
    'IMAGE_UNAVAILABLE',
    'IMAGE_UNSUPPORTED',
    'IMAGE_INVALID',
    'IMAGE_LIMIT_EXCEEDED',
    'SOURCE_NOT_ALLOWED',
  ]),
});
export type CoverImageFailure = z.output<typeof CoverImageFailureSchema>;
const SessionFields = {
  imageFailure: CoverImageFailureSchema.optional(),
  sessionId: StorageIdSchema,
  articleKey: StorageIdSchema,
  baseArticleRevision: ArticleRevisionSchema,
  baseCoverRevision: RevisionSchema,
  draftRevision: RevisionSchema,
  draft: CoverDraftSchema,
  dirty: z.boolean(),
  images: z
    .array(
      z.strictObject({
        imageToken: StorageIdSchema,
        mime: CoverMimeSchema,
        width: z.number().int().positive().max(10000),
        height: z.number().int().positive().max(10000),
      }),
    )
    .max(3),
  notice: CoverNoticeSchema,
};
export const CoverEditReplySchema = z
  .union([
    z.strictObject({
      status: z.enum(['idle', 'unavailable']),
      notice: CoverNoticeSchema,
    }),
    z.strictObject({
      status: z.enum(['open', 'selecting', 'saving', 'closing']),
      ...SessionFields,
    }),
  ])
  .refine(
    (reply) =>
      !('imageFailure' in reply) ||
      reply.imageFailure === undefined ||
      reply.notice === 'image_invalid',
  );
export type CoverEditReply = z.output<typeof CoverEditReplySchema>;
export const CoverImageRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stored'),
    articleKey: StorageIdSchema,
    coverRevision: ArticleRevisionSchema,
    assetKey: StorageIdSchema,
  }),
  z.strictObject({
    kind: z.literal('session'),
    sessionId: StorageIdSchema,
    imageToken: StorageIdSchema,
  }),
]);
export type CoverImageRequest = z.output<typeof CoverImageRequestSchema>;
export const CoverImageResultSchema = z.union([
  z.strictObject({
    status: z.literal('ok'),
    mime: CoverMimeSchema,
    bytes: z
      .instanceof(Uint8Array)
      .refine((b) => b.byteLength > 0 && b.byteLength <= COVER_IMAGE_MAX_BYTES),
  }),
  z.strictObject({ status: z.enum(['not_found', 'busy', 'unavailable']) }),
]);
export type CoverImageResult = z.output<typeof CoverImageResultSchema>;
export const CoverSlotsSchema = z
  .array(z.number().int().min(0).max(2))
  .min(1)
  .max(3)
  .refine((s) => new Set(s).size === s.length);
export interface ArticleCoverApi {
  getArticleCover(articleKey: string): Promise<CoverReadResult>;
  beginCoverEdit(articleKey: string): Promise<CoverEditReply>;
  getCoverEditState(): Promise<CoverEditReply>;
  setCoverDraft(
    command: CoverEditCommand,
    draft: CoverDraft,
  ): Promise<CoverEditReply>;
  pickCoverImages(
    command: CoverEditCommand,
    slots: number[],
  ): Promise<CoverEditReply>;
  copyCoverImage(
    command: CoverEditCommand,
    source: Extract<CoverImageRequest, { kind: 'stored' }>,
  ): Promise<CoverEditReply>;
  getCoverImage(request: CoverImageRequest): Promise<CoverImageResult>;
  saveCoverEdit(command: CoverSaveCommand): Promise<CoverSaveResult>;
  getCoverSaveResult(operationId: string): Promise<CoverSaveResult>;
  closeCoverEdit(sessionId: string): Promise<CoverEditReply>;
}
const exactCoverCount = (mode: CoverMode, count: number) =>
  count === (mode === 'none' ? 0 : mode === 'single' ? 1 : 3);

export const CoverTaskSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    articleKey: StorageIdSchema,
    coverRevision: RevisionSchema,
    mode: CoverModeSchema,
    assets: z.array(StoredCoverAssetSchema).max(3),
    digest: DigestSchema,
  })
  .refine((c) => exactCoverCount(c.mode, c.assets.length))
  .refine(
    (c) => new Set(c.assets.map((a) => a.assetKey)).size === c.assets.length,
  )
  .refine((c) =>
    c.assets.every((a) => a.relativePath.startsWith(c.articleKey + '/')),
  );
export type CoverTaskSnapshot = z.output<typeof CoverTaskSnapshotSchema>;
export const CoverOwnershipMarkerSchema = z.strictObject({
  operationId: StorageIdSchema,
  articleKey: StorageIdSchema,
  ownerNonce: StorageIdSchema,
});

/** Internal projection excludes journal ownership fields; never a renderer DTO. */
export function coverAssetMetadata(asset: StoredCoverAsset): StoredCoverAsset {
  return StoredCoverAssetSchema.parse({
    assetKey: asset.assetKey,
    mime: asset.mime,
    width: asset.width,
    height: asset.height,
    relativePath: asset.relativePath,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
  });
}

export const articleCoverChannels = {
  getArticleCover: 'articles:cover:get',
  beginCoverEdit: 'articles:cover:begin',
  getCoverEditState: 'articles:cover:state',
  setCoverDraft: 'articles:cover:draft',
  pickCoverImages: 'articles:cover:pick',
  getCoverImage: 'articles:cover:image',
  copyCoverImage: 'articles:cover:copy',
  saveCoverEdit: 'articles:cover:save',
  getCoverSaveResult: 'articles:cover:save-result',
  closeCoverEdit: 'articles:cover:close',
} as const;
export const articleCoverRequests = {
  getArticleCover: z.tuple([StorageIdSchema]),
  beginCoverEdit: z.tuple([StorageIdSchema]),
  getCoverEditState: z.tuple([]),
  setCoverDraft: z.tuple([CoverEditCommandSchema, CoverDraftSchema]),
  pickCoverImages: z.tuple([CoverEditCommandSchema, CoverSlotsSchema]),
  getCoverImage: z.tuple([CoverImageRequestSchema]),
  copyCoverImage: z.tuple([
    CoverEditCommandSchema,
    CoverImageRequestSchema.options[0],
  ]),
  saveCoverEdit: z.tuple([CoverSaveCommandSchema]),
  getCoverSaveResult: z.tuple([StorageIdSchema]),
  closeCoverEdit: z.tuple([StorageIdSchema]),
};
export const articleCoverResponses = {
  getArticleCover: CoverReadResultSchema,
  beginCoverEdit: CoverEditReplySchema,
  getCoverEditState: CoverEditReplySchema,
  setCoverDraft: CoverEditReplySchema,
  pickCoverImages: CoverEditReplySchema,
  getCoverImage: CoverImageResultSchema,
  copyCoverImage: CoverEditReplySchema,
  saveCoverEdit: CoverSaveResultSchema,
  getCoverSaveResult: CoverSaveResultSchema,
  closeCoverEdit: CoverEditReplySchema,
};
