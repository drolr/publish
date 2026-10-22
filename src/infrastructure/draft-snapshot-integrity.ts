import { createHash } from 'node:crypto';
import {
  StoredArticleSchema,
  type StoredArticle,
} from '../contracts/stored-article';

export function canonicalDraftArticle(article: StoredArticle): StoredArticle {
  const normalized = StoredArticleSchema.parse(article);
  return {
    ...normalized,
    assets: [...normalized.assets].sort((a, b) =>
      a.assetKey.localeCompare(b.assetKey),
    ),
  };
}

export function serializeDraftArticle(article: StoredArticle): string {
  return JSON.stringify(canonicalDraftArticle(article));
}

export function createDraftSnapshotDigest(article: StoredArticle): string {
  return createHash('sha256')
    .update(serializeDraftArticle(article))
    .digest('hex');
}

// This digest is independent of the unchanged body snapshot contract.
export { coverConfigurationDigest as createCoverSnapshotDigest } from './persistence/article-cover-repository';
