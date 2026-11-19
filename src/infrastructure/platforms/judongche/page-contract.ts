import type { UploadWaits } from './upload-waits';
import type { RichTextBlock } from '../../../contracts/rich-text-body';
import type { RichEditorEvidence } from './rich-content-evidence';
import type { CoverStageGate } from './production-cover-driver';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { BrowserSession } from '../../automation/browser-session';
import type {
  CoverEvidence,
  RemoteRef,
  SessionProbe,
} from '../../../contracts/draft-task';
import {
  emptyEditorPlaceholderSelector,
  unknownEditorEvidence,
  type AcknowledgedTitleEdit,
  type EditorEvidence,
  type ObservedBlock,
} from './content-evidence';
export type { EditorEvidence, ObservedBlock } from './content-evidence';
/** Internal, owner-approved single-article exception; never an automatic store proof. */
export type JudongchePageOptions = {
  uploadWaits?: UploadWaits;
  manualReview?: boolean;
  batchSubmissionReview?: 'operator';
  /** Read back only after saveOnce positively acknowledged its sole request. */
  automaticDraftReview?: boolean;
  ownerConfirmedPilot?: {
    dealerId: string;
    storeName: string;
  };
  /** Only the explicitly approved, already-saved legacy task may be accepted. */
  reviewedSavedTask?: { taskId: string; title: string; recordKey: string };
  /** Internal historical recovery only; never renderer supplied or used during execute. */
  acknowledgedTitleEdit?: AcknowledgedTitleEdit;
};
export interface JudongcheReadPages {
  probe(): Promise<SessionProbe>;
  inspectEditor(): Promise<EditorEvidence>;
  /** Optional only for historical V1 ports. V2 never falls back. */
  inspectRichEditor?(): Promise<RichEditorEvidence>;
  inspectRichDraft?(remote: RemoteRef): Promise<RichEditorEvidence | undefined>;
  inspectDraft(remote: RemoteRef): Promise<EditorEvidence | undefined>;
  locateDraft(remote: RemoteRef): Promise<RemoteRef | undefined>;
  /** Diagnostic only: zero exact-title drafts never releases a task or authorizes replay. */
  inspectDraftAbsence?(title: string): Promise<boolean>;
}
import type { CoverUploadInput, CoverUploadOutcome } from './cover-pages';
export interface JudongchePages extends JudongcheReadPages {
  bindTaskForContinuation?(taskId: string, generation: string): void;
  captureHandledTaskContinuation?(
    taskId: string,
  ): (cancelled: () => boolean) => Promise<SessionProbe>;
  /** Live task/root/images/activity observation, independent of body parsing.
   * Always supplied by production; optional only for historical in-memory ports. */
  inspectOperationEditor?(): Promise<EditorEvidence>;
  /** Infrastructure-only diagnostics; never changes task settlement or retries. */
  reportAdapterFailure?(error: unknown): void;
  readonly writesOnEditorReady?: boolean;
  readonly batchSubmissionReview?: 'operator';
  saveForOperatorReview?(
    stopped: () => boolean,
    observed?: (
      submission: import('../../../contracts/draft-task').Submission,
    ) => Promise<void>,
  ): Promise<import('../../../contracts/draft-task').Submission>;
  returnHomeAfterSubmission?(stopped: () => boolean): Promise<void>;
  returnHomeAfterHandledTask?(
    taskId: string,
    cancelled: () => boolean,
  ): Promise<SessionProbe>;
  /** Absent only on legacy test ports; new local policy must treat absence as unsupported. */
  readonly localCoverUpload?: 'supported' | 'unsupported';
  uploadLocalCover?(
    input: CoverUploadInput,
    stopped: () => boolean,
  ): Promise<CoverUploadOutcome>;
  readonly manualReview?: boolean;
  readonly automaticDraftReview?: boolean;
  /** Live positive save acknowledgement or an explicitly bound saved record. */
  confirmedDraftSave?(taskId: string, title: string): boolean;
  readonly acknowledgedTitleEdit?: AcknowledgedTitleEdit;
  reviewSavedDraft?(
    taskId: string,
    title: string,
    editedTitle?: string,
  ): Promise<EditorEvidence>;
  /** Controlled single-article write checkpoint: stop/session/navigation only. */
  checkWritingContext?(stopped?: () => boolean): Promise<void>;
  enterNewEditor(
    title?: string,
    stopped?: () => boolean,
    taskId?: string,
    operatorBatch?: boolean,
  ): Promise<void>;
  fillTitle(text: string): Promise<void>;
  appendParagraph(text: string): Promise<void>;
  appendTextBlock?(block: RichTextBlock, stopped: () => boolean): Promise<void>;
  reviewRichSavedDraft?(
    taskId: string,
    title: string,
    editedTitle?: string,
  ): Promise<RichEditorEvidence>;
  appendImage(
    bytes: Uint8Array,
    mime: 'image/jpeg' | 'image/png',
  ): Promise<string>;
  chooseFirstCover(): Promise<CoverEvidence>;
  saveOnce(): Promise<void>;
}
export { JudongchePageError } from './production-state';
import { productionPages } from './production-pages';
// E43/E45 distinguish the main candidate from the independent empty textbox.
// These are observation candidates only: none authorizes writes or readiness.
const candidates = {
  title: 'textarea',
  body: 'div[contenteditable="true"]:not([role])',
  emptyPlaceholder: emptyEditorPlaceholderSelector,
};

