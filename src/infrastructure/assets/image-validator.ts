import sharp from 'sharp';
import { ImportFailure } from '../../domain/import-error';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export interface ImageMetadata {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
}

// APNG can otherwise be presented as a single static PNG by a decoder.
function checkPng(bytes: Uint8Array): void {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length < 8 ||
    !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return;
  let offset = 8;
  let ended = false;
  while (offset + 12 <= b.length) {
    const size = b.readUInt32BE(offset);
    if (size > b.length - offset - 12) throw new ImportFailure('IMAGE_INVALID');
    const type = b.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') throw new ImportFailure('IMAGE_UNSUPPORTED');
    offset += 12 + size;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== b.length) throw new ImportFailure('IMAGE_INVALID');
}

export async function validateImage(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<ImageMetadata> {
  signal.throwIfAborted();
  if (bytes.byteLength === 0) throw new ImportFailure('IMAGE_INVALID');
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
  checkPng(bytes);
  const decoder = sharp(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    {
      failOn: 'warning',
      limitInputPixels: 25_000_000,
      limitInputChannels: 4,
      unlimited: false,
    },
  ).timeout({ seconds: 30 });
  // Buffer operations report through their promises; destroy without emitting an
  // unhandled stream error. Native work is additionally bounded by sharp's timeout.
  const abort = () => decoder.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const metadata = await decoder.metadata();
    signal.throwIfAborted();
    if (
      !['jpeg', 'png', 'webp'].includes(metadata.format ?? '') ||
      (metadata.pages ?? 1) !== 1 ||
      // An animation container may have only one frame, but still carries
      // loop/delay metadata. It must not pass as a static image.
      metadata.loop !== undefined ||
      metadata.delay !== undefined
    )
      throw new ImportFailure('IMAGE_UNSUPPORTED');
    const { width, height } = metadata;
    if (!width || !height) throw new ImportFailure('IMAGE_INVALID');
    if (
      width > 10000 ||
      height > 10000 ||
      width * height > 25_000_000 ||
      (metadata.channels ?? 5) > 4
    )
      throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
    await decoder.raw().toBuffer();
    signal.throwIfAborted();
    const format = metadata.format as 'jpeg' | 'png' | 'webp';
    return {
      width,
      height,
      mime: `image/${format}`,
      extension: format === 'jpeg' ? 'jpg' : format,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportFailure) throw error;
    if (
      error instanceof Error &&
      /pixel limit|channel limit/i.test(error.message)
    )
      throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
    throw new ImportFailure('IMAGE_INVALID');
  } finally {
    signal.removeEventListener('abort', abort);
    decoder.destroy();
  }
}
