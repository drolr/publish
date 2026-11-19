import { createHash } from 'node:crypto';
import type { Page, ElementHandle, JSHandle } from 'playwright-core';
import type { SelectionCapture } from './production-upload-selection';
import type { ReasonCode, StoreBinding } from '../../../contracts/draft-task';

/** Structural observations only. No attributes, text, style URLs or HTML leave the page. */
export type OverlayDiagnostic = {
  tag: string;
  widthRatio: number;
  heightRatio: number;
  pointerEventsNone: boolean;
  interactiveDescendants: number;
  childCount: number;
  hasBackgroundImage: boolean;
  hasText: boolean;
  hasShadowRoot: boolean;
  opacity: number;
};

/** Fixed call paths, not caller supplied page strings. */
export type BlockEdgeCallsite =
  | 'unspecified'
  | 'focus-recovery'
  | 'missing-caret'
  | 'block-selection'
  | 'seat-at-leaf-end'
  | 'paragraph-tail-reuse'
  | 'select-block-reseat'
  | 'created-block-selection'
  | 'list-leaf-recovery';
export type BlockEdgeRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type BlockEdgeTag =
  | 'div'
  | 'p'
  | 'span'
  | 'br'
  | 'ul'
  | 'ol'
  | 'li'
  | 'blockquote'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'img'
  | 'label'
  | 'input'
  | 'button'
  | 'body'
  | 'html'
  | 'other'
  | 'absent';
export type BlockEdgeKind =
  | 'paragraph'
  | 'heading'
  | 'bullet-list'
  | 'ordered-list'
  | 'blockquote'
  | 'list-item'
  | 'image'
  | 'other'
  | 'absent';
export type BlockEdgeRelation =
  'target-descendant' | 'editor' | 'ancestor' | 'other' | 'absent';
export type BlockEdgeAttempt = {
  attempt: number;
  status: 'observed' | 'block-missing' | 'unavailable';
  sample?: 'sampled-before-click';
  documentVisibility?: 'visible' | 'hidden' | 'unknown';
  documentHasFocus?: boolean;
  clickStage?: 'not-started' | 'started' | 'completed' | 'exception';
  clickCompleted?: boolean;
  clickElapsedMs?: number;
  positionStage?:
    'before-click' | 'click' | 'settle' | 'post-identity' | 'completed';
  settleElapsedMs?: number;
  postIdentityElapsedMs?: number;
  clickExceptionCategory?: ReturnType<typeof exceptionCategory>;
  blockKind?: BlockEdgeKind;
  targetKind?: BlockEdgeKind;
  targetTag?: BlockEdgeTag;
  beforeScroll?: BlockEdgeRect;
  afterScroll?: BlockEdgeRect;
  scrolled?: boolean;
  viewport?: { width: number; height: number };
  point?: { x: number; y: number };
  inside?: boolean;
  blocked?: boolean;
  hitCategory?: 'popup' | 'radio' | 'element' | 'absent';
  hitTag?: BlockEdgeTag;
  hitRelation?: BlockEdgeRelation;
  /** At most six relevant ancestors, examining at most eight parents. */
  ancestors?: {
    depth: number;
    tag: BlockEdgeTag;
    rect: BlockEdgeRect;
    clipsX: boolean;
    clipsY: boolean;
    pointOutsideX: boolean;
    pointOutsideY: boolean;
    scrollLeft: number;
    scrollTop: number;
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
  }[];
  /** Only the immediate previous and next sibling. */
  siblings?: {
    side: 'previous' | 'next';
    tag: BlockEdgeTag;
    rect: BlockEdgeRect;
  }[];
  focus?: {
    active: BlockEdgeRelation;
    anchor: BlockEdgeRelation;
    focus: BlockEdgeRelation;
    collapsed: boolean | null;
    rangeCount: number;
  };
};
export type BlockEdgeDiagnostic = {
  callsite: BlockEdgeCallsite;
  blockIndex: number;
  leafIndex: number;
  /** Only the existing two hit attempts, never a new observation/retry. */
  attempts: BlockEdgeAttempt[];
};

