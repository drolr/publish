import { createHash } from 'node:crypto';
import {
  CoverUploadInputSchema,
  type CoverUploadInput,
  type CoverUploadFile,
} from '../../../contracts/cover-upload';
import {
  CoverReportSchema,
  type CoverReport,
} from '../../../contracts/cover-task';
import type { ReasonCode } from '../../../contracts/draft-task';
import type { EditorEvidence } from './content-evidence';
import { sameStore } from './content-evidence';
import { fail, JudongchePageError } from './production-state';

export type {
  CoverUploadInput,
  CoverUploadFile,
} from '../../../contracts/cover-upload';
/** Upload-window associations only; T5 must verify loaded reopened resources
 * before producing a final confirmed CoverReport. Digest values may repeat. */
export type CoverUploadItem = CoverReport['confirmedItems'][number];
export type SafeEditorProof = {
  generation: string;
  contextKey: string;
  storeKey: string;
  bodyDigest: string;
  modalClosed: true;
  uploadsSettled: true;
};
export type CoverUploadOutcome =
  | { status: 'completed'; items: CoverUploadItem[]; libraryUnchecked: true }
  | {
      status: 'recoverable_failure';
      reason:
        'UPLOAD_REJECTED' | 'UPLOAD_INCOMPLETE' | 'LIBRARY_OPTION_UNVERIFIED';
      items: CoverUploadItem[];
      safeEditorProof: SafeEditorProof;
    }
  | { status: 'blocked'; reason: ReasonCode };
export type CoverPageObservation = {
  generation: string;
  editor: EditorEvidence;
  modal: 'closed' | 'owned' | 'unknown';
  settlement: 'settled' | 'pending' | 'unknown';
  mode: 'single' | 'triple' | null;
  result: 'complete' | 'incomplete' | 'rejected' | null;
  libraryChecked: boolean | null;
  items: (CoverUploadItem & { loaded: boolean })[];
};
/** INTERNAL single capability. A driver requires separately evidenced semantics;
 * no production driver is enabled while G1 is OPEN. Tests use a synthetic one.
 * guard must enforce existing login/security/store/document checks. inspect must
 * observe current state; modal closure alone must NEVER imply settlement. */
export interface CoverPageDriver {
  guard(): Promise<void>;
  inspect(): Promise<CoverPageObservation>;
  open(mode: CoverUploadInput['mode']): Promise<void>;
  upload(files: CoverUploadFile[]): Promise<void>;
  waitForUpload(): Promise<void>;
  uncheckLibrary(): Promise<void>;
  confirm(): Promise<void>;
  cancel(): Promise<void>;
  /** Release local observation handles only; never click or change platform data. */
  dispose?(): Promise<void>;
}
const bodyDigest = (e: EditorEvidence) =>
  createHash('sha256')
    .update(JSON.stringify({ title: e.title, blocks: e.blocks }))
    .digest('hex');
function sameEditor(
  before: CoverPageObservation,
  after: CoverPageObservation,
): boolean {
  return (
    !!before.generation &&
    before.generation === after.generation &&
    before.editor.known &&
    after.editor.known &&
    !!before.editor.contextKey &&
    before.editor.contextKey === after.editor.contextKey &&
    !!before.editor.editorUrl &&
    before.editor.editorUrl === after.editor.editorUrl &&
    !!before.editor.store &&
    sameStore(after.editor.store, before.editor.store) &&
    bodyDigest(before.editor) === bodyDigest(after.editor)
  );
}
function associations(
  input: CoverUploadInput,
  o: CoverPageObservation,
): CoverUploadItem[] {
  const items = o.items.map(({ position, assetKey, sha256, resourceKey }) => ({
    position,
    assetKey,
    sha256,
    resourceKey,
  }));
  const parsed = CoverReportSchema.safeParse({
    phase: 'pending',
    requestedMode: input.mode,
    expectedCount: input.files.length,
    confirmedItems: items,
    reason: null,
    updatedAt: '2026-10-09T00:00:00.000Z',
  });
  if (!parsed.success) return fail('PAGE_CHANGED');
  if (
    o.items.some(
      (i) =>
        i.loaded !== true ||
        input.files[i.position]?.assetKey !== i.assetKey ||
        input.files[i.position]?.sha256 !== i.sha256,
    )
  )
    fail('PAGE_CHANGED');
  return parsed.data.confirmedItems;
}
/** Fixed internal labels; no platform content is passed to diagnostics. */
export type CoverFailureStep =
  | 'guard'
  | 'inspect'
  | 'verify'
  | 'open'
  | 'upload'
  | 'wait-for-upload'
  | 'uncheck-library'
  | 'confirm'
  | 'cancel';
