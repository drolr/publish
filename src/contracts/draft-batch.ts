import { z } from 'zod';
import { StorageIdSchema, StoredArticleSchema } from './stored-article';
import {
  ReasonCodeSchema,
  ReserveInputSchema,
  SubmissionSchema,
} from './draft-task';
import { CoverSummarySchema, CoverReportViewSchema } from './cover-task';

export const BatchStateSchema = z.enum([
  'prepared',
  'running',
  'paused',
  'stopped',
  'completed',
  'interrupted',
]);
export const BatchItemStateSchema = z.enum([
  'queued',
  'running',
  'draft_saved',
  'submission_recorded',
  'failed',
  'needs_human',
  'stopped',
  'skipped',
]);
export type BatchItemState = z.infer<typeof BatchItemStateSchema>;
export const BatchPrepareInputSchema = z
  .strictObject({
    articleKeys: z
      .array(StorageIdSchema)
      .min(1)
      .refine((keys) => new Set(keys).size === keys.length),
    bindingToken: StorageIdSchema,
    newAttemptArticleKeys: z.array(StorageIdSchema).optional(),
  })
  .refine((input) => {
    const keys = input.newAttemptArticleKeys ?? [];
    return (
      new Set(keys).size === keys.length &&
      keys.every((key) => input.articleKeys.includes(key))
    );
  });
export const BatchStartInputSchema = z.strictObject({
  preparationId: StorageIdSchema,
  requestId: StorageIdSchema,
});
export const BatchIdentityInputSchema = z.strictObject({
  batchId: StorageIdSchema,
});
export const BatchItemViewSchema = z.strictObject({
  submission: SubmissionSchema.optional(),
  articleKey: StorageIdSchema,
  title: StoredArticleSchema.shape.title,
  contentDeclaration: z.enum(['original', 'repost']),
  coverSummary: CoverSummarySchema.nullable(),
  coverReport: CoverReportViewSchema.optional(),
  state: BatchItemStateSchema,
  reason: ReasonCodeSchema.nullable(),
  taskId: StorageIdSchema.nullable(),
});
export const BatchPreparationViewSchema = z.strictObject({
  preparationId: StorageIdSchema,
  storeName: z.string().min(1).max(200),
  items: z.array(BatchItemViewSchema).min(1),
});
export const BatchCountsSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  saved: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  needsHuman: z.number().int().nonnegative(),
  stopped: z.number().int().nonnegative(),
});
export const BatchViewSchema = z.strictObject({
  id: StorageIdSchema,
  revision: z.number().int().nonnegative(),
  state: BatchStateSchema,
  storeName: z.string().min(1).max(200),
  stopRequested: z.boolean(),
  reason: ReasonCodeSchema.nullable(),
  counts: BatchCountsSchema,
  items: z.array(BatchItemViewSchema).min(1),
});
export const BatchCommandResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), view: BatchViewSchema.nullable() }),
  z.strictObject({
    status: z.literal('blocked'),
    reason: ReasonCodeSchema,
    view: BatchViewSchema.nullable(),
  }),
]);
export const BatchPrepareResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    preparation: BatchPreparationViewSchema,
  }),
  z.strictObject({ status: z.literal('blocked'), reason: ReasonCodeSchema }),
]);
// Internal persistence input; never accepted from the renderer.
export const BatchSeedItemSchema = z
  .strictObject({
    view: BatchItemViewSchema,
    reservation: ReserveInputSchema.nullable(),
  })
  .refine((item) =>
    item.view.state === 'queued'
      ? item.reservation !== null &&
        item.reservation.snapshot.article.articleKey === item.view.articleKey
      : item.reservation === null &&
        ['failed', 'skipped'].includes(item.view.state),
  );
export const BatchSeedSchema = z
  .strictObject({
    id: StorageIdSchema,
    requestId: StorageIdSchema,
    preparationId: StorageIdSchema,
    storeKey: z.string().regex(/^[a-f0-9]{64}$/),
    storeName: z.string().min(1).max(200),
    items: z.array(BatchSeedItemSchema).min(1),
    now: z.iso.datetime(),
  })
  .superRefine((seed, ctx) => {
    if (
      new Set(seed.items.map((i) => i.view.articleKey)).size !==
        seed.items.length ||
      !seed.items.some((i) => i.view.state === 'queued') ||
      seed.items.some(
        (i) => i.reservation && i.reservation.store.storeKey !== seed.storeKey,
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent batch selection' });
    }
  });
export type BatchSeed = z.infer<typeof BatchSeedSchema>;
export type BatchItemView = z.infer<typeof BatchItemViewSchema>;
export type BatchView = z.infer<typeof BatchViewSchema>;
export type BatchPreparationView = z.infer<typeof BatchPreparationViewSchema>;
export type BatchCommandResult = z.infer<typeof BatchCommandResultSchema>;
export type BatchPrepareResult = z.infer<typeof BatchPrepareResultSchema>;
export interface BatchApi {
  prepare(
    input: z.infer<typeof BatchPrepareInputSchema>,
  ): Promise<BatchPrepareResult>;
  start(
    input: z.infer<typeof BatchStartInputSchema>,
  ): Promise<BatchCommandResult>;
  stop(
    input: z.infer<typeof BatchIdentityInputSchema>,
  ): Promise<BatchCommandResult>;
  finish(
    input: z.infer<typeof BatchIdentityInputSchema>,
  ): Promise<BatchCommandResult>;
  archiveFinishedBatch(
    input: z.infer<typeof BatchIdentityInputSchema>,
  ): Promise<BatchCommandResult>;
  getCurrent(): Promise<BatchView | null>;
}

export const batchChannels = {
  prepare: 'batch:prepare',
  start: 'batch:start',
  stop: 'batch:stop',
  finish: 'batch:finish',
  archiveFinishedBatch: 'batch:archive-finished',
  getCurrent: 'batch:state',
} as const;
export const batchRequests = {
  prepare: z.tuple([BatchPrepareInputSchema]),
  start: z.tuple([BatchStartInputSchema]),
  stop: z.tuple([BatchIdentityInputSchema]),
  finish: z.tuple([BatchIdentityInputSchema]),
  archiveFinishedBatch: z.tuple([BatchIdentityInputSchema]),
  getCurrent: z.tuple([]),
};
export const batchResponses = {
  prepare: BatchPrepareResultSchema,
  start: BatchCommandResultSchema,
  stop: BatchCommandResultSchema,
  finish: BatchCommandResultSchema,
  archiveFinishedBatch: BatchCommandResultSchema,
  getCurrent: BatchViewSchema.nullable(),
};
