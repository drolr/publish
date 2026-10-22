import { z } from 'zod';
import { StorageIdSchema, StoredArticleSchema } from './stored-article';
import {
  CoverPlanSchema,
  CoverTaskSnapshotSchema,
  CoverReportSchema,
  CoverSummarySchema,
  CoverReportViewSchema,
} from './cover-task';

export const AttemptIntentSchema = z.enum(['default', 'new_attempt']);
export type AttemptIntent = z.infer<typeof AttemptIntentSchema>;

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const LabelSchema = z.string().min(1).max(200);
const PrivateTextSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) =>
    [...value].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
// The adapter additionally validates the observed platform origin, route and record identity.
const EditUrlSchema = PrivateTextSchema.refine((value) => {
  try {
    const url = new URL(value);
    let credentialQuery = false;
    url.searchParams.forEach((_value, key) => {
      if (
        /password|cookie|token|auth|session|secret|signature|credential/i.test(
          key,
        )
      )
        credentialQuery = true;
    });
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !credentialQuery
    );
  } catch {
    return false;
  }
});
export const TaskStateSchema = z.enum([
  'queued',
  'running',
  'draft_saved',
  'submission_recorded',
  'failed',
  'needs_human',
  'stopped',
  'interrupted',
  'closed_without_save',
  'closed_after_review',
  'stopped_by_user',
]);
export const TaskStageSchema = z.enum([
  'reserved',
  'editor',
  'body',
  'cover',
  'save',
  'verify',
  'settled',
]);
export const ReasonCodeSchema = z.enum([
  'INPUT_UNSUPPORTED',
  'TITLE_UNSUPPORTED',
  'IMAGE_FORMAT_UNSUPPORTED',
  'IMAGE_SIZE_UNSUPPORTED',
  'ASSET_UNAVAILABLE',
  'STALE_PREPARATION',
  'LOGIN_REQUIRED',
  'VERIFICATION_REQUIRED',
  'PERMISSION_DENIED',
  'STORE_UNCONFIRMED',
  'STORE_CHANGED',
  'PAGE_CHANGED',
  'EDITOR_NOT_EMPTY',
  'COVER_UNAVAILABLE',
  'COVER_REQUIRED',
  'DECLARATION_REQUIRED',
  'RESULT_AMBIGUOUS',
  'MANUAL_REVIEW_REQUIRED',
  'CONTENT_MISMATCH',
  'BROWSER_UNAVAILABLE',
  'BROWSER_UNSUPPORTED',
  'STORAGE_UNAVAILABLE',
  'STOP_REQUESTED',
  'INTERRUPTED',
  'PLATFORM_BUSY',
  'NEW_ATTEMPT_REQUIRED',
]);
export const StoreBindingSchema = z.strictObject({
  storeKey: DigestSchema,
  displayName: LabelSchema,
  identity: z.strictObject({
    source: z.literal('visible-shop-link'),
    value: PrivateTextSchema,
  }),
});
export const DraftSnapshotSchema = z.strictObject({
  version: z.literal(1),
  article: StoredArticleSchema,
  digest: DigestSchema,
});
export const RemoteRefSchema = z.strictObject({
  recordKey: PrivateTextSchema,
  editUrl: EditUrlSchema,
});
export const ImageEvidenceSchema = z.strictObject({
  bodyIndex: z.number().int().min(0).max(999),
  imageId: z.string().min(1).max(128),
  assetKey: StorageIdSchema,
  resourceKey: DigestSchema,
});
export const CoverEvidenceSchema = z.strictObject({
  resourceKey: DigestSchema,
  source: z.literal('store-material-first'),
});
export const SubmissionSchema = z.strictObject({
  observation: z.enum(['acknowledged', 'rejected', 'unknown']),
  attemptedAt: z.iso.datetime(),
});
export type Submission = z.infer<typeof SubmissionSchema>;
export const DraftEvidenceSchema = z
  .strictObject({
    remote: RemoteRefSchema.nullable(),
    submission: SubmissionSchema.optional(),
    images: z.array(ImageEvidenceSchema).max(1000),
    cover: CoverEvidenceSchema.nullable(),
  })
  .refine(
    (value) =>
      new Set(value.images.map((image) => image.bodyIndex)).size ===
      value.images.length,
  );
