import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  StorageIdSchema,
  StoredArticleSchema,
} from '../../contracts/stored-article';
import { ImportFailure } from '../../domain/import-error';
import type {
  AssetStore,
  ImportAttempt,
  StoredArticle,
} from '../../domain/ports/article-import';
import {
  assertLocalPath,
  assertPhysicalPath,
  readBoundedFile,
} from './local-reader';
import { validateImage } from './image-validator';

const uuid = StorageIdSchema;
const fileName =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT';
async function exists(target: string) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ImportFailure && error.code.startsWith('IMAGE_'))
      throw error;
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw new ImportFailure('STORAGE_UNAVAILABLE');
  }
}

export function createAssetStore(directory: string): AssetStore {
  assertLocalPath(directory);
  const root = path.resolve(directory);
  const staging = path.join(root, '.staging');
  const location = (attempt: ImportAttempt) => {
    uuid.parse(attempt.importId);
    uuid.parse(attempt.articleKey);
    return {
      stage: path.join(staging, attempt.importId),
      final: path.join(root, attempt.articleKey),
    };
  };
  const marker = (a: ImportAttempt) =>
    JSON.stringify({ importId: a.importId, articleKey: a.articleKey });
  async function ensure() {
    await assertPhysicalPath(path.dirname(root), path.dirname(root));
    if (!(await exists(root))) await mkdir(root);
    await assertPhysicalPath(root, root);
    if (!(await exists(staging))) await mkdir(staging);
    await assertPhysicalPath(root, staging);
  }
  async function ownership(
    target: string,
    a: ImportAttempt,
    allowPartial = false,
  ) {
    await assertPhysicalPath(root, target);
    if (!(await lstat(target)).isDirectory())
      throw new Error('Unexpected asset directory');
    const names = await readdir(target);
    const owner = path.join(target, '.owner.json');
    if (allowPartial && names.length === 0) return;
    await assertPhysicalPath(root, owner);
    const stat = await lstat(owner);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512)
      throw new Error('Invalid ownership');
    const value = await readFile(owner, 'utf8');
    const expected = marker(a);
    if (
      value !== expected &&
      !(
        allowPartial &&
        names.length === 1 &&
        value.length < expected.length &&
        expected.startsWith(value)
      )
    )
      throw new Error('Foreign ownership');
  }
  async function clean(target: string, a: ImportAttempt) {
    if (!(await exists(target))) return;
    await ownership(target, a, true);
    const names = await readdir(target);
    // Validate everything before removing anything. Never recurse into foreign directories.
    for (const name of names) {
      if (name !== '.owner.json' && !fileName.test(name))
        throw new Error('Unexpected asset member');
      const member = path.join(target, name);
      await assertPhysicalPath(root, member);
      const stat = await lstat(member);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('Unexpected member type');
    }
    for (const name of names.filter((name) => name !== '.owner.json')) {
      await assertPhysicalPath(root, path.join(target, name));
      await unlink(path.join(target, name));
    }
    if (names.includes('.owner.json'))
      await unlink(path.join(target, '.owner.json'));
    await rmdir(target);
  }
  return {
    readImage: (input, assetKey) =>
      safe(async () => {
        const article = StoredArticleSchema.parse(input);
        uuid.parse(assetKey);
        const asset = article.assets.find(
          (member) => member.assetKey === assetKey,
        );
        if (!asset) throw new Error('Unknown article asset');
        const attempt = {
          importId: article.importId,
          articleKey: article.articleKey,
        } as ImportAttempt;
        await ownership(path.join(root, article.articleKey), attempt);
        const signal = new AbortController().signal;
        const bytes = await readBoundedFile(
          root,
          path.join(root, asset.relativePath),
          signal,
        );
        if (bytes.length !== asset.byteSize || hash(bytes) !== asset.sha256)
          throw new Error('Asset integrity failure');
        const metadata = await validateImage(bytes, signal);
        if (
          metadata.mime !== asset.mime ||
          metadata.width !== asset.width ||
          metadata.height !== asset.height
        )
          throw new Error('Asset metadata mismatch');
        return bytes;
      }),
    prepare: (a, signal) =>
      safe(async () => {
        signal.throwIfAborted();
        const { stage, final } = location(a);
        await ensure();
        if (await exists(final)) throw new Error('Final already exists');
        await mkdir(stage);
        const handle = await open(path.join(stage, '.owner.json'), 'wx');
        try {
          await handle.writeFile(marker(a));
          await handle.sync();
        } finally {
          await handle.close();
        }
        signal.throwIfAborted();
      }),
    put: (a, imageId, bytes, signal) =>
      safe(async () => {
        signal.throwIfAborted();
        const metadata = await validateImage(bytes, signal);
        const { stage } = location(a);
        await ownership(stage, a);
        const assetKey = randomUUID();
        const name = `${assetKey}.${metadata.extension}`;
        const handle = await open(path.join(stage, name), 'wx');
        try {
          for (let offset = 0; offset < bytes.length;) {
            signal.throwIfAborted();
            const chunk = bytes.subarray(
              offset,
              Math.min(offset + 64 * 1024, bytes.length),
            );
            const result = await handle.write(chunk);
            if (!result.bytesWritten) throw new Error('Incomplete asset write');
            offset += result.bytesWritten;
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        signal.throwIfAborted();
        return {
          assetKey,
          imageId,
          relativePath: `${a.articleKey}/${name}`,
          mime: metadata.mime,
          width: metadata.width,
          height: metadata.height,
          byteSize: bytes.length,
          sha256: hash(bytes),
        };
      }),
    finalize: (a, signal) =>
      safe(async () => {
        signal.throwIfAborted();
        const { stage, final } = location(a);
        await ownership(stage, a);
        await assertPhysicalPath(root, root);
        if (await exists(final)) throw new Error('Final already exists');
        await rename(stage, final);
        signal.throwIfAborted();
      }),
    cleanup: (a) =>
      safe(async () => {
        const { stage, final } = location(a);
        if (!(await exists(root))) return;
        await assertPhysicalPath(root, root);
        if (await exists(staging)) await assertPhysicalPath(root, staging);
        await clean(stage, a);
        await clean(final, a);
      }),
    verify: (article: StoredArticle) =>
      safe(async () => {
        StoredArticleSchema.parse(article);
        const a = {
          importId: article.importId,
          articleKey: article.articleKey,
        };
        uuid.parse(a.importId);
        uuid.parse(a.articleKey);
        await ownership(path.join(root, a.articleKey), a as ImportAttempt);
        for (const asset of article.assets) {
          uuid.parse(asset.assetKey);
          const extension =
            asset.mime === 'image/jpeg'
              ? 'jpg'
              : asset.mime === 'image/png'
                ? 'png'
                : 'webp';
          const expected = `${a.articleKey}/${asset.assetKey}.${extension}`;
          if (asset.relativePath !== expected)
            throw new Error('Unexpected asset path');
          const bytes = await readBoundedFile(
            root,
            path.join(root, expected),
            new AbortController().signal,
          );
          if (bytes.length !== asset.byteSize || hash(bytes) !== asset.sha256)
            throw new Error('Asset integrity failure');
        }
      }),
  };
}
