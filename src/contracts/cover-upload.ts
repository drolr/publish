import { z } from 'zod';
import { COVER_IMAGE_MAX_BYTES, CoverMimeSchema } from './article-cover';
import { DigestSchema } from './article-revision';
import { StorageIdSchema } from './stored-article';

/** Internal capability input only. No IPC channel, renderer DTO, path or platform
 * DOM detail. Trusted asset reading/decoding precedes this boundary; actual byte
 * digest verification remains infrastructure-local. none never uploads. */
export const CoverUploadInputSchema = z
  .strictObject({
    mode: z.enum(['single', 'triple']),
    files: z
      .array(
        z.strictObject({
          position: z.number().int().min(0).max(2),
          assetKey: StorageIdSchema,
          sha256: DigestSchema,
          mime: CoverMimeSchema,
          bytes: z
            .instanceof(Uint8Array)
            .refine(
              (b) => b.byteLength > 0 && b.byteLength <= COVER_IMAGE_MAX_BYTES,
            ),
        }),
      )
      .min(1)
      .max(3),
  })
  .refine(
    (i) =>
      i.files.length === (i.mode === 'single' ? 1 : 3) &&
      i.files.every((f, n) => f.position === n) &&
      new Set(i.files.map((f) => f.assetKey)).size === i.files.length,
  );
export type CoverUploadInput = z.output<typeof CoverUploadInputSchema>;
export type CoverUploadFile = CoverUploadInput['files'][number];
