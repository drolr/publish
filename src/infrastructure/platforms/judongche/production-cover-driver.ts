import { coverResourceKey as resource } from './cover-resource';
import { createHash } from 'node:crypto';
import type { Page, ElementHandle, JSHandle, Locator } from 'playwright-core';
import { CoverUploadInputSchema } from '../../../contracts/cover-upload';
import type {
  CoverPageDriver,
  CoverPageObservation,
  CoverUploadFile,
} from './cover-pages';
import type { EditorEvidence } from './content-evidence';
import { assertSafe, fail, exceptionCategory } from './production-state';

// Candidate semantics, NOT live G1 acceptance. Triple associations and failed /
// partial terminal states are deliberately unimplemented. The public adapter
// implements SINGLE only. UI and live admission remain independent gates.
export const productionCoverUploadSupported = true;
const layerSelector =
  '[role="dialog"],[aria-modal="true"],.ant-modal,.arco-modal,.arco-modal-wrapper,.ant-modal-wrap,.arco-modal-mask,.ant-modal-mask';
const modalSelector = '[role="dialog"],[aria-modal="true"],.ant-modal';
const bodySelector = 'div[contenteditable="true"]:not([role])';
type NodeHandle = ElementHandle<Element>;
type SelectionCapture = {
  files: readonly File[];
  inputCount: number;
  changeCount: number;
  invalid: boolean;
  dispose(): void;
};
export type OwnedCoverModalProof = Readonly<{
  page: Page;
  generation: string;
  epoch: number;
  modal: NodeHandle;
  wrapper: NodeHandle;
  mask: NodeHandle;
  selectedFileVerified?: boolean;
}>;
export type CoverStage =
  | 'after-selection'
  | 'after-upload-review'
  | 'after-library-review'
  | 'before-confirm'
  | 'after-cover-review';
/** Internal pause-only instrumentation: no result/proof can be supplied. */
export type CoverEffect =
  'mode' | 'open' | 'upload' | 'uncheck' | 'confirm' | 'cancel';
export type CoverStageGate = {
  reserve(effect: CoverEffect): Promise<void>;
  pause(
    stage: CoverStage,
    observation: Readonly<CoverPageObservation>,
    readCurrent?: () => Promise<Readonly<CoverPageObservation>>,
  ): Promise<void>;
};
/** Fixed internal boundaries only; never include page content or exception text. */
export type CoverOpenPhase =
  | 'guard'
  | 'read-editor'
  | 'capture-nodes'
  | 'capture-region'
  | 'switch-mode'
  | 'prepare-slot'
  | 'slot-click'
  | 'modal-visible'
  | 'modal-structure'
  | 'modal-handles'
  | 'inspect';
export type CoverOpenDiagnostic = Readonly<{
  phase: CoverOpenPhase;
  status: 'start' | 'returned' | 'failed';
  elapsedMs: number;
  exceptionCategory?: ReturnType<typeof exceptionCategory>;
}>;
export type ProductionCoverContext = {
  openDiagnostic?(event: CoverOpenDiagnostic): void;
  stages?: CoverStageGate;
  currentPage(): Page;
  generation(): string | null;
  guard(proof?: OwnedCoverModalProof): Promise<void>;
  readEditor(proof?: OwnedCoverModalProof): Promise<EditorEvidence>;
  invalidateInspection(): void;
};
const digest = (e: EditorEvidence) =>
  createHash('sha256')
    .update(
      JSON.stringify([e.contextKey, e.editorUrl, e.store, e.title, e.blocks]),
    )
    .digest('hex');
async function handle(locator: Locator): Promise<NodeHandle> {
  if ((await locator.count()) !== 1)
    return fail('PAGE_CHANGED', 'cover-node-not-unique');
  const node = await locator.elementHandle();
  if (!node) return fail('PAGE_CHANGED');
  return node;
}
async function same(node: NodeHandle, locator: Locator) {
  if (
    (await locator.count()) !== 1 ||
    !(await node.evaluate(
      (old, current) => old.isConnected && old === current,
      await locator.elementHandle(),
    ))
  )
    fail('PAGE_CHANGED', 'cover-node-replaced');
}
/** Rechecked by BOTH driver and context entry. A boolean cannot own an overlay.
 * No raw page content or resource URL is returned to diagnostics. */
