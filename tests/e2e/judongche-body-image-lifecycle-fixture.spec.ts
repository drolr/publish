import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import type { ProbeDiagnostic } from '../../src/infrastructure/platforms/judongche/production-pages';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { richCapabilities, richDraftHarness } from '../fixtures/rich-draft';
import type { PersistedEditorBodyV2 } from '../../src/contracts/rich-text-body';
import { assertOwnedBodyUploadDialog } from '../../src/infrastructure/platforms/judongche/production-state';
import { captureUploadSelection } from '../../src/infrastructure/platforms/judongche/production-upload-selection';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeProbeLog } from '../../src/desktop/main/probe-log';
import { errors } from 'playwright-core';
import { draftHarness } from '../fixtures/draft-adapter';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);
type Lifecycle = {
  /** Synthetic exact-label counterexample; live body shape is NOT VERIFIED. */
  materialLibraryCheckbox?: boolean;
  standardControls?: boolean;
  library?:
    | 'checked'
    | 'disabled-false'
    | 'disabled-true'
    | 'indeterminate'
    | 'duplicate'
    | 'wrong-label'
    | 'wrong-for'
    | 'rechecked';
  clearInput?: boolean;
  libraryVisibilityDelay?: number;
  hiddenPreview?: boolean;
  hideAtStage?: 'preview-loaded' | 'confirm';
  preselectedInput?: boolean;
  unmountInput?: boolean;
  rebuildInput?: boolean;
  rebuildFault?:
    | 'nonempty'
    | 'multiple'
    | 'event-clear'
    | 'late-event-clear'
    | 'original-connected';
  previewDelay?: number;
  reloadOnUncheck?: boolean;
  closeDelay?: number;
  confirmClose?: 'synchronous' | 'synchronous-second-input';
  insertDelay?: number;
  delayedIndex?: number;
  busyDelay?: number;
  stallAtIndex?: number;
  fault?:
    | 'replace-input-with-file'
    | 'replace-dialog'
    | 'extra-control'
    | 'verification'
    | 'second-selection'
    | 'wrong-position'
    | 'duplicate-image';
  stall?:
    | 'file-control'
    | 'preview-visible'
    | 'preview-loaded'
    | 'confirm'
    | 'dialog-end'
    | 'image-inserted';
};

// Synthetic transitions over the E55 public DOM contract. The real production
// pages, guards, selection, file submission and waits are never replaced.
async function installLifecycle(page: Page, config: Lifecycle) {
  await page.evaluate((config) => {
    const state = {
      opened: 0,
      selected: 0,
      confirmed: 0,
      inserted: 0,
      tailDeletes: 0,
    };
    Object.assign(window, { bodyImageActions: state });
    const body = document.querySelector<HTMLElement>('#body')!;
    body.addEventListener('keydown', (event) => {
      if (event.key === 'Delete') state.tailDeletes++;
    });
    document.querySelector<HTMLElement>('#imageTool')!.onclick = () => {
      const index = ++state.opened;
      const stall =
        !config.stallAtIndex || config.stallAtIndex === index
          ? config.stall
          : undefined;
      if (stall === 'file-control') return;
      const caret = body.lastElementChild!;
      const modal = document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.innerHTML =
        '<input type="file"><div class="preview"></div><button class="confirm" disabled>确定</button>';
      document.body.append(modal);
      if (config.standardControls)
        modal.insertAdjacentHTML(
          'beforeend',
          '<div role="tab">上传图片</div><div role="tab">懂车帝车型库</div><div role="tab">素材库</div><button>选择图片</button><span role="button" aria-label="Close"></span>',
        );
      if (config.materialLibraryCheckbox || config.library)
        modal.insertAdjacentHTML(
          'beforeend',
          '<label><input type="checkbox">保存到素材库</label>',
        );
      const library = modal.querySelector<HTMLInputElement>(
        'input[type=checkbox]',
      );
      Object.assign(window, { bodyImageLibraryChanges: 0 });
      if (library) {
        library.checked = ['checked', 'disabled-true', 'rechecked'].includes(
          config.library ?? '',
        );
        library.disabled = ['disabled-false', 'disabled-true'].includes(
          config.library ?? '',
        );
        library.indeterminate = config.library === 'indeterminate';
        if (config.library === 'duplicate')
          library.parentElement!.after(library.parentElement!.cloneNode(true));
        if (config.library === 'wrong-label')
          library.parentElement!.lastChild!.textContent = '未知设置';
        if (config.library === 'wrong-for')
          library.parentElement!.setAttribute('for', 'foreign-library');
        library.addEventListener('change', () => {
          const record = window as unknown as {
            bodyImageLibraryChanges: number;
          };
          record.bodyImageLibraryChanges++;
          if (config.reloadOnUncheck) {
            const img = modal.querySelector('img')!;
            img.src += '&reload=1';
          }
          if (config.library === 'rechecked') library.checked = true;
        });
      }
      if (config.preselectedInput) {
        const previous = new DataTransfer();
        previous.items.add(
          new File(['previous'], 'previous.png', { type: 'image/png' }),
        );
        modal.querySelector('input')!.files = previous.files;
      }
      const eventInput = modal.querySelector('input')!;
      eventInput.onchange = async () => {
        state.selected++;
        if (config.clearInput)
          modal.querySelector<HTMLInputElement>('input[type=file]')!.value = '';
        if (config.unmountInput) modal.querySelector('input')!.remove();
        if (config.rebuildInput || config.fault === 'replace-input-with-file') {
          const replacement = document.createElement('input');
          replacement.type = 'file';
          modal.replaceChild(replacement, modal.querySelector('input')!);
          if (
            config.fault === 'replace-input-with-file' ||
            config.rebuildFault === 'nonempty'
          ) {
            const other = new DataTransfer();
            other.items.add(
              new File(['other'], 'other.png', { type: 'image/png' }),
            );
            replacement.files = other.files;
          }
          if (config.rebuildFault === 'multiple')
            modal.append(replacement.cloneNode(true));
          const extraSelection = () => {
            const other = new DataTransfer();
            other.items.add(
              new File(['other'], 'other.png', { type: 'image/png' }),
            );
            replacement.files = other.files;
            replacement.dispatchEvent(new Event('input', { bubbles: true }));
            replacement.dispatchEvent(new Event('change', { bubbles: true }));
            replacement.value = '';
          };
          if (config.rebuildFault === 'event-clear') extraSelection();
          if (config.rebuildFault === 'late-event-clear')
            setTimeout(extraSelection, 100);
          if (config.rebuildFault === 'original-connected')
            document.body.append(eventInput);
        }
        if (config.fault === 'replace-dialog')
          modal.replaceWith(modal.cloneNode(true));
        if (config.fault === 'extra-control')
          modal.insertAdjacentHTML('beforeend', '<button>未知操作</button>');
        if (config.fault === 'verification')
          modal.insertAdjacentHTML('beforeend', '<span>安全验证</span>');
        if (config.fault === 'second-selection')
          modal
            .querySelector('input')!
            .dispatchEvent(new Event('input', { bubbles: true }));
        const data = await (
          await fetch('/fixture/upload', { method: 'POST' })
        ).json();
        if (stall === 'preview-visible') return;
        setTimeout(() => {
          const preview = document.createElement('img');
          preview.width = 100;
          preview.height = 100;
          if (config.hiddenPreview) preview.style.visibility = 'hidden';
          preview.src =
            stall === 'preview-loaded'
              ? '/fixture/body-image-never-loads'
              : '/fixture/image?web_uri=' + data.key;
          const confirm =
            modal.querySelector<HTMLButtonElement>('button.confirm')!;
          preview.onload = () => {
            confirm.disabled = stall === 'confirm';
            if (library && config.libraryVisibilityDelay) {
              library.style.visibility = 'hidden';
              setTimeout(() => {
                library.style.visibility = 'visible';
              }, config.libraryVisibilityDelay);
            }
          };
          modal.querySelector('.preview')!.append(preview);
          if (config.busyDelay !== undefined) {
            const busy = document.createElement('progress');
            modal.append(busy);
            setTimeout(() => busy.remove(), config.busyDelay);
          }
          confirm.onclick = () => {
            state.confirmed++;
            Object.assign(window, {
              bodyImageConfirmedWhileBusy: !!modal.querySelector('progress'),
              bodyImageLibraryCheckedAtConfirm: library?.checked ?? false,
            });
            if (config.confirmClose === 'synchronous-second-input')
              modal
                .querySelector('input[type=file]')!
                .dispatchEvent(new Event('input', { bubbles: true }));
            if (stall !== 'dialog-end') {
              if (config.confirmClose) modal.remove();
              else setTimeout(() => modal.remove(), config.closeDelay ?? 0);
            }
            if (stall === 'image-inserted') return;
            const delay =
              !config.delayedIndex || config.delayedIndex === index
                ? (config.insertDelay ?? 0)
                : 0;
            setTimeout(() => {
              const block = document.createElement('div');
              block.setAttribute('__syl_tag', 'true');
              block.setAttribute('contenteditable', 'false');
              block.setAttribute('draggable', 'true');
              block.innerHTML =
                '<templ style="display:none"><img web_uri="' +
                data.key +
                '" src="' +
                preview.src +
                '"></templ><div class="pgc-image"><div class="pgc-img-wrapper"><img width="100" web_uri="' +
                data.key +
                '" src="' +
                preview.src +
                '"></div></div>';
              if (caret.querySelector('.syl-placeholder'))
                caret.innerHTML = '<br class="ProseMirror-trailingBreak">';
              if (config.fault === 'wrong-position') body.prepend(block);
              else caret.after(block);
              if (config.fault === 'duplicate-image')
                block.after(block.cloneNode(true));
              const tail = document.createElement('p');
              tail.innerHTML = '<br class="ProseMirror-trailingBreak">';
              block.after(tail);
              state.inserted++;
            }, delay);
          };
        }, config.previewDelay ?? 0);
      };
    };
  }, config);
}