export const DraftTaskSchema = z
  .strictObject({
    taskId: StorageIdSchema,
    preparationId: StorageIdSchema,
    // Historical attempts have no recoverable content revision.
    articleRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    articleKey: StorageIdSchema,
    platform: z.literal('judongche'),
    mode: z.literal('draft'),
    store: StoreBindingSchema,
    snapshot: DraftSnapshotSchema,
    coverPolicy: z.enum(['store-material-first', 'manual-after-draft']),
    coverPlan: CoverPlanSchema.optional(),
    state: TaskStateSchema,
    stage: TaskStageSchema,
    revision: z.number().int().nonnegative(),
    possibleRemoteEffect: z.boolean(),
    saveAttempted: z.boolean(),
    stopRequested: z.boolean(),
    holdsPlatform: z.boolean(),
    evidence: DraftEvidenceSchema,
    reason: ReasonCodeSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((task, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: 'custom', message: 'Invalid task invariant' });
    if (task.articleKey !== task.snapshot.article.articleKey) invalid();
    if (
      task.coverPlan &&
      task.coverPlan.snapshot.articleKey !== task.articleKey
    )
      invalid();
    if (
      task.state === 'queued' &&
      (task.stage !== 'reserved' ||
        task.possibleRemoteEffect ||
        task.saveAttempted)
    )
      invalid();
    if (
      !task.possibleRemoteEffect &&
      (task.evidence.remote ||
        task.evidence.cover ||
        (task.evidence.images.length > 0 && !task.possibleRemoteEffect))
    )
      invalid();
    if (task.saveAttempted && !task.possibleRemoteEffect) invalid();
    if (
      task.state === 'submission_recorded' &&
      (!task.saveAttempted ||
        !task.possibleRemoteEffect ||
        task.holdsPlatform ||
        task.stopRequested ||
        task.stage !== 'settled' ||
        !task.evidence.submission ||
        task.evidence.remote ||
        Date.parse(task.evidence.submission.attemptedAt) >
          Date.parse(task.updatedAt))
    )
      invalid();
    if (task.coverPlan) {
      const report = task.coverPlan.report;
      const initial =
        task.coverPlan.snapshot.mode === 'none' ? 'not_configured' : 'pending';
      if (Date.parse(report.updatedAt) > Date.parse(task.updatedAt)) invalid();
      if (
        !task.possibleRemoteEffect &&
        (report.phase !== initial || report.confirmedItems.length > 0)
      )
        invalid();
      if (
        report.phase === 'confirmed' &&
        (!task.saveAttempted || !['verify', 'settled'].includes(task.stage))
      )
        invalid();
    }
    if (
      ['queued', 'running', 'needs_human', 'interrupted'].includes(
        task.state,
      ) &&
      !task.holdsPlatform
    )
      invalid();
    if (
      task.state === 'draft_saved' &&
      (task.holdsPlatform ||
        !task.possibleRemoteEffect ||
        task.stage !== 'settled' ||
        task.reason !== null ||
        !task.evidence.remote ||
        (!task.coverPlan &&
          task.coverPolicy === 'store-material-first' &&
          !task.evidence.cover) ||
        task.evidence.images.length !==
          task.snapshot.article.body.filter((block) => block.type === 'image')
            .length)
    )
      invalid();
    if (
      ['failed', 'stopped'].includes(task.state) &&
      (task.holdsPlatform || task.possibleRemoteEffect)
    )
      invalid();
    if (
      task.state === 'closed_without_save' &&
      (task.holdsPlatform ||
        task.saveAttempted ||
        task.stage !== 'settled' ||
        task.evidence.remote ||
        task.evidence.cover ||
        (task.evidence.images.length > 0 && !task.possibleRemoteEffect))
    )
      invalid();
    if (
      task.state === 'closed_after_review' &&
      (task.holdsPlatform ||
        !task.saveAttempted ||
        !task.possibleRemoteEffect ||
        task.stage !== 'settled' ||
        task.evidence.remote ||
        task.reason === null)
    )
      invalid();
    if (
      task.state === 'stopped_by_user' &&
      (task.holdsPlatform || !task.stopRequested || task.stage !== 'settled')
    )
      invalid();
    for (const image of task.evidence.images) {
      const block = task.snapshot.article.body[image.bodyIndex];
      if (
        block?.type !== 'image' ||
        block.image_id !== image.imageId ||
        !task.snapshot.article.assets.some(
          (asset) =>
            asset.assetKey === image.assetKey &&
            asset.imageId === image.imageId,
        )
      )
        invalid();
    }
  });