/** Counts, fixed categories and states only; never arbitrary control labels. */
export type BodyUploadDialogDiagnostic = {
  rejection:
    | 'none'
    | 'verification'
    | 'dialog-count'
    | 'dialog-detached'
    | 'dialog-replaced'
    | 'node-limit'
    | 'preview-count'
    | 'nested-dialog'
    | 'close-name-unverified'
    | 'file-input-replaced'
    | 'selection-invalid'
    | 'unexpected-input'
    | 'unexpected-control'
    | 'material-library-count'
    | 'material-library-association'
    | 'material-library-indeterminate'
    | 'material-library-disabled-checked'
    | 'alternate-library-selected';
  dialogCount: number;
  inputConnected: boolean;
  modalConnected: boolean;
  nestedDialogCount: number;
  inputAssociation: 'retained' | 'unmounted' | 'replaced' | 'conflict';
  selectionPhase: 'before-selection' | 'selected';
  newInputFileCount: number;
  extraSelectionEventCount: number;
  preview: { total: number; visible: number; loaded: number };
  progress: { total: number; visible: number };
  /** Up to 24 controls, with the full quantity retained separately. */
  controlCount: number;
  controlStates: {
    tag:
      | 'input'
      | 'button'
      | 'a'
      | 'select'
      | 'textarea'
      | 'iframe'
      | 'label'
      | 'other';
    type:
      | 'file'
      | 'checkbox'
      | 'radio'
      | 'button'
      | 'submit'
      | 'text'
      | 'other'
      | 'absent';
    role:
      | 'button'
      | 'link'
      | 'checkbox'
      | 'radio'
      | 'switch'
      | 'tab'
      | 'other'
      | 'absent';
    visible: boolean;
    label:
      | 'material-library'
      | 'confirm'
      | 'cancel'
      | 'choose-image'
      | 'close'
      | 'upload-tab'
      | 'model-library-tab'
      | 'material-library-tab'
      | 'unknown';
    selected?: boolean | null;
    labelAssociated: boolean | null;
    checked: boolean | null;
    disabled: boolean | null;
    indeterminate: boolean | null;
  }[];
  controls: {
    file: number;
    checkbox: number;
    button: number;
    link: number;
    select: number;
    textarea: number;
    iframe: number;
    roleButton: number;
    roleLink: number;
    editable: number;
    otherInput: number;
  };
  materialLibrary: {
    association: 'absent' | 'exact' | 'conflict' | 'multiple';
    checked: boolean | null;
    disabled: boolean | null;
    indeterminate: boolean | null;
  };
};

export type DialogCounts = {
  coverShape?: {
    titleVisible: boolean;
    controlsRecognized: boolean;
    confirmVisible: boolean;
    cancelVisible: boolean;
    previewCount: number;
  };
  visibleDialogs: number;
  fileInputs: number;
  ownedCover: boolean;
  sameDialog: boolean;
  uploadAllowed: boolean;
};
export class JudongchePageError extends Error {
  constructor(
    readonly reason: ReasonCode,
    readonly check: string = 'guard-rejected',
    readonly overlay?: OverlayDiagnostic,
    readonly blockEdge?: BlockEdgeDiagnostic,
    readonly bodyUploadDialog?: BodyUploadDialogDiagnostic,
    readonly dialogCounts?: DialogCounts,
  ) {
    super(reason);
  }
}
/** Internal page-producer claim, never derived from exception text. A future
 * production producer needs evidence for every field; G1 supplies none today.
 * T5 independently rereads the unchanged editor/session/body before using it. */
export type CoverRequiredNoSaveProof = {
  explicitRejection: true;
  remoteRecordAbsent: true;
  noPendingSave: true;
  autosaveExcluded: true;
};
export class JudongcheCoverRequiredError extends JudongchePageError {
  constructor(readonly noSaveProof?: CoverRequiredNoSaveProof) {
    super('COVER_REQUIRED');
  }
}

/** Classify locally; never return the exception message or its page contents. */
export function exceptionCategory(error: unknown) {
  if (error instanceof JudongchePageError) return 'platform-guard';
  if (!(error instanceof Error)) return 'non-error';
  if (error.name === 'TimeoutError') return 'timeout';
  if (/strict mode violation/i.test(error.message)) return 'locator-not-unique';
  if (
    /Target .*closed|page.*closed|context.*closed|browser.*closed/i.test(
      error.message,
    )
  )
    return 'target-closed';
  if (/Execution context was destroyed/i.test(error.message))
    return 'navigation-interrupted';
  if (/not attached|detached from the DOM/i.test(error.message))
    return 'element-detached';
  return 'error';
}
export const fail = (reason: ReasonCode, check = 'guard-rejected'): never => {
  throw new JudongchePageError(reason, check);
};
export const origin = 'https://www.autoengine.com';
export const paths = {
  home: '/jdc/cps/home',
  editor: '/jdc/dealer/info/Article',
  list: '/jdc/dealer/info/contentPublish/content/index',
  marketing: '/jdc/dealer/info/contentPublish/sceneMarketing',
};
export function knownUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // Observed content-management article tab (2026-10-14). Keep this alias
    // exact: pageTab is not a general-purpose allowance on other pages.
    if (url.pathname === '/jdc/dealer/info/contentPublish/content/index-cps2') {
      const entries = [...url.searchParams.entries()];
      return (
        url.origin === origin &&
        !url.username &&
        !url.password &&
        !url.hash &&
        entries.length === 1 &&
        entries[0]?.[0] === 'pageTab' &&
        entries[0]?.[1] === '0'
      );
    }
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      ['/', ...Object.values(paths)].includes(url.pathname) &&
      [...url.searchParams.keys()].every((key) =>
        ['pgc_id', 'pgc_status'].includes(key),
      )
    );
  } catch {
    return false;
  }
}