test('T1 selected same-modal empty input rebuild completes delayed preview exactly once', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {
    standardControls: true,
    materialLibraryCheckbox: true,
    rebuildInput: true,
    previewDelay: 200,
  });
  await f.pages.appendImage(png, 'image/png');
  expect(await f.actions()).toEqual({
    opened: 1,
    selected: 1,
    confirmed: 1,
    inserted: 1,
    tailDeletes: 1,
  });
  expect(f.fixture.uploads()).toBe(1);
  expect(f.fixture.saves()).toBe(0);
  expect(
    f.events.filter((event) => event.bodyImage?.dialog).at(-1)?.bodyImage
      ?.dialog,
  ).toMatchObject({
    rejection: 'none',
    inputAssociation: 'replaced',
    inputConnected: false,
    selectionPhase: 'selected',
    newInputFileCount: 0,
    extraSelectionEventCount: 0,
  });
});

for (const rebuildFault of [
  'nonempty',
  'multiple',
  'event-clear',
  'late-event-clear',
  'original-connected',
] as const) {
  test(`T1 selected rebuild conflict ${rebuildFault} pauses without confirmation or save`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, {
      standardControls: true,
      materialLibraryCheckbox: true,
      rebuildInput: true,
      rebuildFault,
      previewDelay: 300,
    });
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
    });
    expect(await f.actions()).toMatchObject({
      selected: 1,
      confirmed: 0,
      inserted: 0,
      tailDeletes: 0,
    });
    expect(f.fixture.saves()).toBe(0);
    const failure = f.events.find((event) => event.failure)?.bodyImage;
    expect(failure?.dialog).toMatchObject({
      rejection: rebuildFault.includes('event-clear')
        ? 'selection-invalid'
        : 'file-input-replaced',
      extraSelectionEventCount: rebuildFault.includes('event-clear') ? 2 : 0,
      newInputFileCount: rebuildFault === 'nonempty' ? 1 : 0,
    });
    const first = structuredClone(f.events.find((event) => event.failure));
    await f.pages.probe();
    expect(f.events.find((event) => event.failure)).toEqual(first);
  });
}

for (const ending of [
  'stop',
  'verification',
  'login',
  'page-identity',
] as const) {
  test(`T1 rebuilt input preserves ${ending} checkpoint before confirmation`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, {
      rebuildInput: true,
      previewDelay: 350,
    });
    const running = f.pages
      .appendImage(png, 'image/png')
      .catch((error: unknown) => error);
    await expect.poll(async () => (await f.actions()).selected).toBe(1);
    if (ending === 'stop') f.stop();
    else if (ending === 'page-identity')
      await page.evaluate(() =>
        history.replaceState(null, '', '/unknown-editor'),
      );
    else
      await page.evaluate((ending) => {
        document.body.insertAdjacentHTML(
          'beforeend',
          ending === 'login'
            ? '<div>巨懂车欢迎您</div>'
            : '<div role="dialog">安全验证</div>',
        );
      }, ending);
    expect(await running).toMatchObject({
      reason:
        ending === 'stop'
          ? 'STOP_REQUESTED'
          : ending === 'verification'
            ? 'VERIFICATION_REQUIRED'
            : ending === 'login'
              ? 'LOGIN_REQUIRED'
              : 'PAGE_CHANGED',
    });
    expect(await f.actions()).toMatchObject({
      selected: 1,
      confirmed: 0,
      tailDeletes: 0,
    });
    expect(f.fixture.saves()).toBe(0);
  });
}

test('T1 selection capture retains original File deduplicates events and releases all listeners', async ({
  context,
  page,
}) => {
  await denyExternalNetwork(context);
  await page.setContent('<div role="dialog"><input type="file"></div>');
  const modal = (await page.$('[role=dialog]'))!;
  const input = (await page.$('input'))!;
  const capture = await captureUploadSelection(input, modal);
  try {
    await input.setInputFiles({
      name: 'body.png',
      mimeType: 'image/png',
      buffer: png,
    });
    expect(
      await capture.evaluate((value) => ({
        input: value.inputCount,
        change: value.changeCount,
        extra: value.extraSelectionEventCount,
        invalid: value.invalid,
        size: value.files[0]?.size,
      })),
    ).toEqual({
      input: 1,
      change: 1,
      extra: 0,
      invalid: false,
      size: png.length,
    });
    await input.evaluate((node) => {
      (node as HTMLInputElement).value = '';
      node.remove();
    });
    expect(
      await capture.evaluate(async (value) => ({
        size: value.files[0]?.size,
        bytes: Array.from(new Uint8Array(await value.files[0]!.arrayBuffer())),
      })),
    ).toEqual({ size: png.length, bytes: [...png] });
    await modal.evaluate((node) => {
      const next = document.createElement('input');
      next.type = 'file';
      node.append(next);
      next.dispatchEvent(new Event('input', { bubbles: true }));
      next.dispatchEvent(new Event('change', { bubbles: true }));
      next.value = '';
    });
    expect(
      await capture.evaluate((value) => ({
        input: value.inputCount,
        change: value.changeCount,
        extra: value.extraSelectionEventCount,
        invalid: value.invalid,
      })),
    ).toEqual({ input: 1, change: 1, extra: 2, invalid: true });
    await capture.evaluate((value) => value.dispose());
    await input.evaluate((node) =>
      node.dispatchEvent(new Event('input', { bubbles: true })),
    );
    await modal.evaluate((node) => {
      node
        .querySelector('input')!
        .dispatchEvent(new Event('input', { bubbles: true }));
      node.remove();
      node
        .querySelector('input')!
        .dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(
      await capture.evaluate((value) => ({
        input: value.inputCount,
        extra: value.extraSelectionEventCount,
      })),
    ).toEqual({ input: 1, extra: 2 });
  } finally {
    await capture.evaluate((value) => value.dispose());
    await capture.dispose();
    await modal.dispose();
    await input.dispose();
  }
});

test('T2 clearing the File before the passive capture can verify change remains rejected', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {});
  await page.evaluate(() => {
    document.addEventListener(
      'change',
      (event) => {
        if (
          event.target instanceof HTMLInputElement &&
          event.target.type === 'file'
        )
          event.target.value = '';
      },
      true,
    );
  });
  await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
    reason: 'PAGE_CHANGED',
    check: 'body-selected-file-mismatch',
  });
  expect(await f.actions()).toMatchObject({
    selected: 1,
    confirmed: 0,
    tailDeletes: 0,
  });
  expect(f.fixture.saves()).toBe(0);
});

test('T1 production adapter completes rebuilt input upload and saves the whole article once', async ({
  context,
  page,
}) => {
  const config: Lifecycle = {
    rebuildInput: true,
    standardControls: true,
    materialLibraryCheckbox: true,
    previewDelay: 150,
  };
  const f = await lifecycle(context, page, config);
  const enter = f.pages.enterNewEditor;
  f.pages.enterNewEditor = async (...args) => {
    await enter(...args);
    await installLifecycle(page, config);
  };
  const adapter = createAdapterWithPages(f.session, f.pages, richCapabilities);
  const h = draftHarness();
  const probe = await adapter.checkSession();
  if (probe.status !== 'ready') throw Error('fixture not ready');
  h.task.store = probe.store;
  h.durable().store = probe.store;
  expect(await adapter.execute(h.task, h.hooks)).toEqual({
    status: 'blocked',
    reason: 'MANUAL_REVIEW_REQUIRED',
  });
  expect(await f.actions()).toMatchObject({
    selected: 2,
    confirmed: 2,
    inserted: 2,
  });
  expect(f.fixture.uploads()).toBe(2);
  expect(f.fixture.saves()).toBe(1);
  expect(
    await page
      .locator('#body > *')
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          node.matches('div[__syl_tag]')
            ? node.querySelector('.pgc-image img')?.getAttribute('web_uri')
            : node.textContent
              ? (node as HTMLElement).innerText
              : '',
        ),
      ),
  ).toEqual(['A\nline', 'body-1', 'body-2', 'B', '']);
});

