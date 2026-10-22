import type { CoverReport } from '../../../contracts/cover-task';
import { effectiveCoverPolicy } from '../../../domain/cover-task';
import type {
  CoverEvidence,
  RemoteRef,
  StoreBinding,
} from '../../../contracts/draft-task';
export type ObservedBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'image'; resourceKey: string; loaded: boolean };
// E68: the real empty editor contains this noneditable UI widget, not body text.
// Callers additionally require exactly three child nodes and exact prompt text.
export const emptyEditorPlaceholderSelector =
  'p:has(> span.syl-placeholder.ProseMirror-widget[ignoreel="true"][contenteditable="false"]:first-child):has(> img.ProseMirror-separator[alt=""]:not([src]):nth-child(2)):has(> br.ProseMirror-trailingBreak:nth-child(3):last-child)';
export interface EditorEvidence {
  store: StoreBinding | null;
  remote: RemoteRef | null;
  isDraft: boolean;
  title: string;
  blocks: ObservedBlock[];
  cover: CoverEvidence | null;
  known: boolean;
  // Positive values require a recognized context and visible completion evidence.
  // Task5 has not established these contracts on production pages.
  contextKey: string | null;
  editorUrl: string | null;
  pendingUploads: boolean;
  coverLoaded: boolean;
  /** Independent optional observation. No production cover association is evidenced while G1 is OPEN. */
  localCover?: {
    known: boolean;
    mode: 'none' | 'single' | 'triple' | null;
    items: { position: number; resourceKey: string; loaded: boolean }[];
    pendingUploads: boolean;
  };
}
/** Unknown observations are never persistence/success evidence. An empty image
 * resourceKey explicitly means no stable resource association has been proved. */
export const unknownEditorEvidence = (): EditorEvidence => ({
  store: null,
  remote: null,
  isDraft: false,
  title: '',
  blocks: [],
  cover: null,
  known: false,
  contextKey: null,
  editorUrl: null,
  pendingUploads: true,
  coverLoaded: false,
  localCover: { known: false, mode: null, items: [], pendingUploads: true },
});
import {
  DraftEvidenceSchema,
  RemoteRefSchema,
  type DraftTask,
} from '../../../contracts/draft-task';

export function validRemote(remote: RemoteRef): boolean {
  if (!RemoteRefSchema.safeParse(remote).success) return false;
  return validEditorUrl(remote.editUrl);
}
export function validEditorUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://www.autoengine.com' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname === '/jdc/dealer/info/Article'
    );
  } catch {
    return false;
  }
}
export function sameStore(
  left: StoreBinding | null,
  right: StoreBinding,
): boolean {
  return (
    left !== null &&
    left.storeKey === right.storeKey &&
    left.identity.source === right.identity.source &&
    left.identity.value === right.identity.value
  );
}
export function sameRemote(
  left: RemoteRef | null,
  right: RemoteRef | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    validRemote(left) &&
    validRemote(right) &&
    left.recordKey === right.recordKey &&
    left.editUrl === right.editUrl
  );
}
/** Trusted composition-only acknowledgement of an intentional post-save title edit.
 * It never changes the original snapshot or the observed remote title. */