/** Bounded structural observation, NOT page recognition or persisted evidence.
 * E53-E57 add the uploaded DIV image shape and a sample-stable web_uri token.
 * The token is hashed before it leaves this helper; no CDN URL is retained.
 */
export async function readEditorEvidence(
  page: Page,
  parsedShape = false,
  imageOnly: boolean | 'all' = false,
): Promise<EditorEvidence> {
  const before = page.url();
  try {
    const result = await page.evaluate(
      ({ title, body, emptyPlaceholder, imageOnly }) => {
        const styleVisible = (node: Element): boolean => {
          for (
            let cursor: Element | null = node;
            cursor;
            cursor = cursor.parentElement
          ) {
            const style = getComputedStyle(cursor);
            if (
              style.display === 'none' ||
              style.visibility !== 'visible' ||
              Number(style.opacity) === 0 ||
              cursor.hasAttribute('hidden')
            )
              return false;
          }
          return true;
        };
        const visibleWithBox = (node: Element): boolean => {
          if (!styleVisible(node)) return false;
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        };
        const titles = Array.from(
          document.querySelectorAll<HTMLTextAreaElement>(title),
        ).filter(visibleWithBox);
        const bodies = Array.from(
          document.querySelectorAll<HTMLElement>(body),
        ).filter(visibleWithBox);
        if (titles.length !== 1 || bodies.length !== 1) return null;
        const blocks: ObservedBlock[] = [];
        let supported = true;
        const image = (node: HTMLImageElement): boolean => {
          if (!visibleWithBox(node)) return false;
          blocks.push({
            type: 'image',
            resourceKey: '',
            loaded:
              node.complete && node.naturalWidth > 0 && node.naturalHeight > 0,
          });
          return true;
        };
        const resourceToken = (node: HTMLImageElement): string => {
          const attribute = node.getAttribute('web_uri');
          if (!attribute) return '';
          try {
            const url = new URL(node.currentSrc || node.src);
            return url.protocol === 'https:' &&
              url.searchParams.getAll('web_uri').length === 1 &&
              url.searchParams.get('web_uri') === attribute
              ? attribute
              : '';
          } catch {
            return '';
          }
        };
        const latestImage =
          imageOnly === true
            ? Array.from(
                bodies[0]!.querySelectorAll(
                  ':scope > div[__syl_tag="true"][contenteditable="false"][draggable="true"]',
                ),
              ).at(-1)
            : undefined;
        const nodes =
          imageOnly === true
            ? latestImage
              ? [latestImage]
              : []
            : Array.from(bodies[0]!.childNodes);
        for (const child of nodes) {
          if (
            imageOnly === 'all' &&
            (!(child instanceof Element) ||
              (child.tagName !== 'IMG' && !child.querySelector('img[src]')))
          )
            continue;
          if (child.nodeType === Node.TEXT_NODE) {
            if (child.textContent?.trim()) supported = false;
            if (!supported) break;
            continue;
          }
          if (!(child instanceof Element) || !styleVisible(child)) continue;
          if (child instanceof HTMLImageElement) {
            image(child);
            continue;
          }
          if (
            child.tagName === 'DIV' &&
            child.getAttribute('__syl_tag') === 'true' &&
            child.getAttribute('contenteditable') === 'false' &&
            child.getAttribute('draggable') === 'true'
          ) {
            const visibleImages = Array.from(
              child.querySelectorAll<HTMLImageElement>('img'),
            ).filter(visibleWithBox);
            const displayed = Array.from(
              child.querySelectorAll<HTMLImageElement>(
                '.pgc-image .pgc-img-wrapper img',
              ),
            ).filter(visibleWithBox);
            if (
              !visibleWithBox(child) ||
              visibleImages.length !== 1 ||
              displayed.length !== 1 ||
              visibleImages[0] !== displayed[0]
            ) {
              supported = false;
              break;
            }
            const visible = displayed[0]!;
            const hidden = Array.from(
              child.querySelectorAll<HTMLImageElement>('templ img'),
            );
            const token = resourceToken(visible);
            blocks.push({
              type: 'image',
              resourceKey:
                hidden.length === 1 && resourceToken(hidden[0]!) === token
                  ? token
                  : '',
              loaded:
                visible.complete &&
                visible.naturalWidth > 0 &&
                visible.naturalHeight > 0,
            });
            continue;
          }
          if (child.tagName !== 'P') {
            supported = false;
            break;
          }
          if (
            child.matches(emptyPlaceholder) &&
            child.childNodes.length === 3 &&
            child.children[0]?.childElementCount === 0 &&
            child.textContent === '请输入正文'
          )
            continue;
          if (
            child.children.length === 1 &&
            child.children[0]?.tagName === 'BR' &&
            child.children[0].classList.contains('ProseMirror-trailingBreak') &&
            !child.textContent?.trim()
          ) {
            // Only the final editable caret paragraph is editor padding. The
            // same markup between body blocks is a visible blank paragraph;
            // dropping it would certify an incorrectly spaced saved draft.
            if (child !== bodies[0]!.lastElementChild)
              blocks.push({ type: 'paragraph', text: '' });
            continue;
          }
          let text = '';
          let hadImage = false;
          let hadVisibleSpan = false;
          const flush = () => {
            blocks.push({ type: 'paragraph', text });
            text = '';
          };
          const walk = (node: Node) => {
            if (node.nodeType === Node.TEXT_NODE) {
              text += node.textContent ?? '';
              return;
            }
            if (!(node instanceof Element) || !styleVisible(node)) return;
            if (node instanceof HTMLImageElement) {
              if (visibleWithBox(node)) {
                if (text.length) flush();
                hadImage = image(node) || hadImage;
              }
              return;
            }
            if (node.tagName === 'BR') {
              text += '\n';
              return;
            }
            if (node.tagName !== 'SPAN') {
              supported = false;
              return;
            }
            hadVisibleSpan = true;
            node.childNodes.forEach(walk);
          };
          child.childNodes.forEach(walk);
          if (
            text.length ||
            (!hadImage && (!child.hasChildNodes() || hadVisibleSpan))
          )
            flush();
        }
        return supported ? { title: titles[0]!.value, blocks } : null;
      },
      { ...candidates, imageOnly },
    );
    if (page.url() !== before || !result) return unknownEditorEvidence();
    return {
      ...unknownEditorEvidence(),
      ...result,
      known: parsedShape,
      blocks: result.blocks.map((block) =>
        block.type === 'image' && block.resourceKey
          ? {
              ...block,
              resourceKey: createHash('sha256')
                .update('judongche:web_uri\0')
                .update(block.resourceKey)
                .digest('hex'),
            }
          : block,
      ),
    };
  } catch {
    return unknownEditorEvidence();
  }
}

export function createJudongchePages(
  session: BrowserSession,
  diagnostic?: import('./production-pages').ProbeDiagnosticSink,
  options?: JudongchePageOptions,
  coverStages?: CoverStageGate,
): JudongchePages {
  return productionPages(
    session,
    (page, imageOnly) => readEditorEvidence(page, true, imageOnly),
    diagnostic,
    options,
    coverStages,
  );
}
