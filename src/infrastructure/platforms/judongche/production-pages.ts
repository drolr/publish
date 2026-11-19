import {
  inspectEditorControls,
  inspectParagraphTarget,
  restoreEmptyParagraphCaret,
} from './production-write-diagnostic';
import { defaultUploadWaits } from './upload-waits';
import {
  appendRichTextBlock,
  unknownRichEditorEvidence,
} from './production-rich-text';
import {
  createPlaywrightEditorDom,
  createRichTextDomPort,
} from './production-rich-text-dom';
import { readRichEditorBlocks } from './rich-editor-dom';
import { clickEditorLeafEnd } from './production-editor-position';
import { assertEntrySafe } from './production-notice';
import { draftListResponseSchema } from '../../../contracts/judongche-draft-list';
import {
  createProductionCoverDriver,
  assertOwnedCoverModal,
  readProductionLocalCover,
  hasEmptyProductionCover,
  productionCoverUploadSupported,
  type OwnedCoverModalProof,
  type CoverStageGate,
  type CoverOpenDiagnostic,
  type CoverTerminalDiagnostic,
} from './production-cover-driver';
import { createLocalCoverUploader, type CoverUploadInput } from './cover-pages';
import {
  uploadBodyImage,
  createBodyImageWait,
  type BodyImageUploadRecord,
  type BodyImageUploadOutcome,
} from './production-body-image-driver';
import {
  createPath,
  observeEditorEntrySave,
  observeLiveSaves,
  entrySaveBusy,
} from './production-editor-entry';
import { randomUUID } from 'node:crypto';
import type { Page, ElementHandle, Request, Response } from 'playwright-core';
import { errors } from 'playwright-core';
import type { BrowserSession } from '../../automation/browser-session';
import type { RemoteRef, StoreBinding } from '../../../contracts/draft-task';
import type { RichTextBlock } from '../../../contracts/rich-text-body';
import type { JudongchePages, JudongchePageOptions } from './page-contract';
import {
  emptyEditorPlaceholderSelector,
  unknownEditorEvidence,
  sameRemote,
  sameStore,
  type EditorEvidence,
} from './content-evidence';
import {
  assertSafe,
  confirmMenuStore as platformConfirmMenuStore,
  fail,
  JudongchePageError,
  exceptionCategory,
  origin,
  paths,
  storeBinding,
  type OverlayDiagnostic,
  type MenuObservation,
  type BlockEdgeDiagnostic,
  type OwnedBodyUploadDialog,
  type BodyUploadDialogDiagnostic,
  assertOwnedBodyUploadDialog,
} from './production-state';

const diag = (event: string, data?: unknown) => {
  if (process.env.JUDONGCHE_DIAG !== '1') return;
  console.error(
    '[jdc] ' + event + ' ' + (data === undefined ? '' : JSON.stringify(data)),
  );
};

const bodySelector = 'div[contenteditable="true"]:not([role])';
const draftListPath = '/motor/dealer_admin/go_api/marketing/article/list';

/** Read only the known entry's bounded structure, never text, attributes or URLs. */
async function inspectEntryStructure(p: Page) {
  const label = p.getByText('文章资讯', { exact: true });
  return {
    labelCount: await label.count(),
    directParentButtonCount: await label
      .locator('..')
      .getByRole('button', { name: '立即发布', exact: true })
      .count(),
    labels: await label.evaluateAll((nodes) => {
      const visible = (e: Element) =>
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility === 'visible';
      const tag = (e: Element) =>
        ['div', 'span', 'section', 'article', 'button', 'a', 'p'].includes(
          e.localName,
        )
          ? e.localName
          : 'other';
      return nodes.slice(0, 4).map((node) => {
        const ancestors = [];
        let parent = node.parentElement;
        for (
          let depth = 1;
          parent && parent !== document.body && depth <= 5;
          depth++, parent = parent.parentElement
        ) {
          const matches = Array.from(parent.querySelectorAll('*')).filter(
            (e) =>
              e.textContent?.trim() === '立即发布' &&
              !Array.from(e.children).some(
                (child) => child.textContent?.trim() === '立即发布',
              ),
          );
          ancestors.push({
            depth,
            tag: tag(parent),
            publishCount: matches.length,
            controls: matches.slice(0, 6).map((e) => ({
              tag: tag(e),
              visible: visible(e),
              buttonRole: e.getAttribute('role') === 'button',
              parentTag: e.parentElement ? tag(e.parentElement) : 'other',
              parentButtonRole:
                e.parentElement?.getAttribute('role') === 'button',
            })),
          });
        }
        return { visible: visible(node), ancestors };
      });
    }),
  };
}

export type BodyImageStage =
  | 'tail-position'
  | 'open'
  | 'file-control'
  | 'select-file'
  | 'preview-visible'
  | 'preview-loaded'
  | 'confirm'
  | 'dialog-end'
  | 'image-inserted'
  | 'tail-finalization'
  | 'readback';

/** Fixed, local diagnostic labels only: never page text, URLs or exception messages. */
export type ProbeDiagnostic = {
  coverClick?: import('./cover-click-observation').CoverClickObservation & {
    taskId: string;
  };
  phase: string;
  check: string;
  reason: string;
  overlay?: OverlayDiagnostic;
  blockEdge?: BlockEdgeDiagnostic;
  editorMount?: {
    budgetMs: number;
    elapsedMs: number;
    titleFirstVisibleMs: number | null;
    bodyFirstVisibleMs: number | null;
    controls: ReturnType<typeof inspectEditorControls>;
  };
  previewErrorAt?: number;
  imageIndex?: number;
  paragraphWrite?: {
    targetBlock: number;
    enterPressed?: boolean;
    stage: string;
    samples: {
      stage: string;
      line: number;
      result: ReturnType<typeof inspectParagraphTarget>;
    }[];
  };
  failureCheck?: string;
  operation?: string;
  failure?: boolean;
  exceptionCategory?: ReturnType<typeof exceptionCategory>;
  pageState?: string;
  firstFailure?: Omit<ProbeDiagnostic, 'firstFailure'>;
  coverOpen?: readonly CoverOpenDiagnostic[];
  coverTerminal?: CoverTerminalDiagnostic;
  dialogCounts?: JudongchePageError['dialogCounts'];
  bodyImage?: {
    /** One-based ordinal in the current article; never an asset identity. */
    index: number;
    stage: BodyImageStage;
    elapsedMs: number;
    status: 'waiting' | 'completed' | 'failed';
    /** Monotonic timestamp in this process; not a wall clock or stage-entry elapsed value. */
    stageStartedAt: number;
    stageElapsedMs: number;
    failureElapsedMs?: number;
    failureCause?: 'budget-exceeded' | 'guard-rejected' | 'operation-failed';
    fileSelectionCount: number;
    confirmationCount: number;
    modalClosed?: boolean;
    uploadState?: BodyImageUploadRecord['uploadState'];
    confirmTrace?: BodyImageUploadRecord['confirmTrace'];
    confirmButton?: BodyImageUploadRecord['confirmButton'];
    /** One latest record per known stage, at most eleven; polling never appends. */
    stages: {
      stage: BodyImageStage;
      status: 'waiting' | 'completed' | 'failed';
      stageStartedAt: number;
      startedElapsedMs: number;
      stageElapsedMs: number;
    }[];
    dialog?: BodyUploadDialogDiagnostic;
  };
  menuObservations?: MenuObservation[];
  entryStructure?: Awaited<ReturnType<typeof inspectEntryStructure>>;
  draftListObservation?: {
    cardCount: number;
    exactTitleCount: number;
    articleTypeVisible: boolean | null;
  };
  saveObservation?: {
    responseReceived: boolean;
    httpStatus: number | null;
    businessStatus: number | null;
  };
  draftObservation?: {
    recordKey: string;
    exactTitle: boolean;
    blockCount: number;
    imageCount: number;
  };
  searchDiagnostic?: {
    requestTitleExact: boolean;
    inputTitleExact: boolean;
    visibleCards: number;
    exactTitleMatches: number;
    draftLabels: number;
    articleLabels: number;
    emptyVisible: boolean;
    endVisible: boolean;
  };
};
export type ProbeDiagnosticSink = (event: ProbeDiagnostic) => void;

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new JudongchePageError('RESULT_AMBIGUOUS')),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Production DOM capabilities. Network requests are observed, never replayed.
 * Local SINGLE cover uses the separately guarded candidate driver. */