for (const unmountInput of [false, true]) {
  test(
    'T2b resolves the T1 checkbox counterexample with input ' +
      (unmountInput ? 'unmounted' : 'retained'),
    async ({ context, page }) => {
      const f = await lifecycle(context, page, {
        materialLibraryCheckbox: true,
        unmountInput,
      });
      await f.pages.appendImage(png, 'image/png');
      expect(await f.actions()).toEqual({
        opened: 1,
        selected: 1,
        confirmed: 1,
        inserted: 1,
        tailDeletes: 1,
      });
      const observed = f.events
        .filter((event) => event.bodyImage?.dialog)
        .at(-1)?.bodyImage?.dialog;
      expect(observed).toMatchObject({
        rejection: 'none',
        inputAssociation: unmountInput ? 'unmounted' : 'retained',
        inputConnected: !unmountInput,
        materialLibrary: {
          association: 'exact',
          checked: false,
          disabled: false,
          indeterminate: false,
        },
      });
      expect(f.fixture.uploads()).toBe(1);
      expect(f.fixture.saves()).toBe(0);
      expect(JSON.stringify(f.events)).not.toMatch(
        /保存到素材库|合成图片生命周期|https:|web_uri|cookie|stack|bytes/,
      );
    },
  );
}
test('T1 stage diagnostics distinguish waiting completion and actual failure duration', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, { stall: 'confirm' });
  await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
    name: 'TimeoutError',
  });
  const confirm = f.events.filter(
    (event) => event.bodyImage?.stage === 'confirm',
  );
  expect(confirm[0]?.bodyImage).toMatchObject({
    status: 'waiting',
    fileSelectionCount: 1,
    confirmationCount: 0,
  });
  const failure = confirm.at(-1)?.bodyImage;
  expect(failure).toMatchObject({
    status: 'failed',
    failureCause: 'budget-exceeded',
  });
  expect(failure?.stageElapsedMs).toBeGreaterThanOrEqual(5000);
  expect(failure?.failureElapsedMs).toBeGreaterThanOrEqual(5000);
  expect(failure?.stageStartedAt).toBe(confirm[0]?.bodyImage?.stageStartedAt);
  expect(
    f.events.some(
      (event) =>
        event.bodyImage?.stage === 'preview-loaded' &&
        event.bodyImage.status === 'completed',
    ),
  ).toBe(true);
});

for (const rejection of [
  'dialog-count',
  'dialog-replaced',
  'node-limit',
  'preview-count',
  'file-input-replaced',
  'unexpected-input',
  'unexpected-control',
  'verification',
] as const) {
  test(`T1 owned modal preserves the guard and reports fixed ${rejection} predicate`, async ({
    context,
    page,
  }) => {
    await denyExternalNetwork(context);
    await page.setContent(
      '<div role="dialog"><input type="file"><button>确定</button></div>',
    );
    const modal = (await page.$('[role=dialog]'))!;
    const input = (await page.$('input'))!;
    try {
      await page.evaluate(
        ({ rejection, modal, input }) => {
          switch (rejection) {
            case 'dialog-count':
              document.body.insertAdjacentHTML(
                'beforeend',
                '<div role="dialog">CREDENTIAL_SENTINEL</div>',
              );
              break;
            case 'dialog-replaced':
              modal.replaceWith(modal.cloneNode(true));
              break;
            case 'node-limit':
              modal.insertAdjacentHTML(
                'beforeend',
                '<span></span>'.repeat(121),
              );
              break;
            case 'preview-count':
              modal.insertAdjacentHTML('beforeend', '<img><img>');
              break;
            case 'file-input-replaced':
              input.replaceWith(input.cloneNode(true));
              break;
            case 'unexpected-input':
              modal.insertAdjacentHTML(
                'beforeend',
                '<input type="text" value="CREDENTIAL_SENTINEL">',
              );
              break;
            case 'unexpected-control':
              modal.insertAdjacentHTML(
                'beforeend',
                '<a href="https://private.example/CREDENTIAL_SENTINEL">CREDENTIAL_SENTINEL</a>',
              );
              break;
            case 'verification':
              modal.insertAdjacentHTML(
                'beforeend',
                '<span>安全验证 CREDENTIAL_SENTINEL</span>',
              );
              break;
          }
        },
        { rejection, modal, input },
      );
      const error = await assertOwnedBodyUploadDialog(page, {
        modal,
        input,
        selectionPhase: 'before-selection',
      }).catch((error: unknown) => error);
      expect(error).toMatchObject({
        reason:
          rejection === 'verification'
            ? 'VERIFICATION_REQUIRED'
            : 'PAGE_CHANGED',
        bodyUploadDialog: { rejection },
      });
      expect(JSON.stringify(error)).not.toMatch(
        /CREDENTIAL_SENTINEL|private\.example|https:|安全验证|href|innerHTML|textContent/,
      );
    } finally {
      await modal.dispose();
      await input.dispose();
    }
  });
}

test('T2b unreadable material-library association pauses before selecting a file', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, { materialLibraryCheckbox: true });
  await page.evaluate(() => {
    Object.defineProperty(HTMLInputElement.prototype, 'labels', {
      get() {
        throw new Error('CREDENTIAL_SENTINEL');
      },
    });
  });
  await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
    reason: 'PAGE_CHANGED',
    check: 'body-material-library-association',
  });
  expect(await f.actions()).toMatchObject({ selected: 0, confirmed: 0 });
  expect(f.events.filter((event) => event.failure)).toHaveLength(1);
  expect(f.events.find((event) => event.failure)?.bodyImage).toMatchObject({
    status: 'failed',
    fileSelectionCount: 0,
    confirmationCount: 0,
  });
  expect(JSON.stringify(f.events)).not.toContain('CREDENTIAL_SENTINEL');
});

test('T1 bounded per-image stage history survives the immutable first-failure log after an earlier successful image', async ({
  context,
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'body-image-history-'));
  const task = { taskId: '91fb259b-ad99-4128-8138-916ebb5b9091' };
  try {
    const f = await lifecycle(
      context,
      page,
      { stall: 'confirm', stallAtIndex: 2 },
      undefined,
      (event) => writeProbeLog(root, event, task),
    );
    await f.pages.appendImage(png, 'image/png');
    const completed = f.events
      .filter((event) => event.bodyImage?.index === 1)
      .at(-1)?.bodyImage;
    expect(completed?.stages).toHaveLength(11);
    expect(
      completed?.stages.every((stage) => stage.status === 'completed'),
    ).toBe(true);
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    const path = join(
      root,
      `judongche-first-failure-${task.taskId}-execution.json`,
    );
    const first = readFileSync(path, 'utf8');
    const record = JSON.parse(first) as ProbeDiagnostic;
    expect(record.bodyImage).toMatchObject({
      index: 2,
      fileSelectionCount: 1,
      confirmationCount: 0,
      status: 'failed',
    });
    expect(record.bodyImage?.stages).toMatchObject([
      { stage: 'tail-position', status: 'completed' },
      { stage: 'open', status: 'completed' },
      { stage: 'file-control', status: 'completed' },
      { stage: 'select-file', status: 'completed' },
      { stage: 'preview-visible', status: 'completed' },
      { stage: 'preview-loaded', status: 'completed' },
      { stage: 'confirm', status: 'failed' },
    ]);
    expect(
      record.bodyImage?.stages.at(-1)?.stageElapsedMs,
    ).toBeGreaterThanOrEqual(5000);
    expect(record.bodyImage?.stages.length).toBeLessThanOrEqual(11);
    writeProbeLog(root, { operation: 'probe', failure: true }, task);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(first).not.toMatch(
      /合成图片生命周期|https:|web_uri|保存到素材库|cookie|stack/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T1 duplicate file controls fail before the file-control stage can be marked completed', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {});
  await page.evaluate(() => {
    document.querySelector('#imageTool')!.addEventListener('click', () => {
      document
        .querySelector('[role=dialog]')!
        .insertAdjacentHTML('beforeend', '<input type="file">');
    });
  });
  await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
    reason: 'PAGE_CHANGED',
  });
  expect(
    f.events.filter(
      (event) =>
        event.bodyImage?.stage === 'file-control' &&
        event.bodyImage.status === 'completed',
    ),
  ).toHaveLength(0);
  expect(f.events.find((event) => event.failure)?.bodyImage).toMatchObject({
    stage: 'file-control',
    status: 'failed',
    fileSelectionCount: 0,
    confirmationCount: 0,
  });
  expect(await f.actions()).toMatchObject({ selected: 0, confirmed: 0 });
});

test('T1 R1 missing upload modal never completes open after the toolbar click returns', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, { stall: 'file-control' });
  await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
    name: 'TimeoutError',
  });
  expect(
    f.events.some((event) =>
      event.bodyImage?.stages.some(
        (stage) => stage.stage === 'open' && stage.status === 'completed',
      ),
    ),
  ).toBe(false);
  expect(f.events.find((event) => event.failure)?.bodyImage).toMatchObject({
    stage: 'file-control',
    status: 'failed',
    fileSelectionCount: 0,
    confirmationCount: 0,
    stages: [
      { stage: 'tail-position', status: 'completed' },
      { stage: 'open', status: 'waiting' },
      { stage: 'file-control', status: 'failed' },
    ],
  });
  expect(await f.actions()).toMatchObject({
    opened: 1,
    selected: 0,
    confirmed: 0,
    inserted: 0,
    tailDeletes: 0,
  });
  expect(f.fixture.uploads()).toBe(0);
  expect(f.fixture.saves()).toBe(0);
});