export const DraftAbsenceProofSchema = z.strictObject({
  taskId: StorageIdSchema,
  revision: z.number().int().nonnegative(),
  snapshotDigest: DigestSchema,
  storeKey: DigestSchema,
  generation: z.string().min(1).max(200),
  checkedAt: z.iso.datetime(),
});
export type DraftAbsenceProof = z.infer<typeof DraftAbsenceProofSchema>;
// An owner-reviewed pre-entry closure is not a claim of remote title absence.
export const TaskClosureProofSchema = DraftAbsenceProofSchema.extend({
  basis: z
    .enum([
      'owner-reviewed-before-entry',
      'owner-reviewed-empty-editor',
      'owner-reviewed-unsaved-body',
      'owner-reviewed-ambiguous-save',
    ])
    .optional(),
});
export type TaskClosureProof = z.infer<typeof TaskClosureProofSchema>;
export const DraftAbsenceResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('absent'),
    proof: DraftAbsenceProofSchema,
  }),
  z.strictObject({ status: z.literal('blocked'), reason: ReasonCodeSchema }),
]);
export type DraftAbsenceResult = z.infer<typeof DraftAbsenceResultSchema>;
export const TaskClosureViewSchema = z.strictObject({
  basis: z
    .enum([
      'owner-reviewed-before-entry',
      'owner-reviewed-empty-editor',
      'owner-reviewed-unsaved-body',
      'owner-reviewed-ambiguous-save',
    ])
    .optional(),
  token: StorageIdSchema,
  taskId: StorageIdSchema,
  revision: z.number().int().nonnegative(),
  title: StoredArticleSchema.shape.title,
  storeName: LabelSchema,
  expiresAt: z.iso.datetime(),
});
export type TaskClosureView = z.infer<typeof TaskClosureViewSchema>;
export const TaskEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('record-submission'),
    submission: SubmissionSchema,
  }),
  z.strictObject({ type: z.literal('release-after-stop') }),
  z.strictObject({
    type: z.literal('close-after-review'),
    proof: TaskClosureProofSchema.extend({
      basis: z.literal('owner-reviewed-ambiguous-save'),
    }),
    confirmedAt: z.iso.datetime(),
  }),
  z.strictObject({
    type: z.literal('cover_report'),
    report: CoverReportSchema,
  }),
  z.strictObject({
    type: z.literal('close-without-save'),
    proof: TaskClosureProofSchema,
    confirmedAt: z.iso.datetime(),
  }),
  z.strictObject({ type: z.literal('begin') }),
  z.strictObject({
    type: z.literal('before-effect'),
    stage: z.enum(['editor', 'body', 'cover']),
  }),
  z.strictObject({ type: z.literal('before-save') }),
  z.strictObject({
    type: z.literal('evidence'),
    evidence: DraftEvidenceSchema,
  }),
  z.strictObject({ type: z.literal('verify') }),
  z.strictObject({ type: z.literal('stop') }),
  z.strictObject({
    type: z.literal('settle'),
    state: z.enum(['draft_saved', 'failed', 'needs_human', 'stopped']),
    reason: ReasonCodeSchema.nullable(),
  }),
  z.strictObject({ type: z.literal('recover') }),
]);
export const SessionViewSchema = z.strictObject({
  status: z.enum(['closed', 'opening', 'ready', 'blocked']),
  bindingToken: StorageIdSchema.nullable(),
  storeName: LabelSchema.nullable(),
  reason: ReasonCodeSchema.nullable(),
});
export const TaskViewSchema = z.strictObject({
  submission: SubmissionSchema.optional(),
  coverSummary: CoverSummarySchema.optional(),
  coverReport: CoverReportViewSchema.optional(),
  manualReview: z.boolean().optional(),
  preEntryReviewed: z.boolean().optional(),
  emptyEditorReviewed: z.boolean().optional(),
  unsavedBodyReviewed: z.boolean().optional(),
  ambiguousSaveReviewed: z.boolean().optional(),
  taskId: StorageIdSchema,
  articleKey: StorageIdSchema,
  title: StoredArticleSchema.shape.title,
  storeName: LabelSchema,
  state: TaskStateSchema,
  stage: TaskStageSchema,
  revision: z.number().int().nonnegative(),
  possibleRemoteEffect: z.boolean(),
  stopRequested: z.boolean(),
  platformPaused: z.boolean(),
  reason: ReasonCodeSchema.nullable(),
  canOpenDraft: z.boolean(),
  canCloseTask: z.boolean().optional(),
});
export const PreparationViewSchema = z
  .strictObject({
    coverSummary: CoverSummarySchema.optional(),
    manualReview: z.boolean().optional(),
    previouslySubmitted: z.boolean().optional(),
    preparationId: StorageIdSchema,
    articleKey: StorageIdSchema,
    title: StoredArticleSchema.shape.title,
    storeName: LabelSchema,
    bodyImageCount: z.number().int().min(0).max(1000),
    contentDeclaration: z.enum(['original', 'repost']),
    mode: z.literal('draft'),
    coverPolicy: z.enum(['manual-after-draft', 'local-upload-v1']),
  })
  .refine(
    (v) => v.coverPolicy !== 'local-upload-v1' || v.coverSummary !== undefined,
  );