export async function assertOwnedCoverModal(
  page: Page,
  generation: string | null,
  proof: OwnedCoverModalProof,
) {
  if (proof.page !== page || !generation || proof.generation !== generation)
    fail('PAGE_CHANGED', 'cover-generation');
  const valid = await page.evaluate(
    ({ modal, wrapper, mask, epoch, selector }) => {
      if (
        performance.timeOrigin !== epoch ||
        ![modal, wrapper, mask].every((n) => n.isConnected)
      )
        return false;
      if (
        !wrapper.matches('.arco-modal-wrapper,.ant-modal-wrap') ||
        modal.closest('.arco-modal-wrapper,.ant-modal-wrap') !== wrapper ||
        !mask.matches('.arco-modal-mask,.ant-modal-mask') ||
        mask.parentElement !== wrapper.parentElement ||
        mask.childNodes.length !== 0
      )
        return false;
      const layers = Array.from(document.querySelectorAll(selector));
      if (layers.length > 24) return false;
      const shown = layers.filter(
        (e) =>
          e.getClientRects().length &&
          getComputedStyle(e).visibility === 'visible',
      );
      if (
        shown.length !== 3 ||
        !shown.includes(modal) ||
        !shown.includes(wrapper) ||
        !shown.includes(mask)
      )
        return false;
      if (modal.querySelectorAll('*').length > 120) return false;
      // Reject a foreign fixed layer even when it uses no known modal class.
      for (const [x, y] of [
        [0.5, 0.5],
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        let node = document.elementFromPoint(innerWidth * x!, innerHeight * y!);
        for (
          let depth = 0;
          node && depth < 8 && !['BODY', 'HTML'].includes(node.tagName);
          depth++, node = node.parentElement
        ) {
          const style = getComputedStyle(node),
            rect = node.getBoundingClientRect();
          if (
            style.position === 'fixed' &&
            style.pointerEvents !== 'none' &&
            style.visibility === 'visible' &&
            rect.width > innerWidth * 0.7 &&
            rect.height > innerHeight * 0.7 &&
            node !== wrapper &&
            node !== mask &&
            node !== modal &&
            !modal.contains(node)
          )
            return false;
        }
      }
      return true;
    },
    { ...proof, page: undefined, selector: layerSelector },
  );
  if (!valid) fail('PAGE_CHANGED', 'cover-owned-layers');
  // Existing login/security/permission checks remain active as well.
  await assertSafe(
    page,
    true,
    proof.selectedFileVerified ? proof.modal : undefined,
  );
}
async function region(page: Page) {
  const label = page.getByText('展示封面', { exact: true });
  if ((await label.count()) !== 1 || !(await label.isVisible()))
    return fail('PAGE_CHANGED', 'cover-region');
  let r = label;
  for (let depth = 0; depth < 6; depth++) {
    r = r.locator('..');
    if (
      !(await r.evaluate(
        (e) =>
          !['BODY', 'HTML', 'MAIN', 'HEADER'].includes(e.tagName) &&
          e.querySelectorAll('*').length <= 120 &&
          !e.querySelector('textarea,[contenteditable]'),
      ))
    )
      break;
    if (await r.getByText(/^(插入超级店铺|发文设置|车系选择|存草稿)$/).count())
      break;
    const s = r.getByText('单图', { exact: true }),
      t = r.getByText('三图', { exact: true });
    if ((await s.count()) !== 1 || (await t.count()) !== 1) continue;
    const sl = s.locator('xpath=ancestor::label[1]'),
      tl = t.locator('xpath=ancestor::label[1]');
    for (const l of [sl, tl]) {
      if (
        (await l.count()) !== 1 ||
        !(await l.isVisible()) ||
        !(await l.evaluate(
          (e) =>
            e instanceof HTMLLabelElement &&
            e.querySelectorAll('input[type=radio]').length === 1 &&
            e.control === e.querySelector('input[type=radio]') &&
            !e.closest(
              'a,button,[role=button],[role=link],[role=menuitem],[role=tab]',
            ),
        ))
      )
        return fail('PAGE_CHANGED', 'cover-radio-association');
    }
    const si = sl.locator('input[type=radio]'),
      ti = tl.locator('input[type=radio]');
    if (
      (await si.evaluate(
        (e, other) => e === other,
        await ti.elementHandle(),
      )) ||
      (await si.isDisabled()) ||
      (await ti.isDisabled()) ||
      (await si.isChecked()) === (await ti.isChecked())
    )
      return fail('PAGE_CHANGED', 'cover-radio-state');
    const slots = r.locator('.article-cover-images:visible');
    if ((await slots.count()) !== 1) return fail('PAGE_CHANGED', 'cover-slots');
    return {
      r,
      sl,
      tl,
      si,
      ti,
      slots,
      mode: (await si.isChecked()) ? ('single' as const) : ('triple' as const),
    };
  }
  return fail('PAGE_CHANGED', 'cover-region-unbounded');
}
async function empty(slots: Locator) {
  return slots.evaluate((e) => {
    if (
      e.closest(
        'a,button,[role=button],[role=link],[role=menuitem],[role=tab],[contenteditable]',
      ) ||
      e.tagName !== 'DIV' ||
      e.childNodes.length !== 1
    )
      return false;
    const add = e.firstElementChild;
    if (
      !add ||
      add.tagName !== 'DIV' ||
      !add.classList.contains('article-cover-add') ||
      add.childNodes.length !== 1 ||
      add.matches('[role],a,button')
    )
      return false;
    const icon = add.firstElementChild;
    return (
      !!icon &&
      icon.tagName === 'IMG' &&
      icon.classList.contains('plus-icon') &&
      !icon.matches('[role],a,button') &&
      icon.childNodes.length === 0
    );
  });
}
/** Readback uses the observed SINGLE source-object forms, with exact URL
 * fallback for unknown shapes. Existing non-cover tasks ignore this projection. */
export async function hasEmptyProductionCover(page: Page): Promise<boolean> {
  const slots = page.locator('.article-cover-images:visible');
  return (await slots.count()) === 1 && (await empty(slots));
}
export async function readProductionLocalCover(
  page: Page,
  waitForImage = false,
): Promise<NonNullable<EditorEvidence['localCover']>> {
  const unknown = {
    known: false,
    mode: null,
    items: [],
    pendingUploads: true,
  } as const;
  try {
    if (await page.locator(modalSelector + ':visible').count())
      return { ...unknown, items: [] };
    const r = await region(page);
    if (await empty(r.slots))
      return { known: true, mode: 'none', items: [], pendingUploads: false };
    const observed = await r.slots.evaluate(async (e, wait) => {
      if (
        e.querySelector('[role=progressbar],[aria-busy=true],progress') ||
        e.querySelectorAll('*').length > 30
      )
        return null;
      const imgs = Array.from(e.querySelectorAll('img')).filter(
        (i) => !i.classList.contains('plus-icon'),
      );
      if (imgs.length !== 1) return null;
      const i = imgs[0]!;
      const source = i.src;
      const sourceSet = i.srcset;
      if (wait && !i.complete) {
        // Wait only for this already present image; never select/upload again.
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            observer.disconnect();
            i.removeEventListener('load', finish);
            i.removeEventListener('error', finish);
            resolve();
          };
          const observer = new MutationObserver(() => {
            if (
              !e.isConnected ||
              !i.isConnected ||
              i.src !== source ||
              i.srcset !== sourceSet
            )
              finish();
          });
          const timer = setTimeout(finish, 10000);
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'srcset'],
          });
          i.addEventListener('load', finish);
          i.addEventListener('error', finish);
          if (i.complete) finish();
        });
      }
      if (
        !e.isConnected ||
        !i.isConnected ||
        i.src !== source ||
        i.srcset !== sourceSet ||
        e.querySelectorAll('img:not(.plus-icon)').length !== 1 ||
        e.querySelector('img:not(.plus-icon)') !== i
      )
        return null;
      if (
        !i.getClientRects().length ||
        !i.complete ||
        i.naturalWidth <= 0 ||
        i.naturalHeight <= 0
      )
        return null;
      try {
        const u = new URL(i.currentSrc);
        if (u.protocol !== 'https:' || u.username || u.password || u.hash)
          return null;
      } catch {
        return null;
      }
      return i.currentSrc;
    }, waitForImage);
    if (r.mode !== 'single' || !observed) return { ...unknown, items: [] };
    return {
      known: true,
      mode: 'single',
      items: [{ position: 0, resourceKey: resource(observed), loaded: true }],
      pendingUploads: false,
    };
  } catch {
    return { ...unknown, items: [] };
  }
}
export function createProductionCoverDriver(
  context: ProductionCoverContext,
): CoverPageDriver {
  let proof: OwnedCoverModalProof | undefined,
    input: NodeHandle | undefined,
    fileObjects: JSHandle<readonly File[]> | undefined,
    selectionCapture: JSHandle<SelectionCapture> | undefined;
  let inputResetAtSelection = false;
  let editorDigest: string | undefined,
    generation: string | null = null,
    epoch: number | undefined;
  let titleNode: NodeHandle | undefined,
    bodyNode: NodeHandle | undefined,
    slotsNode: NodeHandle | undefined;
  let mode: 'single' | 'triple' | undefined,
    files: CoverUploadFile[] | undefined;
  let opened = false,
    uploadAttempted = false,
    confirmAttempted = false,
    cancelAttempted = false,
    uncheckAttempted = false;
  let closed: 'confirmed' | 'cancelled' | undefined,
    items: CoverPageObservation['items'] = [];
  let libraryNode: NodeHandle | undefined;
  let previewNode: NodeHandle | undefined;
  let associationInvalid = false;
  let terminalCheck = 'cover-terminal-unverified';
  async function disposeSelection() {
    const capture = selectionCapture,
      objects = fileObjects,
      node = closed ? input : undefined;
    selectionCapture = undefined;
    fileObjects = undefined;
    if (closed) input = undefined;
    if (capture) {
      try {
        await capture.evaluate((value) => value.dispose());
      } catch {
        /* A destroyed document already removed its listeners. */
      }
    }
    await Promise.allSettled([
      capture?.dispose(),
      objects?.dispose(),
      node?.dispose(),
    ]);
  }

  async function guard() {
    if (associationInvalid) fail('PAGE_CHANGED', 'cover-association-drift');
    const p = context.currentPage();
    if (
      generation &&
      (context.generation() !== generation ||
        (await p.evaluate(() => performance.timeOrigin)) !== epoch)
    )
      fail('PAGE_CHANGED', 'cover-document');
    if (proof) await assertOwnedCoverModal(p, context.generation(), proof);
    await context.guard(proof);
    if (editorDigest) {
      const e = await context.readEditor(proof);
      if (!e.known || digest(e) !== editorDigest)
        fail('PAGE_CHANGED', 'cover-editor-drift');
      await same(titleNode!, p.locator('textarea:visible'));
      await same(bodyNode!, p.locator(bodySelector + ':visible'));
      const r = await region(p);
      await same(slotsNode!, r.slots);
      if (r.mode !== mode) fail('PAGE_CHANGED', 'cover-mode-drift');
    }
  }
  async function library() {
    if (!proof) return null;
    const modal = context
      .currentPage()
      .locator(modalSelector)
      .filter({
        has: context.currentPage().getByText('上传图片', { exact: true }),
      });
    const boxes = modal.getByRole('checkbox', {
      name: '保存到素材库',
      exact: true,
    });
    if ((await boxes.count()) !== 1) return null;
    const box = boxes;
    const valid = await box.evaluate(
      (e) =>
        e instanceof HTMLInputElement &&
        e.type === 'checkbox' &&
        !e.disabled &&
        !e.indeterminate &&
        e.labels?.length === 1 &&
        e.labels[0]!.control === e &&
        e.labels[0]!.textContent?.trim() === '保存到素材库',
    );
    if (!valid) return null;
    if (libraryNode) await same(libraryNode, box);
    else libraryNode = await handle(box);
    return box.isChecked();
  }
  async function terminal() {
    terminalCheck = 'cover-terminal-prerequisites';
    if (!proof || !files || !input || !fileObjects || mode !== 'single')
      return null;
    const p = context.currentPage();
    const captureValid =
      selectionCapture &&
      (await selectionCapture.evaluate(
        (capture) =>
          !capture.invalid &&
          capture.inputCount === 1 &&
          capture.changeCount === 1,
      ));
    const currentInput = p.locator(modalSelector).locator('input[type=file]');
    const connected = await input.evaluate((e) => e.isConnected);
    if (connected) await same(input, currentInput);
    else if ((await currentInput.count()) !== 0)
      fail('PAGE_CHANGED', 'cover-input-replaced');
    const retained =
      !!captureValid &&
      (connected
        ? await input.evaluate(
            (e, { original, reset }) =>
              e instanceof HTMLInputElement &&
              !e.disabled &&
              (reset
                ? e.files?.length === 0
                : e.files?.length === original.length &&
                  original.every((f, i) => e.files![i] === f)),
            { original: fileObjects, reset: inputResetAtSelection },
          )
        : inputResetAtSelection);
    if (!retained) {
      terminalCheck = 'cover-selected-file-not-retained';
      if (previewNode) associationInvalid = true;
      return null;
    }
    const data = await proof.modal.evaluate((e) => {
      if (e.querySelectorAll('*').length > 120) return null;
      const busy = Array.from(
        e.querySelectorAll('[role=progressbar],[aria-busy=true],progress'),
      ).some(
        (n) =>
          n.getClientRects().length &&
          getComputedStyle(n).visibility === 'visible',
      );
      if (busy) return null;
      const labels = Array.from(e.querySelectorAll('*')).filter(
        (n) =>
          n.childElementCount === 0 &&
          n.textContent?.trim() === '上传完成，可以拖拽调整图片顺序' &&
          n.getClientRects().length &&
          getComputedStyle(n).visibility === 'visible',
      );
      const imgs = Array.from(e.querySelectorAll('img')).filter(
        (n) =>
          n.getClientRects().length &&
          getComputedStyle(n).visibility === 'visible',
      );
      if (labels.length !== 1 || imgs.length !== 1) return null;
      const i = imgs[0]!;
      if (!i.complete || i.naturalWidth <= 0 || i.naturalHeight <= 0)
        return null;
      try {
        const u = new URL(i.currentSrc);
        if (u.protocol !== 'https:' || u.username || u.password || u.hash)
          return null;
      } catch {
        return null;
      }
      return i.currentSrc;
    });
    if (!data) {
      terminalCheck = 'cover-terminal-dom-unverified';
      if (previewNode) associationInvalid = true;
      return null;
    }
    const observed: CoverPageObservation['items'] = [
      {
        position: 0,
        assetKey: files[0]!.assetKey,
        sha256: files[0]!.sha256,
        resourceKey: resource(data),
        loaded: true,
      },
    ];
    try {
      const preview = p.locator(modalSelector).locator('img:visible');
      if (previewNode) {
        await same(previewNode, preview);
        if (JSON.stringify(observed) !== JSON.stringify(items))
          fail('PAGE_CHANGED', 'cover-association-drift');
      } else {
        // Pin the FIRST complete causal association, before any review pause.
        // A later observation must never assign a new remote resource to this File.
        const node = await handle(preview);
        if (
          !(await node.evaluate(
            (image, url) =>
              image instanceof HTMLImageElement &&
              image.isConnected &&
              image.complete &&
              image.naturalWidth > 0 &&
              image.naturalHeight > 0 &&
              image.currentSrc === url,
            data,
          ))
        )
          fail('PAGE_CHANGED', 'cover-association-drift');
        previewNode = node;
        items = structuredClone(observed);
      }
    } catch (error) {
      associationInvalid = true;
      throw error;
    }
    // Neither callers nor stage observers receive the private pinned array.
    return structuredClone(items);
  }
  async function inspect(): Promise<CoverPageObservation> {
    await guard();
    const p = context.currentPage(),
      e = await context.readEditor(proof);
    if (!e.known) fail('PAGE_CHANGED', 'cover-editor-unknown');
    let observedItems: CoverPageObservation['items'] = [],
      settlement: CoverPageObservation['settlement'] = 'unknown',
      result: CoverPageObservation['result'] = null;
    let currentMode: typeof mode | null = mode ?? (await region(p)).mode;
    if (!opened) {
      if (
        (await p.locator(modalSelector + ':visible').count()) ||
        !(await empty((await region(p)).slots))
      )
        fail('PAGE_CHANGED', 'cover-not-empty');
      settlement = 'settled';
    } else if (proof && !uploadAttempted) {
      if (!input) return fail('PAGE_CHANGED');
      await same(input, p.locator(modalSelector).locator('input[type=file]'));
      if (
        !(await input.evaluate(
          (e) =>
            e instanceof HTMLInputElement &&
            !e.disabled &&
            e.files?.length === 0,
        ))
      )
        fail('PAGE_CHANGED', 'cover-input-not-empty');
      if (
        await proof.modal.$('img,[role=progressbar],[aria-busy=true],progress')
      )
        fail('PAGE_CHANGED', 'cover-preselection-work');
      settlement = 'settled';
    } else if (proof) {
      const found = await terminal();
      if (found) {
        observedItems = found;
        settlement = 'settled';
        result = 'complete';
      }
    } else if (closed) {
      const cover = await readProductionLocalCover(p);
      if (cover.known && !cover.pendingUploads) {
        if (closed === 'cancelled' && cover.mode === 'none')
          settlement = 'settled';
        if (
          closed === 'confirmed' &&
          cover.mode === mode &&
          JSON.stringify(cover.items) ===
            JSON.stringify(
              items.map(({ position, resourceKey, loaded }) => ({
                position,
                resourceKey,
                loaded,
              })),
            )
        ) {
          settlement = 'settled';
          result = 'complete';
          observedItems = items;
        }
      }
      currentMode = mode ?? null;
    }
    return {
      generation: context.generation() ?? '',
      editor: { ...e, pendingUploads: settlement !== 'settled' },
      modal: proof ? 'owned' : 'closed',
      settlement,
      mode: currentMode,
      result,
      libraryChecked: await library(),
      items: observedItems,
    };
  }
  async function stage(name: CoverStage) {
    if (context.stages)
      await context.stages.pause(
        name,
        structuredClone(await inspect()),
        async () => structuredClone(await inspect()),
      );
    // Release must recheck the pinned association, not only page ownership.
    await inspect();
  }
  async function modalButton(name: '确定' | '取消') {
    if (!proof) return fail('PAGE_CHANGED');
    const button = context
      .currentPage()
      .locator(modalSelector)
      .getByRole('button', { name, exact: true });
    if (
      (await button.count()) !== 1 ||
      !(await button.isVisible()) ||
      !(await button.isEnabled()) ||
      !(await button.evaluate(
        (e) => e instanceof HTMLButtonElement && !e.closest('a,[role=link]'),
      ))
    )
      return fail('PAGE_CHANGED', 'cover-footer-unverified');
    return button;
  }
  async function closeOwned(name: '确定' | '取消') {
    if (name === '确定') await stage('before-confirm');
    const before = await inspect();
    if (
      before.settlement !== 'settled' ||
      before.result !== 'complete' ||
      before.items.length !== 1
    )
      fail('PAGE_CHANGED', 'cover-terminal-unverified');
    if (name === '确定' && before.libraryChecked !== false)
      fail('PAGE_CHANGED', 'cover-library-unverified');
    if (name === '确定' ? confirmAttempted : cancelAttempted)
      fail('PAGE_CHANGED', 'cover-action-already-attempted');
    const button = await modalButton(name),
      buttonNode = await handle(button),
      owned = proof!;
    // Snapshot and actual checkbox node are reread after any external stage gate.
    await context.stages?.reserve(name === '确定' ? 'confirm' : 'cancel');
    const fresh = await inspect();
    if (JSON.stringify(fresh) !== JSON.stringify(before))
      fail('PAGE_CHANGED', 'cover-confirm-drift');
    await same(buttonNode, await modalButton(name));
    if (name === '确定') confirmAttempted = true;
    else cancelAttempted = true;
    context.invalidateInspection();
    await buttonNode.click({ timeout: 5000 });
    await context
      .currentPage()
      .waitForFunction(
        ({ modal, wrapper, mask }) =>
          ![modal, wrapper, mask].some((n) => n.isConnected),
        { modal: owned.modal, wrapper: owned.wrapper, mask: owned.mask },
        { timeout: 10000 },
      );
    proof = undefined;
    closed = name === '确定' ? 'confirmed' : 'cancelled';
    await disposeSelection();
    const after = await inspect();
    if (
      after.settlement !== 'settled' ||
      (name === '确定' && after.result !== 'complete')
    )
      fail('PAGE_CHANGED', 'cover-close-readback');
    if (name === '确定') await stage('after-cover-review');
  }
  return {
    guard,
    inspect,
    async open(nextMode) {
      const started = performance.now();
      let openPhase: CoverOpenPhase = 'guard';
      const record = (
        status: CoverOpenDiagnostic['status'],
        error?: unknown,
      ) => {
        try {
          context.openDiagnostic?.({
            phase: openPhase,
            status,
            elapsedMs: performance.now() - started,
            ...(status === 'failed'
              ? { exceptionCategory: exceptionCategory(error) }
              : {}),
          });
        } catch {
          /* Diagnostics never change the original operation or exception. */
        }
      };
      const next = (nextPhase: CoverOpenPhase) => {
        record('returned');
        openPhase = nextPhase;
        record('start');
      };
      record('start');
      try {
        if (opened) fail('PAGE_CHANGED', 'cover-open-already-attempted');
        await guard();
        const p = context.currentPage();
        generation = context.generation();
        epoch = await p.evaluate(() => performance.timeOrigin);
        if (!generation) fail('PAGE_CHANGED');
        next('read-editor');
        const e = await context.readEditor();
        if (
          !e.known ||
          !e.contextKey ||
          !e.editorUrl ||
          !e.store ||
          e.pendingUploads
        )
          fail('PAGE_CHANGED', 'cover-editor-unknown');
        editorDigest = digest(e);
        next('capture-nodes');
        titleNode = await handle(p.locator('textarea:visible'));
        bodyNode = await handle(p.locator(bodySelector + ':visible'));
        next('capture-region');
        const r = await region(p);
        slotsNode = await handle(r.slots);
        mode = r.mode;
        if (
          (await p.locator(modalSelector + ':visible').count()) ||
          !(await empty(r.slots))
        )
          fail('PAGE_CHANGED', 'cover-not-empty');
        if (mode !== nextMode) {
          next('switch-mode');
          const target = nextMode === 'single' ? r.sl : r.tl,
            retained = await handle(target);
          await context.stages?.reserve('mode');
          await guard();
          await same(retained, target);
          await retained.click({ timeout: 5000 });
          mode = nextMode;
          await guard();
        }
        next('prepare-slot');
        const slot = r.slots.locator(':scope > .article-cover-add'),
          slotNode = await handle(slot);
        await context.stages?.reserve('open');
        await guard();
        if (!(await empty(r.slots))) fail('PAGE_CHANGED', 'cover-slot-drift');
        await same(slotNode, slot);
        opened = true;
        context.invalidateInspection();
        next('slot-click');
        await slotNode.click({ timeout: 5000 });
        next('modal-visible');
        const modal = p.locator(modalSelector + ':visible');
        await modal.waitFor({ state: 'visible', timeout: 5000 });
        next('modal-structure');
        if (
          (await modal.getByText('上传图片', { exact: true }).count()) !== 1 ||
          (await modal
            .getByRole('button', { name: '选择图片', exact: true })
            .count()) !== 1
        )
          fail('PAGE_CHANGED', 'cover-picker-shape');
        next('modal-handles');
        const modalNode = await handle(modal),
          wrapper = modal.locator(
            'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," arco-modal-wrapper ") or contains(concat(" ",normalize-space(@class)," ")," ant-modal-wrap ")][1]',
          );
        const mask = wrapper
          .locator('..')
          .locator(':scope > .arco-modal-mask,:scope > .ant-modal-mask');
        proof = Object.freeze({
          page: p,
          generation: generation!,
          epoch: epoch!,
          modal: modalNode,
          wrapper: await handle(wrapper),
          mask: await handle(mask),
        });
        input = await handle(modal.locator('input[type=file]'));
        next('inspect');
        await inspect();
        record('returned');
      } catch (error) {
        record('failed', error);
        throw error;
      }
    },
    async upload(raw) {
      if (mode === 'triple')
        fail('INPUT_UNSUPPORTED', 'cover-triple-association-unverified');
      if (uploadAttempted || !opened || !proof || !input || !mode)
        fail('PAGE_CHANGED', 'cover-upload-already-attempted');
      const parsed = CoverUploadInputSchema.safeParse({ mode, files: raw });
      if (
        !parsed.success ||
        parsed.data.files.some(
          (f) =>
            createHash('sha256').update(f.bytes).digest('hex') !== f.sha256,
        )
      )
        fail('INPUT_UNSUPPORTED');
      const before = await inspect();
      if (before.settlement !== 'settled') fail('PAGE_CHANGED');
      await context.stages?.reserve('upload');
      const fresh = await inspect();
      if (JSON.stringify(fresh) !== JSON.stringify(before))
        fail('PAGE_CHANGED', 'cover-upload-drift');
      files = parsed.data!.files.map((f) => ({
        ...f,
        bytes: new Uint8Array(f.bytes),
      }));
      uploadAttempted = true;
      context.invalidateInspection();
      // Capture the actual File objects before the platform's change handler
      // clears/unmounts its input. This observer never changes the selection.
      selectionCapture = await input!.evaluateHandle((node) => {
        if (
          !(node instanceof HTMLInputElement) ||
          node.disabled ||
          !node.isConnected
        )
          throw Error('cover-input-unavailable');
        const capture: SelectionCapture = {
          files: [],
          inputCount: 0,
          changeCount: 0,
          invalid: false,
          dispose: () => {},
        };
        const observedEvents = new WeakSet<Event>();
        const observe = (event: Event) => {
          if (event.target !== node || observedEvents.has(event)) return;
          observedEvents.add(event);
          if (event.type === 'input') capture.inputCount++;
          else capture.changeCount++;
          const current = Array.from(node.files ?? []);
          if (
            capture.inputCount > 1 ||
            capture.changeCount > 1 ||
            current.length !== 1
          ) {
            capture.invalid = true;
            return;
          }
          if (!capture.files.length) capture.files = Object.freeze(current);
          else if (current.some((file, index) => file !== capture.files[index]))
            capture.invalid = true;
        };
        node.addEventListener('input', observe, true);
        node.addEventListener('change', observe, true);
        node.ownerDocument.addEventListener('input', observe, true);
        node.ownerDocument.addEventListener('change', observe, true);
        capture.dispose = () => {
          node.removeEventListener('input', observe, true);
          node.removeEventListener('change', observe, true);
          node.ownerDocument.removeEventListener('input', observe, true);
          node.ownerDocument.removeEventListener('change', observe, true);
        };
        return capture;
      });
      await input!.setInputFiles(
        files.map((f) => ({
          name: f.assetKey + (f.mime === 'image/png' ? '.png' : '.jpg'),
          mimeType: f.mime,
          buffer: Buffer.from(f.bytes),
        })),
      );
      fileObjects = await selectionCapture.evaluateHandle(
        (capture) => capture.files,
      );
      const selected = await fileObjects.evaluate(async (selected) =>
        Promise.all(
          selected.map(async (f) => ({
            size: f.size,
            mime: f.type,
            digest: Array.from(
              new Uint8Array(
                await crypto.subtle.digest('SHA-256', await f.arrayBuffer()),
              ),
            )
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(''),
          })),
        ),
      );
      if (
        selected.length !== files.length ||
        selected.some(
          (s, i) =>
            s.size !== files![i]!.bytes.length ||
            s.mime !== files![i]!.mime ||
            s.digest !== files![i]!.sha256,
        )
      )
        fail('PAGE_CHANGED', 'cover-selected-file-mismatch');
      if (
        !(await selectionCapture.evaluate(
          (capture) =>
            !capture.invalid &&
            capture.inputCount === 1 &&
            capture.changeCount === 1,
        ))
      )
        fail('PAGE_CHANGED', 'cover-selected-file-mismatch');
      inputResetAtSelection = await input!.evaluate(
        (e) => e instanceof HTMLInputElement && e.files?.length === 0,
      );
      if (inputResetAtSelection)
        proof = Object.freeze({ ...proof!, selectedFileVerified: true });
      await guard();
      await stage('after-selection');
    },
    async waitForUpload() {
      await guard();
      const modal = context.currentPage().locator(modalSelector);
      // File selection is not upload completion. Observe the owned modal's
      // completion signal before checking its preview; never select again.
      try {
        await modal
          .getByText('上传完成，可以拖拽调整图片顺序', { exact: true })
          .waitFor({ state: 'visible', timeout: 10000 });
      } catch {
        fail('PAGE_CHANGED', 'cover-upload-completion-timeout');
      }
      await guard();
      const preview = modal.locator('img');
      // Loading an already identified preview is asynchronous. Wait only on this
      // exact node and URL; a timeout or a changed resource is never completion.
      if (
        (await preview.count()) === 1 &&
        (await modal
          .getByText('上传完成，可以拖拽调整图片顺序', { exact: true })
          .count()) === 1
      ) {
        const node = await handle(preview);
        try {
          const pendingUrl = await node.evaluate((e) => {
            if (!(e instanceof HTMLImageElement) || e.complete) return null;
            try {
              const u = new URL(e.currentSrc || e.src);
              return u.protocol === 'https:' &&
                !u.username &&
                !u.password &&
                !u.hash
                ? u.href
                : null;
            } catch {
              return null;
            }
          });
          if (pendingUrl) {
            await node.evaluate(
              (e) =>
                new Promise<void>((resolve) => {
                  const done = () => {
                    clearTimeout(timer);
                    e.removeEventListener('load', done);
                    e.removeEventListener('error', done);
                    resolve();
                  };
                  const timer = setTimeout(done, 10000);
                  e.addEventListener('load', done, { once: true });
                  e.addEventListener('error', done, { once: true });
                  if (e instanceof HTMLImageElement && e.complete) done();
                }),
            );
            await guard();
            await same(node, preview);
            if (
              !(await node.evaluate(
                (e, url) =>
                  e instanceof HTMLImageElement &&
                  (e.currentSrc || e.src) === url,
                pendingUrl,
              ))
            )
              fail('PAGE_CHANGED', 'cover-association-drift');
          }
        } finally {
          await node.dispose();
        }
      }
      const value = await inspect();
      if (value.settlement !== 'settled' || value.result !== 'complete')
        fail('PAGE_CHANGED', terminalCheck);
      await stage('after-upload-review');
    },
    async uncheckLibrary() {
      if (uncheckAttempted) fail('PAGE_CHANGED');
      const state = await inspect();
      if (
        state.settlement !== 'settled' ||
        state.result !== 'complete' ||
        state.libraryChecked !== true ||
        !libraryNode
      )
        fail('PAGE_CHANGED', 'cover-library-unverified');
      await context.stages?.reserve('uncheck');
      const fresh = await inspect();
      if (JSON.stringify(fresh) !== JSON.stringify(state))
        fail('PAGE_CHANGED', 'cover-library-drift');
      uncheckAttempted = true;
      context.invalidateInspection();
      await libraryNode!.setChecked(false, { timeout: 5000 });
      if ((await library()) !== false)
        fail('PAGE_CHANGED', 'cover-library-unverified');
      await stage('after-library-review');
    },
    dispose: disposeSelection,
    confirm: () => closeOwned('确定'),
    cancel: () => closeOwned('取消'),
  };
}