export function productionPages(
  session: BrowserSession,
  extract: (page: Page, imageOnly?: boolean | 'all') => Promise<EditorEvidence>,
  diagnostic?: ProbeDiagnosticSink,
  options?: JudongchePageOptions,
  coverStages?: CoverStageGate,
): JudongchePages {
  let waits = options?.uploadWaits ?? defaultUploadWaits;
  const ownerConfirmedPilot = options?.ownerConfirmedPilot
    ? Object.freeze({ ...options.ownerConfirmedPilot })
    : undefined;
  let phase = 'session';
  let operation = 'probe';
  let failureReported = false;
  let firstFailure: ProbeDiagnostic | undefined;
  let coverOpen: CoverOpenDiagnostic[] = [];
  let coverTerminal: CoverTerminalDiagnostic | undefined;
  let bodyImage: ProbeDiagnostic['bodyImage'];
  type OwnedBodyUploadOperation = {
    generation: string | null;
    page: Page;
    contextKey: string | null;
    taskId: string | null;
    record: BodyImageUploadRecord | BodyImageUploadOutcome;
  };
  let bodyUploadOperation: OwnedBodyUploadOperation | undefined;
  // Keep the retired outcome separate. Late callbacks still update their own
  // object, never whichever new operation currently owns the editor.
  let archivedBodyUploadOperation: OwnedBodyUploadOperation | undefined;
  const currentBodyUpload = () => {
    const owner = bodyUploadOperation;
    if (
      owner &&
      owner.page.isClosed() &&
      boundGeneration &&
      owner.generation !== boundGeneration &&
      session.generation() === boundGeneration &&
      primary &&
      primary !== owner.page
    ) {
      archivedBodyUploadOperation = owner;
      bodyUploadOperation = undefined;
    }
    return bodyUploadOperation?.record;
  };
  const bodyUploadUnsettled = () => {
    const current = currentBodyUpload();
    return !!current && current.uploadState !== 'settled';
  };
  let bodyImageStartedAt = 0;
  let blockEdge: BlockEdgeDiagnostic | undefined;
  let editorMount: ProbeDiagnostic['editorMount'];
  let paragraphWrite: ProbeDiagnostic['paragraphWrite'];
  let imageOrdinal = 0;
  let menuObservations: MenuObservation[] = [];
  let entryStructure: ProbeDiagnostic['entryStructure'];
  let searchDiagnostic: ProbeDiagnostic['searchDiagnostic'];
  let draftListObservation: ProbeDiagnostic['draftListObservation'];
  let saveObservation: ProbeDiagnostic['saveObservation'];
  function reportFailure(error: unknown) {
    if (failureReported) return;
    failureReported = true;
    if (bodyImage) {
      const now = performance.now();
      bodyImage = {
        ...bodyImage,
        status: 'failed',
        stageElapsedMs: now - bodyImage.stageStartedAt,
        failureElapsedMs: now - bodyImageStartedAt,
        stages: bodyImage.stages.map((entry) =>
          entry.stage === bodyImage!.stage
            ? {
                ...entry,
                status: 'failed',
                stageElapsedMs: now - entry.stageStartedAt,
              }
            : entry,
        ),
        failureCause:
          error instanceof errors.TimeoutError
            ? 'budget-exceeded'
            : error instanceof JudongchePageError
              ? 'guard-rejected'
              : 'operation-failed',
        ...(error instanceof JudongchePageError && error.bodyUploadDialog
          ? { dialog: error.bodyUploadDialog }
          : {}),
      };
    }
    let pageState = 'unavailable';
    try {
      const url = new URL((reader ?? primary)?.url() ?? '');
      pageState =
        url.origin === origin
          ? (Object.entries(paths).find(
              ([, path]) => path === url.pathname,
            )?.[0] ?? 'unknown')
          : 'unknown';
    } catch {
      /* No URL or page content is logged. */
    }
    try {
      firstFailure = {
        operation,
        phase,
        failure: true,
        pageState,
        check:
          error instanceof JudongchePageError
            ? error.check
            : 'page-operation-failed',
        reason:
          error instanceof JudongchePageError ? error.reason : 'PAGE_CHANGED',
        exceptionCategory: exceptionCategory(error),
        ...(coverOpen.length ? { coverOpen: [...coverOpen] } : {}),
        ...(coverTerminal ? { coverTerminal: { ...coverTerminal } } : {}),
        ...(bodyImage ? { bodyImage: { ...bodyImage } } : {}),
        ...(editorMount ? { editorMount: structuredClone(editorMount) } : {}),
        ...(paragraphWrite
          ? { paragraphWrite: structuredClone(paragraphWrite) }
          : {}),
        menuObservations: [...menuObservations],
        ...(saveObservation ? { saveObservation: { ...saveObservation } } : {}),
        ...(searchDiagnostic ? { searchDiagnostic } : {}),
        ...(draftListObservation ? { draftListObservation } : {}),
        ...(error instanceof JudongchePageError && error.dialogCounts
          ? { dialogCounts: error.dialogCounts }
          : {}),
        ...(error instanceof JudongchePageError && error.overlay
          ? { overlay: error.overlay }
          : {}),
        ...((error instanceof JudongchePageError && error.blockEdge) ||
        blockEdge
          ? {
              blockEdge:
                error instanceof JudongchePageError && error.blockEdge
                  ? error.blockEdge
                  : blockEdge,
            }
          : {}),
      };
      diagnostic?.(firstFailure);
    } catch {
      /* Diagnostics never affect execution. */
    }
  }
  function trace<A extends unknown[], R>(
    name: string,
    action: (...args: A) => Promise<R>,
  ) {
    return async (...args: A): Promise<R> => {
      operation = name;
      phase = name;
      failureReported = false;
      firstFailure = undefined;
      coverOpen = [];
      coverTerminal = undefined;
      bodyImage = undefined;
      blockEdge = undefined;
      editorMount = undefined;
      paragraphWrite = undefined;
      menuObservations = [];
      entryStructure = undefined;
      searchDiagnostic = undefined;
      draftListObservation = undefined;
      saveObservation = undefined;
      try {
        return await action(...args);
      } catch (error) {
        reportFailure(error);
        throw error;
      }
    };
  }
  function report(
    check: string,
    reason: string,
    overlay?: OverlayDiagnostic,
    failureCheck?: string,
  ) {
    try {
      diagnostic?.({
        operation,
        phase,
        check,
        reason,
        ...(editorMount ? { editorMount: structuredClone(editorMount) } : {}),
        ...(paragraphWrite
          ? { paragraphWrite: structuredClone(paragraphWrite) }
          : {}),
        menuObservations: [...menuObservations],
        ...(entryStructure ? { entryStructure } : {}),
        ...(searchDiagnostic ? { searchDiagnostic } : {}),
        ...(firstFailure ? { firstFailure } : {}),
        ...(coverOpen.length ? { coverOpen: [...coverOpen] } : {}),
        ...(coverTerminal ? { coverTerminal: { ...coverTerminal } } : {}),
        ...(bodyImage ? { bodyImage: { ...bodyImage } } : {}),
        ...(blockEdge ? { blockEdge } : {}),
        ...(overlay ? { overlay } : {}),
        ...(failureCheck ? { failureCheck } : {}),
      });
    } catch {
      /* Logging cannot change a safety outcome. */
    }
  }
  function reportBlockEdge(value: BlockEdgeDiagnostic) {
    blockEdge = structuredClone(value);
    report(
      'block-edge-click',
      value.attempts.at(-1)?.clickStage ?? 'sampled-before-click',
    );
  }
  let bound: StoreBinding | null = null;
  let boundGeneration: string | null = null;
  let primary: Page | null = null;
  let reader: Page | null = null;
  let contextKey: string | null = null;
  let expectedUrl: string | null = null;
  let revision = 0,
    expectedRevision = 0;
  let nativeDialog = false;
  let remote: RemoteRef | null = null;
  let title = '';
  const savedTasks = new Set<string>();
  const confirmedSaves = new Map<
    string,
    { title: string; generation: string | null }
  >();
  let activeTask: string | null = null;
  let liveTaskOwner: {
    taskId: string;
    page: Page;
    generation: string | null;
  } | null = null;
  // Independent of entry/save method listeners: covers the entire live Page,
  // including manual handling after the old writer has exited.
  let liveSaveObservation: ReturnType<typeof observeLiveSaves> | null = null;
  let entryObservation:
    (ReturnType<typeof observeEditorEntrySave> & { taskId: string }) | null =
    null;
  function clearEntryObservation() {
    entryObservation?.dispose();
    entryObservation = null;
  }
  let entryEvidence: EditorEvidence | null = null;
  let platformCaret: ElementHandle<Element> | null = null;
  let operationRoot: ElementHandle<Element> | null = null;
  let operationContext: string | null = null;
  let operationImages: string[] = [];
  let coverOperationKey: string | null = null;
  let stopped: () => boolean = () => false;
  let operatorSubmission = false;
  let submissionStarted = 0;
  let submissionSettlingStarted = 0;
  let submissionClicked = false;
  async function operatorWait<T>(work: Promise<T>): Promise<T | undefined> {
    let finished = false;
    let value: T | undefined;
    void work.then(
      (result) => {
        value = result;
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    while (!finished) {
      stop();
      if (Date.now() - submissionSettlingStarted >= 15000) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    stop();
    return value;
  }
  function assertOwnerConfiguration() {
    if (
      !options?.manualReview ||
      !ownerConfirmedPilot ||
      !/^\d+$/.test(ownerConfirmedPilot.dealerId) ||
      !ownerConfirmedPilot.storeName.trim()
    )
      fail('INPUT_UNSUPPORTED');
  }
  async function confirmMenuStore(p: Page, expected: string) {
    if (ownerConfirmedPilot) {
      assertOwnerConfiguration();
      return;
    }
    const parent = phase;
    menuObservations = [];
    await platformConfirmMenuStore(p, expected, {
      step: (step) => {
        phase = `${parent}/${step}`;
      },
      failure: reportFailure,
      observation: (value) => {
        menuObservations.push(value);
      },
    });
    phase = parent;
  }

  function page(): Page {
    const context = session.current();
    if (!context) {
      clearEntryObservation();
      if (boundGeneration && session.generation() !== boundGeneration) {
        liveSaveObservation?.dispose();
        liveSaveObservation = null;
      }
      return fail('BROWSER_UNAVAILABLE');
    }
    if (boundGeneration && session.generation() !== boundGeneration) {
      clearEntryObservation();
      liveSaveObservation?.dispose();
      liveSaveObservation = null;
      return fail('PAGE_CHANGED');
    }
    const pages = context.pages().filter((p) => p !== reader);
    if (pages.length !== 1) {
      clearEntryObservation();
      return fail('PAGE_CHANGED', 'primary-page-count');
    }
    if (primary && pages[0] !== primary) {
      clearEntryObservation();
      return fail('PAGE_CHANGED', 'primary-page-replaced');
    }
    if (!primary) {
      primary = pages[0]!;
      boundGeneration = session.generation();
      liveSaveObservation = observeLiveSaves(primary);
      const boundPage = primary;
      if (diagnostic)
        boundPage.once('crash', () => {
          if (primary !== boundPage) return;
          report('editor-page-crashed', 'cause-unknown');
        });
      primary.on('framenavigated', (frame) => {
        if (frame === primary?.mainFrame()) revision++;
      });
      primary.on('dialog', (dialog) => {
        nativeDialog = true;
        void dialog.dismiss().catch(() => {});
      });
    }
    if (nativeDialog) {
      clearEntryObservation();
      return fail('PAGE_CHANGED', 'native-dialog');
    }
    return primary;
  }
  function stop() {
    if (stopped()) {
      clearEntryObservation();
      fail('STOP_REQUESTED');
    }
  }
  async function ownedRead<T>(
    action: (p: Page) => Promise<T>,
    reportError = true,
  ): Promise<T> {
    page();
    if (reader) return fail('PAGE_CHANGED');
    reader = await session.current()!.newPage();
    try {
      const result = await action(reader);
      page();
      return result;
    } catch (error) {
      if (reportError) reportFailure(error);
      throw error;
    } finally {
      const old = reader;
      reader = null;
      await old.close();
    }
  }
  async function identify(): Promise<StoreBinding> {
    if (ownerConfirmedPilot) {
      page();
      assertOwnerConfiguration();
      // Reuse the historically observed identity key. Current store selection is
      // the owner's responsibility in this explicitly scoped, manual-review pilot.
      return storeBinding(
        ownerConfirmedPilot.dealerId,
        ownerConfirmedPilot.storeName,
      );
    }
    return ownedRead(async (p) => {
      phase = 'home-navigation';
      await p.goto(origin + paths.home);
      phase = 'home-safety';
      await assertSafe(p);
      phase = 'home-greeting';
      const greeting = p.getByText(/^您好！\d+\s+.+$/);
      await greeting.waitFor({ state: 'visible', timeout: 10000 });
      if ((await greeting.count()) !== 1 || !(await greeting.isVisible()))
        return fail('STORE_UNCONFIRMED');
      const match = /^您好！(\d+)\s+(.+)$/.exec(
        (await greeting.innerText()).trim(),
      );
      if (!match) return fail('STORE_UNCONFIRMED');
      const result = storeBinding(match[1]!, match[2]!.trim());
      phase = 'home-store-menu';
      await confirmMenuStore(p, result.displayName);
      phase = 'marketing-navigation';
      await p.goto(origin + paths.marketing);
      phase = 'marketing-safety';
      await assertSafe(p);
      phase = 'marketing-store-menu';
      await confirmMenuStore(p, result.displayName);
      phase = 'marketing-store-link';
      const links = p.locator(
        'a[href^="https://m.dcdapp.com/motor/inapp/dshop/"]:visible',
      );
      if ((await links.count()) !== 1) return fail('STORE_UNCONFIRMED');
      const href = await links.getAttribute('href');
      if (
        !href ||
        new URL(href).searchParams.get('dealer_id') !== result.identity.value
      )
        return fail('STORE_UNCONFIRMED');
      if (diagnostic && operation === 'probe') {
        try {
          entryStructure = await inspectEntryStructure(p);
        } catch {
          // Optional observation cannot affect store verification or execution.
        }
      }
      return result;
    });
  }
  async function guard(
    imageDialog = false,
    checkStop = stop,
    verifiedSelectionModal?: ElementHandle<Element>,
    ownedBodyUpload?: OwnedBodyUploadDialog,
  ) {
    const parentPhase = phase;
    phase = 'guard-stop';
    checkStop();
    phase = 'guard-page';
    const p = page();
    phase = 'guard-safety';
    if (!ownerConfirmedPilot || !imageDialog)
      await assertSafe(p, imageDialog, verifiedSelectionModal, ownedBodyUpload);
    else if (imageDialog) {
      if (verifiedSelectionModal)
        await assertSafe(p, true, verifiedSelectionModal);
      else await checkImageDialogs(p, 'owned', ownedBodyUpload);
    }
    phase = 'guard-store-binding';
    if (!bound) fail('STORE_UNCONFIRMED');
    if (contextKey) {
      phase = 'guard-url';
      if (p.url() !== expectedUrl) fail('PAGE_CHANGED', 'guard-url-changed');
      phase = 'guard-document-version';
      if (revision !== expectedRevision)
        fail('PAGE_CHANGED', 'guard-document-version-changed');
    }
    if (!ownerConfirmedPilot) {
      phase = 'guard-store-menu';
      if (!imageDialog) await confirmMenuStore(p, bound!.displayName);
      else if ((await identify()).storeKey !== bound!.storeKey)
        fail('STORE_CHANGED');
    }
    checkStop();
    page();
    // A later editor action must not be mislabeled as the completed store check.
    phase = parentPhase;
    return p;
  }
  async function coverGuard(proof?: OwnedCoverModalProof) {
    if (!activeTask) fail('PAGE_CHANGED', 'cover-task-unbound');
    const p = page();
    if (proof) await assertOwnedCoverModal(p, session.generation(), proof);
    await guard(
      !!proof,
      stop,
      proof?.selectedFileVerified ? proof.modal : undefined,
    );
    if (proof) await assertOwnedCoverModal(p, session.generation(), proof);
    else await assertSafe(p);
    return p;
  }
  async function observed(
    proof?: OwnedCoverModalProof,
  ): Promise<EditorEvidence> {
    const p = proof ? await coverGuard(proof) : await guard();
    const unknown = (why: string, data?: unknown) => {
      diag('observed-unknown', { why, ...(data as object) });
      return unknownEditorEvidence();
    };
    if (!contextKey || new URL(p.url()).pathname !== paths.editor)
      return unknown('entry', { contextKey, url: p.url() });
    const textareas = await p.locator('textarea:visible').count();
    const bodies = await p.locator(bodySelector + ':visible').count();
    if (textareas !== 1 || bodies !== 1)
      return unknown('shape', { textareas, bodies });
    const value = await extract(p);
    if (!value.known) {
      // A V2 editor holds marks and blocks the plain extractor rejects. Read the
      // rich surface instead, fail closed when it is not parseable either, and
      // keep a plain projection so entry emptiness checks still see content.
      const richBlocks = await readRichEditorBlocks(p);
      if (!richBlocks) return unknown('extract');
      if (revision !== expectedRevision || p.url() !== expectedUrl)
        return unknown('url', {
          url: p.url(),
          expectedUrl,
          revision,
          expectedRevision,
        });
      return {
        ...unknownEditorEvidence(),
        known: true,
        store: bound,
        contextKey,
        editorUrl: p.url(),
        remote,
        isDraft: !!remote,
        title: await p.locator('textarea:visible').inputValue(),
        blocks: richBlocks.map((block) =>
          block.type === 'image'
            ? {
                type: 'image' as const,
                resourceKey: block.resourceKey,
                loaded: block.loaded,
              }
            : {
                type: 'paragraph' as const,
                text:
                  block.type === 'list'
                    ? block.items
                        .map((item) =>
                          item.content.map((run) => run.text).join(''),
                        )
                        .join('\n')
                    : block.type === 'blockquote'
                      ? block.paragraphs
                          .map((paragraph) =>
                            paragraph.content.map((run) => run.text).join(''),
                          )
                          .join('\n')
                      : block.content.map((run) => run.text).join(''),
              },
        ),
        localCover: await readProductionLocalCover(p),
        pendingUploads: bodyUploadUnsettled(),
        rich: { formatKnown: true, blocks: richBlocks },
      };
    }
    // extract returns unknown on unsupported structure; use a separate shape check
    // to distinguish a genuinely empty new editor from failed extraction.
    const readTitle = await p.locator('textarea:visible').inputValue();
    if (readTitle !== value.title)
      return unknown('title-readback', { readTitle, title: value.title });
    const nonempty = await p.locator(bodySelector).innerText();
    if (
      !value.blocks.length &&
      nonempty.trim() &&
      nonempty.trim() !== '请输入正文'
    )
      return unknown('unparsed-text', { text: nonempty.slice(0, 120) });
    if (
      value.blocks.some(
        (b) => b.type === 'image' && (!b.loaded || !b.resourceKey),
      )
    )
      return unknown('image-unloaded');
    if (revision !== expectedRevision || p.url() !== expectedUrl)
      return unknown('url', {
        url: p.url(),
        expectedUrl,
        revision,
        expectedRevision,
      });
    return {
      ...value,
      known: true,
      store: bound,
      contextKey,
      editorUrl: p.url(),
      remote,
      isDraft: !!remote,
      localCover: await readProductionLocalCover(p),
      // The extractor inherits unknownEditorEvidence's pending=true placeholder;
      // this page observation owns the actual body-upload settlement.
      pendingUploads: bodyUploadUnsettled(),
    };
  }

  /** Normal operations read identity, ordered image occurrences and activity.
   * The strict body reader above remains for entry/manual/read-only evidence. */
  async function operationObserved(
    proof?: OwnedCoverModalProof,
  ): Promise<EditorEvidence> {
    const p = proof ? await coverGuard(proof) : await guard();
    if (!proof) await assertSafe(p);
    stop();
    if (!activeTask || !contextKey)
      fail('PAGE_CHANGED', 'operation-task-unbound');
    if (operationContext !== contextKey) {
      await operationRoot?.dispose().catch(() => {});
      operationRoot = null;
      await platformCaret?.dispose().catch(() => {});
      platformCaret = null;
      operationContext = contextKey;
      operationImages = [];
      coverOperationKey = null;
    }
    if (!operationRoot) operationRoot = await p.$(bodySelector);
    if (
      !operationRoot ||
      !(await operationRoot
        .evaluate(
          (root, selector) =>
            root.isConnected &&
            document.querySelectorAll(selector).length === 1 &&
            document.querySelector(selector) === root,
          bodySelector,
        )
        .catch(() => false))
    )
      fail('PAGE_CHANGED', 'operation-root-changed');
    const value = await extract(p, 'all');
    if (!value.known) fail('PAGE_CHANGED', 'operation-images-unknown');
    const images = value.blocks.filter((block) => block.type === 'image');
    if (
      images.length !== operationImages.length ||
      images.some(
        (image, index) =>
          !image.loaded ||
          !image.resourceKey ||
          image.resourceKey !== operationImages[index],
      )
    )
      fail('CONTENT_MISMATCH', 'operation-images-changed');
    const coverProjection = await readProductionLocalCover(p);
    // A strict cover projection can be unknown for manually managed content.
    // Observe active work independently; unknown formatting is not an upload.
    const coverActive = await p
      .locator('.article-cover-images')
      .evaluateAll((regions) =>
        regions.some(
          (region) =>
            !!region.querySelector(
              '[role=progressbar],[aria-busy=true],progress',
            ) ||
            Array.from(
              region.querySelectorAll<HTMLImageElement>('img:not(.plus-icon)'),
            ).some((image) => !image.complete || image.naturalWidth === 0),
        ),
      );
    const localCover = { ...coverProjection, pendingUploads: coverActive };
    const saving = await entrySaveBusy(p, false);
    stop();
    if (proof) await coverGuard(proof);
    else await guard();
    if (!proof) await assertSafe(p);
    if (
      !(await operationRoot!
        .evaluate(
          (root, selector) =>
            root.isConnected &&
            document.querySelectorAll(selector).length === 1 &&
            document.querySelector(selector) === root,
          bodySelector,
        )
        .catch(() => false))
    )
      fail('PAGE_CHANGED', 'operation-root-changed');
    const fresh = await extract(p, 'all');
    const freshImages = fresh.blocks.filter((block) => block.type === 'image');
    if (
      !fresh.known ||
      freshImages.length !== operationImages.length ||
      freshImages.some(
        (image, index) =>
          !image.loaded ||
          !image.resourceKey ||
          image.resourceKey !== operationImages[index],
      )
    )
      fail('CONTENT_MISMATCH', 'operation-images-changed');
    return {
      ...fresh,
      known: true,
      store: bound,
      contextKey,
      editorUrl: p.url(),
      remote,
      isDraft: !!remote,
      localCover,
      pendingUploads: bodyUploadUnsettled(),
      operation: {
        taskId: activeTask!,
        rootKey: operationContext!,
        coverKey: coverOperationKey,
        saving,
      },
    };
  }

  async function checkImageDialogs(
    p: Page,
    mode: 'owned' | 'closed',
    proof?: OwnedBodyUploadDialog,
  ) {
    if (proof) {
      const detail = await assertOwnedBodyUploadDialog(p, proof);
      if (bodyImage && detail) bodyImage = { ...bodyImage, dialog: detail };
      return;
    }
    const state = await p.evaluate((mode) => {
      const visible = (e: Element) =>
        e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility === 'visible';
      const dialogs = Array.from(
        document.querySelectorAll(
          '[role="dialog"],[aria-modal="true"],.ant-modal',
        ),
      ).filter(visible);
      if (
        dialogs.some((e) =>
          /验证码|安全验证|身份验证|账号异常|帐号异常|风险提示|安全提示|人机验证/.test(
            e.textContent || '',
          ),
        )
      )
        return 'verification';
      if (mode === 'closed') return dialogs.length ? 'unknown' : 'ready';
      return dialogs.length &&
        dialogs.every(
          (e) => e.querySelectorAll('input[type="file"]').length === 1,
        )
        ? 'ready'
        : 'unknown';
    }, mode);
    if (state === 'verification') fail('VERIFICATION_REQUIRED');
    if (state !== 'ready') fail('PAGE_CHANGED', 'unknown-dialog');
  }

  function invalidateInspection() {
    entryEvidence = null;
  }

  async function rememberPlatformCaret(
    p: Page,
    image?: ElementHandle<Element>,
    tailFromWrite = false,
  ) {
    await platformCaret?.dispose().catch(() => {});
    platformCaret = null;
    const value = await p.evaluateHandle(
      ({ selector, image, tailFromWrite }) => {
        const body = document.querySelector(selector);
        const selection = window.getSelection();
        let target =
          image?.nextElementSibling ??
          (tailFromWrite ? (body?.lastElementChild ?? null) : null);
        if (
          !image &&
          !tailFromWrite &&
          selection?.isCollapsed &&
          selection.anchorNode
        ) {
          const element =
            selection.anchorNode instanceof Element
              ? selection.anchorNode
              : selection.anchorNode.parentElement;
          target = element?.closest('p') ?? null;
        }
        return target?.parentElement === body &&
          target === body?.lastElementChild &&
          target.tagName === 'P' &&
          target.textContent === '' &&
          target.childNodes.length === 1 &&
          target.firstElementChild?.matches('br.ProseMirror-trailingBreak')
          ? target
          : null;
      },
      { selector: bodySelector, image, tailFromWrite },
    );
    platformCaret = value.asElement() as ElementHandle<Element> | null;
    if (!platformCaret) await value.dispose();
  }

  // Ignore recovery banners. Only current editor activity can block a write.
  async function entryIdle() {
    const p = await guard();
    const observation = entryObservation;
    if (!observation || observation.page !== p)
      fail('PAGE_CHANGED', 'editor-entry-owner-missing');
    await assertSafe(p);
    await guard();
    await checkImageDialogs(p, 'closed');
    await guard();
    observation!.assertIdle();
    const cover = await readProductionLocalCover(p);
    if (bodyUploadUnsettled() || cover.pendingUploads)
      fail('PAGE_CHANGED', 'editor-entry-upload-pending');
    if (await entrySaveBusy(p))
      fail('RESULT_AMBIGUOUS', 'editor-entry-save-busy');
    await guard();
    observation!.assertIdle();
    stop();
  }

  /** E55/E57: exact title search in the draft tab, then the actual card Edit.
   * A completed search and visible terminal state are required; no pagination
   * or general same-title attribution is attempted. */
  async function find(
    titleToFind: string,
    open: boolean,
    checkStop = stop,
  ): Promise<RemoteRef | null> {
    return ownedRead(async (p) => {
      phase = 'draft-list-navigation';
      await p.goto(origin + paths.list);
      phase = 'draft-list-safety';
      await assertSafe(p);
      phase = 'draft-list-store-menu';
      await confirmMenuStore(p, bound!.displayName);
      phase = 'draft-list-tab';
      // The 2026-11 platform build renders 草稿箱 as a status radio option and
      // repeats the same text on every draft card, so a bare text match is
      // never unique. Scope to the status filter's radio label.
      const tab = p
        .locator('label.arco-radio-button')
        .filter({ hasText: /^草稿箱(?:\(\d+\))?$/ });
      await tab.waitFor({ state: 'visible', timeout: 10000 });
      if ((await tab.count()) !== 1)
        fail('RESULT_AMBIGUOUS', 'draft-tab-not-unique');
      await tab.click();
      phase = 'draft-title-input';
      const input = p.getByPlaceholder('请搜索标题关键字', { exact: true });
      // Observe a fresh fetch/XHR caused by this search, without calling private APIs.
      // The live page searches on input: subscribe before fill, not only before Enter.
      const requested = p
        .waitForEvent('request', {
          predicate: (request) =>
            ['xhr', 'fetch'].includes(request.resourceType()) &&
            new URL(request.url()).origin === origin &&
            (decodeURIComponent(request.url()).includes(titleToFind) ||
              (request.postData() ?? '').includes(titleToFind)),
          timeout: 10000,
        })
        .catch(() => null);
      await input.fill(titleToFind);
      phase = 'draft-title-search-request';
      await input.press('Enter');
      const request = await requested;
      if (!request) fail('RESULT_AMBIGUOUS');
      phase = 'draft-title-search-response';
      await bounded(
        (async () => {
          const response = await request!.response();
          if (!response || !response.ok() || (await response.finished()))
            fail('RESULT_AMBIGUOUS');
        })(),
      );
      checkStop();
      phase = 'draft-title-search-terminal';
      await p.waitForLoadState('networkidle', { timeout: 10000 });
      await p
        .getByText('没有符合条件的内容', { exact: true })
        .or(p.locator('[class*="articleBox-"]'))
        .first()
        .waitFor({ state: 'visible', timeout: 10000 });
      await assertSafe(p);
      phase = 'draft-results-store-menu';
      await confirmMenuStore(p, bound!.displayName);
      phase = 'draft-results-cardinality';
      const cards = p.locator('[class*="articleBox-"]:visible');
      const empty = await p
        .getByText('没有符合条件的内容', { exact: true })
        .isVisible();
      if (diagnostic) {
        try {
          // Fixed counts and booleans only; retain the matched request's title
          // equality without logging the title, response body, URL or headers.
          searchDiagnostic = {
            requestTitleExact:
              new URL(request!.url()).searchParams.get('title') === titleToFind,
            inputTitleExact: (await input.inputValue()) === titleToFind,
            visibleCards: await cards.count(),
            exactTitleMatches: await cards
              .getByText(titleToFind, { exact: true })
              .count(),
            draftLabels: await cards
              .getByText('草稿箱', { exact: true })
              .count(),
            articleLabels: await cards
              .getByText('文章资讯', { exact: true })
              .count(),
            emptyVisible: empty,
            endVisible: await p
              .getByText('暂无更多数据', { exact: true })
              .isVisible(),
          };
          report('search-result-observed', 'readonly');
        } catch {
          // Optional diagnostics cannot authorize or prevent task settlement.
        }
      }
      if (empty && (await cards.count()) === 0) return null;
      if (empty || (await cards.count()) !== 1) return fail('RESULT_AMBIGUOUS');
      const card = cards.first();
      if (
        (await card.getByText(titleToFind, { exact: true }).count()) !== 1 ||
        !(await card.getByText('草稿箱', { exact: true }).isVisible()) ||
        !(await card.getByText('文章资讯', { exact: true }).isVisible())
      )
        return fail('RESULT_AMBIGUOUS');
      if (!(await p.getByText('暂无更多数据', { exact: true }).isVisible()))
        return fail('RESULT_AMBIGUOUS');
      if (!open) return fail('RESULT_AMBIGUOUS');
      const edit = card.getByRole('button', { name: '编辑', exact: true });
      if ((await edit.count()) !== 1) return fail('RESULT_AMBIGUOUS');
      await edit.click();
      await p.waitForURL(
        (u) =>
          u.pathname === paths.editor &&
          /^\d+$/.test(u.searchParams.get('pgc_id') || ''),
        { timeout: 10000 },
      );
      await assertSafe(p);
      await confirmMenuStore(p, bound!.displayName);
      return {
        recordKey: new URL(p.url()).searchParams.get('pgc_id')!,
        editUrl: p.url(),
      };
    });
  }
  async function reopen(ref: RemoteRef, associated = false) {
    const url = new URL(ref.editUrl);
    if (
      url.origin !== origin ||
      url.pathname !== paths.editor ||
      url.searchParams.get('pgc_id') !== ref.recordKey ||
      !/^\d+$/.test(ref.recordKey)
    )
      fail('RESULT_AMBIGUOUS');
    const p = page();
    await p.goto(ref.editUrl);
    await assertSafe(p);
    await confirmMenuStore(p, bound!.displayName);
    if (p.url() !== ref.editUrl) fail('RESULT_AMBIGUOUS');
    expectedUrl = p.url();
    expectedRevision = revision;
    contextKey ??= randomUUID();
    remote = associated ? ref : null;
  }
  async function emptyTail(p: Page) {
    const locator = p.locator(bodySelector).locator(':scope > p').last();
    if ((await locator.count()) !== 1) fail('PAGE_CHANGED');
    const tail = await locator.elementHandle({ timeout: 1000 });
    if (!tail) fail('PAGE_CHANGED');
    try {
      // Validate emptiness and its index on one bound node in one DOM read.
      // Passing that same identity prevents the helper from accepting a new P
      // inserted at the validated index between this read and positioning.
      const index = await tail!.evaluate(
        (node, { selector, placeholder, root }) => {
          const bodies = document.querySelectorAll(selector);
          const body = bodies.length === 1 ? bodies[0] : null;
          if (
            !node.isConnected ||
            (root && body !== root) ||
            node.parentElement !== body ||
            body?.lastElementChild !== node
          )
            return -1;
          const empty =
            !(node as HTMLElement).innerText.trim() ||
            (node.matches(placeholder) &&
              node.childNodes.length === 3 &&
              node.children[0]?.childElementCount === 0 &&
              node.textContent === '请输入正文');
          return empty ? Array.prototype.indexOf.call(body.children, node) : -1;
        },
        {
          selector: bodySelector,
          placeholder: emptyEditorPlaceholderSelector,
          root: operationRoot,
        },
      );
      if (index < 0) fail('PAGE_CHANGED');
      await clickEditorLeafEnd(p, bodySelector, index, 0, {
        callsite: 'unspecified',
        clickTimeout: waits.caretClick,
        identity: tail!,
        diagnostic: reportBlockEdge,
        stop,
      });
      return { index, target: tail! };
    } catch (error) {
      await tail!.dispose().catch(() => {});
      throw error;
    }
  }

  // A successful create response can precede visibility in a fresh draft list.
  // Only repeat this read; never replay upload or save, or swallow other guards.
  async function reviewSavedDraft(
    taskId: string,
    reviewedTitle: string,
    editedTitle?: string,
  ): Promise<EditorEvidence> {
    for (let attempt = 0; ; attempt++) {
      stop();
      try {
        return await readSavedDraftOnce(taskId, reviewedTitle, editedTitle);
      } catch (error) {
        const saved = confirmedSaves.get(taskId);
        if (
          !(error instanceof JudongchePageError) ||
          error.reason !== 'RESULT_AMBIGUOUS' ||
          error.check !== 'draft-title-missing' ||
          attempt >= 2 ||
          editedTitle !== undefined ||
          saved?.title !== reviewedTitle ||
          saved.generation !== session.generation()
        ) {
          reportFailure(error);
          throw error;
        }
        stop();
        page();
        report('draft-visibility-pending', 'readonly');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        stop();
        page();
      }
    }
  }

  async function readSavedDraftOnce(
    taskId: string,
    reviewedTitle: string,
    editedTitle?: string,
  ): Promise<EditorEvidence> {
    const legacy = options?.reviewedSavedTask;
    const legacyMatches =
      legacy?.taskId === taskId && legacy.title === reviewedTitle;
    if (!ownerConfirmedPilot || !bound || !taskId || !reviewedTitle)
      fail('RESULT_AMBIGUOUS');
    const edit = options?.acknowledgedTitleEdit;
    if (
      editedTitle !== undefined &&
      (!legacyMatches ||
        !edit ||
        edit.taskId !== taskId ||
        edit.originalTitle !== reviewedTitle ||
        edit.editedTitle !== editedTitle ||
        edit.recordKey !== legacy!.recordKey)
    )
      fail('RESULT_AMBIGUOUS');
    const lookupTitle = editedTitle ?? reviewedTitle;
    return ownedRead(async (p) => {
      phase = 'manual-draft-list';
      await p.goto(origin + paths.list);
      phase = 'manual-draft-list-safety';
      await assertSafe(p);
      phase = 'manual-draft-list-tab';
      const tab = p
        .locator('label.arco-radio-button')
        .filter({ hasText: /^草稿箱(?:\(\d+\))?$/ });
      await tab.waitFor({ state: 'visible', timeout: 10000 });
      if ((await tab.count()) !== 1)
        fail('RESULT_AMBIGUOUS', 'draft-tab-not-unique');
      for (const placeholder of [
        '请搜索标题关键字',
        '开始日期',
        '结束日期',
        '请选择文章类型',
      ]) {
        const name = [
          '请搜索标题关键字',
          '开始日期',
          '结束日期',
          '请选择文章类型',
        ].indexOf(placeholder);
        phase =
          'manual-draft-filter-' +
          ['title', 'start-date', 'end-date', 'article-type'][name];
        const filter = p.getByPlaceholder(placeholder, { exact: true });
        if ((await filter.count()) !== 1)
          fail('RESULT_AMBIGUOUS', 'draft-filter-not-unique');
        if ((await filter.inputValue()) !== '')
          fail('RESULT_AMBIGUOUS', 'draft-filter-not-empty');
      }
      phase = 'manual-draft-list-terminal';
      const freshRequests = new Set<Request>();
      const capture = (request: Request) => {
        const url = new URL(request.url());
        if (
          request.method() === 'GET' &&
          url.origin === origin &&
          url.pathname === draftListPath &&
          url.searchParams.get('pgc_status') === '3' &&
          url.searchParams.get('offset') === '0' &&
          url.searchParams.get('limit') === '20' &&
          url.searchParams.get('title') === ''
        )
          freshRequests.add(request);
      };
      p.on('request', capture);
      let titles: string[];
      try {
        const [response] = await Promise.all([
          p.waitForResponse((r) => freshRequests.has(r.request()), {
            timeout: 10000,
          }),
          tab.click(),
        ]);
        if (!response.ok())
          fail('RESULT_AMBIGUOUS', 'draft-list-response-failed');
        const parsed = draftListResponseSchema.safeParse(
          await bounded(response.json()),
        );
        if (
          !parsed.success ||
          parsed.data.data.count !== parsed.data.data.list.length
        )
          return fail('RESULT_AMBIGUOUS', 'draft-list-response-incomplete');
        titles = parsed.data.data.list.map((item) => item.title);
      } catch (error) {
        if (error instanceof JudongchePageError) throw error;
        return fail('RESULT_AMBIGUOUS', 'draft-list-response-unknown');
      } finally {
        p.off('request', capture);
      }
      try {
        await p.waitForFunction(
          (expected) => {
            const cards = Array.from(
              document.querySelectorAll('[class*="articleBox-"]'),
            );
            return (
              cards.length === expected.length &&
              cards.every((card, i) =>
                Array.from(card.querySelectorAll('*')).some(
                  (node) => node.textContent === expected[i],
                ),
              )
            );
          },
          titles,
          { timeout: 10000 },
        );
        await p
          .getByText('暂无更多数据', { exact: true })
          .waitFor({ state: 'visible', timeout: 10000 });
      } catch {
        fail('RESULT_AMBIGUOUS', 'draft-list-incomplete');
      }
      if (!(await tab.locator('input[type="radio"]').isChecked()))
        fail('RESULT_AMBIGUOUS', 'draft-tab-not-selected');
      phase = 'manual-draft-list-status';
      const cards = p.locator('[class*="articleBox-"]');
      for (const card of await cards.all()) {
        if (!(await card.getByText('草稿箱', { exact: true }).isVisible()))
          fail('RESULT_AMBIGUOUS', 'non-draft-card');
      }
      phase = 'manual-draft-list-title';
      const exact = cards.filter({
        has: p.getByText(lookupTitle, { exact: true }),
      });
      const exactTitleCount = await exact.count();
      const articleTypeVisible =
        exactTitleCount === 1
          ? await exact.getByText('文章资讯', { exact: true }).isVisible()
          : null;
      draftListObservation = {
        cardCount: await cards.count(),
        exactTitleCount,
        articleTypeVisible,
      };
      try {
        diagnostic?.({
          operation,
          phase,
          check: 'draft-title-observed',
          reason: 'readonly',
          draftListObservation,
        });
      } catch {
        /* Diagnostics do not authorize settlement. */
      }
      if (exactTitleCount !== 1)
        fail(
          'RESULT_AMBIGUOUS',
          exactTitleCount === 0
            ? 'draft-title-missing'
            : 'draft-title-multiple',
        );
      if (!articleTypeVisible)
        fail('RESULT_AMBIGUOUS', 'draft-article-type-missing');
      phase = 'manual-draft-list-edit';
      const edit = exact.getByRole('button', { name: '编辑', exact: true });
      if ((await edit.count()) !== 1)
        fail('RESULT_AMBIGUOUS', 'draft-edit-not-unique');
      phase = 'manual-draft-open';
      await edit.click();
      await p.waitForURL(
        (u) =>
          u.pathname === paths.editor &&
          /^\d+$/.test(u.searchParams.get('pgc_id') || ''),
        { timeout: 10000 },
      );
      await p
        .locator('textarea:visible')
        .waitFor({ state: 'visible', timeout: 10000 });
      await p
        .locator(bodySelector + ':visible')
        .waitFor({ state: 'visible', timeout: 10000 });
      await assertSafe(p);
      const url = new URL(p.url());
      const ref = {
        recordKey: url.searchParams.get('pgc_id')!,
        editUrl: p.url(),
      };
      if (
        url.searchParams.get('pgc_status') !== '3' ||
        (legacyMatches && ref.recordKey !== legacy!.recordKey)
      )
        fail('RESULT_AMBIGUOUS', 'draft-record-not-matching');
      phase = 'manual-draft-images';
      await p.waitForFunction(
        (selector) =>
          Array.from(
            document.querySelectorAll<HTMLImageElement>(
              selector + ' .pgc-image .pgc-img-wrapper img',
            ),
          ).every((i) => i.complete && i.naturalWidth > 0),
        bodySelector,
        { timeout: 10000 },
      );
      const localCover = await readProductionLocalCover(p, true);
      await assertSafe(p);
      phase = 'manual-draft-content';
      const value = await extract(p);
      if (!value.known || p.url() !== ref.editUrl) fail('CONTENT_MISMATCH');
      try {
        diagnostic?.({
          operation,
          phase,
          check: 'draft-read-observed',
          reason: 'readonly',
          draftObservation: {
            recordKey: ref.recordKey,
            exactTitle: value.title === lookupTitle,
            blockCount: value.blocks.length,
            imageCount: value.blocks.filter((b) => b.type === 'image').length,
          },
        });
      } catch {
        /* Diagnostics cannot authorize settlement. */
      }
      return {
        ...value,
        store: bound,
        remote: ref,
        isDraft: true,
        localCover,
        pendingUploads: false,
        contextKey: randomUUID(),
        editorUrl: p.url(),
      };
    }, false);
  }

  let coverTask: string | null = null;
  let coverUploader: ReturnType<typeof createLocalCoverUploader> | undefined;
  const capabilities: JudongchePages = {
    bindTaskForContinuation(taskId, generation) {
      // Historical identity only. A temporary additional tab cannot erase the
      // already owned primary. The following fresh probe still rejects it.
      const context = session.current();
      const p = primary;
      if (
        !context ||
        !p ||
        p.isClosed() ||
        p.context() !== context ||
        !context.pages().includes(p) ||
        !liveSaveObservation?.isActive() ||
        liveSaveObservation.page !== p ||
        !bound ||
        !boundGeneration ||
        generation !== boundGeneration ||
        session.generation() !== generation
      )
        return fail('PAGE_CHANGED', 'continuation-session-unbound');
      liveTaskOwner = { taskId, page: p, generation };
    },
    reportAdapterFailure(error) {
      // A page capability may already have reported this exact failure. The
      // adapter sink fills only the internal validation gap, never duplicates it.
      if (failureReported) return;
      operation = 'adapterValidation';
      phase = 'adapter-content-validation';
      reportFailure(error);
    },
    writesOnEditorReady:
      !!ownerConfirmedPilot && options?.batchSubmissionReview === 'operator',
    batchSubmissionReview: options?.batchSubmissionReview,
    async saveForOperatorReview(isStopped, onObserved) {
      if (options?.batchSubmissionReview !== 'operator' || !ownerConfirmedPilot)
        fail('INPUT_UNSUPPORTED');
      stopped = isStopped;
      const p = page();
      const inflight = new Set<Request>();
      const requests = new Set<Request>();
      const accessChecks: Promise<void>[] = [];
      let deniedStatus: 401 | 403 | null = null;
      const assertAccess = () => {
        if (deniedStatus === 401) fail('LOGIN_REQUIRED', 'save-login-required');
        if (deniedStatus === 403)
          fail('PERMISSION_DENIED', 'save-permission-denied');
      };
      const boundedRead = async <T>(work: Promise<T>): Promise<T> => {
        const result = await operatorWait(
          work.then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        );
        assertAccess();
        if (!result) return fail('RESULT_AMBIGUOUS', 'save-still-pending');
        if (!result.ok) throw result.error;
        if (Date.now() - submissionSettlingStarted >= 15000)
          fail('RESULT_AMBIGUOUS', 'save-still-pending');
        return result.value;
      };
      const created = (request: Request) => {
        const url = new URL(request.url());
        if (
          url.origin === origin &&
          url.pathname === createPath &&
          request.method() === 'POST'
        ) {
          inflight.add(request);
          requests.add(request);
          accessChecks.push(
            request.response().then(
              (response) => {
                const status = response?.status();
                if (status === 401 || (status === 403 && deniedStatus !== 401))
                  deniedStatus = status;
              },
              () => {},
            ),
          );
        }
      };
      const ended = (request: Request) => {
        inflight.delete(request);
      };
      p.on('request', created);
      p.on('requestfinished', ended);
      p.on('requestfailed', ended);
      operatorSubmission = true;
      submissionStarted = Date.now();
      submissionSettlingStarted = 0;
      submissionClicked = false;
      let observation: 'acknowledged' | 'rejected' | 'unknown' = 'acknowledged';
      let observationPublished = false;
      const publishObservation = async () => {
        if (
          observationPublished ||
          !submissionClicked ||
          requests.size !== 1 ||
          !saveObservation?.responseReceived
        )
          return;
        observationPublished = true;
        const http = saveObservation.httpStatus;
        const business = saveObservation.businessStatus;
        await onObserved?.({
          observation:
            http !== null &&
            (http < 200 || http >= 300 || (business !== null && business !== 0))
              ? 'rejected'
              : business === 0
                ? 'acknowledged'
                : 'unknown',
          attemptedAt: new Date(submissionStarted).toISOString(),
        });
      };
      try {
        try {
          await capabilities.saveOnce();
        } catch (error) {
          if (
            !(error instanceof JudongchePageError) ||
            error.reason !== 'RESULT_AMBIGUOUS' ||
            phase !== 'save-response' ||
            !submissionClicked
          )
            throw error;
          reportFailure(error);
          assertAccess();
          if (saveObservation?.httpStatus === 401)
            fail('LOGIN_REQUIRED', 'save-login-required');
          if (saveObservation?.httpStatus === 403)
            fail('PERMISSION_DENIED', 'save-permission-denied');
          observation =
            saveObservation?.httpStatus !== null &&
            saveObservation?.httpStatus !== undefined &&
            (saveObservation.httpStatus < 200 ||
              saveObservation.httpStatus >= 300 ||
              (saveObservation.businessStatus !== null &&
                saveObservation.businessStatus !== 0))
              ? 'rejected'
              : 'unknown';
        }
        const isSaving = () => entrySaveBusy(p, false);
        while (
          Date.now() - submissionSettlingStarted < 3000 ||
          inflight.size > 0 ||
          (await boundedRead(isSaving()))
        ) {
          stop();
          assertAccess();
          if (Date.now() - submissionSettlingStarted >= 15000)
            fail('RESULT_AMBIGUOUS', 'save-still-pending');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        stop();
        await boundedRead(Promise.all(accessChecks));
        assertAccess();
        await boundedRead(assertSafe(p));
        if (p.url() !== expectedUrl || session.generation() !== boundGeneration)
          fail('PAGE_CHANGED');
        if (await boundedRead(isSaving()))
          fail('RESULT_AMBIGUOUS', 'save-still-pending');
        if (inflight.size > 0) fail('RESULT_AMBIGUOUS', 'save-still-pending');
        // The verified contract supplies no unique request ID or payload key.
        // Concurrent create requests cannot authorize a known observation.
        if (requests.size !== 1) observation = 'unknown';
        stop();
        assertAccess();
        if (Date.now() - submissionSettlingStarted >= 15000)
          fail('RESULT_AMBIGUOUS', 'save-still-pending');
        await publishObservation();
        return {
          observation,
          attemptedAt: new Date(submissionStarted).toISOString(),
        };
      } catch (error) {
        // Preserve only this sole issued request's actual observation before
        // propagating stop/failure. Await the durable write; never detach it.
        await publishObservation();
        throw error;
      } finally {
        operatorSubmission = false;
        p.off('request', created);
        p.off('requestfinished', ended);
        p.off('requestfailed', ended);
      }
    },
    async returnHomeAfterSubmission(isStopped) {
      stopped = isStopped;
      stop();
      const p = page();
      await assertSafe(p);
      stop();
      contextKey = null;
      expectedUrl = null;
      await p.goto(origin + paths.home, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      stop();
      if (
        nativeDialog ||
        p.url() !== origin + paths.home ||
        session.generation() !== boundGeneration
      )
        fail('PAGE_CHANGED');
      await assertSafe(p);
      stop();
      expectedRevision = revision;
    },
    captureHandledTaskContinuation(taskId) {
      // Historical owner only; current page count/safety/activity are rechecked
      // after writer drain. Capture once for this explicit skip, never afterward.
      const p = primary;
      const context = session.current();
      const generation = boundGeneration;
      const observation = liveSaveObservation;
      if (
        !bound ||
        !p ||
        p.isClosed() ||
        !context ||
        p.context() !== context ||
        !context.pages().includes(p) ||
        !generation ||
        session.generation() !== generation ||
        liveTaskOwner?.taskId !== taskId ||
        liveTaskOwner.page !== p ||
        liveTaskOwner.generation !== generation ||
        !observation?.isActive()
      )
        return fail('PAGE_CHANGED', 'handoff-owner-unbound');
      const history = observation.captureHandledDenials();
      const store = bound;
      return async (cancelled) => {
        // This callback belongs to the handoff, never the stopped writer.
        const check = () => {
          if (cancelled()) fail('STOP_REQUESTED');
        };
        check();
        if (
          page() !== p ||
          session.current() !== context ||
          session.generation() !== generation ||
          liveTaskOwner?.taskId !== taskId ||
          liveTaskOwner.page !== p ||
          liveTaskOwner.generation !== generation ||
          liveSaveObservation !== observation
        )
          return fail('PAGE_CHANGED', 'handoff-owner-unbound');
        const checkActivity = async () => {
          check();
          if (
            page() !== p ||
            session.current() !== context ||
            session.generation() !== generation ||
            liveSaveObservation !== observation
          )
            fail('PAGE_CHANGED');
          const url = new URL(p.url());
          if (
            url.origin !== origin ||
            ![
              paths.home,
              paths.editor,
              paths.list,
              '/jdc/dealer/info/contentPublish/content/index-cps2',
            ].includes(url.pathname)
          )
            fail('PAGE_CHANGED', 'handoff-page-unknown');
          await assertSafe(p);
          history.assertIdle();
          if (
            url.pathname === paths.editor &&
            ((await p.locator('textarea:visible').count()) !== 1 ||
              (await p.locator(bodySelector + ':visible').count()) !== 1 ||
              (await p
                .getByRole('button', { name: '存草稿', exact: true })
                .count()) !== 1)
          )
            fail('PAGE_CHANGED', 'handoff-editor-shape');
          // Activity only. Broken images, unknown uploads and body differences
          // are retained history, not content acceptance for an abandoned task.
          const active = await p
            .locator(
              `${bodySelector} [role="progressbar"],${bodySelector} [aria-busy="true"],${bodySelector} progress,` +
                '.article-cover-images [role="progressbar"],.article-cover-images [aria-busy="true"],.article-cover-images progress,' +
                '.article-cover-images .arco-upload-status-uploading',
            )
            .evaluateAll((nodes) =>
              nodes.some(
                (node) =>
                  node.getClientRects().length > 0 &&
                  getComputedStyle(node).visibility === 'visible',
              ),
            );
          if (active || (await entrySaveBusy(p, false)))
            fail('RESULT_AMBIGUOUS', 'handoff-activity-pending');
          history.assertIdle();
          check();
          if (page() !== p || session.generation() !== generation)
            fail('PAGE_CHANGED');
        };
        await checkActivity();
        await checkActivity();
        // Retire only the matched old owner. Late driver callbacks retain their
        // captured record; none can become the next task's current operation.
        if (bodyUploadOperation) {
          if (
            (bodyUploadOperation.taskId !== taskId ||
              bodyUploadOperation.page !== p ||
              bodyUploadOperation.generation !== generation) &&
            bodyUploadOperation.record.uploadState !== 'settled'
          )
            fail('PAGE_CHANGED', 'handoff-upload-owner');
          archivedBodyUploadOperation = bodyUploadOperation;
          bodyUploadOperation = undefined;
        }
        clearEntryObservation();
        await operationRoot?.dispose().catch(() => {});
        await platformCaret?.dispose().catch(() => {});
        operationRoot = platformCaret = null;
        operationContext = null;
        operationImages = [];
        coverOperationKey = null;
        entryEvidence = null;
        contextKey = expectedUrl = null;
        await checkActivity();
        // Exactly one navigation. A timeout is reconciled read-only, never replayed.
        if (p.url() !== origin + paths.home) {
          try {
            await p.goto(origin + paths.home, {
              waitUntil: 'domcontentloaded',
              timeout: 15000,
            });
          } catch (error) {
            if (
              !(error instanceof errors.TimeoutError) ||
              p.url() !== origin + paths.home
            )
              throw error;
            await p.waitForLoadState('domcontentloaded', { timeout: 1000 });
          }
        }
        await checkActivity();
        if (p.url() !== origin + paths.home)
          fail('PAGE_CHANGED', 'handoff-home-unconfirmed');
        // Retain the existing confirmed store binding. In the owner-confirmed
        // pilot, greeting/menu discovery is deliberately outside this workflow.
        if (bound !== store) fail('STORE_CHANGED');
        check();
        history.retire();
        expectedRevision = revision;
        remote = null;
        // Keep activeTask until the next entry so a failed transaction can retry
        // the same handoff from home without creating another navigation.
        return { status: 'ready', store, generation };
      };
    },
    async returnHomeAfterHandledTask(taskId, cancelled) {
      return capabilities.captureHandledTaskContinuation!(taskId)(cancelled);
    },
    automaticDraftReview:
      options?.automaticDraftReview === true &&
      options.manualReview === true &&
      !!ownerConfirmedPilot,
    // SINGLE candidate only; UI/live admission is separate from implementation.
    localCoverUpload: productionCoverUploadSupported
      ? 'supported'
      : 'unsupported',
    uploadLocalCover: trace(
      'uploadLocalCover',
      async (input: CoverUploadInput, isStopped: () => boolean) => {
        if (!productionCoverUploadSupported || input.mode !== 'single')
          return { status: 'blocked', reason: 'INPUT_UNSUPPORTED' };
        if (!activeTask) return { status: 'blocked', reason: 'PAGE_CHANGED' };
        coverOperationKey = randomUUID();
        if (coverTask !== activeTask) {
          const clickTaskId = activeTask;
          coverTask = activeTask;
          coverUploader = createLocalCoverUploader(
            createProductionCoverDriver({
              waits,
              currentPage: page,
              generation: () => session.generation(),
              guard: async (proof) => {
                await coverGuard(proof);
              },
              readEditor: operationObserved,
              invalidateInspection,
              stages: coverStages,
              clickDiagnostic: diagnostic
                ? (event) =>
                    diagnostic({
                      operation: 'uploadLocalCover',
                      phase: 'local-cover:open',
                      check: 'cover-click-observation',
                      reason: 'observed',
                      coverClick: { taskId: clickTaskId, ...event },
                    })
                : undefined,
              openDiagnostic: (event) => {
                coverOpen.push(event);
                phase = 'local-cover:open';
                report('cover-open-boundary', 'observed');
              },
              terminalDiagnostic: (event) => {
                coverTerminal = { ...event };
                report('cover-terminal-evidence', 'observed');
              },
            }),
            (error, step) => {
              phase = 'local-cover:' + step;
              reportFailure(error);
            },
          );
        }
        return coverUploader!(input, isStopped);
      },
    ),
    acknowledgedTitleEdit: options?.acknowledgedTitleEdit
      ? structuredClone(options.acknowledgedTitleEdit)
      : undefined,
    confirmedDraftSave: (taskId, expectedTitle) => {
      const saved = confirmedSaves.get(taskId);
      const explicit = options?.reviewedSavedTask;
      return (
        (saved?.title === expectedTitle &&
          saved.generation === session.generation()) ||
        (!!ownerConfirmedPilot &&
          options?.manualReview === true &&
          explicit?.taskId === taskId &&
          explicit.title === expectedTitle &&
          /^\d+$/.test(explicit.recordKey))
      );
    },
    manualReview: options?.manualReview === true,
    ...(ownerConfirmedPilot
      ? { reviewSavedDraft: trace('reviewSavedDraft', reviewSavedDraft) }
      : {}),
    ...(ownerConfirmedPilot
      ? {
          checkWritingContext: async (isStopped?: () => boolean) => {
            try {
              await guard(
                false,
                isStopped
                  ? () => {
                      if (isStopped()) fail('STOP_REQUESTED');
                    }
                  : stop,
              );
              if (entryObservation) await entryIdle();
              else if (activeTask && contextKey) {
                const current = await operationObserved();
                if (
                  current.pendingUploads ||
                  current.localCover?.pendingUploads ||
                  current.operation?.saving
                )
                  fail('PAGE_CHANGED', 'writing-operation-pending');
              }
            } catch (error) {
              clearEntryObservation();
              throw error;
            }
          },
        }
      : {}),
    async inspectDraftAbsence(nextTitle) {
      try {
        phase = 'absence-store-guard';
        // This explicit read-only query outlives the prior execution. The
        // controller cancels its proof on a NEW stop; never reset the old
        // execution callback or permit that execution to resume writes.
        const readOnly = () => {};
        await guard(false, readOnly);
        const result = await find(nextTitle, false, readOnly);
        if (result !== null) fail('RESULT_AMBIGUOUS');
        report('exact-title-absent', 'RESULT_AMBIGUOUS');
        return true;
      } catch (error) {
        reportFailure(error);
        report(
          'absence-unconfirmed',
          error instanceof JudongchePageError ? error.reason : 'PAGE_CHANGED',
          error instanceof JudongchePageError ? error.overlay : undefined,
          error instanceof JudongchePageError
            ? error.check
            : 'page-operation-failed',
        );
        return false;
      }
    },
    async probe() {
      phase = 'session';
      diag('probe-start', { activeTask, generation: session.generation() });
      try {
        if (boundGeneration && session.generation() !== boundGeneration) {
          clearEntryObservation();
          liveSaveObservation?.dispose();
          liveSaveObservation = null;
          // Re-identification after an explicitly reopened browser is read-only.
          // Durable task state and adapter attempted IDs still prevent replay.
          bound = null;
          boundGeneration = null;
          primary = null;
          contextKey = null;
          expectedUrl = null;
          remote = null;
          nativeDialog = false;
          activeTask = null;
          liveTaskOwner = null;
        }
        const p = page();
        if (p.url() === 'about:blank' && !bound) {
          phase = 'session-home-navigation';
          await p.goto(origin + paths.home, { waitUntil: 'domcontentloaded' });
        }
        phase = 'primary-safety';
        await assertEntrySafe(p, () => {
          page();
        });
        if (!bound) {
          bound = await identify();
          boundGeneration = session.generation();
        }
        phase = ownerConfirmedPilot
          ? 'primary-owner-confirmed-store'
          : 'primary-store-menu';
        await confirmMenuStore(p, bound.displayName);
        report(
          ownerConfirmedPilot ? 'owner-confirmed-store' : 'confirmed',
          'ready',
        );
        return {
          status: 'ready',
          store: bound,
          generation: session.generation()!,
        };
      } catch (error) {
        reportFailure(error);
        report(
          error instanceof JudongchePageError
            ? error.check
            : 'page-operation-failed',
          error instanceof JudongchePageError ? error.reason : 'PAGE_CHANGED',
          error instanceof JudongchePageError ? error.overlay : undefined,
        );
        return {
          status: 'blocked',
          reason:
            error instanceof JudongchePageError ? error.reason : 'PAGE_CHANGED',
        };
      }
    },
    async enterNewEditor(nextTitle, isStopped, taskId, operatorBatch = false) {
      waits = options?.uploadWaits ?? defaultUploadWaits;
      imageOrdinal = 0;
      stopped = isStopped ?? (() => false);
      if (!nextTitle || !taskId || savedTasks.has(taskId))
        fail('RESULT_AMBIGUOUS');
      liveTaskOwner = {
        taskId: taskId!,
        page: page(),
        generation: session.generation(),
      };
      await guard();
      invalidateInspection();
      title = nextTitle!;
      if (!options?.manualReview) await find(title, false);
      stop();
      const p = page();
      const operatorEntry =
        !!ownerConfirmedPilot && options?.batchSubmissionReview === 'operator';
      if (operatorEntry) {
        clearEntryObservation();
        entryObservation = { ...observeEditorEntrySave(p), taskId: taskId! };
      }
      const navigate = async () => {
        stop();
        if (operatorEntry) {
          await guard();
          await assertSafe(p);
          await guard();
          entryObservation!.assertIdle();
          stop();
        }
        phase = 'editor-entry-navigation';
        if (ownerConfirmedPilot) {
          // The owner supplies the target. Use the editor's observed normal URL;
          // unrelated navigation/header markup is not an execution prerequisite.
          await p.goto(origin + paths.editor, {
            waitUntil: 'domcontentloaded',
          });
        } else {
          await p.goto(origin + paths.marketing);
          phase = 'editor-entry-safety';
          await assertSafe(p);
          phase = 'editor-entry-store-menu';
          await confirmMenuStore(p, bound!.displayName);
          stop();
          phase = 'editor-entry-button';
          const articleLabel = p.getByText('文章资讯', { exact: true });
          // Marketing's route can finish before the article card mounts.
          // Wait for the actual entry, retaining strict unique matching.
          try {
            await articleLabel.waitFor({ state: 'visible', timeout: 10000 });
          } catch {
            stop();
            await assertSafe(p);
            fail('PAGE_CHANGED');
          }
          stop();
          if ((await articleLabel.count()) !== 1) fail('PAGE_CHANGED');
          // E67: the label's parent is the heading; its grandparent owns the button.
          const entry = articleLabel
            .locator('../..')
            .getByRole('button', { name: '立即发布', exact: true });
          try {
            await entry.waitFor({ state: 'visible', timeout: 10000 });
          } catch {
            stop();
            await assertSafe(p);
            fail('PAGE_CHANGED');
          }
          stop();
          await assertSafe(p);
          if ((await entry.count()) !== 1) fail('PAGE_CHANGED');
          await entry.click();
          phase = 'editor-entry-url';
          await p.waitForURL(origin + paths.editor, { timeout: 10000 });
        }
        stop();
        if (p.url() !== origin + paths.editor)
          fail('PAGE_CHANGED', 'editor-entry-url-unexpected');
        contextKey = randomUUID();
        expectedUrl = p.url();
        expectedRevision = revision;
        remote = null;
        // SPA URL changes precede editor mount. Wait for the actual controls,
        // then retain the strict empty-content check before any write.
        const mountStarted = performance.now();
        const budgetMs = operatorEntry ? waits.editor : 10_000;
        if (diagnostic)
          editorMount = {
            budgetMs,
            elapsedMs: 0,
            titleFirstVisibleMs: null,
            bodyFirstVisibleMs: null,
            controls: null,
          };
        const sampleControls = async () => {
          if (!editorMount) return;
          const controls = await p
            .evaluate(inspectEditorControls, {
              selector: bodySelector,
              editorUrl: origin + paths.editor,
            })
            .catch(() => null);
          editorMount.elapsedMs = Math.round(performance.now() - mountStarted);
          editorMount.controls = controls;
          if (controls?.visibleTextareas)
            editorMount.titleFirstVisibleMs ??= editorMount.elapsedMs;
          if (controls?.visibleBodies)
            editorMount.bodyFirstVisibleMs ??= editorMount.elapsedMs;
        };
        phase = 'editor-entry-ready';
        await guard();
        // Slow dashboard assets may still be loading after the editor mounts.
        // Check session and stop between short waits without repeating navigation.
        const waitForControl = async (selector: string) => {
          const control = p.locator(selector);
          const deadline = performance.now() + budgetMs;
          for (;;) {
            await guard();
            await sampleControls();
            const remaining = deadline - performance.now();
            if (remaining <= 0)
              throw new errors.TimeoutError('Editor control did not appear');
            try {
              await control.waitFor({
                state: 'visible',
                timeout: Math.min(500, remaining),
              });
              return;
            } catch (error) {
              if (!(error instanceof errors.TimeoutError)) throw error;
            }
          }
        };
        phase = 'editor-entry-title-mount';
        await waitForControl('textarea:visible');
        phase = 'editor-entry-body-mount';
        await waitForControl(bodySelector + ':visible');
        if (editorMount) {
          await sampleControls();
          report('editor-controls-observed', 'observed');
        }
        if (ownerConfirmedPilot) {
          phase = 'editor-entry-safety';
          await assertEntrySafe(p, stop);
        }
        stop();
      };
      try {
        await navigate();
        if (operatorEntry) {
          await entryIdle();
          activeTask = taskId!;
          return;
        }
        let blank = await observed();
        if (
          blank.known &&
          !blank.title &&
          blank.blocks.length > 0 &&
          blank.blocks.every(
            (block) => block.type === 'paragraph' && block.text === '',
          )
        ) {
          // A restored, wholly empty editor may contain several caret paragraphs.
          // Select only their empty boundaries and delete once, preserving the
          // final caret. Never normalize blanks mixed with actual article content.
          const body = p.locator(bodySelector);
          const expectedCount = blank.blocks.length + 1;
          const positioned = await body.evaluate((node, count) => {
            const emptyCaret = (child: Element) =>
              child.tagName === 'P' &&
              child.textContent === '' &&
              child.childNodes.length === 1 &&
              child.firstElementChild?.tagName === 'BR' &&
              child.firstElementChild.classList.contains(
                'ProseMirror-trailingBreak',
              );
            if (
              node.childNodes.length !== count ||
              node.children.length !== count ||
              !Array.from(node.children).every(emptyCaret)
            )
              return false;
            const range = document.createRange();
            range.setStart(node.firstElementChild!, 0);
            range.setEnd(node.lastElementChild!, 0);
            (node as HTMLElement).focus();
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return true;
          }, expectedCount);
          if (positioned) {
            await guard();
            const focused = await body.evaluate((node, count) => {
              const selection = window.getSelection();
              return (
                document.activeElement === node &&
                selection?.rangeCount === 1 &&
                selection.anchorNode === node.firstElementChild &&
                selection.anchorOffset === 0 &&
                selection.focusNode === node.lastElementChild &&
                selection.focusOffset === 0 &&
                node.childNodes.length === count &&
                node.children.length === count &&
                Array.from(node.children).every(
                  (child) =>
                    child.tagName === 'P' &&
                    child.textContent === '' &&
                    child.childNodes.length === 1 &&
                    child.firstElementChild?.matches(
                      'br.ProseMirror-trailingBreak',
                    ),
                )
              );
            }, expectedCount);
            if (!focused) fail('PAGE_CHANGED');
            stop();
            await p.keyboard.press('Delete');
            blank = await observed();
          }
        }
        phase = 'editor-entry-empty';
        if (!blank.known)
          fail(
            operatorBatch ? 'EDITOR_NOT_EMPTY' : 'CONTENT_MISMATCH',
            'editor-shape-unconfirmed',
          );
        if (blank.title)
          fail(
            operatorBatch ? 'EDITOR_NOT_EMPTY' : 'CONTENT_MISMATCH',
            'editor-title-nonempty',
          );
        if (blank.blocks.length)
          fail(
            operatorBatch ? 'EDITOR_NOT_EMPTY' : 'CONTENT_MISMATCH',
            'editor-body-nonempty',
          );
        if (operatorBatch && options?.batchSubmissionReview === 'operator') {
          const emptyCover = await hasEmptyProductionCover(p);
          stop();
          if (!emptyCover) fail('EDITOR_NOT_EMPTY', 'editor-cover-nonempty');
        }
        activeTask = taskId!;
        if (ownerConfirmedPilot) entryEvidence = structuredClone(blank);
      } catch (error) {
        clearEntryObservation();
        throw error;
      }
    },
    async fillTitle(text) {
      try {
        const p = await guard();
        if (entryObservation) {
          if (entryObservation.taskId !== activeTask)
            fail('PAGE_CHANGED', 'editor-entry-owner-missing');
          await entryIdle();
        }
        invalidateInspection();
        if (text !== title) fail('CONTENT_MISMATCH');
        stop();
        await p.locator('textarea:visible').fill(text);
        if (entryObservation) {
          await entryIdle();
          const body = p.locator(bodySelector);
          // New-article input replaces the text field, including inline images.
          // Leave a normal empty editor's placeholder and caret untouched.
          const readyForFirstBlock = await body.evaluate(
            (root, placeholder) => {
              const only = root.firstElementChild;
              return (
                root.childNodes.length === 1 &&
                !!only &&
                (only.matches(placeholder) ||
                  (only.tagName === 'P' &&
                    only.textContent === '' &&
                    (only.childNodes.length === 0 ||
                      (only.childNodes.length === 1 &&
                        only.firstElementChild?.tagName === 'BR'))))
              );
            },
            emptyEditorPlaceholderSelector,
          );
          if (!readyForFirstBlock) {
            await entryIdle();
            await body.fill('');
          }
        }
      } finally {
        clearEntryObservation();
      }
    },
    async appendParagraph(text) {
      const p = await guard();
      await operationObserved();
      invalidateInspection();
      const root = operationRoot!;
      const task = activeTask,
        writeContext = contextKey;
      const { index: targetIndex, target } = await emptyTail(p);
      if (diagnostic)
        paragraphWrite = {
          targetBlock: targetIndex + 1,
          stage: 'after-click',
          samples: [],
        };
      let expected = '';
      let lineNumber = 1;
      const mark = (stage: string) => {
        if (paragraphWrite) paragraphWrite.stage = stage;
      };
      const sampleTarget = async (stage: string) => {
        mark(stage);
        const result = await p.evaluate(inspectParagraphTarget, {
          root,
          target: target!,
          selector: bodySelector,
          placeholder: emptyEditorPlaceholderSelector,
          index: targetIndex,
          expected,
          source: text,
          collect: !!paragraphWrite,
          requireEmptyTail: stage === 'after-focus-restore',
          observeOnly: stage === 'after-enter',
        });
        if (paragraphWrite) {
          // Retain the latest sample for each checkpoint, even for multiline input.
          paragraphWrite.samples = paragraphWrite.samples.filter(
            (s) => s.stage !== stage,
          );
          paragraphWrite.samples.push({ stage, line: lineNumber, result });
        }
        return result.result;
      };
      const guardTask = async () => {
        await guard();
        stop();
        if (activeTask !== task || contextKey !== writeContext)
          fail('PAGE_CHANGED', 'paragraph-task-changed');
      };
      const checkTarget = async (stage: string) => {
        mark(stage);
        await guardTask();
        let result = await sampleTarget(stage);
        stop();
        if (stage === 'after-click' && result === 'editor-unfocused') {
          await guardTask();
          mark('restore-tail-focus');
          const positioned = await p.evaluate(restoreEmptyParagraphCaret, {
            index: targetIndex,
            root,
            target,
            selector: bodySelector,
            placeholder: emptyEditorPlaceholderSelector,
          });
          if (positioned) {
            await guardTask();
            result = await sampleTarget('after-focus-restore');
            stop();
          }
        }
        if (result !== 'ok') fail('PAGE_CHANGED', 'paragraph-target-changed');
      };
      const hasNext = () =>
        root.evaluate((body, target) => {
          if (!body.isConnected || target?.parentElement !== body) return false;
          const tail = body.lastElementChild;
          return (
            tail !== target &&
            tail?.tagName === 'P' &&
            tail.textContent === '' &&
            tail.childNodes.length === 1 &&
            !!tail.firstElementChild?.matches('br.ProseMirror-trailingBreak')
          );
        }, target!);
      try {
        for (const [index, line] of text.split('\n').entries()) {
          lineNumber = index + 1;
          if (index) {
            await checkTarget('before-soft-break');
            mark('press-soft-break');
            await p.keyboard.press('Shift+Enter');
            expected += '\n';
          }
          await checkTarget(index ? 'after-soft-break' : 'after-click');
          mark('insert-text');
          await p.keyboard.insertText(line);
          expected += line;
          await checkTarget('after-paste');
        }
        if (!(await hasNext())) {
          await checkTarget('before-enter');
          mark('press-enter');
          await p.keyboard.press('Enter');
          if (paragraphWrite) paragraphWrite.enterPressed = true;
          stop();
          if (paragraphWrite) await sampleTarget('after-enter').catch(() => {});
        } else if (paragraphWrite) paragraphWrite.enterPressed = false;
        if (!(await hasNext()))
          fail('PAGE_CHANGED', 'paragraph-next-target-unavailable');
        stop();
        await rememberPlatformCaret(p, undefined, true);
        if (paragraphWrite) report('paragraph-write-observed', 'observed');
      } finally {
        await target!.dispose();
      }
    },
    async appendImage(bytes, mime) {
      const index = ++imageOrdinal;
      const started = performance.now();
      bodyImageStartedAt = started;
      const completeStage = (target = bodyImage?.stage) => {
        if (
          !bodyImage ||
          bodyImage.stages.find((entry) => entry.stage === target)?.status !==
            'waiting'
        )
          return;
        const now = performance.now();
        const current = bodyImage.stage === target;
        bodyImage = {
          ...bodyImage,
          ...(current
            ? {
                status: 'completed' as const,
                stageElapsedMs: now - bodyImage.stageStartedAt,
              }
            : {}),
          stages: bodyImage.stages.map((entry) =>
            entry.stage === target
              ? {
                  ...entry,
                  status: 'completed',
                  stageElapsedMs: now - entry.stageStartedAt,
                }
              : entry,
          ),
        };
        if (current) report('body-image-stage', 'completed');
      };
      const stage = (
        next: NonNullable<ProbeDiagnostic['bodyImage']>['stage'],
        completePrevious = true,
      ) => {
        if (completePrevious) completeStage();
        const now = performance.now();
        bodyImage = {
          ...bodyImage,
          index,
          stage: next,
          elapsedMs: now - started,
          stageStartedAt: now,
          stageElapsedMs: 0,
          status: 'waiting',
          fileSelectionCount: bodyImage?.fileSelectionCount ?? 0,
          confirmationCount: bodyImage?.confirmationCount ?? 0,
          stages: [
            ...(bodyImage?.stages ?? []).filter(
              (entry) => entry.stage !== next,
            ),
            {
              stage: next,
              status: 'waiting' as const,
              stageStartedAt: now,
              startedElapsedMs: now - started,
              stageElapsedMs: 0,
            },
          ].slice(-11),
        };
        phase = 'body-image:' + next;
        report('body-image-stage', 'waiting');
      };
      const p = await guard();
      invalidateInspection();
      const currentUpload = currentBodyUpload();
      if (
        currentUpload &&
        (!currentUpload.modalClosed || bodyUploadUnsettled())
      )
        fail('PAGE_CHANGED', 'body-upload-unsettled');
      await operationObserved();
      const beforeImages = await p
        .locator(bodySelector + ' .pgc-image img:visible')
        .count();
      stage('tail-position');
      await (await emptyTail(p)).target.dispose();
      const bodyRoot = await p.$(bodySelector);
      if (!bodyRoot) fail('PAGE_CHANGED', 'body-image-root-changed');
      const insertionAnchor = await bodyRoot!.evaluateHandle((body) => ({
        caret: body.lastElementChild,
        previous: body.lastElementChild?.previousElementSibling ?? null,
      }));
      let insertedBlock: ElementHandle<Element> | null = null;
      try {
        stop();
        const uploadOperation: OwnedBodyUploadOperation = {
          generation: boundGeneration,
          page: p,
          contextKey,
          taskId: activeTask,
          record: {
            fileSelectionCount: 0,
            confirmationCount: 0,
            modalClosed: false,
            uploadState: 'unknown',
          },
        };
        bodyUploadOperation = uploadOperation;
        const ownsUpload = () =>
          bodyUploadOperation === uploadOperation &&
          archivedBodyUploadOperation !== uploadOperation &&
          uploadOperation.generation === boundGeneration &&
          uploadOperation.page === primary &&
          uploadOperation.contextKey === contextKey &&
          uploadOperation.taskId === activeTask;
        const outcome = await uploadBodyImage({
          allowPreviewReload: index === 1,
          waits,
          page: p,
          bytes,
          mime,
          stop,
          currentPage: page,
          guard: (imageDialog, proof) =>
            guard(imageDialog, stop, undefined, proof),
          stage: (next, completePrevious) => {
            if (ownsUpload()) stage(next, completePrevious);
          },
          completeStage: (target) => {
            if (ownsUpload()) completeStage(target);
          },
          action: (action) => {
            if (!ownsUpload()) return;
            bodyImage = {
              ...bodyImage!,
              fileSelectionCount:
                bodyImage!.fileSelectionCount +
                (action === 'select-file' ? 1 : 0),
              confirmationCount:
                bodyImage!.confirmationCount + (action === 'confirm' ? 1 : 0),
            };
          },
          onPreviewError: (time) => {
            if (ownsUpload()) {
              try {
                diagnostic?.({
                  operation: 'appendImage',
                  phase,
                  check: 'preview-image-error',
                  reason: 'cause-unknown',
                  previewErrorAt: time,
                  imageIndex: index,
                });
              } catch {
                /* Diagnostics cannot interrupt the upload. */
              }
            }
          },
          observe: (record) => {
            uploadOperation.record = record;
            if (bodyImage && ownsUpload())
              bodyImage = { ...bodyImage, ...record };
          },
        });
        uploadOperation.record = outcome;
        if (outcome.status === 'paused') throw outcome.error;
        if (!outcome.modalClosed || outcome.uploadState !== 'settled')
          fail('PAGE_CHANGED', 'body-upload-unsettled');
        const waitImage = createBodyImageWait(stop, page);
        stage('image-inserted');
        await waitImage(
          async () => {
            // An immediate read must not hide Locator auto-waiting inside this
            // stage's stop/deadline loop, or retarget a replacement editor root.
            const inserted = await p.evaluate(
              ({ body, selector, anchor, count }) => {
                if (
                  !body.isConnected ||
                  document.querySelectorAll(selector).length !== 1 ||
                  document.querySelector(selector) !== body
                )
                  return null;
                if (anchor.previous && anchor.previous.parentElement !== body)
                  return null;
                const images = Array.from(
                  body.querySelectorAll<HTMLImageElement>('.pgc-image img'),
                );
                const image = images.at(-1);
                const block = image?.closest('div[__syl_tag]');
                if (
                  images.length !== count + 1 ||
                  !block ||
                  block.parentElement !== body
                )
                  return false;
                let cursor = anchor.previous
                  ? anchor.previous.nextElementSibling
                  : body.firstElementChild;
                while (cursor && cursor !== block) {
                  if (
                    cursor !== anchor.caret &&
                    !(
                      cursor.tagName === 'P' &&
                      cursor.textContent === '' &&
                      Array.from(cursor.children).every((child) =>
                        child.matches('br.ProseMirror-trailingBreak'),
                      )
                    )
                  )
                    return false;
                  cursor = cursor.nextElementSibling;
                }
                return (
                  cursor === block &&
                  image!.complete &&
                  image!.naturalWidth > 0 &&
                  image!.naturalHeight > 0
                );
              },
              {
                body: bodyRoot!,
                selector: bodySelector,
                anchor: insertionAnchor,
                count: beforeImages,
              },
            );
            stop();
            if (inserted === null)
              return fail('PAGE_CHANGED', 'body-image-root-changed');
            return inserted;
          },
          waits.settleImage,
          async () => {
            await guard();
            if (ownerConfirmedPilot) await checkImageDialogs(p, 'closed');
          },
        );
        if (ownerConfirmedPilot) {
          await guard();
          await checkImageDialogs(p, 'closed');
        }
        // The live editor inserts the image after its empty caret paragraph.
        // Remove only that insertion-owned paragraph, never source paragraphs.
        stage('tail-finalization');
        const blockHandle = await bodyRoot!.evaluateHandle(
          (body) =>
            Array.from(body.querySelectorAll('.pgc-image img'))
              .at(-1)
              ?.closest('div[__syl_tag]') ?? null,
        );
        insertedBlock =
          blockHandle.asElement() as ElementHandle<Element> | null;
        if (!insertedBlock) {
          await blockHandle.dispose();
          fail('PAGE_CHANGED', 'image-target-missing');
        }
        const retainedCaret = await p.evaluate(
          ({ body, block, anchor }) =>
            anchor.caret?.parentElement === body &&
            anchor.caret.nextElementSibling === block,
          { body: bodyRoot!, block: insertedBlock!, anchor: insertionAnchor },
        );
        if (retainedCaret) {
          await guard();
          const caretHandle = await insertionAnchor.evaluateHandle(
            (anchor) => anchor.caret,
          );
          const caret = caretHandle.asElement();
          if (!caret) {
            await caretHandle.dispose();
            fail('PAGE_CHANGED', 'image-caret-missing');
          }
          try {
            const positioned = await p.evaluate(
              ({ body, block, caret }) => {
                if (
                  !body.isConnected ||
                  caret?.parentElement !== body ||
                  caret.nextElementSibling !== block ||
                  caret.tagName !== 'P' ||
                  caret.textContent !== '' ||
                  caret.childNodes.length !== 1 ||
                  !caret.firstElementChild?.matches(
                    'br.ProseMirror-trailingBreak',
                  )
                )
                  return false;
                const selection = window.getSelection(),
                  range = document.createRange();
                range.selectNodeContents(caret);
                range.collapse(true);
                (body as HTMLElement).focus();
                selection?.removeAllRanges();
                selection?.addRange(range);
                return (
                  selection?.isCollapsed &&
                  !!selection.anchorNode &&
                  caret.contains(selection.anchorNode)
                );
              },
              { body: bodyRoot!, block: insertedBlock!, caret: caret! },
            );
            if (!positioned) fail('PAGE_CHANGED', 'image-caret-changed');
            stop();
            await p.keyboard.press('Delete');
            if (!(await caret!.evaluate((node) => !node.isConnected)))
              fail('PAGE_CHANGED', 'image-caret-not-removed');
          } finally {
            await caretHandle.dispose();
          }
        }
        const hasTail = async () =>
          p.evaluate(
            ({ body, block, selector }) => {
              if (
                !body.isConnected ||
                document.querySelector(selector) !== body ||
                block.parentElement !== body
              )
                return null;
              const next = block.nextElementSibling;
              if (!next) return false;
              return (
                next.tagName === 'P' &&
                next.textContent === '' &&
                Array.from(next.children).every((child) =>
                  child.matches('br.ProseMirror-trailingBreak'),
                )
              );
            },
            { body: bodyRoot!, block: insertedBlock!, selector: bodySelector },
          );
        const tail = await hasTail();
        if (tail === null) fail('PAGE_CHANGED', 'image-root-changed');
        if (!tail) {
          const atEnd = await insertedBlock!.evaluate((block) => {
            if (block.nextElementSibling || !block.parentElement) return false;
            const range = document.createRange(),
              selection = window.getSelection();
            range.setStartAfter(block);
            range.collapse(true);
            (block.parentElement as HTMLElement).focus();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return true;
          });
          if (!atEnd) fail('PAGE_CHANGED', 'image-next-target-occupied');
          await guard();
          stop();
          await p.keyboard.press('Enter');
          await waitImage(
            async () => {
              const value = await hasTail();
              if (value === null) fail('PAGE_CHANGED', 'image-root-changed');
              return value === true;
            },
            waits.settleImage,
            async () => {
              await guard();
            },
          );
        }
        stage('readback');
        const after = await extract(p, true);
        const image = after.blocks.at(-1);
        {
          if (
            !after.known ||
            after.blocks.length !== 1 ||
            image?.type !== 'image' ||
            !image.resourceKey ||
            !image.loaded ||
            (await p
              .locator(bodySelector + ' .pgc-image img:visible')
              .count()) !==
              beforeImages + 1
          )
            return fail('CONTENT_MISMATCH');
          completeStage();
          operationImages.push(image.resourceKey);
          await rememberPlatformCaret(p, insertedBlock!);
          return image.resourceKey;
        }
      } finally {
        await insertedBlock?.dispose().catch(() => {});
        await insertionAnchor.dispose().catch(() => {});
        await bodyRoot!.dispose().catch(() => {});
      }
    },
    async chooseFirstCover() {
      return fail('INPUT_UNSUPPORTED');
    },
    // T9 rich-text hooks: reads reuse the verified reader, writes go through the
    // guarded DOM port, and every failure keeps its existing error code.
    appendTextBlock: trace(
      'appendTextBlock',
      async (block: RichTextBlock, stopped: () => boolean) => {
        const p = await guard();
        await operationObserved();
        await (await emptyTail(p)).target.dispose();
        const dom = createPlaywrightEditorDom(
          p,
          reportBlockEdge,
          stopped,
          waits.caretClick,
        );
        try {
          await appendRichTextBlock(
            createRichTextDomPort(dom, {
              stopped,
            }),
            block,
            stopped,
          );
          await rememberPlatformCaret(p);
        } finally {
          await dom.dispose?.();
        }
      },
    ),
    inspectRichEditor: trace('inspectRichEditor', async () => {
      const base = await observed();
      const blocks = await readRichEditorBlocks(page());
      const value = blocks
        ? { ...base, rich: { formatKnown: true, blocks } }
        : unknownRichEditorEvidence(base);
      return value;
    }),
    async inspectRichDraft(ref: RemoteRef) {
      if (!sameRemote(remote, ref)) return undefined;
      const base = await observed();
      const blocks = await readRichEditorBlocks(page());
      return blocks
        ? { ...base, rich: { formatKnown: true, blocks } }
        : unknownRichEditorEvidence(base);
    },
    async reviewRichSavedDraft(
      taskId: string,
      reviewedTitle: string,
      editedTitle?: string,
    ) {
      const base = await reviewSavedDraft(taskId, reviewedTitle, editedTitle);
      const blocks = await readRichEditorBlocks(page());
      return blocks
        ? { ...base, rich: { formatKnown: true, blocks } }
        : unknownRichEditorEvidence(base);
    },
    async saveOnce() {
      if (!activeTask || savedTasks.has(activeTask)) fail('RESULT_AMBIGUOUS');
      const readForSave = async () => {
        const value = await operationObserved();
        if (
          value.pendingUploads ||
          value.localCover?.pendingUploads ||
          value.operation?.saving
        )
          fail('PAGE_CHANGED', 'save-operation-pending');
        if (!value.known || value.title !== title || value.remote)
          fail('CONTENT_MISMATCH', 'save-task-changed');
        return value;
      };
      const before = await readForSave();
      if (!options?.manualReview) await find(title, false);
      const p = await guard();
      const unchanged = await readForSave();
      if (
        before.contextKey !== unchanged.contextKey ||
        before.editorUrl !== unchanged.editorUrl ||
        !before.store ||
        !sameStore(unchanged.store, before.store) ||
        before.operation?.rootKey !== unchanged.operation?.rootKey ||
        before.operation?.taskId !== unchanged.operation?.taskId ||
        revision !== expectedRevision
      )
        fail('PAGE_CHANGED', 'save-identity-changed');
      stop();
      const save = p.getByRole('button', { name: '存草稿', exact: true });
      if ((await save.count()) !== 1) fail('PAGE_CHANGED');
      const saveGeneration = session.generation();
      if (!saveGeneration) fail('BROWSER_UNAVAILABLE');
      savedTasks.add(activeTask!);
      saveObservation = {
        responseReceived: false,
        httpStatus: null,
        businessStatus: null,
      };
      const candidates = new Set<Request>();
      let receiveResponse!: (response: Response | null) => void;
      const response = new Promise<Response | null>((resolve) => {
        receiveResponse = resolve;
      });
      const created = (request: Request) => {
        const url = new URL(request.url());
        if (
          url.origin === origin &&
          url.pathname === createPath &&
          request.method() === 'POST'
        ) {
          candidates.add(request);
          if (candidates.size === 1)
            void request
              .response()
              .then(receiveResponse, () => receiveResponse(null));
        }
      };
      // Platform formatGetHTML removes ignoreel nodes, but its exact <br>
      // trimming misses the attributed ProseMirror caret. Exclude only the
      // already-verified caret BR while the save serializes. The P remains,
      // so text added to that paragraph cannot be excluded by this marker.
      const tail = platformCaret
        ? await platformCaret.$(':scope > br.ProseMirror-trailingBreak')
        : null;
      const prepared = tail
        ? await tail.evaluate((node, root) => {
            if (
              !(node instanceof Element) ||
              node.tagName !== 'BR' ||
              node.childNodes.length !== 0 ||
              node.parentElement?.tagName !== 'P' ||
              node.parentElement.parentElement !== root ||
              !root?.isConnected ||
              node.parentElement.parentElement?.lastElementChild !==
                node.parentElement ||
              node.parentElement.textContent !== '' ||
              node.parentElement.childNodes.length !== 1 ||
              node.parentElement.hasAttribute('ignoreel') ||
              node.hasAttribute('ignoreel')
            )
              return false;
            node.setAttribute('ignoreel', 'true');
            return true;
          }, operationRoot)
        : false;
      let result;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      p.on('request', created);
      try {
        await readForSave();
        await assertSafe(p);
        if (await entrySaveBusy(p))
          fail('PAGE_CHANGED', 'save-operation-pending');
        stop();
        if (operatorSubmission) submissionStarted = Date.now();
        else responseTimer = setTimeout(() => receiveResponse(null), 15000);
        await save.click({ timeout: 5000 });
        submissionClicked = true;
        if (operatorSubmission) submissionSettlingStarted = Date.now();
        result = operatorSubmission
          ? await operatorWait(response)
          : await response;
      } finally {
        p.off('request', created);
        clearTimeout(responseTimer);
        // This handle refers to the original node, never a new page's tail.
        if (prepared)
          await tail!
            .evaluate((node) => {
              if (node instanceof Element) node.removeAttribute('ignoreel');
            })
            .catch(() => {});
        await tail?.dispose();
      }
      phase = 'save-response';
      if (candidates.size > 1)
        return fail('RESULT_AMBIGUOUS', 'save-request-unbound');
      if (!result) return fail('RESULT_AMBIGUOUS', 'save-response-missing');
      saveObservation.responseReceived = true;
      saveObservation.httpStatus = result.status();
      if (!result.ok()) return fail('RESULT_AMBIGUOUS', 'save-http-failure');
      const payload: unknown = operatorSubmission
        ? await operatorWait(result.json().catch(() => null))
        : await bounded(result.json().catch(() => null)).catch(() => null);
      // E63 proves non-zero status is failure. Zero only permits readback;
      // it is not itself proof of a saved draft.
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('status' in payload) ||
        typeof payload.status !== 'number' ||
        !Number.isSafeInteger(payload.status)
      )
        return fail('RESULT_AMBIGUOUS', 'save-response-invalid');
      saveObservation.businessStatus = payload.status;
      if (payload.status !== 0)
        return fail('RESULT_AMBIGUOUS', 'save-business-rejected');
      if (session.generation() !== saveGeneration) fail('PAGE_CHANGED');
      confirmedSaves.set(activeTask!, { title, generation: saveGeneration });
      stop();
      if (options?.manualReview || operatorSubmission) return;
      await guard();
      const ref = await find(title, true);
      if (!ref) fail('RESULT_AMBIGUOUS');
      await reopen(ref!, true);
      const after = await extract(p, 'all');
      await assertSafe(p);
      if (
        !after.known ||
        after.title !== before.title ||
        JSON.stringify(
          after.blocks.filter((block) => block.type === 'image'),
        ) !==
          JSON.stringify(
            before.blocks.filter((block) => block.type === 'image'),
          )
      )
        fail('CONTENT_MISMATCH');
    },
    async inspectEditor() {
      try {
        if (ownerConfirmedPilot && entryEvidence) {
          await guard();
          const value = entryEvidence;
          entryEvidence = null;
          return structuredClone({
            ...value,
            pendingUploads: value.pendingUploads || bodyUploadUnsettled(),
          });
        }
        if (ownerConfirmedPilot) await assertSafe(await guard());
        const value = await observed();
        return value;
      } catch (error) {
        reportFailure(error);
        return unknownEditorEvidence();
      }
    },
    inspectOperationEditor: operationObserved,
    async locateDraft(ref) {
      try {
        await guard();
        // A persisted URL only supplies a title to search; it cannot establish
        // draft identity until the list's actual Edit action returns the same ID.
        await reopen(ref);
        const value = await observed();
        if (!value.known || !value.title) return undefined;
        const located = await find(value.title, true);
        if (!sameRemote(located, ref)) return undefined;
        await reopen(ref, true);
        return ref;
      } catch (error) {
        reportFailure(error);
        return undefined;
      }
    },
    async inspectDraft(ref) {
      if (!sameRemote(remote, ref)) return undefined;
      return observed();
    },
  };
  return {
    ...capabilities,
    saveForOperatorReview: trace(
      'saveForOperatorReview',
      capabilities.saveForOperatorReview!,
    ),
    returnHomeAfterSubmission: trace(
      'returnHomeAfterSubmission',
      capabilities.returnHomeAfterSubmission!,
    ),
    ...(capabilities.checkWritingContext
      ? {
          checkWritingContext: trace(
            'writingCheckpoint',
            capabilities.checkWritingContext,
          ),
        }
      : {}),
    probe: trace('probe', capabilities.probe),
    inspectDraftAbsence: trace(
      'inspectDraftAbsence',
      capabilities.inspectDraftAbsence!,
    ),
    enterNewEditor: trace('enterNewEditor', capabilities.enterNewEditor),
    fillTitle: trace('fillTitle', capabilities.fillTitle),
    appendParagraph: trace('appendParagraph', capabilities.appendParagraph),
    appendImage: trace('appendImage', capabilities.appendImage),
    saveOnce: trace('saveOnce', capabilities.saveOnce),
    inspectEditor: trace('inspectEditor', capabilities.inspectEditor),
    locateDraft: trace('locateDraft', capabilities.locateDraft),
    inspectDraft: trace('inspectDraft', capabilities.inspectDraft),
  };
}
