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
} from './production-cover-driver';
import { createLocalCoverUploader, type CoverUploadInput } from './cover-pages';
import { randomUUID } from 'node:crypto';
import type { Page, ElementHandle, Request, Response } from 'playwright-core';
import type { BrowserSession } from '../../automation/browser-session';
import type { RemoteRef, StoreBinding } from '../../../contracts/draft-task';
import type { JudongchePages, JudongchePageOptions } from './page-contract';
import {
  emptyEditorPlaceholderSelector,
  unknownEditorEvidence,
  sameRemote,
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
} from './production-state';

const bodySelector = 'div[contenteditable="true"]:not([role])';
const createPath = '/motor/dealer_admin/go_api/article/create';
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

/** Fixed, local diagnostic labels only: never page text, URLs or exception messages. */
export type ProbeDiagnostic = {
  phase: string;
  check: string;
  reason: string;
  overlay?: OverlayDiagnostic;
  failureCheck?: string;
  operation?: string;
  failure?: boolean;
  exceptionCategory?: ReturnType<typeof exceptionCategory>;
  pageState?: string;
  firstFailure?: Omit<ProbeDiagnostic, 'firstFailure'>;
  coverOpen?: readonly CoverOpenDiagnostic[];
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
  extract: (page: Page, imageOnly?: boolean) => Promise<EditorEvidence>,
  diagnostic?: ProbeDiagnosticSink,
  options?: JudongchePageOptions,
  coverStages?: CoverStageGate,
): JudongchePages {
  const ownerConfirmedPilot = options?.ownerConfirmedPilot
    ? Object.freeze({ ...options.ownerConfirmedPilot })
    : undefined;
  let phase = 'session';
  let operation = 'probe';
  let failureReported = false;
  let firstFailure: ProbeDiagnostic | undefined;
  let coverOpen: CoverOpenDiagnostic[] = [];
  let menuObservations: MenuObservation[] = [];
  let entryStructure: ProbeDiagnostic['entryStructure'];
  let searchDiagnostic: ProbeDiagnostic['searchDiagnostic'];
  let draftListObservation: ProbeDiagnostic['draftListObservation'];
  let saveObservation: ProbeDiagnostic['saveObservation'];
  function reportFailure(error: unknown) {
    if (failureReported) return;
    failureReported = true;
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
        menuObservations: [...menuObservations],
        ...(saveObservation ? { saveObservation: { ...saveObservation } } : {}),
        ...(searchDiagnostic ? { searchDiagnostic } : {}),
        ...(draftListObservation ? { draftListObservation } : {}),
        ...(error instanceof JudongchePageError && error.overlay
          ? { overlay: error.overlay }
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
        menuObservations: [...menuObservations],
        ...(entryStructure ? { entryStructure } : {}),
        ...(searchDiagnostic ? { searchDiagnostic } : {}),
        ...(firstFailure ? { firstFailure } : {}),
        ...(coverOpen.length ? { coverOpen: [...coverOpen] } : {}),
        ...(overlay ? { overlay } : {}),
        ...(failureCheck ? { failureCheck } : {}),
      });
    } catch {
      /* Logging cannot change a safety outcome. */
    }
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
  let entryEvidence: EditorEvidence | null = null;
  let finalEvidence: EditorEvidence | null = null;
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
    if (!context) return fail('BROWSER_UNAVAILABLE');
    if (boundGeneration && session.generation() !== boundGeneration)
      return fail('PAGE_CHANGED');
    const pages = context.pages().filter((p) => p !== reader);
    if (pages.length !== 1) return fail('PAGE_CHANGED', 'primary-page-count');
    if (primary && pages[0] !== primary)
      return fail('PAGE_CHANGED', 'primary-page-replaced');
    if (!primary) {
      primary = pages[0]!;
      boundGeneration = session.generation();
      primary.on('framenavigated', (frame) => {
        if (frame === primary?.mainFrame()) revision++;
      });
      primary.on('dialog', (dialog) => {
        nativeDialog = true;
        void dialog.dismiss().catch(() => {});
      });
    }
    if (nativeDialog) return fail('PAGE_CHANGED', 'native-dialog');
    return primary;
  }
  function stop() {
    if (stopped()) fail('STOP_REQUESTED');
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
  ) {
    phase = 'guard-stop';
    checkStop();
    phase = 'guard-page';
    const p = page();
    phase = 'guard-safety';
    if (!ownerConfirmedPilot)
      await assertSafe(p, imageDialog, verifiedSelectionModal);
    else if (imageDialog) {
      if (verifiedSelectionModal)
        await assertSafe(p, true, verifiedSelectionModal);
      else await checkImageDialogs(p, 'owned');
    }
    if (!bound) fail('STORE_UNCONFIRMED');
    if (
      contextKey &&
      (p.url() !== expectedUrl || revision !== expectedRevision)
    )
      fail('PAGE_CHANGED');
    if (!ownerConfirmedPilot) {
      phase = 'guard-store-menu';
      if (!imageDialog) await confirmMenuStore(p, bound!.displayName);
      else if ((await identify()).storeKey !== bound!.storeKey)
        fail('STORE_CHANGED');
    }
    checkStop();
    page();
    // A later editor action must not be mislabeled as the completed store check.
    phase = operation;
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
    if (!contextKey || new URL(p.url()).pathname !== paths.editor)
      return unknownEditorEvidence();
    if (
      (await p.locator('textarea:visible').count()) !== 1 ||
      (await p.locator(bodySelector + ':visible').count()) !== 1
    )
      return unknownEditorEvidence();
    const value = await extract(p);
    if (!value.known) return unknownEditorEvidence();
    // extract returns unknown on unsupported structure; use a separate shape check
    // to distinguish a genuinely empty new editor from failed extraction.
    if ((await p.locator('textarea:visible').inputValue()) !== value.title)
      return unknownEditorEvidence();
    const nonempty = await p.locator(bodySelector).innerText();
    if (
      !value.blocks.length &&
      nonempty.trim() &&
      nonempty.trim() !== '请输入正文'
    )
      return unknownEditorEvidence();
    if (
      value.blocks.some(
        (b) => b.type === 'image' && (!b.loaded || !b.resourceKey),
      )
    )
      return unknownEditorEvidence();
    if (revision !== expectedRevision || p.url() !== expectedUrl)
      return unknownEditorEvidence();
    return {
      ...value,
      known: true,
      store: bound,
      contextKey,
      editorUrl: p.url(),
      remote,
      isDraft: !!remote,
      localCover: await readProductionLocalCover(p),
      pendingUploads: false,
    };
  }

  async function checkImageDialogs(p: Page, mode: 'owned' | 'closed') {
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
    finalEvidence = null;
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
      const tab = p
        .getByText('草稿箱', { exact: true })
        .filter({ visible: true });
      if ((await tab.count()) !== 1) return fail('RESULT_AMBIGUOUS');
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
    const tail = p.locator(bodySelector).locator(':scope > p').last();
    if ((await tail.count()) !== 1) fail('PAGE_CHANGED');
    if (
      (await tail.innerText()).trim() &&
      !(await tail.evaluate(
        (node, selector) =>
          node.matches(selector) &&
          node.childNodes.length === 3 &&
          node.children[0]?.childElementCount === 0 &&
          node.textContent === '请输入正文',
        emptyEditorPlaceholderSelector,
      ))
    )
      fail('PAGE_CHANGED');
    await tail.click();
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
    batchSubmissionReview: options?.batchSubmissionReview,
    async saveForOperatorReview(isStopped) {
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
        const isSaving = () =>
          p
            .getByRole('button', { name: '存草稿', exact: true })
            .evaluateAll((nodes) =>
              nodes.some(
                (node) =>
                  node.getAttribute('aria-busy') === 'true' ||
                  node.classList.contains('arco-btn-loading'),
              ),
            );
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
        return {
          observation,
          attemptedAt: new Date(submissionStarted).toISOString(),
        };
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
        if (coverTask !== activeTask) {
          coverTask = activeTask;
          coverUploader = createLocalCoverUploader(
            createProductionCoverDriver({
              currentPage: page,
              generation: () => session.generation(),
              guard: async (proof) => {
                await coverGuard(proof);
              },
              readEditor: observed,
              invalidateInspection,
              stages: coverStages,
              openDiagnostic: (event) => {
                coverOpen.push(event);
                phase = 'local-cover:open';
                report('cover-open-boundary', 'observed');
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
            await guard(
              false,
              isStopped
                ? () => {
                    if (isStopped()) fail('STOP_REQUESTED');
                  }
                : stop,
            );
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
      try {
        if (boundGeneration && session.generation() !== boundGeneration) {
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
        }
        const p = page();
        if (p.url() === 'about:blank' && !bound)
          await p.goto(origin + paths.home);
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
      stopped = isStopped ?? (() => false);
      if (!nextTitle || !taskId || savedTasks.has(taskId))
        fail('RESULT_AMBIGUOUS');
      await guard();
      invalidateInspection();
      title = nextTitle!;
      if (!options?.manualReview) await find(title, false);
      stop();
      const p = page();
      phase = 'editor-entry-navigation';
      if (ownerConfirmedPilot) {
        // The owner supplies the target. Use the editor's observed normal URL;
        // unrelated navigation/header markup is not an execution prerequisite.
        await p.goto(origin + paths.editor, { waitUntil: 'domcontentloaded' });
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
      contextKey = randomUUID();
      expectedUrl = p.url();
      expectedRevision = revision;
      remote = null;
      // SPA URL changes precede editor mount. Wait for the actual controls,
      // then retain the strict empty-content check before any write.
      phase = 'editor-entry-ready';
      await guard();
      await p.locator('textarea:visible').waitFor({
        state: 'visible',
        timeout: 10000,
      });
      await guard();
      await p.locator(bodySelector + ':visible').waitFor({
        state: 'visible',
        timeout: 10000,
      });
      if (ownerConfirmedPilot) await assertEntrySafe(p, stop);
      if (operatorBatch && options?.batchSubmissionReview === 'operator') {
        // Bounded observation catches delayed editor restoration before writes.
        // This does not prove that arbitrary later cache activity is impossible.
        const observingUntil = Date.now() + 500;
        do {
          await guard();
          await assertSafe(p);
          const candidate = await observed();
          if (
            !candidate.known ||
            candidate.title ||
            candidate.blocks.some(
              (block) => block.type !== 'paragraph' || block.text !== '',
            ) ||
            !(await hasEmptyProductionCover(p))
          )
            fail('EDITOR_NOT_EMPTY', 'editor-restoration-observed');
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < observingUntil);
        await guard();
        await assertSafe(p);
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
    },
    async fillTitle(text) {
      const p = await guard();
      invalidateInspection();
      if (text !== title) fail('CONTENT_MISMATCH');
      await p.locator('textarea:visible').fill(text);
    },
    async appendParagraph(text) {
      const p = await guard();
      invalidateInspection();
      await emptyTail(p);
      stop();
      for (const [index, line] of text.split('\n').entries()) {
        stop();
        if (index) await p.keyboard.press('Shift+Enter');
        await p.keyboard.insertText(line);
      }
      // The live editor supplies a trailing caret paragraph after text input.
      // Only create one when the editor has not already supplied it.
      const hasTail = await p.locator(bodySelector).evaluate((body) => {
        const tail = body.lastElementChild;
        return (
          tail?.tagName === 'P' &&
          tail.textContent === '' &&
          tail.childNodes.length === 1 &&
          tail.firstElementChild?.tagName === 'BR' &&
          tail.firstElementChild.classList.contains('ProseMirror-trailingBreak')
        );
      });
      stop();
      if (!hasTail) await p.keyboard.press('Enter');
    },
    async appendImage(bytes, mime) {
      const p = await guard();
      invalidateInspection();
      const before = ownerConfirmedPilot ? null : await observed();
      const beforeImages = ownerConfirmedPilot
        ? await p.locator(bodySelector + ' .pgc-image img:visible').count()
        : 0;
      await emptyTail(p);
      const insertionIndex = await p.locator(bodySelector).evaluate((body) => {
        if (body.lastElementChild?.tagName !== 'P') return -1;
        return body.children.length - 1;
      });
      if (insertionIndex < 0) fail('PAGE_CHANGED');
      stop();
      const button = p.locator('.syl-toolbar-tool.image button');
      if ((await button.count()) !== 1) fail('PAGE_CHANGED');
      await button.click();
      const file = p.locator('input[type="file"]');
      await file.waitFor({ state: 'attached', timeout: 5000 });
      if ((await file.count()) !== 1) fail('PAGE_CHANGED');
      await guard(true);
      await file.setInputFiles({
        name: mime === 'image/png' ? 'body.png' : 'body.jpg',
        mimeType: mime,
        buffer: Buffer.from(bytes),
      });
      const dialog = p
        .locator('[role="dialog"],.ant-modal')
        .filter({ has: file });
      if ((await dialog.count()) !== 1) fail('PAGE_CHANGED');
      await dialog
        .locator('img:visible')
        .waitFor({ state: 'visible', timeout: 15000 });
      await p.waitForFunction(
        () => {
          const dialogs = Array.from(
            document.querySelectorAll('[role="dialog"],.ant-modal'),
          ).filter((d) => d.querySelector('input[type="file"]'));
          const imgs = dialogs
            .flatMap((d) => Array.from(d.querySelectorAll('img')))
            .filter((i) => i.getClientRects().length);
          return (
            imgs.length === 1 && imgs[0]!.complete && imgs[0]!.naturalWidth > 0
          );
        },
        undefined,
        { timeout: 15000 },
      );
      await guard(true);
      const closingDialog = await dialog.evaluateHandle(
        (node) => node.closest('[aria-modal="true"]') || node,
      );
      if (!closingDialog) fail('PAGE_CHANGED');
      try {
        await dialog
          .getByRole('button', { name: '确定', exact: true })
          .click({ timeout: 5000 });
        // The upload input may unmount before the dialog. A locator filtered
        // by that input can stop matching while the owned dialog still exists.
        await p.waitForFunction((node) => !node.isConnected, closingDialog, {
          timeout: 10000,
        });
      } finally {
        await closingDialog.dispose().catch(() => {});
      }
      await p.waitForFunction(
        (selector) =>
          Array.from(document.querySelectorAll(selector + ' .pgc-image img'))
            .slice(-1)
            .some(
              (e) =>
                (e as HTMLImageElement).complete &&
                (e as HTMLImageElement).naturalWidth > 0,
            ),
        bodySelector,
        { timeout: 10000 },
      );
      if (ownerConfirmedPilot) {
        await guard();
        await checkImageDialogs(p, 'closed');
      }
      // The live editor inserts the image after its empty caret paragraph.
      // Remove only that insertion-owned paragraph, never source paragraphs.
      const retainedCaret = await p
        .locator(bodySelector)
        .evaluate((body, index) => {
          const isEmpty = (node: Element | undefined) =>
            node?.tagName === 'P' &&
            node.textContent === '' &&
            node.childNodes.length === 1 &&
            node.firstElementChild?.tagName === 'BR' &&
            node.firstElementChild.classList.contains(
              'ProseMirror-trailingBreak',
            );
          const children = Array.from(body.children);
          if (
            children.length === index + 2 &&
            children[index]?.matches('div[__syl_tag]') &&
            isEmpty(children[index + 1])
          )
            return false;
          if (
            children.length === index + 3 &&
            isEmpty(children[index]) &&
            children[index + 1]?.matches('div[__syl_tag]') &&
            isEmpty(children[index + 2])
          )
            return true;
          return null;
        }, insertionIndex);
      if (retainedCaret === null) fail('PAGE_CHANGED');
      if (retainedCaret) {
        await guard();
        const caret = p
          .locator(bodySelector)
          .locator(':scope > *')
          .nth(insertionIndex);
        // Empty paragraphs between atomic images may be hit-tested as the image.
        // Place the DOM selection inside the verified empty paragraph explicitly.
        const positioned = await caret.evaluate((node) => {
          if (
            node.tagName !== 'P' ||
            node.textContent !== '' ||
            node.childNodes.length !== 1 ||
            node.firstElementChild?.tagName !== 'BR' ||
            !node.firstElementChild.classList.contains(
              'ProseMirror-trailingBreak',
            ) ||
            !node.nextElementSibling?.matches('div[__syl_tag]')
          )
            return false;
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(node);
          range.collapse(true);
          (
            node.closest('[contenteditable="true"]') as HTMLElement | null
          )?.focus();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return true;
        });
        if (!positioned) fail('PAGE_CHANGED');
        const focused = await caret.evaluate((node) => {
          const selection = window.getSelection();
          return (
            selection?.isCollapsed &&
            !!selection.anchorNode &&
            node.contains(selection.anchorNode)
          );
        });
        if (!focused) fail('PAGE_CHANGED');
        stop();
        await p.keyboard.press('Delete');
        const removed = await p
          .locator(bodySelector)
          .evaluate(
            (body, index) =>
              body.children.length === index + 2 &&
              body.children[index]?.matches('div[__syl_tag]') &&
              body.lastElementChild?.tagName === 'P' &&
              body.lastElementChild.textContent === '',
            insertionIndex,
          );
        if (!removed) fail('CONTENT_MISMATCH');
      }
      const after = ownerConfirmedPilot
        ? await extract(p, true)
        : await observed();
      const image = after.blocks.at(-1);
      if (ownerConfirmedPilot) {
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
        return image.resourceKey;
      }
      if (
        !after.known ||
        !before ||
        after.blocks.length !== before.blocks.length + 1 ||
        JSON.stringify(after.blocks.slice(0, -1)) !==
          JSON.stringify(before.blocks) ||
        image?.type !== 'image' ||
        !image.resourceKey ||
        !image.loaded
      )
        return fail('CONTENT_MISMATCH');
      return image.resourceKey;
    },
    async chooseFirstCover() {
      return fail('INPUT_UNSUPPORTED');
    },
    async saveOnce() {
      if (!activeTask || savedTasks.has(activeTask)) fail('RESULT_AMBIGUOUS');
      const before = ownerConfirmedPilot ? finalEvidence : await observed();
      if (!before || !before.known || before.title !== title || remote)
        return fail('CONTENT_MISMATCH');
      if (!options?.manualReview) await find(title, false);
      const p = await guard();
      if (ownerConfirmedPilot) {
        if (
          before.contextKey !== contextKey ||
          before.editorUrl !== p.url() ||
          revision !== expectedRevision
        )
          fail('PAGE_CHANGED');
        finalEvidence = null;
      } else {
        const unchanged = await observed();
        if (JSON.stringify(unchanged) !== JSON.stringify(before))
          fail('CONTENT_MISMATCH');
      }
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
      const tails = await p
        .locator(bodySelector)
        .locator(':scope > p:last-child > br.ProseMirror-trailingBreak')
        .elementHandles();
      if (tails.length !== 1) {
        await Promise.all(tails.map((node) => node.dispose()));
        return fail('CONTENT_MISMATCH');
      }
      const tail = tails[0]!;
      const prepared = await tail.evaluate((node) => {
        if (
          !(node instanceof Element) ||
          node.tagName !== 'BR' ||
          node.childNodes.length !== 0 ||
          node.parentElement?.tagName !== 'P' ||
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
      });
      if (!prepared) {
        await tail.dispose();
        return fail('CONTENT_MISMATCH');
      }
      let result;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      p.on('request', created);
      try {
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
        await tail
          .evaluate((node) => {
            if (node instanceof Element) node.removeAttribute('ignoreel');
          })
          .catch(() => {});
        await tail.dispose();
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
      const after = await observed();
      if (
        !after.known ||
        after.title !== before.title ||
        JSON.stringify(after.blocks) !== JSON.stringify(before.blocks)
      )
        fail('CONTENT_MISMATCH');
    },
    async inspectEditor() {
      try {
        if (ownerConfirmedPilot && entryEvidence) {
          await guard();
          const value = entryEvidence;
          entryEvidence = null;
          return structuredClone(value);
        }
        if (ownerConfirmedPilot) await assertSafe(await guard());
        const value = await observed();
        if (ownerConfirmedPilot) {
          finalEvidence = null;
          finalEvidence = value.known ? structuredClone(value) : null;
        }
        return value;
      } catch (error) {
        reportFailure(error);
        return unknownEditorEvidence();
      }
    },
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
