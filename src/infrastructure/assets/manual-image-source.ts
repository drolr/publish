import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ManualImage } from '../../contracts/manual-article';
import type { VerifiedStoredImage } from '../../contracts/article-revision';
import {
  StoredArticleSchema,
  type StoredArticle,
  type StoredAsset,
} from '../../contracts/stored-article';
import type { AssetStore } from '../../domain/ports/article-import';
import type { StoredImageLeases } from '../../domain/ports/revision-assets';
import { WebPasteFailure } from '../../domain/web-paste-error';
import { imagePasteFailure } from './web-paste-image-reader';
import type { ManualTempStore, TempImageRef } from './manual-temp-store';
import { ImportFailure } from '../../domain/import-error';
import type {
  ManualImageCapability,
  ManualImageSource,
} from '../../domain/ports/manual-images';
import { validateImage } from './image-validator';
import {
  assertLocalPath,
  assertPhysicalPath,
  readBoundedFile,
} from './local-reader';

interface LocalImage {
  kind: 'local';
  target: string;
  root: string;
  identity: BigIntStats;
  hash: string;
  dto: ManualImage;
}
type AuthorizedImage =
  | LocalImage
  | { kind: 'temp'; ref: TempImageRef; dto: ManualImage }
  | {
      kind: 'stored';
      article: StoredArticle;
      asset: StoredAsset;
      lease: VerifiedStoredImage;
      dto: ManualImage;
    };
interface Session {
  pending?: Promise<unknown>;
  cleanupFailure?: WebPasteFailure;
  id: string;
  images: Map<string, AuthorizedImage>;
  revision: number;
  capability: ManualImageCapability;
}
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const sameIdentity = (before: BigIntStats, after: BigIntStats) =>
  after.isFile() &&
  after.nlink === 1n &&
  before.ino === after.ino &&
  before.dev === after.dev &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs &&
  before.birthtimeNs === after.birthtimeNs;