export const PrepareResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    preparation: PreparationViewSchema,
  }),
  z.strictObject({ status: z.literal('existing'), task: TaskViewSchema }),
  z.strictObject({ status: z.literal('blocked'), reason: ReasonCodeSchema }),
]);
export const DraftViewSchema = z.strictObject({
  session: SessionViewSchema,
  preparation: PreparationViewSchema.nullable(),
  task: TaskViewSchema.nullable(),
});
export const DraftCommandResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    view: DraftViewSchema,
    closure: TaskClosureViewSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('blocked'),
    reason: ReasonCodeSchema,
    view: DraftViewSchema,
  }),
]);
export const ReserveInputSchema = z
  .strictObject({
    // Only historical controlled fixtures may omit BOTH cover fields. Production always supplies them.
    expectedCoverRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    coverSnapshot: CoverTaskSnapshotSchema.optional(),
    expectedArticleRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    taskId: StorageIdSchema,
    preparationId: StorageIdSchema,
    snapshot: DraftSnapshotSchema,
    store: StoreBindingSchema,
    now: z.iso.datetime(),
  })
  .refine(
    (v) =>
      (v.expectedCoverRevision === undefined) ===
        (v.coverSnapshot === undefined) &&
      (!v.coverSnapshot ||
        (v.coverSnapshot.articleKey === v.snapshot.article.articleKey &&
          v.expectedCoverRevision === v.coverSnapshot.coverRevision)),
  );
