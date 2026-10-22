import {
  DraftSnapshotSchema,
  type DraftSnapshot,
} from '../../contracts/draft-task';
import {
  StoredArticleSchema,
  type StoredArticle,
} from '../../contracts/stored-article';
import type { AssetStore } from '../../domain/ports/article-import';
import type { SnapshotPort } from '../../domain/ports/draft-task';
import {
  canonicalDraftArticle,
  createDraftSnapshotDigest,
  createCoverSnapshotDigest,
} from '../draft-snapshot-integrity';

import {
  CoverConfigurationSchema,
  CoverTaskSnapshotSchema,
  type StoredCoverConfiguration,
} from '../../contracts/article-cover';
import type {
  ArticleCoverRepository,
  CoverAssetStore,
} from '../../domain/ports/article-cover';

type DraftInputErrorCode =
  | 'INPUT_UNSUPPORTED'
  | 'TITLE_UNSUPPORTED'
  | 'IMAGE_FORMAT_UNSUPPORTED'
  | 'IMAGE_SIZE_UNSUPPORTED'
  | 'ASSET_UNAVAILABLE';

class DraftInputError extends Error {
  constructor(readonly code: DraftInputErrorCode) {
    super(code);
    this.name = 'DraftInputError';
  }
}

function input(article: StoredArticle): StoredArticle {
  try {
    return canonicalDraftArticle(StoredArticleSchema.parse(article));
  } catch {
    throw new DraftInputError('INPUT_UNSUPPORTED');
  }
}

function checkAssets(article: StoredArticle): void {
  for (const asset of article.assets) {
    if (asset.mime !== 'image/jpeg' && asset.mime !== 'image/png')
      throw new DraftInputError('IMAGE_FORMAT_UNSUPPORTED');
    if (asset.byteSize > 10_000_000)
      throw new DraftInputError('IMAGE_SIZE_UNSUPPORTED');
  }
}

function checkDigest(snapshot: DraftSnapshot): void {
  if (createDraftSnapshotDigest(snapshot.article) !== snapshot.digest)
    throw new DraftInputError('INPUT_UNSUPPORTED');
}

export function createDraftSnapshotPort(
  assets: AssetStore,
  covers?: {
    repository: Pick<ArticleCoverRepository, 'loadArchivedCoverVersion'>;
    assets: CoverAssetStore;
  },
): SnapshotPort {
  function captureCover(value: StoredCoverConfiguration) {
    const c = CoverConfigurationSchema.parse(value);
    if (
      c.configurationDigest !==
      createCoverSnapshotDigest(c.articleKey, c.coverRevision, c.mode, c.assets)
    )
      throw Error('Invalid cover digest');
    return CoverTaskSnapshotSchema.parse({
      version: 1,
      articleKey: c.articleKey,
      coverRevision: c.coverRevision,
      mode: c.mode,
      assets: c.assets,
      digest: c.configurationDigest,
    });
  }
  async function trustedRead(article: StoredArticle, assetKey: string) {
    if (!assets.readImage) throw new DraftInputError('ASSET_UNAVAILABLE');
    try {
      return await assets.readImage(article, assetKey);
    } catch {
      throw new DraftInputError('ASSET_UNAVAILABLE');
    }
  }

  async function verifyAssets(article: StoredArticle): Promise<void> {
    checkAssets(article);
    for (const asset of article.assets)
      await trustedRead(article, asset.assetKey);
  }

  return {
    captureCover,
    async readCoverImage(value, assetKey) {
      const snapshot = CoverTaskSnapshotSchema.parse(value);
      if (!covers) throw Error('Cover storage unavailable');
      const c = covers.repository.loadArchivedCoverVersion(
        snapshot.articleKey,
        snapshot.coverRevision,
      );
      if (
        !c ||
        JSON.stringify(captureCover(c)) !== JSON.stringify(snapshot) ||
        !snapshot.assets.some((a) => a.assetKey === assetKey)
      )
        throw Error('Invalid cover snapshot');
      return covers.assets.readCoverAsset(c, assetKey);
    },
    async capture(article) {
      const normalized = input(article);
      await verifyAssets(normalized);
      return DraftSnapshotSchema.parse({
        version: 1,
        article: normalized,
        digest: createDraftSnapshotDigest(normalized),
      });
    },
    async verify(value) {
      let snapshot: DraftSnapshot;
      try {
        snapshot = DraftSnapshotSchema.parse(value);
      } catch {
        throw new DraftInputError('INPUT_UNSUPPORTED');
      }
      checkDigest(snapshot);
      await verifyAssets(snapshot.article);
    },
    async readImage(value, assetKey) {
      let snapshot: DraftSnapshot;
      try {
        snapshot = DraftSnapshotSchema.parse(value);
      } catch {
        throw new DraftInputError('INPUT_UNSUPPORTED');
      }
      checkDigest(snapshot);
      checkAssets(snapshot.article);
      if (!snapshot.article.assets.some((asset) => asset.assetKey === assetKey))
        throw new DraftInputError('ASSET_UNAVAILABLE');
      return trustedRead(snapshot.article, assetKey);
    },
  };
}
