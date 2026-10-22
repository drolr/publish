import { ImportFailure } from '../../domain/import-error';
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
  coverAssetMetadata,
  CoverOperationSchema,
  OwnedCoverFileSchema,
  CoverAssetJournalSchema,
  CoverConfigurationSchema,
  CoverSaveIntentSchema,
  CoverOwnershipMarkerSchema,
  StoredCoverAssetSchema,
  COVER_IMAGE_MAX_BYTES,
  type CoverAssetJournal,
  type CoverOperation,
  type CoverSaveIntent,
  type OwnedCoverFile,
  type StoredCoverConfiguration,
  type StoredCoverAsset,
} from '../../contracts/article-cover';
import type {
  ArticleCoverRepository,
  CoverAssetStore,
} from '../../domain/ports/article-cover';
import {
  assertLocalPath,
  assertPhysicalPath,
  readBoundedFile,
} from './local-reader';
import { validateImage } from './image-validator';
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
  if (!s.isFile() || s.nlink !== 1n) throw Error('Invalid owned file');
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
export function createCoverAssetStore(
  directory: string,
  repository: ArticleCoverRepository,
): CoverAssetStore {
  assertLocalPath(directory);
  const root = path.resolve(directory);
  const base = path.join(root, 'covers');
  const stage = (op: CoverSaveIntent) => {
    if ('status' in op) CoverOperationSchema.parse(op);
    else CoverSaveIntentSchema.parse(op);
    return path.join(base, op.articleKey, op.operationId);
  };
  const member = (op: CoverSaveIntent, file: StoredCoverAsset) => {
    if ('complete' in file) OwnedCoverFileSchema.parse(file);
    else StoredCoverAssetSchema.parse(file);
    if (
      file.relativePath !==
      `${op.articleKey}/${op.operationId}/${file.assetKey}.${file.mime === 'image/png' ? 'png' : 'jpg'}`
    )
      throw Error('Foreign cover file');
    return path.join(base, file.relativePath);
  };
  async function syncedJson(target: string, value: unknown) {
    const handle = await open(target, 'wx');
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async function writeJournal(op: CoverSaveIntent, journal: CoverAssetJournal) {
    await assertPhysicalPath(root, stage(op));
    const temporary = path.join(stage(op), '.journal.next');
    await syncedJson(temporary, CoverAssetJournalSchema.parse(journal));
    await rename(temporary, path.join(stage(op), '.journal.json'));
  }
  async function readJson(target: string): Promise<unknown> {
    await assertPhysicalPath(root, target);
    const s = await lstat(target);
    if (!s.isFile() || s.nlink !== 1 || s.size > 256 * 1024)
      throw Error('Invalid cover journal');
    return JSON.parse(await readFile(target, 'utf8')) as unknown;
  }
  async function journalFor(
    op: CoverOperation,
  ): Promise<CoverAssetJournal | undefined> {
    const dir = stage(op);
    if (!(await exists(dir))) {
      if (op.ownedFiles.length) throw Error('Missing cover ownership');
      return undefined;
    }
    await assertPhysicalPath(root, dir);
    const marker = CoverOwnershipMarkerSchema.parse(
      await readJson(path.join(dir, '.owner.json')),
    );
    const journal = CoverAssetJournalSchema.parse(
      await readJson(path.join(dir, '.journal.json')),
    );
    if (
      marker.operationId !== op.operationId ||
      marker.articleKey !== op.articleKey ||
      marker.ownerNonce !== journal.ownerNonce ||
      journal.operationId !== op.operationId ||
      journal.articleKey !== op.articleKey ||
      JSON.stringify(journal.files) !== JSON.stringify(op.ownedFiles) ||
      journal.files.some((f) => f.ownerNonce !== marker.ownerNonce)
    )
      throw Error('Cover ownership mismatch');
    return journal;
  }
  async function verifyFile(
    op: CoverSaveIntent,
    file: OwnedCoverFile,
    allowIncomplete = false,
  ) {
    const target = member(op, file);
    await assertPhysicalPath(root, target);
    if ((await identity(target)) !== file.fileIdentity)
      throw Error('Cover replaced');
    const bytes = await readBoundedFile(
      root,
      target,
      new AbortController().signal,
    );
    if (file.complete || !allowIncomplete) {
      if (bytes.byteLength !== file.byteSize || hash(bytes) !== file.sha256)
        throw Error('Cover bytes changed');
    } else if (bytes.byteLength > file.byteSize)
      throw Error('Unknown incomplete cover');
    if ((await identity(target)) !== file.fileIdentity)
      throw Error('Cover changed');
    return bytes;
  }
  async function verifiedOperation(config: StoredCoverConfiguration) {
    const normalized = CoverConfigurationSchema.parse(config);
    const stored = repository.loadArchivedCoverVersion(
      config.articleKey,
      config.coverRevision,
    );
    if (!stored || JSON.stringify(stored) !== JSON.stringify(normalized))
      throw Error('Foreign cover configuration');
    if (config.coverRevision === 0) return undefined;
    const op = repository.readCoverOperation(config.saveOperationId!);
    if (
      !op ||
      op.committedCoverRevision !== config.coverRevision ||
      op.committedAt !== config.committedAt
    )
      throw Error('Missing cover receipt');
    const journal = await journalFor(op);
    if (config.assets.length && !journal)
      throw Error('Missing committed journal');
    const expected = op.ownedFiles.map(coverAssetMetadata);
    if (
      op.ownedFiles.some((f) => !f.complete) ||
      JSON.stringify(expected) !== JSON.stringify(config.assets)
    )
      throw Error('Committed journal mismatch');
    return op;
  }
  async function knownCommittedFile(
    op: CoverOperation,
    file: OwnedCoverFile,
  ): Promise<Uint8Array | undefined> {
    if (!repository.isCoverAssetReferenced(file, op.operationId))
      throw Error('Missing committed cover reference');
    const target = member(op, file);
    await assertPhysicalPath(root, path.dirname(target));
    if (!(await lstat(path.dirname(target))).isDirectory())
      throw Error('Unknown cover namespace');
    if (!(await exists(target))) return undefined;
    return verifyFile(op, file);
  }
  async function verifyCommittedFiles(op: CoverOperation): Promise<void> {
    let unavailable = false;
    for (const file of op.ownedFiles) {
      if ((await knownCommittedFile(op, file)) === undefined)
        unavailable = true;
    }
    // Only exact file absence is degraded, after every other committed file was verified.
    if (unavailable) throw new ImportFailure('IMAGE_UNAVAILABLE');
  }
  return {
    async prepareCoverFiles(raw, images, signal) {
      const intent = CoverSaveIntentSchema.parse(raw);
      signal.throwIfAborted();
      const count =
        intent.mode === 'none' ? 0 : intent.mode === 'single' ? 1 : 3;
      if (images.length !== count) throw Error('Cover count');
      const op = repository.readCoverOperation(intent.operationId);
      if (
        !op ||
        op.status !== 'preparing' ||
        op.cleanupComplete ||
        op.ownedFiles.length ||
        Object.keys(CoverSaveIntentSchema.shape).some(
          (k) =>
            op[k as keyof CoverSaveIntent] !==
            intent[k as keyof CoverSaveIntent],
        )
      )
        throw Error('Missing fresh cover intent');
      const checked = [];
      let total = 0;
      for (const image of images) {
        if (
          !(image.bytes instanceof Uint8Array) ||
          image.bytes.byteLength > COVER_IMAGE_MAX_BYTES
        )
          throw Error('Cover byte budget');
        const bytes = Uint8Array.from(image.bytes);
        total += bytes.byteLength;
        if (bytes.byteLength > COVER_IMAGE_MAX_BYTES || total > 30_000_000)
          throw Error('Cover byte budget');
        const metadata = await validateImage(bytes, signal);
        if (metadata.mime === 'image/webp') throw Error('Cover format');
        checked.push({ bytes, metadata });
      }
      if (!checked.length) return [];
      await assertPhysicalPath(root, root);
      if (!(await exists(base))) await mkdir(base);
      await assertPhysicalPath(root, base);
      const articleDir = path.join(base, intent.articleKey);
      if (!(await exists(articleDir))) await mkdir(articleDir);
      await assertPhysicalPath(root, articleDir);
      await mkdir(stage(intent));
      await assertPhysicalPath(root, stage(intent));
      const journal: CoverAssetJournal = {
        operationId: intent.operationId,
        articleKey: intent.articleKey,
        ownerNonce: randomUUID(),
        files: [],
      };
      await syncedJson(
        path.join(stage(intent), '.owner.json'),
        CoverOwnershipMarkerSchema.parse({
          operationId: intent.operationId,
          articleKey: intent.articleKey,
          ownerNonce: journal.ownerNonce,
        }),
      );
      await writeJournal(intent, journal);
      const assets: StoredCoverAsset[] = [];
      for (const { bytes, metadata } of checked) {
        signal.throwIfAborted();
        const assetKey = randomUUID();
        const asset = StoredCoverAssetSchema.parse({
          assetKey,
          relativePath: `${intent.articleKey}/${intent.operationId}/${assetKey}.${metadata.extension}`,
          mime: metadata.mime,
          width: metadata.width,
          height: metadata.height,
          byteSize: bytes.byteLength,
          sha256: hash(bytes),
        });
        const target = member(intent, asset);
        const handle = await open(target, 'wx');
        let file: OwnedCoverFile;
        try {
          const opened = await handle.stat({ bigint: true });
          if (!opened.isFile() || opened.nlink !== 1n)
            throw Error('Invalid opened cover');
          const openedIdentity = `${opened.dev}:${opened.ino}:${opened.birthtimeNs}`;
          if ((await identity(target)) !== openedIdentity)
            throw Error('Cover ownership race');
          file = {
            ...asset,
            ownerNonce: journal.ownerNonce,
            fileIdentity: openedIdentity,
            complete: false,
          };
          journal.files.push(file);
          await writeJournal(intent, journal);
          repository.markCoverOperation(intent.operationId, {
            ownedFiles: journal.files,
          });
          for (let offset = 0; offset < bytes.byteLength;) {
            signal.throwIfAborted();
            const { bytesWritten } = await handle.write(
              bytes.subarray(
                offset,
                Math.min(offset + 65536, bytes.byteLength),
              ),
            );
            if (!bytesWritten) throw Error('Incomplete cover write');
            offset += bytesWritten;
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        await verifyFile(intent, file);
        file.complete = true;
        await writeJournal(intent, journal);
        repository.markCoverOperation(intent.operationId, {
          ownedFiles: journal.files,
        });
        assets.push(asset);
      }
      signal.throwIfAborted();
      return assets;
    },
    async readCoverAsset(config, assetKey) {
      if (!repository.loadCover(config.articleKey))
        throw Error('Inactive article');
      const op = await verifiedOperation(config);
      const file = op?.ownedFiles.find((f) => f.assetKey === assetKey);
      if (!file) throw Error('Foreign cover asset');
      const bytes = await knownCommittedFile(op!, file);
      if (bytes === undefined) {
        // Recoverable absence requires the same complete configuration proof as startup.
        await verifyCommittedFiles(op!);
        throw new ImportFailure('IMAGE_UNAVAILABLE');
      }
      return bytes;
    },
    async verifyCoverVersion(config) {
      const op = await verifiedOperation(config);
      if (op) await verifyCommittedFiles(op);
    },
    async cleanupOwnedUnreferenced(op) {
      if (op.committedCoverRevision !== null) {
        const config = repository.loadArchivedCoverVersion(
          op.articleKey,
          op.committedCoverRevision,
        );
        if (!config) throw Error('Missing committed cover');
        const committed = await verifiedOperation(config);
        if (committed) await verifyCommittedFiles(committed);
        return;
      }
      const latest = repository.readCoverOperation(op.operationId);
      if (!latest || JSON.stringify(latest) !== JSON.stringify(op))
        throw Error('Stale cover cleanup');
      const journal = await journalFor(op);
      if (!journal) return;
      const dir = stage(op);
      const expected = new Set([
        '.owner.json',
        '.journal.json',
        ...journal.files.map((f) => path.basename(f.relativePath)),
      ]);
      if ((await readdir(dir)).some((n) => !expected.has(n)))
        throw Error('Unjournaled cover file');
      const removals: OwnedCoverFile[] = [];
      for (const file of journal.files) {
        if (repository.isCoverAssetReferenced(file, op.operationId))
          throw Error('Referenced cover file');
        const target = member(op, file);
        if (await exists(target)) {
          await verifyFile(op, file, true);
          removals.push(file);
        }
      }
      for (const file of removals) {
        if (repository.isCoverAssetReferenced(file, op.operationId))
          throw Error('Cover reference changed');
        await verifyFile(op, file, true);
        await unlink(member(op, file));
      }
      await unlink(path.join(dir, '.journal.json'));
      await unlink(path.join(dir, '.owner.json'));
      await rmdir(dir);
    },
  };
}