export function createLocalCoverUploader(
  driver: CoverPageDriver,
  onFailure?: (error: unknown, step: CoverFailureStep) => void,
) {
  // One live invocation per driver; overlapping uploads never start effects.
  let active = false;
  return async (
    raw: CoverUploadInput,
    stopped: () => boolean,
  ): Promise<CoverUploadOutcome> => {
    if (active) return { status: 'blocked', reason: 'PAGE_CHANGED' };
    const parsed = CoverUploadInputSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.files.some(
        (f) => createHash('sha256').update(f.bytes).digest('hex') !== f.sha256,
      )
    )
      return { status: 'blocked', reason: 'INPUT_UNSUPPORTED' };
    const input: CoverUploadInput = {
      mode: parsed.data.mode,
      files: parsed.data.files.map((f) => ({
        ...f,
        bytes: new Uint8Array(f.bytes),
      })),
    };
    active = true;
    let step: CoverFailureStep = 'verify';
    try {
      const stop = () => {
        if (stopped()) fail('STOP_REQUESTED');
      };
      async function checkpoint() {
        stop();
        step = 'guard';
        await driver.guard();
        stop();
        step = 'inspect';
        const value = structuredClone(await driver.inspect());
        step = 'verify';
        stop();
        return value;
      }
      const before = await checkpoint();
      if (
        before.modal !== 'closed' ||
        before.settlement !== 'settled' ||
        before.editor.pendingUploads ||
        !sameEditor(before, before)
      )
        fail('PAGE_CHANGED');
      async function current(modal: 'closed' | 'owned', settled = false) {
        const value = await checkpoint();
        if (
          !sameEditor(before, value) ||
          value.modal !== modal ||
          (settled &&
            (value.settlement !== 'settled' || value.editor.pendingUploads))
        )
          fail('PAGE_CHANGED');
        return value;
      }
      async function recover(
        reason:
          'UPLOAD_REJECTED' | 'UPLOAD_INCOMPLETE' | 'LIBRARY_OPTION_UNVERIFIED',
        items: CoverUploadItem[],
      ): Promise<CoverUploadOutcome> {
        await current('owned', true);
        stop();
        step = 'cancel';
        await driver.cancel();
        const after = await current('closed', true);
        // Explicit settlement AND unchanged current editor, never catch-all fallback.
        return {
          status: 'recoverable_failure',
          reason,
          items,
          safeEditorProof: {
            generation: after.generation,
            contextKey: after.editor.contextKey!,
            storeKey: after.editor.store!.storeKey,
            bodyDigest: bodyDigest(after.editor),
            modalClosed: true,
            uploadsSettled: true,
          },
        };
      }
      stop();
      step = 'open';
      await driver.open(input.mode);
      const opened = await current('owned', true);
      if (opened.mode !== input.mode) fail('PAGE_CHANGED');
      stop();
      step = 'upload';
      await driver.upload(input.files);
      await current('owned');
      stop();
      step = 'wait-for-upload';
      await driver.waitForUpload();
      let uploaded = await current('owned', true);
      if (uploaded.mode !== input.mode) fail('PAGE_CHANGED');
      if (uploaded.result === null) fail('PAGE_CHANGED');
      const items = associations(input, uploaded);
      if (uploaded.result === 'rejected')
        return await recover('UPLOAD_REJECTED', items);
      if (
        uploaded.result === 'incomplete' ||
        items.length !== input.files.length
      )
        return await recover('UPLOAD_INCOMPLETE', items);
      if (uploaded.result !== 'complete') fail('PAGE_CHANGED');
      if (uploaded.libraryChecked === true) {
        stop();
        step = 'uncheck-library';
        await driver.uncheckLibrary();
        uploaded = await current('owned', true);
      }
      if (uploaded.libraryChecked !== false)
        return await recover('LIBRARY_OPTION_UNVERIFIED', items);
      // Fresh false readback immediately before confirm; uploaded identities must
      // still match after toggling the option. No retries, mode changes or replacement.
      uploaded = await current('owned', true);
      if (uploaded.mode !== input.mode || uploaded.result !== 'complete')
        fail('PAGE_CHANGED');
      if (uploaded.libraryChecked !== false)
        return await recover('LIBRARY_OPTION_UNVERIFIED', items);
      if (
        JSON.stringify(associations(input, uploaded)) !== JSON.stringify(items)
      )
        fail('PAGE_CHANGED');
      stop();
      step = 'confirm';
      await driver.confirm();
      const selected = await current('closed', true);
      if (
        selected.mode !== input.mode ||
        selected.result !== 'complete' ||
        JSON.stringify(associations(input, selected)) !== JSON.stringify(items)
      )
        fail('PAGE_CHANGED');
      return { status: 'completed', items, libraryUnchecked: true };
    } catch (error) {
      try {
        onFailure?.(error, step);
      } catch {
        /* Diagnostics must never change a blocked result or start effects. */
      }
      return {
        status: 'blocked',
        reason:
          error instanceof JudongchePageError ? error.reason : 'PAGE_CHANGED',
      };
    } finally {
      try {
        await driver.dispose?.();
      } catch {
        /* Cleanup cannot change the saved outcome. */
      }
      active = false;
    }
  };
}
