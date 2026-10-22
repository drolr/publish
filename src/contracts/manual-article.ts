import { z } from 'zod';
import {
  ImageResultSchema,
  ImportOutcomeSchema,
  type ImageResult,
} from './article-library';
import { StorageIdSchema, StoredAssetSchema } from './stored-article';
import { IdentifierSchema } from './article-package';
import { SaveLookupSchema } from './article-revision';
import {
  DocumentCommandSchema,
  SaveCommandSchema,
  DraftRangeSchema,
  EditorTargetSchema,
  AcknowledgedEditSchema,
  SaveOutcomeSchema,
  ManualOperationKindSchema,
  InternalPasteInputSchema,
  ManualCloseChoiceSchema,
  ManualCloseResponseStatusSchema,
  type ContinuousManualArticleApi,
} from './manual-edit';

import {
  CandidateViewSchema,
  DraftSnapshotBudgetSchema,
  PasteCommandSchema,
  PasteProgressSchema,
  PasteSummarySchema,
  PendingBlockSchema,
  RevisionSchema,
  WebPasteInputSchema,
  codePointLength,
  textWithin,
  webPasteLimits,
  type PasteCommand,
  type WebPasteInput,
} from './web-paste';

const BlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    blockKey: StorageIdSchema,
    type: z.literal('paragraph'),
    text: textWithin(webPasteLimits.paragraphCodePoints),
  }),
  z.strictObject({
    blockKey: StorageIdSchema,
    type: z.literal('image'),
    imageToken: StorageIdSchema,
  }),
  PendingBlockSchema,
]);
const DraftShape = z
  .strictObject({
    title: textWithin(webPasteLimits.titleCodePoints),
    contentDeclaration: z.enum(['original', 'repost']),
    blocks: z.array(BlockSchema).max(webPasteLimits.blocks),
  })
  .superRefine((draft, ctx) => {
    if (
      new Set(draft.blocks.map((block) => block.blockKey)).size !==
      draft.blocks.length
    )
      ctx.addIssue({ code: 'custom', message: '内容块标识重复。' });
    if (
      new Set(
        draft.blocks.flatMap((block) =>
          block.type === 'image' ? [block.imageToken] : [],
        ),
      ).size +
        draft.blocks.filter((block) => block.type === 'image-pending').length >
      webPasteLimits.images
    )
      ctx.addIssue({ code: 'custom', message: '图片数量过多。' });
    if (
      draft.blocks.reduce(
        (sum, block) =>
          sum + (block.type === 'paragraph' ? codePointLength(block.text) : 0),
        0,
      ) > webPasteLimits.totalCodePoints
    )
      ctx.addIssue({ code: 'custom', message: '正文文字过多。' });
    const candidateIds = draft.blocks.flatMap((block) =>
      block.type === 'image-pending' ? [block.candidateId] : [],
    );
    if (new Set(candidateIds).size !== candidateIds.length)
      ctx.addIssue({ code: 'custom', message: '图片位置标识重复。' });
  });
export const ManualDraftSchema = DraftSnapshotBudgetSchema.pipe(DraftShape);
export type ManualDraft = z.infer<typeof ManualDraftSchema>;
export const ManualImageSchema = z
  .strictObject({
    imageToken: StorageIdSchema,
    mime: StoredAssetSchema.shape.mime,
    width: StoredAssetSchema.shape.width,
    height: StoredAssetSchema.shape.height,
    byteSize: z.number().int().positive().max(webPasteLimits.imageBytes),
  })
  .refine((image) => image.width * image.height <= webPasteLimits.imagePixels);
export type ManualImage = z.infer<typeof ManualImageSchema>;
const ManualIssuesSchema = z
  .array(
    z.strictObject({
      message: z.string().max(300),
      position: z.string().max(60).optional(),
    }),
  )
  .max(50);