test('T1 R1 successful upload completes open only after existing modal ownership checks', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {});
  await f.pages.appendImage(png, 'image/png');
  const fileWaiting = f.events.find(
    (event) =>
      event.bodyImage?.stage === 'file-control' &&
      event.bodyImage.status === 'waiting',
  );
  expect(
    fileWaiting?.bodyImage?.stages.find((stage) => stage.stage === 'open')
      ?.status,
  ).toBe('waiting');
  const firstOpenCompleted = f.events.find((event) =>
    event.bodyImage?.stages.some(
      (stage) => stage.stage === 'open' && stage.status === 'completed',
    ),
  );
  expect(firstOpenCompleted?.bodyImage).toMatchObject({
    stage: 'file-control',
    status: 'completed',
    fileSelectionCount: 0,
    confirmationCount: 0,
  });
  const final = f.events.at(-1)?.bodyImage;
  expect(final?.stages).toHaveLength(11);
  expect(final?.stages.every((stage) => stage.status === 'completed')).toBe(
    true,
  );
  expect(await f.actions()).toMatchObject({
    opened: 1,
    selected: 1,
    confirmed: 1,
    inserted: 1,
  });
  expect(f.fixture.uploads()).toBe(1);
  expect(f.fixture.saves()).toBe(0);
});

async function lifecycle(
  context: BrowserContext,
  page: Page,
  config: Lifecycle,
  stopStage?: NonNullable<ProbeDiagnostic['bodyImage']>['stage'],
  onDiagnostic?: (event: ProbeDiagnostic) => void,
) {
  await denyExternalNetwork(context);
  const fixture = await installProductionFixture(context, {
    observedTrailingParagraphs: true,
  });
  await context.route('**/fixture/body-image-never-loads', () => {});
  await page.goto(fixture.home);
  const events: ProbeDiagnostic[] = [];
  let stopped = false;
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => 'body-image-fixture',
    close: async () => {},
  };
  const pages = createJudongchePages(
    session,
    (event) => {
      events.push(event);
      onDiagnostic?.(event);
      if (stopStage && event.bodyImage?.stage === stopStage) stopped = true;
      if (
        config.hideAtStage &&
        event.check === 'body-image-stage' &&
        event.bodyImage?.stage === config.hideAtStage
      )
        void page
          .evaluate(() => {
            const img =
              document.querySelector<HTMLElement>('[role=dialog] img');
            if (img) img.style.visibility = 'hidden';
          })
          .catch(() => {});
    },
    {
      manualReview: true,
      ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
    },
  );
  expect((await pages.probe()).status).toBe('ready');
  await pages.enterNewEditor(
    '合成图片生命周期',
    () => stopped,
    'body-image-task',
  );
  await installLifecycle(page, config);
  return {
    pages,
    session,
    events,
    fixture,
    stop: () => {
      stopped = true;
    },
    resume: () => {
      stopped = false;
    },
    actions: () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              bodyImageActions: {
                opened: number;
                selected: number;
                confirmed: number;
                inserted: number;
                tailDeletes: number;
              };
            }
          ).bodyImageActions,
      ),
  };
}

for (const [name, html] of [
  [
    'close-name-conflict',
    '<span role="button" aria-label="Close" aria-labelledby="other"></span><span id="other">未知操作</span>',
  ],
  ['combobox', '<div role="combobox" tabindex="0">未知操作</div>'],
  ['slider', '<div role="slider" tabindex="0">未知操作</div>'],
] as const) {
  test(`R1 pauses unknown actionable control before selection ${name}`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, {});
    await page.evaluate(
      (html) =>
        document.querySelector('#imageTool')!.addEventListener('click', () => {
          document
            .querySelector('[role=dialog]')!
            .insertAdjacentHTML('beforeend', html);
        }),
      html,
    );
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
    });
    expect(await f.actions()).toMatchObject({ selected: 0, confirmed: 0 });
  });
}

test('R1 passive group and status remain observable within the owned modal', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {});
  await page.evaluate(() =>
    document.querySelector('#imageTool')!.addEventListener('click', () => {
      document
        .querySelector('[role=dialog]')!
        .insertAdjacentHTML(
          'beforeend',
          '<div role="group"><span role="status">处理中</span><svg role="presentation"></svg></div>',
        );
    }),
  );
  await f.pages.appendImage(png, 'image/png');
  expect(await f.actions()).toMatchObject({ selected: 1, confirmed: 1 });
});

for (const secondInput of [false, true]) {
  test(`R2 synchronous close preserves single selection proof secondInput=${secondInput}`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, {
      confirmClose: secondInput ? 'synchronous-second-input' : 'synchronous',
    });
    if (secondInput)
      await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject(
        { reason: 'PAGE_CHANGED' },
      );
    else await f.pages.appendImage(png, 'image/png');
    await expect.poll(async () => (await f.actions()).inserted).toBe(1);
    expect(await f.actions()).toEqual({
      opened: 1,
      selected: 1,
      confirmed: 1,
      inserted: 1,
      tailDeletes: secondInput ? 0 : 1,
    });
    const observed = secondInput
      ? f.events.find((event) => event.failure)
      : f.events.at(-1);
    expect(observed?.bodyImage).toMatchObject({
      fileSelectionCount: 1,
      confirmationCount: 1,
      ...(secondInput
        ? { stage: 'dialog-end', status: 'failed' }
        : { status: 'completed' }),
    });
    expect(f.fixture.uploads()).toBe(1);
    expect(f.fixture.saves()).toBe(0);
  });
}

for (const endingKind of [
  'normal',
  'replacement',
  'security',
  'second-selection',
  'stop',
] as const) {
  test(`R1 modal closing guard preserves ${endingKind} evidence without another confirmation`, async ({
    context,
    page,
  }) => {
    let ending = false,
      removed = false;
    const f = await lifecycle(
      context,
      page,
      { closeDelay: 5000, rebuildInput: true },
      undefined,
      (event) => {
        if (event.bodyImage?.stage === 'dialog-end') ending = true;
      },
    );
    const evaluate = page.evaluate.bind(page);
    page.evaluate = (async (...args: Parameters<Page['evaluate']>) => {
      const observed = await evaluate(...args);
      const argument = args[1];
      if (
        ending &&
        !removed &&
        argument &&
        typeof argument === 'object' &&
        'modal' in argument &&
        'input' in argument
      ) {
        removed = true;
        if (endingKind === 'replacement' || endingKind === 'security')
          await page
            .locator('body')
            .evaluate(
              (body, security) =>
                body.insertAdjacentHTML(
                  'beforeend',
                  security
                    ? '<div role="dialog">安全验证</div>'
                    : '<div role="dialog"><button>未知操作</button></div>',
                ),
              endingKind === 'security',
            );
        if (endingKind === 'second-selection')
          await page
            .locator('[role=dialog] input[type=file]')
            .evaluate((input) =>
              input.dispatchEvent(new Event('input', { bubbles: true })),
            );
        await page
          .locator('[role=dialog]')
          .first()
          .evaluate((node) => node.remove());
        if (endingKind === 'stop') f.stop();
      }
      return observed;
    }) as Page['evaluate'];
    if (endingKind === 'normal') await f.pages.appendImage(png, 'image/png');
    else
      await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject(
        {
          reason:
            endingKind === 'security'
              ? 'VERIFICATION_REQUIRED'
              : endingKind === 'stop'
                ? 'STOP_REQUESTED'
                : 'PAGE_CHANGED',
        },
      );
    expect(removed).toBe(true);
    // The already dispatched platform insertion may finish after stop. Observe
    // that effect without issuing another selection, confirmation or tail edit.
    await expect.poll(async () => (await f.actions()).inserted).toBe(1);
    expect(f.fixture.saves()).toBe(0);
    expect(await f.actions()).toEqual({
      opened: 1,
      selected: 1,
      confirmed: 1,
      inserted: 1,
      tailDeletes: endingKind === 'normal' ? 1 : 0,
    });
  });
}

test('R1 file-control proof initialization cannot reset an expired stage budget', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {});
  const locate = page.locator.bind(page);
  let delayed = false;
  page.locator = ((...args: Parameters<Page['locator']>) => {
    const locator = locate(...args);
    if (args[0] !== 'input[type="file"]') return locator;
    return new Proxy(locator, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === 'elementHandle')
          return async () => {
            const handle = await target.elementHandle();
            return handle
              ? new Proxy(handle, {
                  get(node, method, nodeReceiver) {
                    const entry = Reflect.get(node, method, nodeReceiver);
                    if (typeof entry !== 'function') return entry;
                    if (method === 'evaluateHandle')
                      return async (...inner: unknown[]) => {
                        const result = await Reflect.apply(entry, node, inner);
                        if (!delayed) {
                          delayed = true;
                          await new Promise((resolve) =>
                            setTimeout(resolve, 5200),
                          );
                        }
                        return result;
                      };
                    return entry.bind(node);
                  },
                })
              : handle;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as Page['locator'];
  await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
    name: 'TimeoutError',
  });
  expect(delayed).toBe(true);
  expect(await f.actions()).toMatchObject({ selected: 0, confirmed: 0 });
  expect(f.events.find((event) => event.failure)?.bodyImage).toMatchObject({
    stage: 'file-control',
  });
});

