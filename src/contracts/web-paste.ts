import { z } from 'zod';
import { StorageIdSchema } from './stored-article';

export const webPasteLimits = Object.freeze({
  inputBytes: 2 * 1024 * 1024,
  snapshotBytes: 2 * 1024 * 1024,
  nodes: 50000,
  depth: 100,
  parseMs: 5000,
  blocks: 1000,
  paragraphCodePoints: 20000,
  totalCodePoints: 200000,
  titleCodePoints: 512,
  images: 200,
  imageBytes: 20 * 1024 * 1024,
  totalImageBytes: 200 * 1024 * 1024,
  imageSide: 10000,
  imagePixels: 25000000,
  imageFetchMs: 30000,
  imageDecodeMs: 30000,
  operationMs: 600000,
});
export const RevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length;) {
    index += value.codePointAt(index)! > 0xffff ? 2 : 1;
    count++;
  }
  return count;
}
export function textWithin(limit: number) {
  return z
    .string()
    .max(limit * 2)
    .refine(
      (value) => value.length <= limit * 2 && codePointLength(value) <= limit,
    );
}
export const DraftSnapshotBudgetSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    try {
      const json = JSON.stringify(value);
      if (
        json === undefined ||
        json.length > webPasteLimits.snapshotBytes ||
        new TextEncoder().encode(json).byteLength > webPasteLimits.snapshotBytes
      )
        ctx.addIssue({
          code: 'custom',
          message: '文章内容超出当前支持范围，请减少后重试。',
        });
    } catch {
      ctx.addIssue({ code: 'custom', message: '文章内容格式无法识别。' });
    }
  });
export const WebPasteInputSchema = z
  .strictObject({
    html: z.string().max(webPasteLimits.inputBytes),
    plain: z.string().max(webPasteLimits.inputBytes),
  })
  .refine(
    (input) =>
      input.html.length + input.plain.length <= webPasteLimits.inputBytes &&
      new TextEncoder().encode(input.html).byteLength +
        new TextEncoder().encode(input.plain).byteLength <=
        webPasteLimits.inputBytes,
  );
export type WebPasteInput = z.infer<typeof WebPasteInputSchema>;
export const PasteCommandSchema = z.strictObject({
  sessionId: StorageIdSchema,
  expectedRevision: RevisionSchema,
  commandId: StorageIdSchema,
});
export type PasteCommand = z.infer<typeof PasteCommandSchema>;
export const PendingBlockSchema = z.strictObject({
  blockKey: StorageIdSchema,
  type: z.literal('image-pending'),
  candidateId: StorageIdSchema,
});
export type PendingBlock = z.infer<typeof PendingBlockSchema>;
export const PasteErrorCodeSchema = z.enum([
  'EMPTY',
  'INPUT_LIMIT',
  'PARSE_LIMIT',
  'PARSE_TIMEOUT',
  'UNSUPPORTED_STRUCTURE',
  'INVALID_FRAGMENT',
  'SOURCE_UNSUPPORTED',
  'IMAGE_NETWORK',
  'IMAGE_TIMEOUT',
  'IMAGE_INVALID',
  'IMAGE_UNSUPPORTED',
  'IMAGE_LIMIT',
  'OPERATION_TIMEOUT',
  'CANCELLED',
  'RECOVERY_REQUIRED',
]);
export type PasteErrorCode = z.infer<typeof PasteErrorCodeSchema>;
export const CandidateViewSchema = z.strictObject({
  candidateId: StorageIdSchema,
  blockKey: StorageIdSchema,
  state: z.enum(['waiting', 'fetching', 'failed', 'cancelled']),
  reason: PasteErrorCodeSchema.optional(),
  retryable: z.boolean(),
});
export type CandidateView = z.infer<typeof CandidateViewSchema>;
const imageCount = z.number().int().nonnegative().max(webPasteLimits.images);
export const PasteProgressSchema = z
  .strictObject({
    jobId: StorageIdSchema,
    kind: z.enum(['paste', 'retry']),
    phase: z.enum(['parsing', 'images']),
    admitted: z.boolean(),
    current: imageCount,
    total: imageCount,
  })
  .refine((progress) => progress.current <= progress.total);
export type PasteProgress = z.infer<typeof PasteProgressSchema>;
export const RichPasteWarningSchema = z.enum([
  'HEADING_NORMALIZED',
  'STYLE_NORMALIZED',
  'PLAIN_ONLY',
]);
export type RichPasteWarning = z.output<typeof RichPasteWarningSchema>;
export const PasteSummarySchema = z
  .strictObject({
    jobId: StorageIdSchema,
    kind: z.enum(['paste', 'retry']),
    outcome: z.enum(['rejected', 'completed', 'partial', 'cancelled']),
    admitted: z.boolean(),
    paragraphs: z.number().int().nonnegative().max(webPasteLimits.blocks),
    imagePositions: imageCount,
    unresolved: imageCount,
    plainOnly: z.boolean(),
    reason: PasteErrorCodeSchema.optional(),
    warnings: z.array(RichPasteWarningSchema).max(3),
  })
  .refine(
    (summary) =>
      summary.unresolved <= summary.imagePositions &&
      summary.paragraphs + summary.imagePositions <= webPasteLimits.blocks,
  );
export type PasteSummary = z.infer<typeof PasteSummarySchema>;
const ConvertedBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('paragraph'),
    text: textWithin(webPasteLimits.paragraphCodePoints),
  }),
  z
    .strictObject({
      type: z.literal('image'),
      source: z.string().max(webPasteLimits.inputBytes).optional(),
    })
    .transform((block) => ({ type: block.type, source: block.source })),
]);
export type ConvertedBlock = z.infer<typeof ConvertedBlockSchema>;
// Trusted worker/controller boundary only; source addresses never enter bridge responses.
export const ConvertedPasteSchema = DraftSnapshotBudgetSchema.pipe(
  z
    .strictObject({
      blocks: z.array(ConvertedBlockSchema).max(webPasteLimits.blocks),
      plainOnly: z.boolean(),
    })
    .superRefine((paste, ctx) => {
      if (
        paste.blocks.filter((block) => block.type === 'image').length >
          webPasteLimits.images ||
        paste.blocks.reduce(
          (sum, block) =>
            sum +
            (block.type === 'paragraph' ? codePointLength(block.text) : 0),
          0,
        ) > webPasteLimits.totalCodePoints
      )
        ctx.addIssue({
          code: 'custom',
          message: '本次内容超出支持范围，请减少内容后再粘贴。',
        });
    }),
);
export type ConvertedPaste = z.infer<typeof ConvertedPasteSchema>;
