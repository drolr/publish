import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  OwnedRevisionFileSchema,
  PreparedRevisionAssetsSchema,
  type RevisionIntent,
  type RevisionOperation,
  type OwnedRevisionFile,
  RevisionAssetJournalSchema as JournalSchema,
  type RevisionAssetJournal as Journal,
} from '../../contracts/article-revision';
import { StorageIdSchema } from '../../contracts/stored-article';
import type { ArticleRevisionRepository } from '../../domain/ports/article-revision';
import type {
  RevisionAssetStore,
  StoredImageLeases,
} from '../../domain/ports/revision-assets';
import type { ManualImageSource } from '../../domain/ports/manual-images';
import {
  assertLocalPath,
  assertPhysicalPath,
  readBoundedFile,
} from './local-reader';
import { createAssetStore } from './asset-store';
import { validateImage } from './image-validator';
import { revisionDigest } from '../persistence/article-revision-repository';
import { deriveEditorBody } from '../../domain/article-edit';
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const missing = (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';
async function exists(target: string) {
  try {
    await lstat(target);
    return true;
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
}
async function identity(target: string) {
  const s = await lstat(target, { bigint: true });
  if (!s.isFile() || s.nlink !== 1n) throw Error('Invalid file');
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
export function createRevisionAssetStore(
  directory: string,
  repository: ArticleRevisionRepository,
  images: ManualImageSource & StoredImageLeases,
): RevisionAssetStore {
  assertLocalPath(directory);
  const root = path.resolve(directory);
  const base = path.join(root, '.revisions');
  const formal = createAssetStore(root);
  const stage = (op: RevisionIntent) => {
    StorageIdSchema.parse(op.operationId);
    StorageIdSchema.parse(op.articleKey);
    return path.join(base, op.operationId);
  };
  const member = (file: OwnedRevisionFile, op: RevisionIntent) => {
    OwnedRevisionFileSchema.parse(file);
    if (
      !file.relativePath.startsWith(`${op.articleKey}/`) ||
      file.relativePath.split('/').length !== 2
    )
      throw Error('Foreign article file');
    const extension =
      file.mime === 'image/jpeg'
        ? 'jpg'
        : file.mime === 'image/png'
          ? 'png'
          : 'webp';
    if (file.relativePath !== `${op.articleKey}/${file.assetKey}.${extension}`)
      throw Error('Invalid asset path');
    return {
      final: path.join(root, file.relativePath),
      staged: path.join(stage(op), path.basename(file.relativePath)),
    };
  };
  async function writeJournal(op: RevisionIntent, journal: Journal) {
    const dir = stage(op);
    await assertPhysicalPath(root, dir);
    const tmp = path.join(dir, '.journal.next');
    const target = path.join(dir, '.journal.json');
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(JSON.stringify(JournalSchema.parse(journal)));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
  }
  async function journalFor(
    op: RevisionOperation,
  ): Promise<Journal | undefined> {
    const dir = stage(op);
    if (!(await exists(dir))) {
      if (op.ownedFiles.length) throw Error('Missing file journal');
      return undefined;
    }
    await assertPhysicalPath(root, dir);
    const target = path.join(dir, '.journal.json');
    await assertPhysicalPath(root, target);
    const s = await lstat(target);
    if (!s.isFile() || s.nlink !== 1 || s.size > 256 * 1024)
      throw Error('Invalid journal');
    const journal = JournalSchema.parse(
      JSON.parse(await readFile(target, 'utf8')),
    );
    if (
      journal.operationId !== op.operationId ||
      journal.articleKey !== op.articleKey ||
      JSON.stringify(journal.files) !== JSON.stringify(op.ownedFiles) ||
      journal.files.some((f) => f.ownerNonce !== journal.ownerNonce)
    )
      throw Error('Journal mismatch');
    return journal;
  }
  async function verifyFile(target: string, file: OwnedRevisionFile) {
    await assertPhysicalPath(root, target);
    if ((await identity(target)) !== file.fileIdentity)
      throw Error('File replaced');
    const bytes = await readBoundedFile(
      root,
      target,
      new AbortController().signal,
    );
    if (bytes.byteLength !== file.byteSize || hash(bytes) !== file.sha256)
      throw Error('File integrity');
    if ((await identity(target)) !== file.fileIdentity)
      throw Error('File changed');
  }
  return {
    async prepare(op, sources, signal) {
      signal.throwIfAborted();
      const assets: import('../../contracts/stored-article').StoredAsset[] = [];
      const files: OwnedRevisionFile[] = [];
      let journal: Journal | undefined;
      let total = 0;
      for (const source of sources) {
        signal.throwIfAborted();
        if (assets.some((a) => a.imageId === source.imageId))
          throw Error('Duplicate image ID');
        if (source.kind === 'stored') {
          const stored = await images.readStored(
            source.lease,
            op.sessionId,
            op.articleKey,
            source.imageId,
            signal,
          );
          assets.push(stored.asset);
          total += stored.asset.byteSize;
        } else {
          if (source.sessionId !== op.sessionId) throw Error('Foreign session');
          const { bytes } = await images.read(
            source.sessionId,
            source.imageToken,
            signal,
          );
          const metadata = await validateImage(bytes, signal);
          total += bytes.byteLength;
          if (total > 200 * 1024 * 1024) throw Error('Image budget');
          if (!journal) {
            if (!repository.readRevisionOperation(op.operationId))
              throw Error('Missing intent');
            await assertPhysicalPath(root, root);
            if (!(await exists(base))) await mkdir(base);
            await assertPhysicalPath(root, base);
            await mkdir(stage(op));
            journal = {
              operationId: op.operationId,
              articleKey: op.articleKey,
              ownerNonce: randomUUID(),
              files,
            };
            await writeJournal(op, journal);
          }
          const assetKey = randomUUID();
          const relativePath = `${op.articleKey}/${assetKey}.${metadata.extension}`;
          const target = path.join(stage(op), path.basename(relativePath));
          const handle = await open(target, 'wx');
          try {
            const file: OwnedRevisionFile = {
              assetKey,
              relativePath,
              mime: metadata.mime,
              byteSize: bytes.byteLength,
              sha256: hash(bytes),
              ownerNonce: journal.ownerNonce,
              fileIdentity: await identity(target),
            };
            files.push(file);
            repository.markRevisionOperation(op.operationId, {
              ownedFiles: [...files],
            });
            await writeJournal(op, journal);
            for (let offset = 0; offset < bytes.byteLength;) {
              signal.throwIfAborted();
              const { bytesWritten } = await handle.write(
                bytes.subarray(
                  offset,
                  Math.min(offset + 65536, bytes.byteLength),
                ),
              );
              if (!bytesWritten) throw Error('Incomplete write');
              offset += bytesWritten;
            }
            await handle.sync();
          } finally {
            await handle.close();
          }
          signal.throwIfAborted();
          await verifyFile(target, files[files.length - 1]);
          assets.push({
            assetKey,
            imageId: source.imageId,
            relativePath,
            mime: metadata.mime,
            byteSize: bytes.byteLength,
            width: metadata.width,
            height: metadata.height,
            sha256: hash(bytes),
          });
        }
        if (total > 200 * 1024 * 1024) throw Error('Image budget');
      }
      return PreparedRevisionAssetsSchema.parse({
        assets,
        ownedNewAssetKeys: files.map((f) => f.assetKey),
      });
    },
    async finalizeNewFiles(op, signal) {
      const operation = repository.readRevisionOperation(op.operationId);
      if (!operation) throw Error('Missing operation');
      const journal = await journalFor(operation);
      if (!journal) return;
      const article = repository.loadEditableArticle(op.articleKey);
      if (!article) throw Error('Missing article');
      await formal.verify(article.article);
      for (const file of journal.files) {
        signal.throwIfAborted();
        const loc = member(file, op);
        await verifyFile(loc.staged, file);
        if (await exists(loc.final)) throw Error('Final collision');
        await assertPhysicalPath(root, path.dirname(loc.final));
        await rename(loc.staged, loc.final);
        await verifyFile(loc.final, file);
      }
    },
    async verify(receipt) {
      const op = repository.readRevisionOperation(receipt.operationId);
      const current = repository.loadArchivedEditableArticle(
        receipt.articleKey,
      );
      if (
        !op ||
        op.committedRevision !== receipt.articleRevision ||
        op.committedAt !== receipt.committedAt ||
        !current ||
        current.article.externalId !== receipt.externalId ||
        current.articleRevision < receipt.articleRevision
      )
        throw Error('Commit evidence missing');
      if (
        current.articleRevision === receipt.articleRevision &&
        revisionDigest(
          current.article,
          current.editorBody ?? deriveEditorBody(current.article.body),
        ) !== op.nextDigest
      )
        throw Error('Committed digest mismatch');
      await formal.verify(current.article);
      // Older immutable receipts remain valid after later revisions; only unresolved owned files need physical checks.
      if (!op.cleanupComplete && op.ownedFiles.length) {
        await journalFor(op);
        for (const file of op.ownedFiles)
          await verifyFile(member(file, op).final, file);
      }
    },
    async cleanupOwnedUnreferenced(op) {
      const journal = await journalFor(op);
      if (!journal) return;
      const current = repository.loadArchivedEditableArticle(op.articleKey);
      const removals: string[] = [];
      const dir = stage(op);
      const expected = new Set([
        '.journal.json',
        ...journal.files.map((f) => path.basename(f.relativePath)),
      ]);
      if ((await readdir(dir)).some((n) => !expected.has(n)))
        throw Error('Unjournaled file');
      for (const file of journal.files) {
        const loc = member(file, op);
        if (await exists(loc.staged)) {
          await verifyFile(loc.staged, file);
          removals.push(loc.staged);
        }
        if (await exists(loc.final)) {
          await verifyFile(loc.final, file);
          if (op.committedRevision === null) {
            if (
              current?.article.assets.some(
                (a) =>
                  a.assetKey === file.assetKey ||
                  a.relativePath === file.relativePath,
              )
            )
              throw Error('Unexpected formal reference');
            removals.push(loc.final);
          }
        }
      }
      // Validate the entire ownership set before deletion. Committed final files are always retained.
      for (const target of removals) {
        const file = journal.files.find(
          (f) => path.basename(f.relativePath) === path.basename(target),
        )!;
        await verifyFile(target, file);
        await unlink(target);
      }
      await unlink(path.join(dir, '.journal.json'));
      await rmdir(dir);
    },
  };
}