test('R1 same adapter drains a stopped upload and rebinds a fresh session for the next task', async ({
  context,
  page,
  browser,
}) => {
  const f = await lifecycle(context, page, {});
  let currentContext: BrowserContext | undefined = context;
  let currentPage = page;
  let generation = 'body-image-fixture';
  let nextFixture:
    Awaited<ReturnType<typeof installProductionFixture>> | undefined;
  f.session.current = () => currentContext!;
  f.session.generation = () => generation;
  f.session.close = async () => {
    await currentContext?.close();
    currentContext = undefined;
  };
  f.session.open = async () => {
    currentContext = await browser.newContext({ serviceWorkers: 'block' });
    await denyExternalNetwork(currentContext);
    nextFixture = await installProductionFixture(currentContext, {
      observedTrailingParagraphs: true,
    });
    currentPage = await currentContext.newPage();
    await currentPage.goto(nextFixture.home);
    generation = 'body-image-fixture-next';
    return currentContext;
  };
  const enter = f.pages.enterNewEditor;
  f.pages.enterNewEditor = async (...args) => {
    await enter(...args);
    await installLifecycle(
      currentPage,
      generation === 'body-image-fixture' ? { previewDelay: 5000 } : {},
    );
  };
  const adapter = createAdapterWithPages(f.session, f.pages, richCapabilities);
  const first = draftHarness();
  const ready = await adapter.checkSession();
  if (ready.status !== 'ready') throw Error('fixture not ready');
  first.task.store = ready.store;
  first.durable().store = ready.store;
  const writing = adapter.execute(first.task, first.hooks);
  await expect.poll(() => f.fixture.uploads()).toBe(1);
  first.stop();
  expect(await writing).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  const oldFailure = structuredClone(f.events.find((event) => event.failure));
  await adapter.closeSession();
  try {
    const reopened = await adapter.openSession();
    if (reopened.status !== 'ready') throw Error('fresh fixture not ready');
    const next = draftHarness();
    next.task.taskId = '66666666-6666-4666-8666-666666666666';
    next.durable().taskId = next.task.taskId;
    next.task.store = reopened.store;
    next.durable().store = reopened.store;
    expect(await adapter.execute(next.task, next.hooks)).toEqual({
      status: 'blocked',
      reason: 'MANUAL_REVIEW_REQUIRED',
    });
    expect(nextFixture!.uploads()).toBe(2);
    expect(nextFixture!.saves()).toBe(1);
    expect(f.events.find((event) => event.failure)).toEqual(oldFailure);
  } finally {
    await adapter.closeSession();
  }
});

for (const [name, html, rejection] of [
  ['close', '<span role="button" aria-label="Close"><svg></svg></span>', null],
  ['chinese-close', '<div role="button">关闭</div>', null],
  [
    'wrong-close-name',
    '<span role="button" aria-label="未知">关闭</span>',
    'unexpected-control',
  ],
  [
    'arbitrary-role-button',
    '<span role="button">选择图片</span>',
    'unexpected-control',
  ],
  ['link-tab', '<a role="tab">上传图片</a>', 'unexpected-control'],
  [
    'select-role-close',
    '<select role="button" aria-label="Close"></select>',
    'unexpected-control',
  ],
  [
    'native-wrong-role',
    '<button role="checkbox">确定</button>',
    'unexpected-control',
  ],
  ['unknown-tab', '<div role="tab">其他操作</div>', 'unexpected-control'],
  [
    'alternate-tab',
    '<div role="tab" aria-selected="true">素材库</div>',
    'alternate-library-selected',
  ],
  ['hidden-unknown-input', '<input type="text" hidden>', 'unexpected-input'],
  [
    'nested-dialog',
    '<div role="dialog" hidden><button>确定</button></div>',
    'nested-dialog',
  ],
] as const) {
  test(`T2b owned-control boundary ${name}`, async ({ context, page }) => {
    await denyExternalNetwork(context);
    await page.setContent(
      '<div role="dialog"><input type="file"><button>确定</button>' +
        html +
        '</div>',
    );
    const modal = (await page.$('[role=dialog]'))!;
    const input = (await page.$('input[type=file]'))!;
    try {
      if (rejection)
        await expect(
          assertOwnedBodyUploadDialog(page, {
            modal,
            input,
            selectionPhase: 'before-selection',
          }),
        ).rejects.toMatchObject({
          reason: 'PAGE_CHANGED',
          bodyUploadDialog: { rejection },
        });
      else
        expect(
          await assertOwnedBodyUploadDialog(page, {
            modal,
            input,
            selectionPhase: 'before-selection',
          }),
        ).toMatchObject({ rejection: 'none' });
    } finally {
      await modal.dispose();
      await input.dispose();
    }
  });
}

test('T2b checkbox action and confirmation preparation share the original five-second deadline', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {
    library: 'checked',
    libraryVisibilityDelay: 1500,
    stall: 'confirm',
  });
  await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
    name: 'TimeoutError',
  });
  const failure = f.events.find((event) => event.failure)?.bodyImage;
  expect(failure).toMatchObject({ stage: 'confirm', confirmationCount: 0 });
  expect(failure?.stageElapsedMs).toBeGreaterThanOrEqual(4900);
  expect(failure?.stageElapsedMs).toBeLessThan(6200);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { bodyImageLibraryChanges: number })
          .bodyImageLibraryChanges,
    ),
  ).toBe(1);
});

for (const action of ['open', 'select', 'confirm'] as const) {
  for (const dispatched of [false, true]) {
    for (const readbackFails of [false, true]) {
      if (readbackFails && !dispatched) continue;
      test(
        readbackFails
          ? `R1 preserves original ${action} error after failed readback`
          : `T2b reconciles ${action} exception dispatched=${dispatched} without replay`,
        async ({ context, page }) => {
          const f = await lifecycle(context, page, {
            closeDelay: 150,
            rebuildInput: true,
          });
          const original = new errors.TimeoutError(
            'fixture lost acknowledgement',
          );
          const readback = new Error(
            'fixture lost observation acknowledgement',
          );
          let injected = false;
          // Forward actual Playwright actions; drop only their acknowledgement, or
          // reject before dispatch. No production result or observation is mocked.
          const watch = <T extends object>(
            target: T,
            kind: 'open' | 'input' | 'modal' | 'confirm',
          ): T =>
            new Proxy(target, {
              get(object, key, receiver) {
                const value = Reflect.get(object, key, receiver);
                if (typeof value !== 'function') return value;
                if (key === 'evaluate' && readbackFails && kind === 'modal')
                  return async (...args: unknown[]) => {
                    const observed = await Reflect.apply(value, object, args);
                    if (injected) throw readback;
                    return observed;
                  };
                if (
                  (key === 'click' &&
                    (kind === 'open' || kind === 'confirm') &&
                    action === kind) ||
                  (key === 'setInputFiles' &&
                    kind === 'input' &&
                    action === 'select')
                )
                  return async (...args: unknown[]) => {
                    if (!injected) {
                      injected = true;
                      if (dispatched) await Reflect.apply(value, object, args);
                      throw original;
                    }
                    return Reflect.apply(value, object, args);
                  };
                if (key === 'evaluateHandle' && kind === 'input')
                  return async (...args: unknown[]) => {
                    const handle = await Reflect.apply(value, object, args);
                    return watch(handle as object, 'modal');
                  };
                if (key === 'asElement' && kind === 'modal')
                  return (...args: unknown[]) => {
                    const element = Reflect.apply(value, object, args);
                    return element
                      ? watch(element as object, 'modal')
                      : element;
                  };
                if (key === '$' && kind === 'modal')
                  return async (...args: unknown[]) => {
                    const handle = await Reflect.apply(value, object, args);
                    return handle && args[0] === 'button:text-is("确定")'
                      ? watch(handle as object, 'confirm')
                      : handle;
                  };
                return value.bind(object);
              },
            });
          const locate = page.locator.bind(page);
          page.locator = ((...args: Parameters<Page['locator']>) => {
            const locator = locate(...args);
            if (
              readbackFails &&
              args[0] === '[role=dialog]:visible,.ant-modal:visible'
            )
              return new Proxy(locator, {
                get(target, key, receiver) {
                  const value = Reflect.get(target, key, receiver);
                  if (key === 'count')
                    return async () => {
                      const count = await target.count();
                      if (injected) throw readback;
                      return count;
                    };
                  return typeof value === 'function'
                    ? value.bind(target)
                    : value;
                },
              });
            if (args[0] === '.syl-toolbar-tool.image button')
              return watch(locator, 'open');
            if (args[0] !== 'input[type="file"]') return locator;
            return new Proxy(locator, {
              get(target, key, receiver) {
                const value = Reflect.get(target, key, receiver);
                if (key === 'elementHandle')
                  return async (...inner: unknown[]) => {
                    const handle = await Reflect.apply(value, target, inner);
                    return handle ? watch(handle as object, 'input') : handle;
                  };
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          }) as Page['locator'];
          if (dispatched && !readbackFails)
            await f.pages.appendImage(png, 'image/png');
          else
            await expect(f.pages.appendImage(png, 'image/png')).rejects.toBe(
              original,
            );
          expect(injected).toBe(true);
          expect(await f.actions()).toMatchObject({
            opened: action === 'open' && !dispatched ? 0 : 1,
            selected:
              (!dispatched && action !== 'confirm') ||
              (readbackFails && action === 'open')
                ? 0
                : 1,
            confirmed:
              dispatched && (!readbackFails || action === 'confirm') ? 1 : 0,
          });
          expect(f.fixture.saves()).toBe(0);
        },
      );
    }
  }
}

for (const terminal of ['complete', 'reject', 'timeout', 'stop'] as const) {
  test(`T2b releases actual capture listeners at ${terminal}`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(
      context,
      page,
      terminal === 'reject'
        ? { fault: 'extra-control' }
        : terminal === 'timeout'
          ? { stall: 'confirm' }
          : {},
      terminal === 'stop' ? 'preview-visible' : undefined,
    );
    await page.evaluate(() => {
      const counts = { added: 0, removed: 0 };
      Object.assign(window, { bodyListenerCounts: counts });
      const relevant = (
        target: EventTarget,
        type: string,
        options: boolean | EventListenerOptions | undefined,
      ) =>
        ['input', 'change'].includes(type) &&
        (options === true ||
          (typeof options === 'object' && options.capture === true)) &&
        (target === document ||
          (target instanceof HTMLInputElement && target.type === 'file'));
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (
        type,
        listener,
        options,
      ) {
        if (relevant(this, type, options)) counts.added++;
        return add.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function (
        type,
        listener,
        options,
      ) {
        if (relevant(this, type, options)) counts.removed++;
        return remove.call(this, type, listener, options);
      };
    });
    if (terminal === 'complete') await f.pages.appendImage(png, 'image/png');
    else
      await expect(f.pages.appendImage(png, 'image/png')).rejects.toBeDefined();
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              bodyListenerCounts: { added: number; removed: number };
            }
          ).bodyListenerCounts,
      ),
    ).toEqual({ added: 4, removed: 4 });
    expect(f.fixture.saves()).toBe(0);
  });
}

