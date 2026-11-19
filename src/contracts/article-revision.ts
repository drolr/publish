import { z } from 'zod';
import { IdentifierSchema } from './article-package';
import {
  StorageIdSchema,
  StoredArticleSchema,
  StoredAssetSchema,
} from './stored-article';
import { ArticleRevisionSchema } from './manual-edit';
import {
  PersistedEditorBodySchema,
  PersistedEditorBodyV2Schema,
} from './rich-text-body';
import { RevisionSchema, textWithin, webPasteLimits } from './web-paste';
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const EditableArticleSchema = z.strictObject({
  article: StoredArticleSchema,
  articleRevision: ArticleRevisionSchema,
  editorBody: PersistedEditorBodySchema.nullable(),
});
export type EditableArticle = z.output<typeof EditableArticleSchema>;
export const SaveReceiptSchema = z.strictObject({
  operationId: StorageIdSchema,
  sessionId: StorageIdSchema,
  articleKey: StorageIdSchema,
  externalId: IdentifierSchema,
  documentRevision: RevisionSchema,
  articleRevision: ArticleRevisionSchema,
  kind: z.enum(['created', 'updated']),
  payloadDigest: DigestSchema,
  committedAt: z.iso.datetime(),
});
export type SaveReceipt = z.output<typeof SaveReceiptSchema>;
const OperationIdentity = { operationId: StorageIdSchema };
export const SaveLookupSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending'), ...OperationIdentity }),
  z.strictObject({
    status: z.literal('committed'),
    receipt: SaveReceiptSchema,
  }),
  z.strictObject({ status: z.literal('not_started'), ...OperationIdentity }),
  z.strictObject({ status: z.literal('failed'), ...OperationIdentity }),
  z.strictObject({ status: z.literal('needs_review'), ...OperationIdentity }),
  z.strictObject({ status: z.literal('unavailable'), ...OperationIdentity }),
]);
export type SaveLookup = z.output<typeof SaveLookupSchema>;
export const RevisionIntentSchema = z
  .strictObject({
    operationId: StorageIdSchema,
    sessionId: StorageIdSchema,
    articleKey: StorageIdSchema,
    externalId: IdentifierSchema,
    kind: z.enum(['created', 'updated']),
    documentRevision: RevisionSchema,
    baseRevision: RevisionSchema,
    payloadDigest: DigestSchema,
    startedAt: z.iso.datetime(),
  })
  .refine((i) =>
    i.kind === 'created' ? i.baseRevision === 0 : i.baseRevision >= 1,
  );
export type RevisionIntent = z.output<typeof RevisionIntentSchema>;
declare const verifiedStoredImage: unique symbol;
// Main-only opaque lease. Infrastructure validates provenance by registry identity, not DTO fields.
export interface VerifiedStoredImage {
  readonly [verifiedStoredImage]: true;
}
export const VerifiedStoredImageSchema = z.custom<VerifiedStoredImage>(
  (value) => typeof value === 'object' && value !== null,
);
export const RevisionImageSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stored'),
    imageId: IdentifierSchema,
    lease: VerifiedStoredImageSchema,
  }),
  z.strictObject({
    kind: z.literal('temporary'),
    imageId: IdentifierSchema,
    sessionId: StorageIdSchema,
    imageToken: StorageIdSchema,
  }),
]);
export type RevisionImageSource = z.output<typeof RevisionImageSourceSchema>;
declare const editorCompatibilityLease: unique symbol;
/** Process-local repository proof; never accepted through the renderer protocol or persisted. */
export interface EditorCompatibilityLease {
  readonly [editorCompatibilityLease]: true;
}
export const EditorCompatibilityLeaseSchema =
  z.custom<EditorCompatibilityLease>(
    (value) => typeof value === 'object' && value !== null,
  );