/** E40 and the fail-closed safety rules. Article text is never a safety signal. */
export type OwnedBodyUploadDialog = Readonly<{
  /** Bound before selection; retained through the entire upload. */
  modal: ElementHandle<Element>;
  input: ElementHandle<Element>;
  selectionPhase: 'before-selection' | 'selected';
  /** Selected is set only after the original File and single event pair verify. */
  selection?: JSHandle<SelectionCapture>;
}>;
/** Image-local ownership/safety check for the approved lightweight writing path.
 * The ordinary path composes the same check with its full-page safety scan. */
export async function assertOwnedBodyUploadDialog(
  page: Page,
  proof: OwnedBodyUploadDialog,
): Promise<BodyUploadDialogDiagnostic | undefined> {
  if (await page.getByText('巨懂车欢迎您', { exact: true }).isVisible())
    fail('LOGIN_REQUIRED');
  const state = await page.evaluate((proof) => {
    const { modal, input, selectionPhase, selection } = proof;
    const visible = (node: Element) =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility === 'visible';
    const dialogs = Array.from(
      document.querySelectorAll(
        '[role="dialog"],[aria-modal="true"],.ant-modal',
      ),
    ).filter(visible);
    let detail: BodyUploadDialogDiagnostic | undefined;
    try {
      const count = (selector: string) =>
        modal.querySelectorAll(selector).length;
      const checkboxes = Array.from(
        modal.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
      );
      const checkbox = checkboxes.length === 1 ? checkboxes[0]! : null;
      const controls = Array.from(
        modal.querySelectorAll(
          'input,button,a,select,textarea,iframe,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=combobox],[role=slider],[role=spinbutton],[role=textbox],[role=searchbox],[role=listbox],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=scrollbar],[role=treeitem],[contenteditable]',
        ),
      );
      const images = Array.from(modal.querySelectorAll('img'));
      const progress = Array.from(
        modal.querySelectorAll('[role=progressbar],[aria-busy=true],progress'),
      );
      const files = Array.from(modal.querySelectorAll('input[type=file]'));
      detail = {
        rejection: 'none',
        dialogCount: dialogs.length,
        inputConnected: input.isConnected,
        selectionPhase,
        newInputFileCount: files
          .filter((file) => file !== input)
          .reduce(
            (count, file) =>
              count + ((file as HTMLInputElement).files?.length ?? 0),
            0,
          ),
        extraSelectionEventCount: selection?.extraSelectionEventCount ?? 0,
        modalConnected: modal.isConnected,
        nestedDialogCount: count('[role=dialog],[aria-modal=true],.ant-modal'),
        inputAssociation:
          files.length > 1
            ? 'conflict'
            : files[0] === input
              ? 'retained'
              : files.length
                ? 'replaced'
                : !input.isConnected
                  ? 'unmounted'
                  : 'conflict',
        preview: {
          total: images.length,
          visible: images.filter(visible).length,
          loaded: images.filter((img) => img.complete && img.naturalWidth > 0)
            .length,
        },
        progress: {
          total: progress.length,
          visible: progress.filter(visible).length,
        },
        controlCount: controls.length,
        controlStates: controls
          .slice(0, 24)
          .map((node): BodyUploadDialogDiagnostic['controlStates'][number] => {
            const tag = node.localName;
            const type =
              node instanceof HTMLInputElement ||
              node instanceof HTMLButtonElement
                ? node.type
                : null;
            const role = node.getAttribute('role');
            const labelAssociated =
              node instanceof HTMLInputElement
                ? node.labels?.length === 1 &&
                  node.labels[0]!.control === node &&
                  modal.contains(node.labels[0]!)
                : null;
            const label =
              node instanceof HTMLInputElement && labelAssociated
                ? node.labels![0]!.textContent?.trim()
                : node.textContent?.trim();
            return {
              tag:
                tag === 'input' ||
                tag === 'button' ||
                tag === 'a' ||
                tag === 'select' ||
                tag === 'textarea' ||
                tag === 'iframe' ||
                tag === 'label'
                  ? tag
                  : 'other',
              type:
                type === null
                  ? 'absent'
                  : type === 'file' ||
                      type === 'checkbox' ||
                      type === 'radio' ||
                      type === 'button' ||
                      type === 'submit' ||
                      type === 'text'
                    ? type
                    : 'other',
              role:
                role === null
                  ? 'absent'
                  : role === 'button' ||
                      role === 'link' ||
                      role === 'checkbox' ||
                      role === 'radio' ||
                      role === 'switch' ||
                      role === 'tab'
                    ? role
                    : 'other',
              visible: visible(node),
              label:
                label === '保存到素材库'
                  ? 'material-library'
                  : label === '确定'
                    ? 'confirm'
                    : label === '取消'
                      ? 'cancel'
                      : label === '选择图片'
                        ? 'choose-image'
                        : label === '关闭' ||
                            node.getAttribute('aria-label') === 'Close'
                          ? 'close'
                          : role === 'tab' && label === '上传图片'
                            ? 'upload-tab'
                            : role === 'tab' && label === '懂车帝车型库'
                              ? 'model-library-tab'
                              : role === 'tab' && label === '素材库'
                                ? 'material-library-tab'
                                : 'unknown',
              selected:
                role === 'tab'
                  ? node.getAttribute('aria-selected') === 'true'
                    ? true
                    : node.getAttribute('aria-selected') === 'false'
                      ? false
                      : null
                  : null,
              labelAssociated: labelAssociated ?? null,
              checked:
                node instanceof HTMLInputElement &&
                (node.type === 'checkbox' || node.type === 'radio')
                  ? node.checked
                  : null,
              disabled:
                node instanceof HTMLInputElement ||
                node instanceof HTMLButtonElement ||
                node instanceof HTMLSelectElement ||
                node instanceof HTMLTextAreaElement
                  ? node.disabled
                  : null,
              indeterminate:
                node instanceof HTMLInputElement && node.type === 'checkbox'
                  ? node.indeterminate
                  : null,
            };
          }),
        controls: {
          file: count('input[type=file]'),
          checkbox: checkboxes.length,
          button: count('button'),
          link: count('a'),
          select: count('select'),
          textarea: count('textarea'),
          iframe: count('iframe'),
          roleButton: count('[role=button]'),
          roleLink: count('[role=link]'),
          editable: count('[contenteditable]'),
          otherInput: count('input:not([type=file]):not([type=checkbox])'),
        },
        materialLibrary: {
          association: !checkboxes.length
            ? 'absent'
            : checkboxes.length > 1
              ? 'multiple'
              : checkbox?.labels?.length === 1 &&
                  checkbox.labels[0]!.control === checkbox &&
                  modal.contains(checkbox.labels[0]!) &&
                  checkbox.labels[0]!.textContent?.trim() === '保存到素材库'
                ? 'exact'
                : 'conflict',
          checked: checkbox?.checked ?? null,
          disabled: checkbox?.disabled ?? null,
          indeterminate: checkbox?.indeterminate ?? null,
        },
      };
    } catch {
      /* Optional diagnostics cannot change the existing guard. */
    }
    const result = (rejection: BodyUploadDialogDiagnostic['rejection']) => ({
      rejection,
      detail: detail ? { ...detail, rejection } : undefined,
    });
    if (
      dialogs.some((dialog) =>
        /验证码|安全验证|身份验证|账号异常|帐号异常|风险提示|安全提示|人机验证/.test(
          dialog.textContent ?? '',
        ),
      )
    )
      return result('verification');
    if (dialogs.length !== 1) return result('dialog-count');
    if (dialogs[0] !== modal) return result('dialog-replaced');
    if (!modal.isConnected) return result('dialog-detached');
    if (modal.querySelector('[role=dialog],[aria-modal=true],.ant-modal'))
      return result('nested-dialog');
    if (modal.querySelectorAll('*').length > 120) return result('node-limit');
    if (modal.querySelectorAll('img').length > 1)
      return result('preview-count');
    if (
      selection?.extraSelectionEventCount ||
      (selectionPhase === 'selected' &&
        (!selection ||
          selection.invalid ||
          selection.inputCount !== 1 ||
          selection.changeCount !== 1 ||
          selection.files.length !== 1))
    )
      return result('selection-invalid');
    const files = Array.from(
      modal.querySelectorAll<HTMLInputElement>('input[type=file]'),
    );
    const replacement =
      files.length === 1 && files[0] !== input ? files[0] : undefined;
    if (
      files.length > 1 ||
      (input.isConnected && !modal.contains(input)) ||
      (selectionPhase === 'before-selection' &&
        (files[0] !== input || !input.isConnected)) ||
      (replacement &&
        (selectionPhase !== 'selected' ||
          input.isConnected ||
          replacement.files?.length !== 0))
    )
      return result('file-input-replaced');
    // The observed close uses its own exact name. An unverified association can
    // override aria-label; do not guess what an aria-labelledby chain names.
    if (
      Array.from(modal.querySelectorAll('button,[role=button]')).some(
        (node) =>
          node.hasAttribute('aria-labelledby') &&
          ['Close', '关闭'].includes(
            node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '',
          ),
      )
    )
      return result('close-name-unverified');
    const checkboxes = Array.from(
      modal.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
    );
    if (checkboxes.length > 1) return result('material-library-count');
    const library = checkboxes[0];
    if (library) {
      const associated = (() => {
        try {
          const labels = library.labels;
          return (
            labels?.length === 1 &&
            labels[0]!.control === library &&
            modal.contains(labels[0]!) &&
            labels[0]!.textContent?.trim() === '保存到素材库' &&
            !labels[0]!.closest(
              'a,button,[role=button],[role=link],[role=tab],[contenteditable]',
            ) &&
            (!library.getAttribute('role') ||
              library.getAttribute('role') === 'checkbox')
          );
        } catch {
          return false;
        }
      })();
      if (!associated) return result('material-library-association');
      if (library.indeterminate)
        return result('material-library-indeterminate');
      if (library.disabled && library.checked)
        return result('material-library-disabled-checked');
    }
    const unknown = Array.from(
      modal.querySelectorAll(
        'input,button,a,select,textarea,iframe,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=combobox],[role=slider],[role=spinbutton],[role=textbox],[role=searchbox],[role=listbox],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=scrollbar],[role=treeitem],[contenteditable]',
      ),
    ).find((node) => {
      if (node instanceof HTMLInputElement)
        return !(
          ((node === input || node === replacement) && node.type === 'file') ||
          node === library
        );
      if (
        node.matches('a,select,textarea,iframe,[contenteditable]') ||
        node.closest('a,[role=link],[contenteditable]')
      )
        return true;
      const role = node.getAttribute('role');
      if (role === 'tab')
        return (
          node instanceof HTMLButtonElement ||
          !['上传图片', '懂车帝车型库', '素材库'].includes(
            node.textContent?.trim() ?? '',
          )
        );
      if (role !== null && role !== 'button') return true;
      if (
        node instanceof HTMLButtonElement &&
        ['选择图片', '确定', '取消'].includes(node.textContent?.trim() ?? '')
      )
        return false;
      return !(
        (node instanceof HTMLButtonElement || role === 'button') &&
        ['Close', '关闭'].includes(
          node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '',
        )
      );
    });
    // Attribute absence is diagnostic-only: E34 establishes names, not a required
    // tab DOM or aria-selected shape. Explicit alternate selection is unsafe.
    if (
      Array.from(modal.querySelectorAll('[role=tab][aria-selected=true]')).some(
        (tab) =>
          ['懂车帝车型库', '素材库'].includes(tab.textContent?.trim() ?? ''),
      )
    )
      return result('alternate-library-selected');
    return result(
      !unknown
        ? 'none'
        : unknown instanceof HTMLInputElement
          ? unknown.type === 'file'
            ? 'file-input-replaced'
            : 'unexpected-input'
          : 'unexpected-control',
    );
  }, proof);
  if (state.rejection !== 'none')
    throw new JudongchePageError(
      state.rejection === 'verification'
        ? 'VERIFICATION_REQUIRED'
        : 'PAGE_CHANGED',
      state.rejection === 'verification'
        ? 'guard-rejected'
        : state.rejection === 'selection-invalid'
          ? 'body-selected-file-mismatch'
          : state.rejection.startsWith('material-library-')
            ? 'body-' + state.rejection
            : 'unknown-dialog',
      undefined,
      undefined,
      state.detail,
    );
  return state.detail;
}
export async function assertSafe(
  page: Page,
  imageDialog = false,
  verifiedSelectionModal?: ElementHandle<Element>,
  ownedBodyUpload?: OwnedBodyUploadDialog,
): Promise<void> {
  if (!knownUrl(page.url())) fail('PAGE_CHANGED', 'url-not-allowed');
  if (await page.getByText('巨懂车欢迎您', { exact: true }).isVisible())
    fail('LOGIN_REQUIRED');
  if (ownedBodyUpload) await assertOwnedBodyUploadDialog(page, ownedBodyUpload);
  const state = await page.evaluate(
    ({ allowImage, verifiedSelectionModal, ownedBodyUpload }) => {
      const visible = (e: Element) =>
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility === 'visible';
      const leaves = Array.from(document.querySelectorAll('body *')).filter(
        (e) =>
          visible(e) &&
          !e.children.length &&
          !e.closest('[contenteditable],textarea,input'),
      );
      if (
        leaves.some((e) =>
          /验证码|安全验证|身份验证|账号异常|帐号异常|风险提示|安全提示|人机验证/.test(
            e.textContent || '',
          ),
        )
      )
        return 'VERIFICATION_REQUIRED';
      if (
        leaves.some((e) =>
          /暂无权限|无权限访问|权限不足/.test(e.textContent || ''),
        )
      )
        return 'PERMISSION_DENIED';
      if (Array.from(document.querySelectorAll('iframe')).some(visible))
        return 'visible-iframe';
      const dialogs = Array.from(
        document.querySelectorAll(
          '[role="dialog"],[aria-modal="true"],.ant-modal',
        ),
      ).filter(visible);
      let coverShape:
        | {
            titleVisible: boolean;
            controlsRecognized: boolean;
            confirmVisible: boolean;
            cancelVisible: boolean;
            previewCount: number;
          }
        | undefined;
      const filelessOwnedUpload = (dialog: Element) => {
        if (
          dialog !== verifiedSelectionModal ||
          dialog.querySelectorAll('input[type=file]').length !== 0
        )
          return false;
        const elements = Array.from(dialog.querySelectorAll('*')).filter(
          visible,
        );
        const leaf = (text: string) =>
          elements.filter(
            (n) => !n.childElementCount && n.textContent?.trim() === text,
          ).length === 1;
        const buttons = (text: string) =>
          elements.filter(
            (n) => n.tagName === 'BUTTON' && n.textContent?.trim() === text,
          ).length === 1;
        const controls = Array.from(
          dialog.querySelectorAll(
            'input,button,a,select,textarea,iframe,[role=button],[role=link],[contenteditable]',
          ),
        );
        const knownControls = controls.every((node) => {
          if (
            node.getAttribute('role') === 'button' &&
            ['Close', '关闭'].includes(node.getAttribute('aria-label') ?? '') &&
            !node.closest('a,[role=link],[contenteditable]')
          )
            return true;
          if (node instanceof HTMLInputElement)
            return (
              node.type === 'checkbox' &&
              node.labels?.length === 1 &&
              node.labels[0]!.control === node &&
              node.labels[0]!.textContent?.trim() === '保存到素材库'
            );
          return (
            node instanceof HTMLButtonElement &&
            !node.closest('a,[role=link]') &&
            (['选择图片', '确定', '取消'].includes(
              node.textContent?.trim() ?? '',
            ) ||
              node.getAttribute('aria-label') === 'Close')
          );
        });
        coverShape = {
          titleVisible: leaf('上传图片'),
          controlsRecognized: knownControls,
          confirmVisible: buttons('确定'),
          cancelVisible: buttons('取消'),
          previewCount: dialog.querySelectorAll('img').length,
        };
        return (
          coverShape.titleVisible &&
          // A verified selection may unmount its input before its preview,
          // completion marker, preview or footer appears. This admission does not
          // authorize confirmation; terminal() must still verify the selected file,
          // loaded preview, completion marker and library checkbox before a click.
          knownControls &&
          dialog.querySelectorAll('input[type=checkbox]').length <= 1 &&
          dialog.querySelectorAll('*').length <= 120 &&
          dialog.querySelectorAll('img').length <= 1 &&
          ((buttons('确定') && buttons('取消')) ||
            !elements.some(
              (n) =>
                n.tagName === 'BUTTON' &&
                /^(确定|取消)$/.test(n.textContent?.trim() ?? ''),
            ))
        );
      };
      const image =
        allowImage &&
        dialogs.length === 1 &&
        (ownedBodyUpload
          ? !verifiedSelectionModal &&
            dialogs[0] === ownedBodyUpload.modal &&
            ownedBodyUpload.modal.isConnected
          : dialogs[0]!.querySelectorAll('input[type=file]').length === 1 ||
            filelessOwnedUpload(dialogs[0]!))
          ? dialogs[0]!
          : null;
      if (dialogs.some((dialog) => dialog !== image)) {
        const sameDialog =
          dialogs.length === 1 && dialogs[0] === verifiedSelectionModal;
        const fileInputs = dialogs.reduce(
          (n, dialog) => n + dialog.querySelectorAll('input[type=file]').length,
          0,
        );
        const check = !verifiedSelectionModal
          ? 'unknown-dialog'
          : dialogs.length !== 1
            ? 'cover-upload-dialog-count'
            : !sameDialog
              ? 'cover-upload-dialog-replaced'
              : fileInputs === 0
                ? 'cover-upload-fileless-shape'
                : 'cover-upload-file-control-count';
        return {
          check,
          dialogCounts: {
            ...(coverShape ? { coverShape } : {}),
            visibleDialogs: dialogs.length,
            fileInputs,
            ownedCover: !!verifiedSelectionModal,
            sameDialog,
            uploadAllowed: allowImage,
          },
        };
      }
      // Unrecognized blocking overlays must not be clicked through.
      const overlay = Array.from(document.querySelectorAll('body *')).find(
        (e) => {
          if (
            !visible(e) ||
            (allowImage &&
              e.closest('[role="dialog"],[aria-modal="true"],.ant-modal'))
          )
            return false;
          // Only the unique approved image dialog's own structural wrapper or
          // empty Arco backdrop is permitted. Unrelated overlays remain unknown.
          if (
            image &&
            (e.contains(image) ||
              (e.classList.contains('arco-modal-mask') &&
                !e.textContent?.trim() &&
                !e.querySelector('input,button,a,[role="button"]') &&
                e.parentElement ===
                  image.closest('.arco-modal-wrapper')?.parentElement))
          )
            return false;
          const s = getComputedStyle(e),
            r = e.getBoundingClientRect();
          // Observed 2026-09-28: a full-viewport, empty background-only div
          // cannot intercept input. Size alone must not classify it as a dialog.
          // Content, descendants, semantic controls and solid masks still stop.
          if (
            e.tagName === 'DIV' &&
            s.pointerEvents === 'none' &&
            e.childElementCount === 0 &&
            !e.textContent?.trim() &&
            !e.shadowRoot &&
            !e.matches('[role],[aria-modal],[tabindex],[contenteditable]') &&
            s.backgroundImage !== 'none' &&
            ['transparent', 'rgba(0, 0, 0, 0)'].includes(s.backgroundColor)
          )
            return false;
          return (
            s.position === 'fixed' &&
            r.width > innerWidth * 0.7 &&
            r.height > innerHeight * 0.7
          );
        },
      );
      if (overlay) {
        const style = getComputedStyle(overlay);
        const rect = overlay.getBoundingClientRect();
        const tag = overlay.tagName.toLowerCase();
        const details: OverlayDiagnostic = {
          tag: ['div', 'section', 'main', 'aside', 'span'].includes(tag)
            ? tag
            : 'other',
          widthRatio: Math.round((rect.width / innerWidth) * 100) / 100,
          heightRatio: Math.round((rect.height / innerHeight) * 100) / 100,
          pointerEventsNone: style.pointerEvents === 'none',
          interactiveDescendants: Math.min(
            10000,
            overlay.querySelectorAll(
              'input,button,a,select,textarea,[role="button"],[contenteditable],[tabindex]',
            ).length,
          ),
          childCount: Math.min(10000, overlay.childElementCount),
          hasBackgroundImage: style.backgroundImage !== 'none',
          hasText: !!overlay.textContent?.trim(),
          hasShadowRoot: !!overlay.shadowRoot,
          opacity: Number(style.opacity),
        };
        return { check: 'blocking-overlay', overlay: details };
      }
      return null;
    },
    { allowImage: imageDialog, verifiedSelectionModal, ownedBodyUpload },
  );
  if (state) {
    if (typeof state === 'object' && state.dialogCounts)
      throw new JudongchePageError(
        'PAGE_CHANGED',
        state.check,
        undefined,
        undefined,
        undefined,
        state.dialogCounts,
      );
    if (typeof state === 'object')
      throw new JudongchePageError('PAGE_CHANGED', state.check, state.overlay);
    if (state === 'VERIFICATION_REQUIRED' || state === 'PERMISSION_DENIED')
      fail(state);
    fail('PAGE_CHANGED', state);
  }
}