for (const config of [
  { standardControls: true },
  { materialLibraryCheckbox: true },
  { library: 'checked' },
  { library: 'disabled-false', clearInput: true },
  { library: 'checked', unmountInput: true },
] satisfies Lifecycle[]) {
  test(`T2b completes exact owned controls ${JSON.stringify(config)}`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, config);
    expect(await f.pages.appendImage(png, 'image/png')).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(await f.actions()).toEqual({
      opened: 1,
      selected: 1,
      confirmed: 1,
      inserted: 1,
      tailDeletes: 1,
    });
    expect(
      await page.evaluate(() => ({
        changes: (window as unknown as { bodyImageLibraryChanges: number })
          .bodyImageLibraryChanges,
        checked: (
          window as unknown as { bodyImageLibraryCheckedAtConfirm: boolean }
        ).bodyImageLibraryCheckedAtConfirm,
      })),
    ).toEqual({
      changes: 'library' in config && config.library === 'checked' ? 1 : 0,
      checked: false,
    });
    expect(f.fixture.uploads()).toBe(1);
    expect(f.fixture.saves()).toBe(0);
    if ('standardControls' in config) {
      const dialog = f.events.filter((event) => event.bodyImage?.dialog).at(-1)
        ?.bodyImage?.dialog;
      expect(dialog?.controlStates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'button', label: 'close' }),
          expect.objectContaining({
            role: 'tab',
            label: 'upload-tab',
            selected: null,
          }),
          expect.objectContaining({
            role: 'tab',
            label: 'model-library-tab',
            selected: null,
          }),
          expect.objectContaining({
            role: 'tab',
            label: 'material-library-tab',
            selected: null,
          }),
        ]),
      );
    }
  });
}

for (const state of ['pending', 'unknown'] as const) {
  test(`T2b preserves ${state} after stop and listener cleanup until explicit reconciliation`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(
      context,
      page,
      state === 'pending'
        ? { busyDelay: 5000, rebuildInput: true }
        : { previewDelay: 5000, rebuildInput: true },
    );
    const outcome = f.pages.appendImage(png, 'image/png');
    const rejected = expect(outcome).rejects.toMatchObject({
      reason: 'STOP_REQUESTED',
    });
    if (state === 'pending')
      await expect.poll(() => page.locator('progress').count()).toBe(1);
    else await expect.poll(() => f.fixture.uploads()).toBe(1);
    f.stop();
    await rejected;
    expect(f.events.find((event) => event.failure)?.bodyImage).toMatchObject({
      uploadState: state,
      modalClosed: false,
    });
    await page.locator('[role=dialog]').evaluate((node) => node.remove());
    f.resume();
    expect(await f.pages.inspectEditor()).toMatchObject({
      known: true,
      pendingUploads: true,
    });
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
      check: 'body-upload-unsettled',
    });
    expect(await f.actions()).toMatchObject({
      selected: 1,
      confirmed: 0,
      inserted: 0,
    });
  });
}

for (const library of [
  'disabled-true',
  'indeterminate',
  'duplicate',
  'wrong-label',
  'wrong-for',
  'rechecked',
] as const) {
  test(`T2b rejects unsafe material-library state ${library}`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, { library });
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
    });
    expect(await f.actions()).toMatchObject({
      selected: library === 'rechecked' ? 1 : 0,
      confirmed: 0,
      inserted: 0,
      tailDeletes: 0,
    });
    expect(f.fixture.saves()).toBe(0);
  });
}

test('T2 extraction preserves the complete diagnostic order and single action counts', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {});
  await f.pages.appendImage(png, 'image/png');
  const stages = [
    'tail-position',
    'open',
    'file-control',
    'select-file',
    'preview-visible',
    'preview-loaded',
    'confirm',
    'dialog-end',
    'image-inserted',
    'tail-finalization',
    'readback',
  ];
  expect(
    f.events
      .filter((event) => event.check === 'body-image-stage')
      .map((event) => [event.bodyImage?.stage, event.bodyImage?.status]),
  ).toEqual(
    stages.flatMap((stage) =>
      stage === 'open'
        ? [[stage, 'waiting']]
        : [
            [stage, 'waiting'],
            [stage, 'completed'],
          ],
    ),
  );
  expect(await f.actions()).toEqual({
    opened: 1,
    selected: 1,
    confirmed: 1,
    inserted: 1,
    tailDeletes: 1,
  });
  expect(f.events.at(-1)?.bodyImage).toMatchObject({
    fileSelectionCount: 1,
    confirmationCount: 1,
  });
});

for (const stage of [
  'file-control',
  'preview-visible',
  'preview-loaded',
  'confirm',
  'dialog-end',
  'image-inserted',
] as const) {
  test(`T4 timeout at ${stage} preserves side effect counts and never advances`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, { stall: stage });
    const started = Date.now();
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(Date.now() - started).toBeLessThan(20000);
    const confirmed =
      stage === 'dialog-end' || stage === 'image-inserted' ? 1 : 0;
    expect(await f.actions()).toMatchObject({
      opened: 1,
      selected: stage === 'file-control' ? 0 : 1,
      confirmed,
      tailDeletes: 0,
    });
    expect(f.fixture.uploads()).toBe(stage === 'file-control' ? 0 : 1);
    expect(f.fixture.saves()).toBe(0);
    expect(f.events.filter((e) => e.failure)).toEqual([
      expect.objectContaining({
        operation: 'appendImage',
        phase: 'body-image:' + stage,
        exceptionCategory: 'timeout',
        bodyImage: expect.objectContaining({ index: 1, stage }),
      }),
    ]);
    expect(f.events.at(-1)?.bodyImage?.stage).toBe(stage);
  });
}

for (const stage of [
  'tail-position',
  'open',
  'file-control',
  'select-file',
  'preview-visible',
  'preview-loaded',
  'confirm',
  'dialog-end',
  'image-inserted',
  'tail-finalization',
] as const) {
  test(`T4 stop at ${stage} prevents later selection confirmation and cleanup`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, { rebuildInput: true }, stage);
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
      reason: 'STOP_REQUESTED',
    });
    const beforeSelection = [
      'tail-position',
      'open',
      'file-control',
      'select-file',
    ].includes(stage);
    const atStart = stage === 'tail-position' || stage === 'open';
    const afterConfirm = [
      'dialog-end',
      'image-inserted',
      'tail-finalization',
    ].includes(stage);
    const stoppedActions = await f.actions();
    expect(await f.actions()).toMatchObject({
      opened: atStart ? 0 : 1,
      selected: beforeSelection ? 0 : 1,
      confirmed: afterConfirm ? 1 : 0,
      tailDeletes: 0,
    });
    // An earlier confirmation can still finish inserting its image. Preserve that
    // observed outcome while forbidding every newly started side effect.
    await page.waitForTimeout(100);
    const settledActions = await f.actions();
    expect(settledActions).toEqual({
      ...stoppedActions,
      inserted: settledActions.inserted,
    });
    expect(settledActions.inserted).toBeGreaterThanOrEqual(
      stoppedActions.inserted,
    );
    expect(settledActions.inserted).toBeLessThanOrEqual(
      stoppedActions.confirmed,
    );
    await test.info().attach('stop-side-effects', {
      body: JSON.stringify({
        stage,
        stoppedActions,
        settledActions,
        uploads: f.fixture.uploads(),
        saves: f.fixture.saves(),
      }),
      contentType: 'application/json',
    });
    expect(f.fixture.uploads()).toBe(beforeSelection ? 0 : 1);
    expect(f.fixture.saves()).toBe(0);
    expect(f.events.find((e) => e.failure)).toMatchObject({
      operation: 'appendImage',
      reason: 'STOP_REQUESTED',
      bodyImage: { index: 1, stage },
    });
    expect(f.events.at(-1)?.bodyImage?.stage).toBe(stage);
  });
}

