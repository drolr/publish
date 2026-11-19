import { createHash } from 'node:crypto';
import {
  DraftSnapshotSchema,
  type DraftSnapshot,
} from '../contracts/draft-task';
import type { PersistedEditorBodyV2 } from '../contracts/rich-text-body';
import { normalizeRichBody } from '../domain/rich-text-body';
import { editorProjectionMatches } from '../domain/article-edit';
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

export function createDraftSnapshotV2Digest(
  article: StoredArticle,
  editorBody: PersistedEditorBodyV2,
): string {
  const normalized = canonicalDraftArticle(article),
    body = normalizeRichBody(editorBody);
  if (!editorProjectionMatches(normalized, body))
    throw Error('Invalid snapshot projection');
  return createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'draft-snapshot-v2',
        article: normalized,
        editorBody: body,
      }),
    )
    .digest('hex');
}
export function verifyDraftSnapshotIntegrity(value: DraftSnapshot): void {
  const snapshot = DraftSnapshotSchema.parse(value);
  const digest =
    snapshot.version === 1
      ? createDraftSnapshotDigest(snapshot.article)
      : createDraftSnapshotV2Digest(snapshot.article, snapshot.editorBody);
  if (digest !== snapshot.digest) throw Error('Invalid task snapshot digest');
}
