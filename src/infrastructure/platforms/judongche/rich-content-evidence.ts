import { createHash } from 'node:crypto';
import {
  PersistedEditorBodyV2Schema,
  type RichTextBlock,
  type PersistedEditorBodyV2,
} from '../../../contracts/rich-text-body';
import {
  DraftEvidenceSchema,
  snapshotBodyLength,
  type DraftTask,
} from '../../../contracts/draft-task';
import { verifyDraftSnapshotIntegrity } from '../../draft-snapshot-integrity';
import { richBodyEquals } from '../../../domain/rich-text-body';
import {
  sameStore,
  sameRemote,
  validEditorUrl,
  validRemote,
  type EditorEvidence,
} from './content-evidence';
export type ObservedRichBlock =
  RichTextBlock | { type: 'image'; resourceKey: string; loaded: boolean };
export type RichEditorEvidence = EditorEvidence & {
  rich: { formatKnown: boolean; blocks: ObservedRichBlock[] };
};
function semanticBody(blocks: ObservedRichBlock[]) {
  return PersistedEditorBodyV2Schema.safeParse({
    version: 2,
    blocks: blocks.map((b) =>
      b?.type === 'image' ? { type: 'image', imageId: 'evidence-image' } : b,
    ),
  });
}
export function richEvidenceKnown(
  observed: EditorEvidence,
): observed is RichEditorEvidence {
  return (
    observed.known &&
    !!observed.store &&
    !!observed.contextKey &&
    !!observed.editorUrl &&
    validEditorUrl(observed.editorUrl) &&
    (!observed.remote ||
      (validRemote(observed.remote) &&
        observed.editorUrl === observed.remote.editUrl)) &&
    observed.rich?.formatKnown === true &&
    Array.isArray(observed.rich.blocks) &&
    semanticBody(observed.rich.blocks).success
  );
}
function canonicalLineEndings(
  body: PersistedEditorBodyV2,
): PersistedEditorBodyV2 {
  const canonical = PersistedEditorBodyV2Schema.parse(body);
  for (const block of canonical.blocks) {
    if (block.type === 'image') continue;
    const leaves =
      block.type === 'list'
        ? block.items
        : block.type === 'blockquote'
          ? block.paragraphs
          : [block];
    for (const leaf of leaves)
      for (const run of leaf.content)
        run.text = run.text.replace(/\r\n?/g, '\n');
  }
  return PersistedEditorBodyV2Schema.parse(canonical);
}
export function matchesRichContent(
  task: DraftTask,
  observed: EditorEvidence,
  prefixCount = snapshotBodyLength(task.snapshot),
): boolean {
  return matchesRichContentTitle(
    task,
    observed,
    prefixCount,
    task.snapshot.article.title,
  );
}
export function matchesRichContentTitle(
  task: DraftTask,
  observed: EditorEvidence,
  count: number,
  title: string,
): boolean {
  if (
    task.snapshot.version !== 2 ||
    !richEvidenceKnown(observed) ||
    !DraftEvidenceSchema.safeParse(task.evidence).success ||
    !sameStore(observed.store, task.store) ||
    !observed.contextKey ||
    !observed.editorUrl ||
    !validEditorUrl(observed.editorUrl) ||
    observed.pendingUploads ||
    (!!task.coverPlan &&
      task.coverPlan.snapshot.mode !== 'none' &&
      observed.localCover?.pendingUploads === true) ||
    observed.title !== title ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > task.snapshot.editorBody.blocks.length ||
    observed.rich.blocks.length !== count ||
    (observed.remote &&
      task.evidence.remote &&
      !sameRemote(observed.remote, task.evidence.remote))
  )
    return false;
  try {
    verifyDraftSnapshotIntegrity(task.snapshot);
  } catch {
    return false;
  }
  const expected = task.snapshot.editorBody.blocks.slice(0, count);
  if (
    task.evidence.images.length !==
    expected.filter((b) => b.type === 'image').length
  )
    return false;
  const blocks = observed.rich.blocks.map((b, index) => {
    if (b.type !== 'image') return b;
    const wanted = expected[index];
    const proof = task.evidence.images.find((i) => i.bodyIndex === index);
    if (
      wanted?.type !== 'image' ||
      !b.loaded ||
      !proof ||
      proof.imageId !== wanted.imageId ||
      proof.resourceKey !== b.resourceKey ||
      !task.snapshot.article.assets.some(
        (a) => a.imageId === wanted.imageId && a.assetKey === proof.assetKey,
      )
    )
      return null;
    return { type: 'image' as const, imageId: wanted.imageId };
  });
  if (blocks.some((b) => b === null)) return false;
  const actual = PersistedEditorBodyV2Schema.safeParse({ version: 2, blocks });
  return (
    actual.success &&
    richBodyEquals(
      canonicalLineEndings({ version: 2, blocks: expected }),
      canonicalLineEndings(actual.data),
    )
  );
}
/** Shared cover proof: V1 bytes stay unchanged; V2 includes exact canonical semantics and resource associations. */
export function editorBodyDigest(e: EditorEvidence): string {
  if (e.rich) {
    if (!richEvidenceKnown(e)) throw Error('Unknown rich editor semantics');
    const normalized = semanticBody(e.rich.blocks);
    if (!normalized.success) throw Error('Unknown rich editor semantics');
    const images = e.rich.blocks.flatMap((b, index) =>
      b.type === 'image'
        ? [{ index, resourceKey: b.resourceKey, loaded: b.loaded }]
        : [],
    );
    return createHash('sha256')
      .update(
        JSON.stringify({
          domain: 'rich-editor-proof-v2',
          title: e.title,
          body: canonicalLineEndings(normalized.data),
          images,
        }),
      )
      .digest('hex');
  }
  return createHash('sha256')
    .update(JSON.stringify({ title: e.title, blocks: e.blocks }))
    .digest('hex');
}