for (const fault of [
  'replace-input-with-file',
  'replace-dialog',
  'extra-control',
  'verification',
  'second-selection',
  'wrong-position',
  'duplicate-image',
] as const) {
  test(`T4 rejects ${fault} without a repeat submission or later cleanup`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, { fault });
    if (fault === 'wrong-position') await f.pages.appendParagraph('前文');
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toBeDefined();
    const inserted = fault === 'wrong-position' || fault === 'duplicate-image';
    expect(await f.actions()).toMatchObject({
      opened: 1,
      selected: 1,
      confirmed: inserted ? 1 : 0,
      tailDeletes: 0,
    });
    expect(f.fixture.uploads()).toBe(1);
    expect(f.fixture.saves()).toBe(0);
    expect(f.events.find((e) => e.failure)).toMatchObject({
      operation: 'appendImage',
      bodyImage: {
        index: 1,
        stage: inserted
          ? 'image-inserted'
          : fault === 'second-selection'
            ? 'select-file'
            : 'preview-visible',
      },
    });
    expect(JSON.stringify(f.events)).not.toMatch(
      /合成图片生命周期|https:|web_uri|stack|bytes/,
    );
  });
}

test('T4 long rich article preserves source blanks five ordered images and the actual final caret', async ({
  context,
  page,
}) => {
  const config: Lifecycle = {
    unmountInput: true,
    previewDelay: 100,
    closeDelay: 150,
    insertDelay: 350,
  };
  const f = await lifecycle(context, page, config);
  const para = (text: string) => ({
    type: 'paragraph' as const,
    content: text ? [{ type: 'text' as const, text, marks: [] }] : [],
  });
  const body: PersistedEditorBodyV2 = {
    version: 2,
    blocks: [
      para('前文'.repeat(600)),
      para(''),
      { type: 'image', imageId: 'X' },
      para(''),
      { type: 'image', imageId: 'X' },
      { type: 'image', imageId: 'X' },
      para('长文'.repeat(700)),
      { type: 'image', imageId: 'X' },
      para(''),
      { type: 'image', imageId: 'X' },
      para('图片后的最终文字'),
    ],
  };
  const enter = f.pages.enterNewEditor;
  f.pages.enterNewEditor = async (...args) => {
    await enter(...args);
    await installLifecycle(page, config);
    await page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>('#body')!;
      const wrapper = document.createElement('div');
      wrapper.className = 'publish-editor';
      editor.before(wrapper);
      wrapper.append(editor);
      editor.classList.add('ProseMirror');
      editor.addEventListener('mousedown', (event) => {
        const target = (event.target as Element).closest('p');
        if (target?.parentElement !== editor) return;
        const content = target.cloneNode(true) as Element;
        content
          .querySelectorAll('.syl-placeholder,img.ProseMirror-separator')
          .forEach((node) => node.remove());
        if (content.textContent) return;
        event.preventDefault();
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      for (const name of ['bold', 'italic', 'underline']) {
        const tool = document.createElement('div');
        tool.className = 'syl-toolbar-tool ' + name;
        const button = document.createElement('button');
        button.className = 'syl-toolbar-button';
        button.textContent = name;
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => {
          const active = !tool.classList.contains('active');
          editor.focus();
          if (document.queryCommandState(name) !== active)
            document.execCommand(name);
          tool.classList.toggle('active', active);
        };
        tool.append(button);
        document.querySelector('.syl-toolbar')!.append(tool);
      }
    });
  };
  const h = richDraftHarness(body);
  const adapter = createAdapterWithPages(f.session, f.pages, richCapabilities);
  const probe = await adapter.checkSession();
  if (probe.status !== 'ready') throw Error('fixture not ready');
  h.task.store = probe.store;
  h.durable().store = probe.store;
  let caretBeforeSave: unknown;
  const save = f.pages.saveOnce;
  f.pages.saveOnce = async (...args) => {
    caretBeforeSave = await page.locator('#body').evaluate((editor) => {
      const selection = window.getSelection();
      const lastText = editor.children[editor.children.length - 2];
      return {
        active: document.activeElement === editor,
        collapsed: selection?.isCollapsed,
        inLastText:
          !!selection?.anchorNode && !!lastText?.contains(selection.anchorNode),
        inTail:
          !!selection?.anchorNode &&
          editor.lastElementChild?.contains(selection.anchorNode),
        text: selection?.anchorNode?.textContent,
        offset: selection?.anchorOffset,
      };
    });
    await save(...args);
  };
  const result = await adapter.execute(h.task, h.hooks);
  expect(f.events.filter((event) => event.failure)).toEqual([]);
  expect(result).toEqual({
    status: 'blocked',
    reason: 'MANUAL_REVIEW_REQUIRED',
  });
  expect(await f.actions()).toEqual({
    opened: 5,
    selected: 5,
    confirmed: 5,
    inserted: 5,
    tailDeletes: 5,
  });
  expect(f.fixture.uploads()).toBe(5);
  expect(f.fixture.saves()).toBe(1);
  expect(
    await page
      .locator('#body > *')
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          node.matches('div[__syl_tag]')
            ? node.querySelector('.pgc-image img')?.getAttribute('web_uri')
            : node.textContent,
        ),
      ),
  ).toEqual([
    '前文'.repeat(600),
    '',
    'body-1',
    '',
    'body-2',
    'body-3',
    '长文'.repeat(700),
    'body-4',
    '',
    'body-5',
    '图片后的最终文字',
    '',
  ]);
  expect(caretBeforeSave).toEqual({
    active: true,
    collapsed: true,
    inLastText: false,
    inTail: true,
    text: '',
    offset: 0,
  });
  expect(f.events.some((event) => event.failure)).toBe(false);
});

test('T4 keeps its owned dialog when the file input unmounts before preview', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {
    unmountInput: true,
    previewDelay: 250,
  });
  expect(await f.pages.appendImage(png, 'image/png')).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.actions()).toEqual({
    opened: 1,
    selected: 1,
    confirmed: 1,
    inserted: 1,
    tailDeletes: 1,
  });
  expect(f.fixture.uploads()).toBe(1);
  expect(f.fixture.saves()).toBe(0);
});

for (const index of [1, 2, 5]) {
  test(`T4 waits for this image at ordinal ${index} after the dialog closes`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, {
      delayedIndex: index,
      insertDelay: 500,
      rebuildInput: true,
    });
    for (let current = 1; current <= index; current++) {
      expect(await f.pages.appendImage(png, 'image/png')).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect((await f.actions()).inserted).toBe(current);
    }
    expect(
      await page
        .locator('#body .pgc-image img')
        .evaluateAll((images) =>
          images.map((image) => image.getAttribute('web_uri')),
        ),
    ).toEqual(
      index === 1
        ? ['body-1']
        : index === 2
          ? ['body-1', 'body-2']
          : ['body-1', 'body-2', 'body-3', 'body-4', 'body-5'],
    );
    expect(await f.actions()).toEqual({
      opened: index,
      selected: index,
      confirmed: index,
      inserted: index,
      tailDeletes: index,
    });
    expect(f.fixture.uploads()).toBe(index);
    expect(f.fixture.saves()).toBe(0);
  });
}

test('first image waits for a reloading selected preview before its sole confirmation', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {
    library: 'checked',
    reloadOnUncheck: true,
  });
  await page.route('**/fixture/image?*reload=1', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.fulfill({ contentType: 'image/png', body: png });
  });
  await f.pages.appendImage(png, 'image/png');
  expect(
    f.events.some((e) =>
      e.bodyImage?.confirmTrace?.some((s) => s.step === 'wait-preview-reload'),
    ),
  ).toBe(true);
  expect(await f.actions()).toMatchObject({
    selected: 1,
    confirmed: 1,
    inserted: 1,
  });
});
test('T4 waits for active upload progress even when preview is loaded and confirm is enabled', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, { busyDelay: 500 });
  await f.pages.appendImage(png, 'image/png');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { bodyImageConfirmedWhileBusy: boolean })
          .bodyImageConfirmedWhileBusy,
    ),
  ).toBe(false);
  expect(await f.actions()).toMatchObject({
    selected: 1,
    confirmed: 1,
    inserted: 1,
  });
});

for (const index of [2, 5]) {
  test(`T4 timeout on image ${index} cannot reuse earlier loaded images`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, {
      stall: 'image-inserted',
      stallAtIndex: index,
    });
    for (let current = 1; current < index; current++)
      await f.pages.appendImage(png, 'image/png');
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(await f.actions()).toEqual({
      opened: index,
      selected: index,
      confirmed: index,
      inserted: index - 1,
      tailDeletes: index - 1,
    });
    expect(f.fixture.uploads()).toBe(index);
    expect(f.fixture.saves()).toBe(0);
    expect(f.events.find((event) => event.failure)).toMatchObject({
      bodyImage: { index, stage: 'image-inserted' },
      exceptionCategory: 'timeout',
    });
  });
}