export const ReserveResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['created', 'existing', 'blocked']),
    task: DraftTaskSchema,
  }),
  z.strictObject({ status: z.literal('stale') }),
]);
export const SessionProbeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    store: StoreBindingSchema,
    generation: StorageIdSchema,
  }),
  z.strictObject({ status: z.literal('blocked'), reason: ReasonCodeSchema }),
]);
export const AdapterOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('submission_recorded'),
    submission: SubmissionSchema,
    evidence: DraftEvidenceSchema,
    coverReport: CoverReportSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('verified'),
    evidence: DraftEvidenceSchema,
    coverReport: CoverReportSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('blocked'),
    reason: ReasonCodeSchema,
    coverReport: CoverReportSchema.optional(),
  }),
]);
export type TaskState = z.infer<typeof TaskStateSchema>;
export type TaskStage = z.infer<typeof TaskStageSchema>;
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;
export type StoreBinding = z.infer<typeof StoreBindingSchema>;
export type DraftSnapshot = z.infer<typeof DraftSnapshotSchema>;
export type RemoteRef = z.infer<typeof RemoteRefSchema>;
export type ImageEvidence = z.infer<typeof ImageEvidenceSchema>;
export type CoverEvidence = z.infer<typeof CoverEvidenceSchema>;
export type DraftEvidence = z.infer<typeof DraftEvidenceSchema>;
export type DraftTask = z.infer<typeof DraftTaskSchema>;
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export type SessionView = z.infer<typeof SessionViewSchema>;
export type TaskView = z.infer<typeof TaskViewSchema>;
export type PreparationView = z.infer<typeof PreparationViewSchema>;
export type PrepareResult = z.infer<typeof PrepareResultSchema>;
export type DraftView = z.infer<typeof DraftViewSchema>;
export type DraftCommandResult = z.infer<typeof DraftCommandResultSchema>;
export type ReserveInput = z.infer<typeof ReserveInputSchema>;
export type ReserveResult = z.infer<typeof ReserveResultSchema>;
export type SessionProbe = z.infer<typeof SessionProbeSchema>;
export type AdapterOutcome = z.infer<typeof AdapterOutcomeSchema>;
export interface DraftApi {
  prepareTaskClosure(taskId: string): Promise<DraftCommandResult>;
  confirmTaskClosure(token: string): Promise<DraftCommandResult>;
  openDraftSession(): Promise<DraftCommandResult>;
  checkDraftSession(): Promise<DraftCommandResult>;
  closeDraftSession(): Promise<DraftCommandResult>;
  prepareDraft(
    articleKey: string,
    bindingToken: string,
    intent?: AttemptIntent,
  ): Promise<PrepareResult>;
  startDraft(preparationId: string): Promise<DraftCommandResult>;
  getDraftState(): Promise<DraftView>;
  stopDraft(taskId: string): Promise<DraftCommandResult>;
  reconcileDraft(taskId: string): Promise<DraftCommandResult>;
  openSavedDraft(taskId: string): Promise<DraftCommandResult>;
}
export const draftChannels = {
  prepareTaskClosure: 'draft:prepare-closure',
  confirmTaskClosure: 'draft:confirm-closure',
  openDraftSession: 'draft:open-session',
  checkDraftSession: 'draft:check-session',
  closeDraftSession: 'draft:close-session',
  prepareDraft: 'draft:prepare',
  startDraft: 'draft:start',
  getDraftState: 'draft:state',
  stopDraft: 'draft:stop',
  reconcileDraft: 'draft:reconcile',
  openSavedDraft: 'draft:open-saved',
} as const;
export const draftRequests = {
  prepareTaskClosure: z.tuple([StorageIdSchema]),
  confirmTaskClosure: z.tuple([StorageIdSchema]),
  openDraftSession: z.tuple([]),
  checkDraftSession: z.tuple([]),
  closeDraftSession: z.tuple([]),
  prepareDraft: z.tuple([
    StorageIdSchema,
    StorageIdSchema,
    AttemptIntentSchema.optional(),
  ]),
  startDraft: z.tuple([StorageIdSchema]),
  getDraftState: z.tuple([]),
  stopDraft: z.tuple([StorageIdSchema]),
  reconcileDraft: z.tuple([StorageIdSchema]),
  openSavedDraft: z.tuple([StorageIdSchema]),
};
export const draftResponses = {
  prepareTaskClosure: DraftCommandResultSchema,
  confirmTaskClosure: DraftCommandResultSchema,
  openDraftSession: DraftCommandResultSchema,
  checkDraftSession: DraftCommandResultSchema,
  closeDraftSession: DraftCommandResultSchema,
  prepareDraft: PrepareResultSchema,
  startDraft: DraftCommandResultSchema,
  getDraftState: DraftViewSchema,
  stopDraft: DraftCommandResultSchema,
  reconcileDraft: DraftCommandResultSchema,
  openSavedDraft: DraftCommandResultSchema,
};