const ContentFields = {
  title: textWithin(webPasteLimits.titleCodePoints),
  contentDeclaration: z.enum(['original', 'repost']),
  editorBody: PersistedEditorBodyV2Schema,
  images: z.array(RevisionImageSourceSchema).max(webPasteLimits.images),
};
export const RevisionSaveInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('created'),
    command: z.strictObject({
      operationId: StorageIdSchema,
      sessionId: StorageIdSchema,
      documentRevision: RevisionSchema,
      payloadDigest: DigestSchema,
    }),
    externalId: IdentifierSchema,
    ...ContentFields,
  }),
  z.strictObject({
    kind: z.literal('updated'),
    intent: RevisionIntentSchema,
    identity: z.strictObject({
      articleKey: StorageIdSchema,
      externalId: IdentifierSchema,
      importId: StorageIdSchema,
      createdAt: z.iso.datetime(),
    }),
    compatibilityLease: EditorCompatibilityLeaseSchema.optional(),
    ...ContentFields,
  }),
]);
export type RevisionSaveInput = z.output<typeof RevisionSaveInputSchema>;
export const PreparedRevisionAssetsSchema = z.strictObject({
  assets: z.array(StoredAssetSchema).max(webPasteLimits.images),
  ownedNewAssetKeys: z.array(StorageIdSchema).max(webPasteLimits.images),
});
export type PreparedRevisionAssets = z.output<
  typeof PreparedRevisionAssetsSchema
>;
export const OwnedRevisionFileSchema = z
  .strictObject({
    assetKey: StorageIdSchema,
    relativePath: z.string().max(240),
    mime: StoredAssetSchema.shape.mime,
    byteSize: StoredAssetSchema.shape.byteSize,
    sha256: DigestSchema,
    ownerNonce: StorageIdSchema,
    fileIdentity: z.string().min(1).max(512),
  })
  .refine(
    (file) =>
      /^[a-zA-Z0-9._/-]+$/.test(file.relativePath) &&
      file.relativePath
        .split('/')
        .every((p) => p !== '.' && p !== '..' && p.length > 0),
  );
export type OwnedRevisionFile = z.output<typeof OwnedRevisionFileSchema>;
// Infrastructure-only physical journal; never part of the renderer protocol.
export const RevisionAssetJournalSchema = z.strictObject({
  operationId: StorageIdSchema,
  articleKey: StorageIdSchema,
  ownerNonce: StorageIdSchema,
  files: z.array(OwnedRevisionFileSchema).max(webPasteLimits.images),
});
export type RevisionAssetJournal = z.output<typeof RevisionAssetJournalSchema>;
export const RevisionOperationStatusSchema = z.enum([
  'preparing',
  'committed',
  'failed',
  'cleanup_required',
  'needs_review',
]);
export const RevisionOperationSchema = RevisionIntentSchema.safeExtend({
  nextDigest: DigestSchema.nullable(),
  status: RevisionOperationStatusSchema,
  committedRevision: ArticleRevisionSchema.nullable(),
  committedAt: z.iso.datetime().nullable(),
  cleanupComplete: z.boolean(),
  ownedFiles: z.array(OwnedRevisionFileSchema).max(webPasteLimits.images),
})
  .refine((op) => (op.committedRevision === null) === (op.committedAt === null))
  .refine((op) => op.status !== 'committed' || op.committedRevision !== null)
  .refine((op) => op.committedRevision === null || op.nextDigest !== null)
  .refine(
    (op) =>
      op.committedRevision === null ||
      op.committedRevision === op.baseRevision + 1,
  );
export type RevisionOperation = z.output<typeof RevisionOperationSchema>;
export const RevisionOperationPatchSchema = z.strictObject({
  status: RevisionOperationStatusSchema.optional(),
  cleanupComplete: z.boolean().optional(),
  ownedFiles: z
    .array(OwnedRevisionFileSchema)
    .max(webPasteLimits.images)
    .optional(),
});
export type RevisionOperationPatch = z.output<
  typeof RevisionOperationPatchSchema
>;
export const RevisionProposalSchema = z.strictObject({
  intent: RevisionIntentSchema,
  nextArticle: StoredArticleSchema,
  editorBody: PersistedEditorBodySchema,
  compatibilityLease: EditorCompatibilityLeaseSchema.optional(),
});
export type RevisionProposal = z.output<typeof RevisionProposalSchema>;
export const RevisionCommitResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('committed'),
    receipt: SaveReceiptSchema,
  }),
  z.strictObject({
    status: z.literal('already_committed'),
    receipt: SaveReceiptSchema,
  }),
  z.strictObject({ status: z.literal('conflict') }),
  z.strictObject({ status: z.literal('invalid') }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export type RevisionCommitResult = z.output<typeof RevisionCommitResultSchema>;
export type RevisionSaveResult =
  | SaveLookup
  | { status: 'unchanged'; articleKey: string; articleRevision: number };
export const RevisionSaveResultSchema = z.union([
  SaveLookupSchema,
  z.strictObject({
    status: z.literal('unchanged'),
    articleKey: StorageIdSchema,
    articleRevision: ArticleRevisionSchema,
  }),
]);
