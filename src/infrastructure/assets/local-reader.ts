import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ImportFailure } from '../../domain/import-error';
import type { LocalRootCapability } from '../../domain/ports/article-import';
import { MAX_IMAGE_BYTES } from './image-validator';

const roots = new WeakMap<LocalRootCapability, string>();
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export function assertLocalPath(value: string): void {
  if (
    value.startsWith('\\\\') ||
    value.startsWith('//') ||
    !path.isAbsolute(value)
  )
    throw new ImportFailure('SOURCE_NOT_ALLOWED');
}
export async function assertPhysicalPath(
  root: string,
  target: string,
): Promise<void> {
  assertLocalPath(root);
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new ImportFailure('SOURCE_NOT_ALLOWED');
  const segments = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !samePath(await realpath(current), current))
      throw new ImportFailure('SOURCE_NOT_ALLOWED');
  }
}
export async function authorizeLocalRoot(
  directory: string,
): Promise<LocalRootCapability> {
  try {
    assertLocalPath(directory);
    const root = path.resolve(directory);
    await assertPhysicalPath(root, root);
    if (!(await lstat(root)).isDirectory())
      throw new ImportFailure('SOURCE_NOT_ALLOWED');
    const capability = Object.freeze({ kind: 'local-root' } as const);
    roots.set(capability, root);
    return capability;
  } catch {
    throw new ImportFailure('SOURCE_NOT_ALLOWED');
  }
}
export async function readLocalImage(
  capability: LocalRootCapability,
  relativePath: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const root = roots.get(capability);
  if (
    !root ||
    relativePath.includes(':') ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    [...relativePath].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    relativePath
      .split(/[\\/]/)
      .some((s) => !s || s === '.' || s === '..' || /[. ]$/.test(s))
  )
    throw new ImportFailure('SOURCE_NOT_ALLOWED');
  try {
    return await readBoundedFile(
      root,
      path.resolve(root, relativePath),
      signal,
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportFailure) throw error;
    throw new ImportFailure('IMAGE_UNAVAILABLE');
  }
}
export async function readBoundedFile(
  root: string,
  target: string,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  await assertPhysicalPath(root, target);
  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n)
    throw new ImportFailure('SOURCE_NOT_ALLOWED');
  if (before.size > BigInt(MAX_IMAGE_BYTES))
    throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs
    )
      throw new ImportFailure('SOURCE_NOT_ALLOWED');
    await assertPhysicalPath(root, target);
    const chunks: Buffer[] = [];
    let count = 0;
    while (true) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(
        Math.min(64 * 1024, MAX_IMAGE_BYTES + 1 - count),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count > MAX_IMAGE_BYTES)
        throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    signal.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    await assertPhysicalPath(root, target);
    const location = await lstat(target, { bigint: true });
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      location.ino !== before.ino ||
      location.dev !== before.dev ||
      count !== Number(before.size)
    )
      throw new ImportFailure('SOURCE_NOT_ALLOWED');
    return Buffer.concat(chunks, count);
  } finally {
    await handle.close();
  }
}