test('T4 stop during preview waiting returns promptly without confirm or cleanup', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, {
    previewDelay: 1500,
    unmountInput: true,
  });
  const operation = f.pages.appendImage(png, 'image/png');
  const rejected = expect(operation).rejects.toMatchObject({
    reason: 'STOP_REQUESTED',
  });
  await expect.poll(() => f.fixture.uploads()).toBe(1);
  const started = Date.now();
  f.stop();
  await rejected;
  expect(Date.now() - started).toBeLessThan(1000);
  expect(await f.actions()).toMatchObject({
    selected: 1,
    confirmed: 0,
    tailDeletes: 0,
  });
  expect(f.fixture.saves()).toBe(0);
});

test('T4 an already populated file input blocks before another selection or upload', async ({
  context,
  page,
}) => {
  const f = await lifecycle(context, page, { preselectedInput: true });
  await expect(f.pages.appendImage(png, 'image/png')).rejects.toBeDefined();
  expect(await f.actions()).toMatchObject({
    selected: 0,
    confirmed: 0,
    tailDeletes: 0,
  });
  expect(f.fixture.uploads()).toBe(0);
  expect(f.fixture.saves()).toBe(0);
});

for (const hidden of ['initial', 'preview-loaded', 'confirm'] as const) {
  test(`T4 visibility-hidden preview cannot authorize confirm: ${hidden}`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(
      context,
      page,
      hidden === 'initial' ? { hiddenPreview: true } : { hideAtStage: hidden },
    );
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toBeDefined();
    expect(
      await page
        .locator('[role=dialog] img')
        .evaluate((img) => getComputedStyle(img).visibility),
    ).toBe('hidden');
    expect(await f.actions()).toMatchObject({
      selected: 1,
      confirmed: 0,
      inserted: 0,
      tailDeletes: 0,
    });
    expect(f.fixture.uploads()).toBe(1);
    expect(f.fixture.saves()).toBe(0);
    expect(f.events.find((event) => event.failure)).toMatchObject({
      bodyImage: {
        index: 1,
        stage: hidden === 'initial' ? 'preview-visible' : hidden,
      },
    });
  });
}

for (const change of [
  'remove',
  'selector-mismatch',
  'replace',
  'duplicate',
  'async-stop',
  'late-remove',
] as const) {
  test(`T4 I1 missing or changed body root cannot block the stage budget or stop: ${change}`, async ({
    context,
    page,
  }) => {
    // Match the actual production context's default Locator timeout. No
    // production wait or method is replaced to reproduce the hidden wait.
    context.setDefaultTimeout(10000);
    const f = await lifecycle(context, page, { stall: 'image-inserted' });
    const documentBefore = await page.evaluate(() => ({
      url: location.href,
      epoch: performance.timeOrigin,
    }));
    const outcome = f.pages.appendImage(png, 'image/png').then(
      () => ({ settled: Date.now(), error: null as unknown }),
      (error: unknown) => ({ settled: Date.now(), error }),
    );
    await expect
      .poll(() =>
        f.events.some(
          (event) =>
            event.check === 'body-image-stage' &&
            event.bodyImage?.stage === 'image-inserted',
        ),
      )
      .toBe(true);
    const stageStarted = Date.now();
    if (change === 'late-remove')
      await new Promise((resolve) => setTimeout(resolve, 9000));
    const changedAt = Date.now();
    const snapshot = await page.evaluate((change) => {
      const body = document.querySelector('#body')!;
      if (change === 'selector-mismatch') body.setAttribute('role', 'textbox');
      else if (change === 'replace') body.replaceWith(body.cloneNode(true));
      else if (change === 'duplicate') body.after(body.cloneNode(true));
      else body.remove();
      return document.body.innerHTML;
    }, change);
    let stopAt: number | undefined;
    if (change === 'async-stop')
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          stopAt = Date.now();
          f.stop();
          resolve();
        }, 100),
      );
    const result = await outcome;
    expect(result.error).toMatchObject({
      reason:
        change === 'async-stop'
          ? expect.stringMatching(/^(PAGE_CHANGED|STOP_REQUESTED)$/)
          : 'PAGE_CHANGED',
    });
    expect(result.settled - changedAt).toBeLessThan(1000);
    if (stopAt !== undefined)
      expect(result.settled - stopAt).toBeLessThan(1000);
    if (change === 'late-remove')
      expect(result.settled - stageStarted).toBeLessThan(11000);
    expect(
      await page.evaluate(() => ({
        url: location.href,
        epoch: performance.timeOrigin,
      })),
    ).toEqual(documentBefore);
    expect(await page.evaluate(() => document.body.innerHTML)).toBe(snapshot);
    expect(await f.actions()).toEqual({
      opened: 1,
      selected: 1,
      confirmed: 1,
      inserted: 0,
      tailDeletes: 0,
    });
    expect(f.fixture.uploads()).toBe(1);
    expect(f.fixture.saves()).toBe(0);
    expect(f.fixture.coverActions()).toBe(0);
    expect(f.events.find((event) => event.failure)).toMatchObject({
      operation: 'appendImage',
      bodyImage: { index: 1, stage: 'image-inserted' },
    });
    expect(f.events.at(-1)?.bodyImage?.stage).toBe('image-inserted');
  });
}

for (const fault of [
  'input-read-close',
  'dialog-bind-reload',
  'capture-disabled',
] as const) {
  test(`T4 M1 initialization failure disposes every acquired handle: ${fault}`, async ({
    context,
    page,
  }) => {
    const f = await lifecycle(context, page, {});
    const disposed = { input: 0, dialog: 0 };
    let injected = false,
      handleReads = 0;
    let actionsBefore: Awaited<ReturnType<typeof f.actions>> | undefined;
    let disabledSnapshot: string | undefined;
    // Observe actual handle disposal and forward every API to its real object.
    // Failures come from closing/reloading this temporary page or disabling the
    // real input, never from a fabricated production-method rejection.
    function watch<T extends object>(
      handle: T,
      kind: keyof typeof disposed,
    ): T {
      return new Proxy(handle, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== 'function') return value;
          if (key === 'dispose')
            return async (...args: unknown[]) => {
              disposed[kind]++;
              return Reflect.apply(value, target, args);
            };
          if (
            kind === 'input' &&
            key === 'evaluate' &&
            fault === 'input-read-close'
          )
            return async (...args: unknown[]) => {
              if (!injected) {
                actionsBefore = await f.actions();
                injected = true;
                await page.close();
              }
              return Reflect.apply(value, target, args);
            };
          if (kind === 'input' && key === 'evaluateHandle')
            return async (...args: unknown[]) => {
              handleReads++;
              if (
                !injected &&
                ((fault === 'dialog-bind-reload' && handleReads === 1) ||
                  (fault === 'capture-disabled' && handleReads === 2))
              ) {
                actionsBefore = await f.actions();
                injected = true;
                if (fault === 'dialog-bind-reload') await page.reload();
                else {
                  const evaluate = Reflect.get(target, 'evaluate');
                  if (typeof evaluate !== 'function')
                    throw Error('input evaluate unavailable');
                  await Reflect.apply(evaluate, target, [
                    (node: Element) => {
                      (node as HTMLInputElement).disabled = true;
                    },
                  ]);
                  disabledSnapshot = await page.evaluate(
                    () => document.body.innerHTML,
                  );
                }
              }
              const result = await Reflect.apply(value, target, args);
              return handleReads === 1
                ? watch(result as object, 'dialog')
                : result;
            };
          return value.bind(target);
        },
      });
    }
    const locate = page.locator.bind(page);
    page.locator = ((...args: Parameters<Page['locator']>) => {
      const locator = locate(...args);
      if (args[0] !== 'input[type="file"]') return locator;
      return new Proxy(locator, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== 'function') return value;
          if (key === 'elementHandle')
            return async (...args: unknown[]) => {
              const handle = await Reflect.apply(value, target, args);
              return handle ? watch(handle as object, 'input') : handle;
            };
          return value.bind(target);
        },
      });
    }) as Page['locator'];
    await expect(f.pages.appendImage(png, 'image/png')).rejects.toBeDefined();
    expect(injected).toBe(true);
    expect(actionsBefore).toEqual({
      opened: 1,
      selected: 0,
      confirmed: 0,
      inserted: 0,
      tailDeletes: 0,
    });
    expect(disposed).toEqual({
      input: 1,
      dialog: fault === 'capture-disabled' ? 1 : 0,
    });
    expect(f.fixture.uploads()).toBe(0);
    expect(f.fixture.saves()).toBe(0);
    if (disabledSnapshot)
      expect(await page.evaluate(() => document.body.innerHTML)).toBe(
        disabledSnapshot,
      );
    expect(f.events.find((event) => event.failure)).toMatchObject({
      operation: 'appendImage',
      bodyImage: { stage: 'file-control' },
    });
  });
}
