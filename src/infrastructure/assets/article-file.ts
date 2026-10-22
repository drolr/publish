import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { ImportFailure } from '../../domain/import-error';
import type { LocalRootCapability } from '../../domain/ports/article-import';
import {
  assertLocalPath,
  assertPhysicalPath,
  authorizeLocalRoot,
} from './local-reader';

const LIMIT = 2 * 1024 * 1024;
export async function readArticleFile(
  filename: string,
  signal: AbortSignal,
): Promise<{ input: unknown; capability: LocalRootCapability }> {
  try {
    signal.throwIfAborted();
    assertLocalPath(filename);
    const target = path.resolve(filename);
    const root = path.dirname(target);
    const capability = await authorizeLocalRoot(root);
    await assertPhysicalPath(root, target);
    const before = await lstat(target, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new ImportFailure('FILE_UNAVAILABLE');
    if (before.size > BigInt(LIMIT)) throw new ImportFailure('FILE_TOO_LARGE');
    const handle = await open(target, 'r');
    let bytes: Buffer;
    try {
      const same = (stat: typeof before) =>
        stat.isFile() &&
        stat.nlink === 1n &&
        stat.ino === before.ino &&
        stat.dev === before.dev &&
        stat.size === before.size &&
        stat.mtimeNs === before.mtimeNs &&
        stat.ctimeNs === before.ctimeNs;
      if (!same(await handle.stat({ bigint: true })))
        throw new ImportFailure('FILE_UNAVAILABLE');
      await assertPhysicalPath(root, target);
      const chunks: Buffer[] = [];
      let count = 0;
      while (true) {
        signal.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(64 * 1024, LIMIT + 1 - count));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        count += bytesRead;
        if (count > LIMIT) throw new ImportFailure('FILE_TOO_LARGE');
        chunks.push(buffer.subarray(0, bytesRead));
      }
      signal.throwIfAborted();
      await assertPhysicalPath(root, target);
      if (
        !same(await handle.stat({ bigint: true })) ||
        !same(await lstat(target, { bigint: true })) ||
        count !== Number(before.size)
      )
        throw new ImportFailure('FILE_UNAVAILABLE');
      bytes = Buffer.concat(chunks, count);
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    let input: unknown;
    try {
      // TextDecoder strips exactly one optional leading UTF-8 BOM.
      input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
      if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Object required');
    } catch {
      throw new ImportFailure('FILE_INVALID');
    }
    return { input, capability };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportFailure && error.code.startsWith('FILE_'))
      throw error;
    throw new ImportFailure('FILE_UNAVAILABLE');
  }
}