/** E54: current-login badge and the name must belong to the same store card.
 * No account name is compiled into the adapter. Ambiguous header/menu stops. */
export type MenuObservation = {
  point: 'before-hover' | 'after-hover' | 'badge-visible' | 'failure';
  entryCount: number;
  entryVisible: boolean;
  entryHovered: boolean;
  entryCenterHit: boolean;
  badgeCount: number;
  visibleBadges: number;
  documentFocused: boolean;
  documentVisible: boolean;
  documentChanged: boolean;
};

export async function confirmMenuStore(
  page: Page,
  expected: string,
  diagnostic?: {
    step(value: string): void;
    failure(error: unknown): void;
    observation?(value: MenuObservation): void;
  },
): Promise<void> {
  diagnostic?.step('menu-safety');
  await assertSafe(page);
  let opened = false;
  let account = '';
  let documentEpoch: number | undefined;
  async function observe(point: MenuObservation['point']) {
    if (!diagnostic?.observation) return;
    try {
      const { epoch, ...state } = await page.evaluate((name) => {
        const visible = (e: Element) =>
          e.getClientRects().length > 0 &&
          getComputedStyle(e).visibility === 'visible';
        const entries = Array.from(
          document.querySelectorAll('header *,[role="banner"] *'),
        ).filter((e) => !e.children.length && e.textContent?.trim() === name);
        const entry = entries.length === 1 ? entries[0] : undefined;
        const rect = entry?.getBoundingClientRect();
        const hit = rect
          ? document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            )
          : null;
        const badges = Array.from(document.querySelectorAll('body *')).filter(
          (e) => !e.children.length && e.textContent?.trim() === '当前登录',
        );
        return {
          epoch: performance.timeOrigin,
          entryCount: Math.min(entries.length, 100),
          entryVisible: !!entry && visible(entry),
          entryHovered: !!entry?.matches(':hover'),
          entryCenterHit:
            !!entry && !!hit && (entry === hit || entry.contains(hit)),
          badgeCount: Math.min(badges.length, 100),
          visibleBadges: Math.min(badges.filter(visible).length, 100),
          documentFocused: document.hasFocus(),
          documentVisible: document.visibilityState === 'visible',
        };
      }, account);
      documentEpoch ??= epoch;
      diagnostic.observation({
        point,
        ...state,
        documentChanged: epoch !== documentEpoch,
      });
    } catch {
      /* Observation cannot change the safety result. */
    }
  }
  if (!(await page.getByText('当前登录', { exact: true }).isVisible())) {
    diagnostic?.step('menu-banner');
    const banner = page.getByRole('banner');
    await banner.waitFor({ state: 'visible', timeout: 10000 });
    if ((await banner.count()) !== 1) fail('STORE_UNCONFIRMED');
    diagnostic?.step('menu-account-candidates');
    const candidates = await banner.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return Array.from(node.querySelectorAll('*'))
        .filter((e) => {
          const r = e.getBoundingClientRect(),
            t = (e.textContent || '').trim();
          return (
            !e.children.length &&
            r.width > 0 &&
            r.left > box.left + box.width * 0.7 &&
            t.length > 0 &&
            !/^(会话|帮助中心|通知|功能引导|\d+\+?)$/.test(t) &&
            !e.closest('a')
          );
        })
        .map((e) => (e.textContent || '').trim());
    });
    if (candidates.length !== 1) fail('STORE_UNCONFIRMED');
    account = candidates[0]!;
    await observe('before-hover');
    const entry = banner.getByText(account, { exact: true });
    diagnostic?.step('menu-account-leave');
    // One initial entry transition, never a retry after an ambiguous outcome.
    await banner.hover({ position: { x: 1, y: 1 }, timeout: 5000 });
    await entry
      .and(page.locator(':hover'))
      .waitFor({ state: 'hidden', timeout: 5000 });
    diagnostic?.step('menu-account-open');
    // Owner-confirmed hover menu. A click can toggle the menu after mouse entry.
    const hoverDocument = {
      url: page.url(),
      epoch: await page.evaluate(() => performance.timeOrigin),
    };
    let acknowledged = true;
    try {
      await entry.hover({ timeout: 5000 });
    } catch (error) {
      if (exceptionCategory(error) !== 'timeout') throw error;
      diagnostic?.step('menu-account-timeout-evidence');
      const badge = page.getByText('当前登录', { exact: true });
      if (
        page.url() !== hoverDocument.url ||
        (await page.evaluate(() => performance.timeOrigin)) !==
          hoverDocument.epoch ||
        (await badge.count()) !== 1 ||
        !(await badge.isVisible())
      )
        throw error;
      await assertSafe(page);
      acknowledged = false;
    }
    await observe('after-hover');
    if (acknowledged) {
      diagnostic?.step('menu-account-hover-state');
      await entry
        .and(page.locator(':hover'))
        .waitFor({ state: 'visible', timeout: 5000 });
    }
    opened = true;
  }
  try {
    diagnostic?.step('menu-current-login-badge');
    await page
      .getByText('当前登录', { exact: true })
      .waitFor({ state: 'visible', timeout: 5000 });
    await observe('badge-visible');
    diagnostic?.step('menu-open-safety');
    await assertSafe(page);
    diagnostic?.step('menu-store-card');
    const matches = await page.evaluate((name) => {
      const visible = (e: Element) =>
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility === 'visible';
      const leaves = Array.from(document.querySelectorAll('body *')).filter(
        (e) => !e.children.length && visible(e),
      );
      const badges = leaves.filter((e) => e.textContent?.trim() === '当前登录');
      const names = leaves.filter((e) => e.textContent?.trim() === name);
      if (
        badges.length !== 1 ||
        names.length !== 1 ||
        !leaves.some((e) => e.textContent?.trim() === '全部业务')
      )
        return false;
      let node: Element | null = badges[0]!;
      for (
        let depth = 0;
        node && depth < 6;
        depth++, node = node.parentElement
      ) {
        if (!node.contains(names[0]!)) continue;
        const text = node.textContent || '';
        return (
          (text.match(/角色/g) || []).length === 1 &&
          !/全部业务|退出登录/.test(text)
        );
      }
      return false;
    }, expected);
    if (!matches) fail('STORE_CHANGED');
  } catch (error) {
    await observe('failure');
    diagnostic?.failure(error);
    throw error;
  } finally {
    if (opened && account) {
      diagnostic?.step('menu-account-close');
      await page
        .getByRole('banner')
        .hover({ position: { x: 1, y: 1 }, timeout: 5000 });
      await page
        .getByText('当前登录', { exact: true })
        .waitFor({ state: 'hidden', timeout: 5000 });
    }
  }
}

export function storeBinding(id: string, name: string): StoreBinding {
  return {
    storeKey: createHash('sha256')
      .update('judongche:dealer_id\0')
      .update(id)
      .digest('hex'),
    displayName: name,
    identity: { source: 'visible-shop-link', value: id },
  };
}