export function createManualImageSource(
  tempStore: ManualTempStore,
  formalAssets?: AssetStore,
): ManualImageSource & StoredImageLeases {
  const sessions = new Map<string, Session>();
  const capabilities = new WeakMap<ManualImageCapability, Session>();
  const storedLeases = new WeakMap<
    VerifiedStoredImage,
    {
      session: Session;
      image: AuthorizedImage;
      article: StoredArticle;
      asset: StoredAsset;
    }
  >();
  // Retain the original registry owner (and temp cleanup obligation) while
  // preferring the formal bytes verified by a successful save binding.
  const savedBindings = new WeakMap<
    AuthorizedImage,
    { article: StoredArticle; asset: StoredAsset }
  >();
  let busy = false;

  function sessionFor(id: string): Session {
    const existing = sessions.get(id);
    if (existing) return existing;
    const capability = Object.freeze({ kind: 'manual-images' } as const);
    const session = {
      id,
      images: new Map<string, AuthorizedImage>(),
      revision: 0,
      capability,
    };
    sessions.set(id, session);
    capabilities.set(capability, session);
    return session;
  }
  function assertLive(session: Session): void {
    if (sessions.get(session.id) !== session)
      throw new ImportFailure('SOURCE_NOT_ALLOWED');
  }
  async function exclusive<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (busy) throw new ImportFailure('IMAGE_UNAVAILABLE');
    busy = true;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WebPasteFailure) throw error;
      signal.throwIfAborted();
      if (error instanceof ImportFailure) throw error;
      throw new ImportFailure('IMAGE_UNAVAILABLE');
    } finally {
      busy = false;
    }
  }
  async function assertUnchanged(image: LocalImage): Promise<void> {
    await assertPhysicalPath(image.root, image.target);
    if (
      !sameIdentity(image.identity, await lstat(image.target, { bigint: true }))
    )
      throw new ImportFailure('IMAGE_UNAVAILABLE');
  }
  function read(sessionId: string, token: string, signal: AbortSignal) {
    const owner = sessions.get(sessionId);
    const wasBusy = busy;
    const pending = exclusive(signal, async () => {
      const session = sessions.get(sessionId);
      const image = session?.images.get(token);
      if (!session || !image) throw new ImportFailure('SOURCE_NOT_ALLOWED');
      let bytes: Uint8Array;
      const stored =
        savedBindings.get(image) ??
        (image.kind === 'stored' ? image : undefined);
      if (stored) {
        if (!formalAssets?.readImage)
          throw new ImportFailure('SOURCE_NOT_ALLOWED');
        bytes = await formalAssets.readImage(
          stored.article,
          stored.asset.assetKey,
        );
        if (
          bytes.byteLength !== stored.asset.byteSize ||
          hash(bytes) !== stored.asset.sha256
        )
          throw new ImportFailure('SOURCE_NOT_ALLOWED');
      } else if (image.kind === 'temp') {
        bytes = await tempStore.read(image.ref, signal);
      } else if (image.kind === 'local') {
        await assertUnchanged(image);
        bytes = await readBoundedFile(image.root, image.target, signal);
        await assertUnchanged(image);
        if (hash(bytes) !== image.hash)
          throw new ImportFailure('IMAGE_UNAVAILABLE');
      } else throw new ImportFailure('SOURCE_NOT_ALLOWED');
      signal.throwIfAborted();
      assertLive(session);
      if (session.images.get(token) !== image)
        throw new ImportFailure('SOURCE_NOT_ALLOWED');
      return { mime: image.dto.mime, bytes };
    });
    const ownedImage = owner?.images.get(token);
    if (
      owner &&
      !wasBusy &&
      ownedImage &&
      (ownedImage.kind === 'stored' || savedBindings.has(ownedImage))
    )
      owner.pending = pending.then(
        () => {},
        () => {},
      );
    return pending;
  }

  return {
    findEquivalent(sessionId, sha256, retainedTokens) {
      const owner = sessions.get(sessionId);
      if (!owner || owner.cleanupFailure) return undefined;
      const retained = new Set(retainedTokens);
      for (const [token, image] of owner.images) {
        const fingerprint =
          image.kind === 'local'
            ? image.hash
            : image.kind === 'temp'
              ? image.ref.sha256
              : image.asset.sha256;
        if (retained.has(token) && fingerprint === sha256)
          return { ...image.dto };
      }
      return undefined;
    },
    bindSavedImage(sessionId, input, assetKey, imageToken, signal) {
      if (busy) return Promise.reject(new ImportFailure('IMAGE_UNAVAILABLE'));
      const owner = sessions.get(sessionId),
        original = owner?.images.get(imageToken);
      if (!owner || !original)
        return Promise.reject(new ImportFailure('SOURCE_NOT_ALLOWED'));
      const pending = (async () => {
        const prior = await read(sessionId, imageToken, signal);
        return exclusive(signal, async () => {
          const article = StoredArticleSchema.parse(input);
          const asset = article.assets.find((a) => a.assetKey === assetKey);
          if (
            !asset ||
            !formalAssets?.readImage ||
            (original.kind === 'stored'
              ? asset.assetKey !== original.asset.assetKey ||
                asset.imageId !== original.asset.imageId
              : asset.imageId !== imageToken) ||
            asset.byteSize !== original.dto.byteSize ||
            asset.mime !== original.dto.mime ||
            asset.width !== original.dto.width ||
            asset.height !== original.dto.height ||
            hash(prior.bytes) !== asset.sha256
          )
            throw new ImportFailure('SOURCE_NOT_ALLOWED');
          const bytes = await formalAssets.readImage(article, assetKey);
          signal.throwIfAborted();
          assertLive(owner);
          if (
            owner.images.get(imageToken) !== original ||
            bytes.byteLength !== asset.byteSize ||
            hash(bytes) !== asset.sha256
          )
            throw new ImportFailure('SOURCE_NOT_ALLOWED');
          const lease = Object.freeze({}) as VerifiedStoredImage;
          storedLeases.set(lease, {
            session: owner,
            image: original,
            article,
            asset,
          });
          savedBindings.set(original, { article, asset });
          return lease;
        });
      })();
      owner.pending = pending.then(
        () => {},
        () => {},
      );
      return pending;
    },
    authorizeStored(sessionId, input, assetKey, signal) {
      const owner = sessionFor(sessionId);
      const wasBusy = busy;
      const pending = exclusive(signal, async () => {
        const article = StoredArticleSchema.parse(input);
        const asset = article.assets.find((a) => a.assetKey === assetKey);
        if (!asset || !formalAssets?.readImage)
          throw new ImportFailure('SOURCE_NOT_ALLOWED');
        const session = sessionFor(sessionId);
        const revision = session.revision;
        await formalAssets.readImage(article, assetKey);
        signal.throwIfAborted();
        assertLive(session);
        if (session.revision !== revision)
          throw new ImportFailure('SOURCE_NOT_ALLOWED');
        const existing = [...session.images.values()].find(
          (i) => i.kind === 'stored' && i.asset.assetKey === assetKey,
        );
        if (existing?.kind === 'stored')
          return { image: { ...existing.dto }, lease: existing.lease };
        if (
          session.images.size >= 200 ||
          [...session.images.values()].reduce(
            (n, i) => n + i.dto.byteSize,
            asset.byteSize,
          ) >
            200 * 1024 * 1024
        )
          throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
        const lease = Object.freeze({}) as VerifiedStoredImage;
        const dto = {
          imageToken: randomUUID(),
          mime: asset.mime,
          width: asset.width,
          height: asset.height,
          byteSize: asset.byteSize,
        };
        const image = { kind: 'stored' as const, article, asset, lease, dto };
        session.images.set(dto.imageToken, image);
        storedLeases.set(lease, { session, image, article, asset });
        return { image: { ...dto }, lease };
      });
      if (!wasBusy)
        owner.pending = pending.then(
          () => {},
          () => {},
        );
      return pending;
    },
    async readStored(lease, sessionId, articleKey, imageId, signal) {
      const entry = storedLeases.get(lease);
      if (
        !entry ||
        entry.session.id !== sessionId ||
        entry.article.articleKey !== articleKey ||
        entry.asset.imageId !== imageId ||
        entry.session.images.get(entry.image.dto.imageToken) !== entry.image
      )
        throw new ImportFailure('SOURCE_NOT_ALLOWED');
      assertLive(entry.session);
      const wasBusy = busy;
      const pending = exclusive(signal, async () => {
        if (!formalAssets?.readImage)
          throw new ImportFailure('SOURCE_NOT_ALLOWED');
        const bytes = await formalAssets.readImage(
          entry.article,
          entry.asset.assetKey,
        );
        signal.throwIfAborted();
        assertLive(entry.session);
        if (
          entry.session.images.get(entry.image.dto.imageToken) !==
            entry.image ||
          bytes.byteLength !== entry.asset.byteSize ||
          hash(bytes) !== entry.asset.sha256
        )
          throw new ImportFailure('SOURCE_NOT_ALLOWED');
        return { asset: { ...entry.asset }, bytes };
      });
      if (!wasBusy)
        entry.session.pending = pending.then(
          () => {},
          () => {},
        );
      return pending;
    },
    authorize(sessionId, filename, signal) {
      return exclusive(signal, async () => {
        const session = sessionFor(sessionId);
        const revision = session.revision;
        if (session.images.size >= 200)
          throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
        assertLocalPath(filename);
        const target = path.resolve(filename);
        const root = path.parse(target).root;
        await assertPhysicalPath(root, target);
        const identity = await lstat(target, { bigint: true });
        if (!identity.isFile() || identity.nlink !== 1n)
          throw new ImportFailure('SOURCE_NOT_ALLOWED');
        const bytes = await readBoundedFile(root, target, signal);
        const metadata = await validateImage(bytes, signal);
        const dto: ManualImage = {
          imageToken: randomUUID(),
          mime: metadata.mime,
          width: metadata.width,
          height: metadata.height,
          byteSize: bytes.byteLength,
        };
        const authorized: LocalImage = {
          kind: 'local',
          target,
          root,
          identity,
          hash: hash(bytes),
          dto,
        };
        await assertUnchanged(authorized);
        signal.throwIfAborted();
        assertLive(session);
        if (session.revision !== revision)
          throw new ImportFailure('SOURCE_NOT_ALLOWED');
        const total = [...session.images.values()].reduce(
          (sum, image) => sum + image.dto.byteSize,
          bytes.byteLength,
        );
        if (total > 200 * 1024 * 1024)
          throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
        session.images.set(dto.imageToken, authorized);
        return { ...dto };
      });
    },
    authorizeBytes(sessionId, input, signal) {
      const session = sessionFor(sessionId);
      const revision = session.revision;
      const wasBusy = busy;
      const pending = exclusive(signal, async () => {
        let ref: TempImageRef | undefined;
        try {
          const total = [...session.images.values()].reduce(
            (sum, image) => sum + image.dto.byteSize,
            input.byteLength,
          );
          if (session.images.size >= 200 || total > 200 * 1024 * 1024)
            throw new WebPasteFailure('IMAGE_LIMIT');
          const bytes = Buffer.from(input);
          const deadline = new AbortController();
          const timer = setTimeout(() => deadline.abort(), 30000);
          let metadata;
          try {
            metadata = await validateImage(
              bytes,
              AbortSignal.any([signal, deadline.signal]),
            );
            if (deadline.signal.aborted && !signal.aborted)
              throw new WebPasteFailure('IMAGE_TIMEOUT');
          } catch (error) {
            if (deadline.signal.aborted && !signal.aborted)
              throw new WebPasteFailure('IMAGE_TIMEOUT');
            throw error;
          } finally {
            clearTimeout(timer);
          }
          signal.throwIfAborted();
          assertLive(session);
          if (session.revision !== revision)
            throw new WebPasteFailure('CANCELLED');
          ref = await tempStore.put(sessionId, bytes, signal);
          signal.throwIfAborted();
          assertLive(session);
          if (session.revision !== revision)
            throw new WebPasteFailure('CANCELLED');
          const dto: ManualImage = {
            imageToken: randomUUID(),
            mime: metadata.mime,
            width: metadata.width,
            height: metadata.height,
            byteSize: bytes.byteLength,
          };
          session.images.set(dto.imageToken, { kind: 'temp', ref, dto });
          return { ...dto };
        } catch (error) {
          if (ref) await tempStore.remove(ref);
          if (
            error instanceof WebPasteFailure &&
            error.code === 'RECOVERY_REQUIRED'
          )
            throw error;
          if (
            signal.aborted ||
            sessions.get(sessionId) !== session ||
            session.revision !== revision
          )
            throw new WebPasteFailure('CANCELLED');
          throw imagePasteFailure(error);
        }
      });
      if (!wasBusy)
        session.pending = pending.then(
          () => {},
          (error) => {
            if (
              error instanceof WebPasteFailure &&
              error.code === 'RECOVERY_REQUIRED'
            )
              session.cleanupFailure = error;
          },
        );
      return pending;
    },
    read,
    async retain(sessionId, tokens, options) {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.revision++;
      await session.pending;
      if (session.cleanupFailure) throw session.cleanupFailure;
      if (options?.preserveHistory) return;
      const retained = new Set(tokens);
      for (const token of session.images.keys()) {
        if (!retained.has(token)) {
          const image = session.images.get(token)!;
          if (image.kind === 'temp') await tempStore.remove(image.ref);
          session.images.delete(token);
        }
      }
    },
    async release(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      capabilities.delete(session.capability);
      sessions.delete(sessionId);
      await session.pending;
      if (session.cleanupFailure) throw session.cleanupFailure;
      for (const image of session.images.values())
        if (image.kind === 'temp') await tempStore.remove(image.ref);
      session.images.clear();
    },
    capability(sessionId) {
      return sessionFor(sessionId).capability;
    },
    async readCapability(capability, sourcePath, signal) {
      signal.throwIfAborted();
      const session = capabilities.get(capability);
      if (!session) throw new ImportFailure('SOURCE_NOT_ALLOWED');
      assertLive(session);
      const token = sourcePath.endsWith('.image')
        ? sourcePath.slice(0, -6)
        : '';
      if (!session.images.has(token) || sourcePath !== `${token}.image`)
        throw new ImportFailure('SOURCE_NOT_ALLOWED');
      return (await read(session.id, token, signal)).bytes;
    },
  };
}
