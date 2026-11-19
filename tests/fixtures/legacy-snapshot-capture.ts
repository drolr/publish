import type { SnapshotPort } from '../../src/domain/ports/draft-task';
import {
  canonicalDraftArticle,
  createDraftSnapshotDigest,
} from '../../src/infrastructure/draft-snapshot-integrity';
import {
  richBodyEquals,
  upgradeEditorBody,
} from '../../src/domain/rich-text-body';
/** evidenceV1 only: historical production-page regression, never current V2 acceptance. */
export function legacyFixtureSnapshotCapture(snapshots: SnapshotPort): void {
  snapshots.capture = async (editable) => {
    if (
      !richBodyEquals(
        upgradeEditorBody(editable.editorBody, editable.article.body),
        upgradeEditorBody(null, editable.article.body),
      )
    )
      throw Error('Legacy fixture must be lossless plain');
    const article = canonicalDraftArticle(editable.article);
    const snapshot = {
      version: 1 as const,
      article,
      digest: createDraftSnapshotDigest(article),
    };
    await snapshots.verify(snapshot);
    return snapshot;
  };
}
