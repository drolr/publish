import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import {
  COVER_IMAGE_MAX_BYTES,
  CoverImageFailureSchema,
} from '../../contracts/article-cover';
import { CoverPickFailure } from '../../domain/cover-pick-error';
import { ImportFailure } from '../../domain/import-error';
import type {
  CoverFilePicker,
  PickedCoverImage,
} from '../../domain/ports/article-cover';
import {
  assertLocalPath,
  authorizeLocalRoot,
  readLocalImage,
} from '../../infrastructure/assets/local-reader';
import { validateImage } from '../../infrastructure/assets/image-validator';
/** Only the native dialog chooses paths; no path parameter crosses the IPC bridge. */
export function createCoverFilePicker(
  choose: (
    count: number,
    signal: AbortSignal,
  ) => Promise<readonly string[] | undefined>,
): CoverFilePicker {
  return {
    async pick(count, signal) {
      if (!Number.isInteger(count) || count < 1 || count > 3)
        throw Error('Selection rejected');
      signal.throwIfAborted();
      const paths = await choose(count, signal);
      signal.throwIfAborted();
      if (!paths) return undefined;
      if (paths.length !== count) throw Error('Selection count rejected');
      const images: PickedCoverImage[] = [];
      for (const [selectionIndex, path] of paths.entries()) {
        try {
          signal.throwIfAborted();
          assertLocalPath(path);
          const root = await authorizeLocalRoot(dirname(path));
          const bytes = await readLocalImage(root, basename(path), signal);
          if (bytes.byteLength > COVER_IMAGE_MAX_BYTES)
            throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
          const metadata = await validateImage(bytes, signal);
          if (metadata.mime !== 'image/jpeg' && metadata.mime !== 'image/png')
            throw new ImportFailure('IMAGE_UNSUPPORTED');
          images.push({
            bytes,
            mime: metadata.mime,
            width: metadata.width,
            height: metadata.height,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
        } catch (error) {
          signal.throwIfAborted();
          const reason =
            error instanceof ImportFailure
              ? CoverImageFailureSchema.shape.reason.safeParse(error.code)
              : null;
          if (reason?.success)
            throw new CoverPickFailure(selectionIndex, reason.data);
          throw error;
        }
      }
      signal.throwIfAborted();
      return images;
    },
  };
}
