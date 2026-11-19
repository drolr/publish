import type { PersistedEditorBodyV2 } from '../../src/contracts/rich-text-body';
import { projectRichBody } from '../../src/domain/rich-text-body';
import { createDraftSnapshotV2Digest } from '../../src/infrastructure/draft-snapshot-integrity';
import { makeDraftTask } from './draft-task';
export function budgetSnapshot(runs = 50000) {
  const editorBody: PersistedEditorBodyV2 = {
    version: 2,
    blocks: Array.from({ length: 50 }, (_, p) => ({
      type: 'paragraph',
      content: Array.from(
        { length: Math.max(0, Math.min(1000, runs - p * 1000)) },
        (_, i) => ({ type: 'text', text: 'a', marks: i % 2 ? ['bold'] : [] }),
      ),
    })),
  };
  const article = {
    ...makeDraftTask().snapshot.article,
    title: 'Title',
    body: projectRichBody(editorBody),
  };
  return {
    version: 2 as const,
    article,
    editorBody,
    digest: createDraftSnapshotV2Digest(article, editorBody),
  };
}