export interface AcknowledgedTitleEdit {
  taskId: string;
  snapshotDigest: string;
  storeKey: string;
  recordKey: string;
  originalTitle: string;
  editedTitle: string;
}
export function titleEditApplies(
  task: DraftTask,
  edit: AcknowledgedTitleEdit,
): boolean {
  return (
    task.state === 'needs_human' &&
    task.saveAttempted &&
    task.possibleRemoteEffect &&
    task.holdsPlatform &&
    task.taskId === edit.taskId &&
    task.snapshot.digest === edit.snapshotDigest &&
    task.store.storeKey === edit.storeKey &&
    task.snapshot.article.title === edit.originalTitle &&
    edit.editedTitle.trim().length > 0 &&
    edit.editedTitle.length <= 200 &&
    edit.editedTitle !== edit.originalTitle &&
    /^\d+$/.test(edit.recordKey) &&
    (!task.evidence.remote || task.evidence.remote.recordKey === edit.recordKey)
  );
}
export function matchesContent(
  task: DraftTask,
  observed: EditorEvidence,
  count = task.snapshot.article.body.length,
): boolean {
  return matchesContentTitle(
    task,
    observed,
    count,
    task.snapshot.article.title,
  );
}
function matchesContentTitle(
  task: DraftTask,
  observed: EditorEvidence,
  count: number,
  expectedTitle: string,
): boolean {
  if (
    !DraftEvidenceSchema.safeParse(task.evidence).success ||
    !observed.known ||
    !sameStore(observed.store, task.store) ||
    observed.pendingUploads ||
    (!!task.coverPlan &&
      task.coverPlan.snapshot.mode !== 'none' &&
      observed.localCover?.pendingUploads === true) ||
    observed.title !== expectedTitle ||
    observed.blocks.length !== count
  )
    return false;
  const expected = task.snapshot.article.body.slice(0, count);
  if (
    task.evidence.images.length !==
    expected.filter((block) => block.type === 'image').length
  )
    return false;
  return expected.every((block, index) => {
    const found = observed.blocks[index];
    if (block.type === 'paragraph')
      return found?.type === 'paragraph' && found.text === block.text;
    const evidence = task.evidence.images.find(
      (image) => image.bodyIndex === index,
    );
    return (
      found?.type === 'image' &&
      found.loaded &&
      !!evidence &&
      evidence.imageId === block.image_id &&
      evidence.resourceKey === found.resourceKey &&
      task.snapshot.article.assets.some(
        (asset) =>
          asset.imageId === block.image_id &&
          asset.assetKey === evidence.assetKey,
      )
    );
  });
}
export function verifyEvidence(
  task: DraftTask,
  observed: EditorEvidence,
): boolean {
  return verifyContentTitle(task, observed, task.snapshot.article.title);
}
export function verifyAcknowledgedTitleEdit(
  task: DraftTask,
  observed: EditorEvidence,
  edit: AcknowledgedTitleEdit,
): boolean {
  return (
    titleEditApplies(task, edit) &&
    observed.remote?.recordKey === edit.recordKey &&
    verifyContentTitle(task, observed, edit.editedTitle)
  );
}
function verifyContentTitle(
  task: DraftTask,
  observed: EditorEvidence,
  expectedTitle: string,
): boolean {
  return (
    matchesContentTitle(
      task,
      observed,
      task.snapshot.article.body.length,
      expectedTitle,
    ) &&
    observed.isDraft &&
    (!task.coverPlan ||
      (!!observed.contextKey &&
        observed.editorUrl === task.evidence.remote?.editUrl)) &&
    sameRemote(observed.remote, task.evidence.remote) &&
    (['manual-after-draft', 'local-upload-v1'].includes(
      effectiveCoverPolicy(task),
    ) ||
      (!!task.evidence.cover &&
        observed.coverLoaded &&
        observed.cover?.source === 'store-material-first' &&
        observed.cover.resourceKey === task.evidence.cover.resourceKey))
  );
}

/** Cover result is independent of body verification. Window associations are
 * pending until a unique bound draft is reopened with exactly loaded resources. */
export function verifyLocalCover(
  task: DraftTask,
  observed: EditorEvidence,
): CoverReport {
  if (!task.coverPlan) throw Error('Local cover plan required');
  const report = structuredClone(task.coverPlan.report);
  report.updatedAt = new Date().toISOString();
  // No cover was requested. Platform-selected covers on reopen are outside
  // this task's contract; body and unique-draft proof remain mandatory.
  if (task.coverPlan.snapshot.mode === 'none')
    return { ...report, phase: 'not_configured', reason: null };
  // An explicit upload/local-byte failure remains a warning after body success.
  if (
    report.phase === 'failed' ||
    (report.phase === 'needs_human' && report.reason !== 'PAGE_UNVERIFIED')
  )
    return report;
  const cover = observed.localCover;
  if (
    !verifyEvidence(task, observed) ||
    cover?.pendingUploads ||
    !cover?.known
  ) {
    return { ...report, phase: 'needs_human', reason: 'PAGE_UNVERIFIED' };
  }
  const matches =
    cover.mode === task.coverPlan.snapshot.mode &&
    cover.items.length === report.expectedCount &&
    report.confirmedItems.length === report.expectedCount &&
    cover.items.every(
      (item, index) =>
        item.loaded &&
        item.position === index &&
        report.confirmedItems[index]?.position === index &&
        report.confirmedItems[index]?.resourceKey === item.resourceKey,
    );
  if (!matches) return { ...report, phase: 'failed', reason: 'COVER_MISMATCH' };
  return {
    ...report,
    phase: report.requestedMode === 'none' ? 'not_configured' : 'confirmed',
    reason: null,
  };
}