export const ManualStateSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.enum(['idle', 'unavailable']),
    revision: RevisionSchema,
  }),
  z
    .strictObject({
      state: z.enum([
        'editing',
        'selecting',
        'saving',
        'stopping',
        'finished',
        'pasting',
        'retrying',
      ]),
      revision: RevisionSchema,
      sessionId: StorageIdSchema,
      nextPasteCommandId: StorageIdSchema,
      candidates: z.array(CandidateViewSchema).max(webPasteLimits.images),
      pasteProgress: PasteProgressSchema.optional(),
      pasteSummary: PasteSummarySchema.optional(),
      externalId: IdentifierSchema,
      target: EditorTargetSchema,
      documentRevision: RevisionSchema,
      acknowledgedEdit: AcknowledgedEditSchema.nullable(),
      nextEditCommandId: StorageIdSchema,
      nextClientSequence: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER),
      nextSaveOperationId: StorageIdSchema,
      saveOutcome: SaveOutcomeSchema.optional(),
      operationKind: ManualOperationKindSchema.optional(),
      draft: ManualDraftSchema,
      images: z.array(ManualImageSchema).max(webPasteLimits.images),
      dirty: z.boolean(),
      jobId: StorageIdSchema.optional(),
      result: ImportOutcomeSchema.optional(),
      issues: ManualIssuesSchema.optional(),
    })
    .refine(
      (session) =>
        new Set(session.images.map((image) => image.imageToken)).size +
          session.candidates.length <=
        webPasteLimits.images,
    )
    .refine(
      (session) =>
        session.acknowledgedEdit === null ||
        session.nextClientSequence > session.acknowledgedEdit.clientSequence,
    ),
]);
export type ManualState = z.infer<typeof ManualStateSchema>;
export const ManualReplySchema = z.strictObject({
  status: z.enum([
    'ok',
    'started',
    'busy',
    'conflict',
    'invalid',
    'unavailable',
  ]),
  snapshot: ManualStateSchema,
});
export type ManualReply = z.infer<typeof ManualReplySchema>;
export interface ManualArticleApi extends ContinuousManualArticleApi {
  startManualPaste(
    command: PasteCommand,
    input: WebPasteInput,
  ): Promise<ManualReply>;
  retryManualPasteImage(
    command: PasteCommand,
    candidateId: string,
  ): Promise<ManualReply>;
  beginManualArticle(): Promise<ManualReply>;
  getManualArticleState(): Promise<ManualState>;
  updateManualDraft(
    sessionId: string,
    expectedRevision: number,
    draft: ManualDraft,
  ): Promise<ManualReply>;
  pickManualImage(
    sessionId: string,
    expectedRevision: number,
  ): Promise<ManualReply>;
  getManualImage(sessionId: string, imageToken: string): Promise<ImageResult>;
  saveManualArticle(
    sessionId: string,
    expectedRevision: number,
  ): Promise<ManualReply>;
  cancelManualOperation(sessionId: string, jobId: string): Promise<ManualReply>;
  discardManualArticle(
    sessionId: string,
    expectedRevision: number,
  ): Promise<ManualReply>;
}
export const manualChannels = {
  openManualArticle: 'manual:open',
  applyManualEdit: 'manual:edit',
  spliceManualPaste: 'manual:splice-paste',
  insertManualImage: 'manual:insert-image',
  commitManualDocument: 'manual:commit',
  closeManualEditor: 'manual:close-editor',
  copyManualSelection: 'manual:copy-selection',
  getManualSaveResult: 'manual:save-result',
  respondManualClose: 'manual:respond-close',
  startManualPaste: 'manual:paste',
  retryManualPasteImage: 'manual:retry-image',
  beginManualArticle: 'manual:begin',
  getManualArticleState: 'manual:state',
  updateManualDraft: 'manual:update',
  pickManualImage: 'manual:pick-image',
  getManualImage: 'manual:image',
  saveManualArticle: 'manual:save',
  cancelManualOperation: 'manual:cancel',
  discardManualArticle: 'manual:discard',
} as const;
export const manualRequests = {
  openManualArticle: z.tuple([StorageIdSchema]),
  applyManualEdit: z.tuple([DocumentCommandSchema, ManualDraftSchema]),
  spliceManualPaste: z.tuple([
    DocumentCommandSchema,
    DraftRangeSchema,
    z.union([WebPasteInputSchema, InternalPasteInputSchema]),
  ]),
  insertManualImage: z.tuple([DocumentCommandSchema, DraftRangeSchema]),
  commitManualDocument: z.tuple([SaveCommandSchema]),
  closeManualEditor: z.tuple([DocumentCommandSchema, ManualCloseChoiceSchema]),
  copyManualSelection: z.tuple([
    DocumentCommandSchema,
    DraftRangeSchema,
    z.boolean(),
  ]),
  getManualSaveResult: z.tuple([StorageIdSchema, StorageIdSchema]),
  respondManualClose: z.tuple([
    StorageIdSchema,
    StorageIdSchema,
    RevisionSchema,
    ManualCloseResponseStatusSchema,
  ]),
  startManualPaste: z.tuple([PasteCommandSchema, WebPasteInputSchema]),
  retryManualPasteImage: z.tuple([PasteCommandSchema, StorageIdSchema]),
  beginManualArticle: z.tuple([]),
  getManualArticleState: z.tuple([]),
  updateManualDraft: z.tuple([
    StorageIdSchema,
    RevisionSchema,
    ManualDraftSchema,
  ]),
  pickManualImage: z.tuple([StorageIdSchema, RevisionSchema]),
  getManualImage: z.tuple([StorageIdSchema, StorageIdSchema]),
  saveManualArticle: z.tuple([StorageIdSchema, RevisionSchema]),
  cancelManualOperation: z.tuple([StorageIdSchema, StorageIdSchema]),
  discardManualArticle: z.tuple([StorageIdSchema, RevisionSchema]),
};
export const manualResponses = {
  openManualArticle: ManualReplySchema,
  applyManualEdit: ManualReplySchema,
  spliceManualPaste: ManualReplySchema,
  insertManualImage: ManualReplySchema,
  commitManualDocument: ManualReplySchema,
  closeManualEditor: ManualReplySchema,
  copyManualSelection: ManualReplySchema,
  getManualSaveResult: SaveLookupSchema,
  respondManualClose: ManualReplySchema,
  startManualPaste: ManualReplySchema,
  retryManualPasteImage: ManualReplySchema,
  beginManualArticle: ManualReplySchema,
  getManualArticleState: ManualStateSchema,
  updateManualDraft: ManualReplySchema,
  pickManualImage: ManualReplySchema,
  getManualImage: ImageResultSchema,
  saveManualArticle: ManualReplySchema,
  cancelManualOperation: ManualReplySchema,
  discardManualArticle: ManualReplySchema,
};
