import { z } from 'zod';
import { IdentifierSchema } from './article-package';
import { StorageIdSchema } from './stored-article';
import { RevisionSchema } from './web-paste';
export const ArticleRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export {
  PersistedEditorBodyV1Schema,
  type PersistedEditorBodyV1,
} from './editor-body-v1';
export const DocumentCommandSchema = z.strictObject({
  sessionId: StorageIdSchema,
  expectedDocumentRevision: RevisionSchema,
  clientSequence: RevisionSchema,
  commandId: StorageIdSchema,
});
export type DocumentCommand = z.output<typeof DocumentCommandSchema>;
export const SaveCommandSchema = z.strictObject({
  sessionId: StorageIdSchema,
  expectedDocumentRevision: RevisionSchema,
  operationId: StorageIdSchema,
  expectedCoverDraftRevision: RevisionSchema.optional(),
});
export type SaveCommand = z.output<typeof SaveCommandSchema>;
export const DraftBoundarySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    blockKey: StorageIdSchema,
    kind: z.literal('text'),
    offset: RevisionSchema,
  }),
  z.strictObject({
    blockKey: StorageIdSchema,
    kind: z.literal('edge'),
    side: z.enum(['before', 'after']),
  }),
]);
export type DraftBoundary = z.output<typeof DraftBoundarySchema>;
export const DraftRangeSchema = z.strictObject({
  anchor: DraftBoundarySchema,
  head: DraftBoundarySchema,
});
export type DraftRange = z.output<typeof DraftRangeSchema>;
export const EditorTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new') }),
  z.strictObject({
    kind: z.literal('existing'),
    articleKey: StorageIdSchema,
    externalId: IdentifierSchema,
    importId: StorageIdSchema,
    baseArticleRevision: ArticleRevisionSchema,
  }),
]);
export type EditorTarget = z.output<typeof EditorTargetSchema>;
export const AcknowledgedEditSchema = z.strictObject({
  clientSequence: RevisionSchema,
  commandId: StorageIdSchema,
});
export type AcknowledgedEdit = z.output<typeof AcknowledgedEditSchema>;
export const SaveOutcomeSchema = z.strictObject({
  kind: z.enum(['created', 'updated', 'unchanged']),
  articleKey: StorageIdSchema,
  articleRevision: ArticleRevisionSchema,
  operationId: StorageIdSchema,
});
export type SaveOutcome = z.output<typeof SaveOutcomeSchema>;
export const ManualCloseRequestSchema = z.strictObject({
  requestId: StorageIdSchema,
});
export type ManualCloseRequest = z.output<typeof ManualCloseRequestSchema>;
export interface EditorCloseEventsApi {
  onManualCloseRequest(
    listener: (request: ManualCloseRequest) => void,
  ): () => void;
}

export const InternalPasteInputSchema = z.strictObject({
  kind: z.literal('internal'),
  grantId: StorageIdSchema,
});
export type InternalPasteInput = z.output<typeof InternalPasteInputSchema>;
export const ManualCloseChoiceSchema = z.enum(['save', 'discard', 'keep']);
export const ManualCloseResponseStatusSchema = z.enum(['flushed', 'blocked']);
export const ManualOperationKindSchema = z.enum([
  'paste',
  'retry',
  'image',
  'save',
  'open',
  'copy',
  'close',
]);
export type ManualOperationKind = z.output<typeof ManualOperationKindSchema>;
// Shared editor request types; T3 activates them on the existing manual controller.
export interface ContinuousManualArticleApi {
  openManualArticle(
    articleKey: string,
  ): Promise<import('./manual-article').ManualReply>;
  applyManualEdit(
    command: DocumentCommand,
    draft: import('./manual-article').ManualDraft,
  ): Promise<import('./manual-article').ManualReply>;
  spliceManualPaste(
    command: DocumentCommand,
    range: DraftRange,
    input: import('./web-paste').WebPasteInput | InternalPasteInput,
  ): Promise<import('./manual-article').ManualReply>;
  insertManualImage(
    command: DocumentCommand,
    range: DraftRange,
  ): Promise<import('./manual-article').ManualReply>;
  commitManualDocument(
    command: SaveCommand,
  ): Promise<import('./manual-article').ManualReply>;
  closeManualEditor(
    command: DocumentCommand,
    choice: z.output<typeof ManualCloseChoiceSchema>,
  ): Promise<import('./manual-article').ManualReply>;
  copyManualSelection(
    command: DocumentCommand,
    range: DraftRange,
    cut: boolean,
  ): Promise<import('./manual-article').ManualReply>;
  getManualSaveResult(
    sessionId: string,
    operationId: string,
  ): Promise<import('./article-revision').SaveLookup>;
  respondManualClose(
    requestId: string,
    sessionId: string,
    documentRevision: number,
    status: z.output<typeof ManualCloseResponseStatusSchema>,
  ): Promise<import('./manual-article').ManualReply>;
}
