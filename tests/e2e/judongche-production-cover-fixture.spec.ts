import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProductionCoverDriver,
  assertOwnedCoverModal,
  type OwnedCoverModalProof,
  type CoverStageGate,
  type CoverTerminalDiagnostic,
} from '../../src/infrastructure/platforms/judongche/production-cover-driver';
import { unknownEditorEvidence } from '../../src/infrastructure/platforms/judongche/content-evidence';
import { createLocalCoverUploader } from '../../src/infrastructure/platforms/judongche/cover-pages';
import { coverInput } from '../fixtures/judongche-cover';
import { denyExternalNetwork } from './network-policy';

test.beforeEach(async ({ context }) => denyExternalNetwork(context));
async function fixture(
  page: Page,
  stages?: CoverStageGate,
  terminalDiagnostic?: (event: CoverTerminalDiagnostic) => void,
) {
  await page.route('https://www.autoengine.com/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: html }),
  );
  const html = await readFile(
    'tests/fixtures/judongche-pages/production-cover-upload.html',
    'utf8',
  );
  await page.goto('https://www.autoengine.com/jdc/dealer/info/Article');
  let generation = 'generation-1';
  const read = async (proof?: OwnedCoverModalProof) => {
    if (proof) await assertOwnedCoverModal(page, generation, proof);
    return {
      ...unknownEditorEvidence(),
      known: true,
      title: await page.locator('textarea').inputValue(),
      blocks: [
        {
          type: 'paragraph' as const,
          text: await page.locator('[contenteditable] p').innerText(),
        },
      ],
      store: {
        storeKey: 'a'.repeat(64),
        displayName: 'fixture',
        identity: { source: 'visible-shop-link' as const, value: '123' },
      },
      contextKey: 'context-1',
      editorUrl: page.url(),
      pendingUploads: false,
    };
  };
  const driver = createProductionCoverDriver({
    currentPage: () => page,
    generation: () => generation,
    guard: async (proof) => {
      if (proof) await assertOwnedCoverModal(page, generation, proof);
    },
    readEditor: read,
    invalidateInspection: () => {},
    stages,
    terminalDiagnostic,
  });
  const actions = () =>
    page.evaluate(() => (window as unknown as { actions: string[] }).actions);
  return {
    driver,
    actions,
    upload: createLocalCoverUploader(driver),
    changeGeneration: () => {
      generation = 'generation-2';
    },
  };
}
test('actual pre-upload: filled body stays intact, checked single is not clicked, absent footer is unknown', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.driver.open('single');
  expect(await f.driver.inspect()).toMatchObject({
    modal: 'owned',
    settlement: 'settled',
    mode: 'single',
    result: null,
    libraryChecked: null,
    items: [],
    editor: {
      title: '已填写的标题',
      blocks: [{ type: 'paragraph', text: '已填写的正文' }],
    },
  });
  expect(await f.actions()).toEqual(['open']);
  await expect(f.driver.confirm()).rejects.toThrow();
  await expect(f.driver.cancel()).rejects.toThrow();
  expect(await f.actions()).toEqual(['open']);
});
for (const fault of [
  'label',
  'slot-link',
  'slot-child',
  'foreign',
  'duplicate-file',
  'disabled-file',
  'generation',
  'body',
  'modal-replacement',
  'mask-replacement',
  'input-replacement',
] as const) {
  test('actual pre-upload guard rejects ' + fault, async ({ page }) => {
    const f = await fixture(page);
    if (fault === 'label')
      await page
        .locator('label')
        .first()
        .evaluate((e) => e.setAttribute('for', 'unrelated'));
    if (fault === 'slot-link')
      await page.locator('.article-cover-images').evaluate((e) => {
        const a = document.createElement('a');
        e.replaceWith(a);
        a.append(e);
      });
    if (fault === 'slot-child')
      await page
        .locator('.article-cover-add')
        .evaluate((e) => e.append(document.createElement('span')));
    if (['label', 'slot-link', 'slot-child'].includes(fault)) {
      await expect(f.driver.open('single')).rejects.toThrow();
      expect(await f.actions()).toEqual([]);
      return;
    }
    await f.driver.open('single');
    if (fault === 'foreign')
      await page.evaluate(() => {
        const e = document.createElement('div');
        e.setAttribute('role', 'dialog');
        e.textContent = 'Other';
        document.body.append(e);
      });
    if (fault === 'duplicate-file')
      await page
        .locator('input[type=file]')
        .evaluate((e) => e.after(e.cloneNode()));
    if (fault === 'disabled-file')
      await page
        .locator('input[type=file]')
        .evaluate((e) => ((e as HTMLInputElement).disabled = true));
    if (fault === 'generation') f.changeGeneration();
    if (fault === 'body')
      await page.locator('[contenteditable] p').fill('changed');
    if (fault === 'modal-replacement')
      await page
        .locator('[role=dialog]')
        .evaluate((e) => e.replaceWith(e.cloneNode(true)));
    if (fault === 'mask-replacement')
      await page
        .locator('.arco-modal-mask')
        .evaluate((e) => e.replaceWith(e.cloneNode(true)));
    if (fault === 'input-replacement')
      await page
        .locator('input[type=file]')
        .evaluate((e) => e.replaceWith(e.cloneNode(true)));
    if (fault === 'body') {
      await f.driver.guard();
      expect(await f.actions()).toEqual(['open']);
      return;
    }
    await expect(f.driver.upload(coverInput('single').files)).rejects.toThrow();
    expect(await f.actions()).toEqual(['open']);
  });
}
for (const mode of ['single', 'triple'] as const) {
  test(
    'one ' +
      mode +
      ' selection then unknown post-upload blocks all confirm/cancel/retry',
    async ({ page }) => {
      const f = await fixture(page);
      if (mode === 'single') {
        // Two 90s terminal waits plus one controlled retry need more than test.slow().
        test.setTimeout(240000);
        // The production fixture records only mode/open/upload. Real cancel is a
        // platform footer action; inject the exact button the driver owns.
        await page.evaluate(() => {
          const actions = (window as unknown as { actions: string[] }).actions;
          new MutationObserver(() => {
            const modal = document.querySelector('[role=dialog]');
            if (!modal || modal.querySelector('[data-fixture-cancel]')) return;
            const button = document.createElement('button');
            button.dataset.fixtureCancel = '';
            button.textContent = '取消';
            button.addEventListener('click', () => {
              actions.push('cancel');
              document.querySelector('#layer')?.remove();
            });
            modal.append(button);
          }).observe(document.body, { childList: true, subtree: true });
        });
      }
      const result = await f.upload(coverInput(mode), () => false);
      if (mode === 'single') {
        expect(result).toMatchObject({
          status: 'blocked',
          reason: 'COVER_UPLOAD_FAILED',
          safeEditorProof: { modalClosed: true, uploadsSettled: true },
        });
        const actions = await f.actions();
        expect(actions.filter((a) => a === 'open')).toHaveLength(2);
        expect(actions.filter((a) => a === 'upload')).toHaveLength(2);
        expect(actions.filter((a) => a === 'cancel')).toHaveLength(2);
        expect(actions.some((a) => a.startsWith('confirm:'))).toBe(false);
        expect(await f.driver.inspect()).toMatchObject({
          modal: 'closed',
          settlement: 'settled',
        });
        await expect(f.driver.upload(coverInput(mode).files)).rejects.toThrow();
        return;
      }
      expect(result).toEqual({
        status: 'blocked',
        reason: 'INPUT_UNSUPPORTED',
      });
      expect(await f.actions()).toEqual(['mode', 'open']);
      expect(await f.driver.inspect()).toMatchObject({
        modal: 'owned',
        settlement: 'settled',
        result: null,
        libraryChecked: null,
        items: [],
      });
      await expect(f.driver.upload(coverInput(mode).files)).rejects.toThrow();
    },
  );
}
test('candidate post loaded preview and false checkbox without terminal/resource association remain unknown', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.driver.open('single');
  await f.driver.upload(coverInput('single').files);
  await page.locator('[role=dialog]').evaluate((e) => {
    e.insertAdjacentHTML(
      'beforeend',
      '<img src="data:image/png;base64,iVBORw0KGgo="><label><input type="checkbox">保存到素材库</label><button>确定</button><button>取消</button><span>上传完成，可以拖拽调整图片顺序</span>',
    );
  });
  expect(await f.driver.inspect()).toMatchObject({
    settlement: 'unknown',
    result: null,
    items: [],
    libraryChecked: false,
  });
  await expect(f.driver.waitForUpload()).rejects.toThrow();
  await expect(f.driver.confirm()).rejects.toThrow();
  expect(await f.actions()).toEqual(['open', 'upload']);
});

async function candidate(
  page: Page,
  fault = '',
  terminalDiagnostic?: (event: CoverTerminalDiagnostic) => void,
) {
  const f = await fixture(page, undefined, terminalDiagnostic);
  await page.route('https://cover-resource.invalid/**', (r) =>
    r.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await f.driver.open('single');
  await page.locator('input[type=file]').evaluate((e, fault) => {
    e.addEventListener('change', () => {
      const m = e.closest('[role=dialog]')!;
      m.insertAdjacentHTML(
        'beforeend',
        '<img src="https://cover-resource.invalid/image.png?signature=exact"><span>上传完成，可以拖拽调整图片顺序</span><label><input type="checkbox" checked>保存到素材库</label><button id="confirm">确定</button><button id="cancel">取消</button>',
      );
      if (fault === 'no-terminal') m.querySelector('span')!.remove();
      if (fault === 'blob')
        m.querySelector('img')!.src = URL.createObjectURL(
          (e as HTMLInputElement).files![0]!,
        );
      if (fault === 'duplicate-checkbox')
        m.querySelector('label')!.after(
          m.querySelector('label')!.cloneNode(true),
        );
      if (fault === 'disabled-checkbox')
        (m.querySelector('input[type=checkbox]') as HTMLInputElement).disabled =
          true;
      if (fault === 'mixed-checkbox')
        (
          m.querySelector('input[type=checkbox]') as HTMLInputElement
        ).indeterminate = true;
      if (fault === 'absent-checkbox') m.querySelector('label')!.remove();
      if (fault === 'cleared-file' || fault === 'cleared-detached-file') {
        (e as HTMLInputElement).value = '';
        if (fault === 'cleared-detached-file') e.remove();
      }
      m.querySelector('#confirm')!.addEventListener('click', () => {
        (window as unknown as { actions: string[] }).actions.push('confirm');
        if (fault === 'input-unmount') {
          e.remove();
          return;
        }
        const img = m.querySelector('img')!.cloneNode(true);
        document.querySelector('.article-cover-images')!.replaceChildren(img);
        if (fault === 'resource-change')
          (img as HTMLImageElement).src =
            'https://cover-resource.invalid/image.png?signature=different';
        document.querySelector('#layer')!.remove();
      });
      m.querySelector('#cancel')!.addEventListener('click', () => {
        (window as unknown as { actions: string[] }).actions.push('cancel');
        document.querySelector('#layer')!.remove();
      });
    });
  }, fault);
  const retainedInput = await page.locator('input[type=file]').elementHandle();
  await f.driver.upload(coverInput('single').files);
  if (fault !== 'blob')
    await expect(page.locator('[role=dialog] img')).toHaveJSProperty(
      'complete',
      true,
    );
  return { ...f, retainedInput };
}

for (const fault of [
  'progress',
  'marker',
  'preview-loading',
  'file-association',
  'node-change',
  'none',
] as const) {
  test(`T1 terminal diagnostics isolate unmet evidence without changing settlement: ${fault}`, async ({
    page,
  }) => {
    const diagnostics: CoverTerminalDiagnostic[] = [];
    const f = await candidate(page, '', (event) => diagnostics.push(event));
    if (fault === 'node-change') await f.driver.inspect();
    await page.locator('[role=dialog]').evaluate((modal, fault) => {
      if (fault === 'progress')
        modal.insertAdjacentHTML('beforeend', '<progress></progress>');
      if (fault === 'marker') modal.querySelector('span')!.remove();
      if (fault === 'preview-loading')
        Object.defineProperty(modal.querySelector('img')!, 'complete', {
          value: false,
        });
      if (fault === 'file-association') {
        const input =
          modal.querySelector<HTMLInputElement>('input[type=file]')!;
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(['private'], 'private.png', { type: 'image/png' }),
        );
        input.files = transfer.files;
      }
      if (fault === 'node-change')
        modal
          .querySelector('img')!
          .replaceWith(modal.querySelector('img')!.cloneNode(true));
    }, fault);
    if (fault === 'node-change')
      await expect(f.driver.inspect()).rejects.toMatchObject({
        reason: 'PAGE_CHANGED',
        check: 'cover-node-replaced',
      });
    else
      expect((await f.driver.inspect()).settlement).toBe(
        fault === 'none' ? 'settled' : 'unknown',
      );
    expect(diagnostics.at(-1)).toMatchObject({
      ...{
        progress: { busy: true },
        marker: { completionMarkerCount: 0 },
        'preview-loading': { previewLoaded: false },
        'file-association': { selectedFileRetained: false },
        'node-change': { previewNodeStable: false },
        none: {
          busy: false,
          completionMarkerCount: 1,
          previewLoaded: true,
          selectedFileRetained: true,
          previewNodeStable: true,
        },
      }[fault],
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /private|https:|assetKey|sha256|resourceKey|signature|bytes/,
    );
    expect(await f.actions()).toEqual(['open', 'upload']);
  });
}
test('candidate single exact HTTPS identity is retained through false and complete modal closure', async ({
  page,
}) => {
  const f = await candidate(page);
  await f.driver.waitForUpload();
  expect((await f.driver.inspect()).libraryChecked).toBe(true);
  await f.driver.uncheckLibrary();
  await f.driver.confirm();
  expect(await f.driver.inspect()).toMatchObject({
    modal: 'closed',
    settlement: 'settled',
    result: 'complete',
    items: [{ position: 0, assetKey: coverInput('single').files[0]!.assetKey }],
  });
  expect(await f.actions()).toEqual(['open', 'upload', 'confirm']);
});
for (const fault of [
  'no-terminal',
  'blob',
  'duplicate-checkbox',
  'disabled-checkbox',
  'mixed-checkbox',
  'absent-checkbox',
  'resource-change',
  'input-unmount',
] as const) {
  test('candidate fault fails closed: ' + fault, async ({ page }) => {
    // The typed incomplete terminal is only decidable at the 90s deadline.
    if (fault === 'no-terminal') test.slow();
    const f = await candidate(page, fault);
    if (fault === 'no-terminal') {
      expect(await f.driver.waitForUpload()).toBe('incomplete');
      expect((await f.driver.inspect()).settlement).toBe('unknown');
    } else if (fault === 'blob') {
      await expect(f.driver.waitForUpload()).rejects.toThrow();
      expect((await f.driver.inspect()).settlement).toBe('unknown');
    } else if (['resource-change', 'input-unmount'].includes(fault)) {
      await f.driver.waitForUpload();
      await f.driver.uncheckLibrary();
      await expect(f.driver.confirm()).rejects.toThrow();
    } else {
      expect((await f.driver.inspect()).libraryChecked).toBeNull();
      await expect(f.driver.confirm()).rejects.toThrow();
    }
    expect((await f.actions()).filter((x) => x === 'confirm').length).toBe(
      ['resource-change', 'input-unmount'].includes(fault) ? 1 : 0,
    );
  });
}
test('candidate false becomes true before confirmation: no click', async ({
  page,
}) => {
  const f = await candidate(page);
  await f.driver.waitForUpload();
  await f.driver.uncheckLibrary();
  await page.getByRole('checkbox').check();
  await expect(f.driver.confirm()).rejects.toThrow();
  expect(await f.actions()).toEqual(['open', 'upload']);
});
test('candidate settled cancel checks owned layer closure independently of body normalization', async ({
  page,
}) => {
  const f = await candidate(page, 'absent-checkbox');
  await f.driver.waitForUpload();
  await page.locator('[contenteditable] p').fill('normalized body');
  await f.driver.cancel();
  expect(await f.driver.inspect()).toMatchObject({
    modal: 'closed',
    settlement: 'settled',
    editor: { title: '已填写的标题' },
  });
  expect(await f.actions()).toEqual(['open', 'upload', 'cancel']);
});

async function injectCandidateCompletion(page: Page) {
  await page.route('https://cover-resource.invalid/**', (r) =>
    r.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await page.locator('[role=dialog]').evaluate((m) => {
    m.insertAdjacentHTML(
      'beforeend',
      '<img src="https://cover-resource.invalid/image.png?signature=exact"><span>上传完成，可以拖拽调整图片顺序</span><label><input type="checkbox">保存到素材库</label><button id="confirm">确定</button><button id="cancel">取消</button>',
    );
    m.querySelector('#confirm')!.addEventListener('click', () => {
      (window as unknown as { actions: string[] }).actions.push('confirm');
      document
        .querySelector('.article-cover-images')!
        .replaceChildren(m.querySelector('img')!.cloneNode(true));
      document.querySelector('#layer')!.remove();
    });
  });
  await expect(page.locator('[role=dialog] img')).toHaveJSProperty(
    'complete',
    true,
  );
}
test('one real uploader invocation crosses fixed stages with one selection and one confirmation', async ({
  page,
}) => {
  let release: (() => void) | undefined;
  let stage = '';
  const reserves: string[] = [];
  const f = await fixture(page, {
    reserve: async (effect) => {
      reserves.push(effect);
      if (effect !== 'open')
        await page
          .locator('[contenteditable] p')
          .fill('normalization at ' + effect);
    },
    pause: async (name) => {
      stage = name;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  const running = f.upload(coverInput('single'), () => false);
  await expect.poll(() => stage).toBe('after-selection');
  expect(await f.actions()).toEqual(['open', 'upload']);
  await injectCandidateCompletion(page);
  release!();
  await expect.poll(() => stage).toBe('after-upload-review');
  release!();
  await expect.poll(() => stage).toBe('before-confirm');
  expect(await f.actions()).toEqual(['open', 'upload']);
  release!();
  await expect.poll(() => stage).toBe('after-cover-review');
  release!();
  expect((await running).status).toBe('completed');
  expect(await f.actions()).toEqual(['open', 'upload', 'confirm']);
  expect(reserves).toEqual(['open', 'upload', 'confirm']);
});
test('stop releases paused invocation without confirmation or a second upload', async ({
  page,
}) => {
  let release: (() => void) | undefined;
  let stopped = false;
  const f = await fixture(page, {
    reserve: async () => {},
    pause: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  const running = f.upload(coverInput('single'), () => stopped);
  await expect.poll(() => !!release).toBe(true);
  stopped = true;
  release!();
  expect(await running).toEqual({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(await f.actions()).toEqual(['open', 'upload']);
});
test('FileList cleared after verified selection retains the pinned association', async ({
  page,
}) => {
  const f = await candidate(page);
  await page
    .locator('input[type=file]')
    .evaluate((e) => ((e as HTMLInputElement).value = ''));
  expect((await f.driver.inspect()).settlement).toBe('settled');
  await f.driver.uncheckLibrary();
  await f.driver.confirm();
  expect(await f.actions()).toEqual(['open', 'upload', 'confirm']);
});

import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
test('formal pages integration uses owned proof, filled body, local cover readback and unchanged saveOnce', async ({
  page,
  context,
}) => {
  await fixture(page);
  const html = (
    await readFile(
      'tests/fixtures/judongche-pages/production-cover-upload.html',
      'utf8',
    )
  )
    .replace('已填写的标题', '')
    .replace(
      '<p>已填写的正文</p>',
      '<p><br class="ProseMirror-trailingBreak"></p>',
    );
  await page.route('https://www.autoengine.com/jdc/dealer/info/Article', (r) =>
    r.fulfill({ contentType: 'text/html', body: html }),
  );
  let saves = 0;
  await page.route(
    'https://www.autoengine.com/motor/dealer_admin/go_api/article/create',
    (r) => {
      saves++;
      return r.fulfill({ json: { status: 0 } });
    },
  );
  const stages: string[] = [];
  const pages = createJudongchePages(
    {
      current: () => context,
      generation: () => 'formal-generation',
      open: async () => context,
      close: async () => {},
    },
    undefined,
    {
      manualReview: true,
      ownerConfirmedPilot: { dealerId: '123', storeName: 'fixture' },
    },
    {
      reserve: async () => {},
      pause: async (stage) => {
        stages.push(stage);
        if (stage === 'after-selection') await injectCandidateCompletion(page);
      },
    },
  );
  expect((await pages.probe()).status).toBe('ready');
  await pages.enterNewEditor('正式已填标题', () => false, 'formal-task');
  await pages.fillTitle('正式已填标题');
  // Fixture editor input setup; the production body extractor still reads it.
  await page
    .locator('[contenteditable]')
    .evaluate(
      (e) =>
        (e.innerHTML =
          '<p>正式已填正文</p><p><br class="ProseMirror-trailingBreak"></p>'),
    );
  expect(
    (await pages.uploadLocalCover!(coverInput('single'), () => false)).status,
  ).toBe('completed');
  const observed = await pages.inspectEditor();
  expect(observed.known).toBe(true);
  expect(observed.localCover).toMatchObject({
    known: true,
    mode: 'single',
    pendingUploads: false,
  });
  expect(observed.blocks).toEqual([
    { type: 'paragraph', text: '正式已填正文' },
  ]);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = '存草稿';
    button.onclick = () => {
      void fetch('/motor/dealer_admin/go_api/article/create', {
        method: 'POST',
      });
    };
    document.body.append(button);
  });
  await pages.saveOnce();
  await expect(pages.saveOnce()).rejects.toThrow();
  expect(saves).toBe(1);
  expect(stages).toEqual([
    'after-selection',
    'after-upload-review',
    'before-confirm',
    'after-cover-review',
  ]);
});

import { readProductionLocalCover } from '../../src/infrastructure/platforms/judongche/production-cover-driver';
test('candidate saved SINGLE projection hashes full exact URL; query change cannot match', async ({
  page,
}) => {
  const f = await candidate(page);
  await f.driver.waitForUpload();
  const before = (await f.driver.inspect()).items[0]!.resourceKey;
  await f.driver.uncheckLibrary();
  await f.driver.confirm();
  expect((await readProductionLocalCover(page)).items[0]!.resourceKey).toBe(
    before,
  );
  await page
    .locator('.article-cover-images img')
    .evaluate(
      (e) =>
        ((e as HTMLImageElement).src =
          'https://cover-resource.invalid/image.png?signature=other'),
    );
  await expect(page.locator('.article-cover-images img')).toHaveJSProperty(
    'complete',
    true,
  );
  expect((await readProductionLocalCover(page)).items[0]!.resourceKey).not.toBe(
    before,
  );
});
test('fixed fresh-read closure observes changed false and rejects replaced owned nodes without actions', async ({
  page,
}) => {
  let readCurrent: (() => Promise<unknown>) | undefined;
  let release: (() => void) | undefined;
  let stopped = false;
  const f = await fixture(page, {
    reserve: async () => {},
    pause: async (_stage, _observation, read) => {
      readCurrent = read;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  const running = f.upload(coverInput('single'), () => stopped);
  await expect.poll(() => !!readCurrent).toBe(true);
  expect(await readCurrent!()).toMatchObject({
    settlement: 'unknown',
    libraryChecked: null,
  });
  await injectCandidateCompletion(page);
  expect(await readCurrent!()).toMatchObject({
    settlement: 'settled',
    libraryChecked: false,
  });
  await page.getByRole('checkbox').check();
  expect(await readCurrent!()).toMatchObject({ libraryChecked: true });
  await page
    .locator('.arco-modal-mask')
    .evaluate((e) => e.replaceWith(e.cloneNode(true)));
  await expect(readCurrent!()).rejects.toThrow();
  stopped = true;
  release!();
  expect((await running).status).toBe('blocked');
  expect(await f.actions()).toEqual(['open', 'upload']);
});

test('short completion label is not the frozen screenshot full-text predicate', async ({
  page,
}) => {
  const f = await candidate(page);
  await page
    .getByText('上传完成，可以拖拽调整图片顺序', { exact: true })
    .evaluate((e) => (e.textContent = '上传完成'));
  expect((await f.driver.inspect()).settlement).toBe('unknown');
  await expect(f.driver.confirm()).rejects.toThrow();
  expect(await f.actions()).toEqual(['open', 'upload']);
});

for (const boundary of [
  'after-upload-review',
  'after-library-review',
  'before-confirm',
] as const) {
  for (const reobserve of ['release', 'refresh'] as const) {
    test(`I1 original association survives ${boundary} ${reobserve} without confirm or reupload`, async ({
      page,
    }) => {
      let reached = false;
      let release: (() => void) | undefined;
      let refresh: (() => Promise<unknown>) | undefined;
      const f = await fixture(page, {
        reserve: async () => {},
        pause: async (stage, _observation, readCurrent) => {
          if (stage === 'after-selection') {
            await injectCandidateCompletion(page);
            await page.getByRole('checkbox').check();
          }
          if (stage === boundary) {
            reached = true;
            refresh = readCurrent;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        },
      });
      const running = f.upload(coverInput('single'), () => false);
      await expect.poll(() => reached).toBe(true);
      await page.locator('[role=dialog] img').evaluate((e) => {
        (e as HTMLImageElement).src =
          'https://cover-resource.invalid/image.png?signature=changed';
      });
      await expect(page.locator('[role=dialog] img')).toHaveJSProperty(
        'complete',
        true,
      );
      if (reobserve === 'refresh') await expect(refresh!()).rejects.toThrow();
      release!();
      expect(await running).toEqual({
        status: 'blocked',
        reason: 'PAGE_CHANGED',
      });
      expect(await f.actions()).toEqual(['open', 'upload']);
      // Once drift is observed, restoring A cannot authorize a new close attempt.
      await page.locator('[role=dialog] img').evaluate((e) => {
        (e as HTMLImageElement).src =
          'https://cover-resource.invalid/image.png?signature=exact';
      });
      await expect(f.driver.confirm()).rejects.toThrow();
      await expect(f.driver.cancel()).rejects.toThrow();
      expect((await f.upload(coverInput('single'), () => false)).status).toBe(
        'blocked',
      );
      expect(await f.actions()).toEqual(['open', 'upload']);
    });
  }
}

test('I1 replacing the pinned preview node with the same URL never authorizes close', async ({
  page,
}) => {
  const f = await candidate(page);
  await f.driver.waitForUpload();
  await page
    .locator('[role=dialog] img')
    .evaluate((e) => e.replaceWith(e.cloneNode(true)));
  await expect(f.driver.inspect()).rejects.toThrow();
  await expect(f.driver.confirm()).rejects.toThrow();
  await expect(f.driver.cancel()).rejects.toThrow();
  expect(await f.actions()).toEqual(['open', 'upload']);
});
test('I1 losing terminal after pinning remains blocked when terminal is restored', async ({
  page,
}) => {
  const f = await candidate(page);
  await f.driver.waitForUpload();
  const terminal = page.getByText('上传完成，可以拖拽调整图片顺序', {
    exact: true,
  });
  await terminal.evaluate((e) => (e.textContent = '等待'));
  expect((await f.driver.inspect()).settlement).toBe('unknown');
  await page
    .getByText('等待', { exact: true })
    .evaluate((e) => (e.textContent = '上传完成，可以拖拽调整图片顺序'));
  await expect(f.driver.confirm()).rejects.toThrow();
  await expect(f.driver.cancel()).rejects.toThrow();
  expect(await f.actions()).toEqual(['open', 'upload']);
});
test('I1 confirmation reservation rereads the pinned association before any click', async ({
  page,
}) => {
  const f = await fixture(page, {
    reserve: async (effect) => {
      if (effect === 'confirm') {
        await page
          .locator('[role=dialog] img')
          .evaluate(
            (e) =>
              ((e as HTMLImageElement).src =
                'https://cover-resource.invalid/image.png?signature=changed'),
          );
        await expect(page.locator('[role=dialog] img')).toHaveJSProperty(
          'complete',
          true,
        );
      }
    },
    pause: async (stage) => {
      if (stage === 'after-selection') await injectCandidateCompletion(page);
    },
  });
  expect(await f.upload(coverInput('single'), () => false)).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(await f.actions()).toEqual(['open', 'upload']);
});

for (const sinkThrows of [false, true]) {
  test(
    'formal local cover preserves the first swallowed driver failure; sink throws=' +
      sinkThrows,
    async ({ page, context }) => {
      const html = (
        await readFile(
          'tests/fixtures/judongche-pages/production-cover-upload.html',
          'utf8',
        )
      )
        .replace('已填写的标题', '')
        .replace(
          '<p>已填写的正文</p>',
          '<p><br class="ProseMirror-trailingBreak"></p>',
        )
        .replace(
          "root.querySelector('input').onchange = () => window.actions.push('upload');",
          "document.addEventListener('input', (event) => { if (event.target === root.querySelector('input')) { const transfer = new DataTransfer(); transfer.items.add(new File(['altered'], 'altered.png', { type: 'image/png' })); event.target.files = transfer.files; } }, { capture: true, once: true }); root.querySelector('input').onchange = () => window.actions.push('upload');",
        );
      await page.route('https://www.autoengine.com/**', (r) =>
        r.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.goto('https://www.autoengine.com/jdc/dealer/info/Article');
      const diagnostics: import('../../src/infrastructure/platforms/judongche/production-pages').ProbeDiagnostic[] =
        [];
      const pages = createJudongchePages(
        {
          current: () => context,
          generation: () => 'failure-generation',
          open: async () => context,
          close: async () => {},
        },
        (event) => {
          diagnostics.push(event);
          if (sinkThrows) throw new Error('private diagnostic sink failure');
        },
        {
          manualReview: true,
          ownerConfirmedPilot: { dealerId: '123', storeName: 'fixture' },
        },
      );
      expect((await pages.probe()).status).toBe('ready');
      await pages.enterNewEditor(
        'private article title',
        () => false,
        'failure-task',
      );
      await pages.fillTitle('private article title');
      await page
        .locator('[contenteditable]')
        .evaluate((e) => (e.innerHTML = '<p>private article body</p>'));
      expect(
        await pages.uploadLocalCover!(coverInput('single'), () => false),
      ).toEqual({ status: 'blocked', reason: 'PAGE_CHANGED' });
      const failures = diagnostics.filter((event) => event.failure);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        operation: 'uploadLocalCover',
        phase: 'local-cover:upload',
        check: 'cover-selected-file-mismatch',
        reason: 'PAGE_CHANGED',
        exceptionCategory: 'platform-guard',
        pageState: 'editor',
      });
      expect(JSON.stringify(diagnostics)).not.toMatch(
        /private article|private diagnostic|https:\/\/|assetKey|bytes/,
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { actions: string[] }).actions,
        ),
      ).toEqual(['open', 'upload']);
    },
  );
}

for (const fault of ['cleared-file', 'cleared-detached-file']) {
  test(
    'platform-cleared file input retains the causal single-file evidence: ' +
      fault,
    async ({ page }) => {
      const f = await candidate(page, fault);
      await f.driver.waitForUpload();
      expect(await f.driver.inspect()).toMatchObject({
        result: 'complete',
        items: [
          {
            position: 0,
            assetKey: coverInput('single').files[0].assetKey,
            sha256: coverInput('single').files[0].sha256,
          },
        ],
      });
      await f.driver.uncheckLibrary();
      await f.driver.confirm();
      expect(await f.actions()).toEqual(['open', 'upload', 'confirm']);
      expect(await f.driver.inspect()).toMatchObject({
        settlement: 'settled',
        mode: 'single',
      });
      await expect(
        f.driver.upload(coverInput('single').files),
      ).rejects.toThrow();
    },
  );
}
test('unexpected second file selection signal invalidates a cleared-input association', async ({
  page,
}) => {
  const f = await candidate(page, 'cleared-file');
  await f.driver.waitForUpload();
  await page.locator('input[type=file]').dispatchEvent('input');
  expect((await f.driver.inspect()).settlement).toBe('unknown');
  await expect(f.driver.confirm()).rejects.toThrow();
  expect(await f.actions()).toEqual(['open', 'upload']);
});

test('unexpected second signal on the detached original input never authorizes confirmation', async ({
  page,
}) => {
  const f = await candidate(page, 'cleared-detached-file');
  await f.driver.waitForUpload();
  await f.driver.uncheckLibrary();
  await f.retainedInput!.evaluate((e) =>
    e.dispatchEvent(new Event('input', { bubbles: true })),
  );
  expect((await f.driver.inspect()).settlement).toBe('unknown');
  await expect(f.driver.confirm()).rejects.toThrow();
  expect(await f.actions()).toEqual(['open', 'upload']);
});

for (const drift of [false, true]) {
  test(
    'single cover pending HTTPS preview, session drift=' + drift,
    async ({ page }) => {
      const f = await fixture(page);
      await f.driver.open('single');
      await f.driver.upload(coverInput('single').files);
      let release!: () => void;
      const responseGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        'https://cover-resource.invalid/delayed.png',
        async (route) => {
          await responseGate;
          if (drift) f.changeGeneration();
          await route.fulfill({
            contentType: 'image/png',
            body: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
              'base64',
            ),
          });
        },
      );
      await page.locator('[role=dialog]').evaluate((m) => {
        m.insertAdjacentHTML(
          'beforeend',
          '<img src="https://cover-resource.invalid/delayed.png"><div class="upload-image-tips"><span>上传完成，可以拖拽调整图片顺序</span></div><label><input type="checkbox">保存到素材库</label><button>确定</button><button>取消</button>',
        );
      });
      expect((await f.driver.inspect()).settlement).toBe('unknown');
      const result = f.driver.waitForUpload().then(
        () => 'complete',
        () => 'blocked',
      );
      // Hold the actual response beyond a single inspection; only observation may wait.
      const timer = setTimeout(release, 750);
      try {
        expect(await result).toBe(drift ? 'blocked' : 'complete');
        if (!drift) expect((await f.driver.inspect()).items).toHaveLength(1);
        expect(await f.actions()).toEqual(['open', 'upload']);
      } finally {
        clearTimeout(timer);
        release();
      }
    },
  );
}

for (const drift of [false, true]) {
  test(
    'single cover asynchronous upload completion, session drift=' + drift,
    async ({ page }) => {
      const f = await fixture(page);
      await f.driver.open('single');
      await f.driver.upload(coverInput('single').files);
      expect((await f.driver.inspect()).settlement).toBe('unknown');
      const completion = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (drift) f.changeGeneration();
          injectCandidateCompletion(page).then(resolve, reject);
        }, 500);
      });
      const outcome = await f.driver.waitForUpload().then(
        () => 'complete',
        () => 'blocked',
      );
      await completion;
      expect(outcome).toBe(drift ? 'blocked' : 'complete');
      expect(await f.actions()).toEqual(['open', 'upload']);
    },
  );
}

for (const sameObject of [true, false]) {
  test(
    'single cover readback uses observed object identity, same=' + sameObject,
    async ({ page }) => {
      await fixture(page);
      await page.route('https://p3-dcd-sign.byteimg.com/**', (r) =>
        r.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
            'base64',
          ),
        }),
      );
      const show = async (url: string) => {
        await page.locator('.article-cover-images').evaluate((e, value) => {
          e.replaceChildren();
          const i = document.createElement('img');
          i.src = value;
          e.append(i);
        }, url);
        await expect
          .poll(async () => (await readProductionLocalCover(page)).known)
          .toBe(true);
        return readProductionLocalCover(page);
      };
      const prefix = 'https://p3-dcd-sign.byteimg.com/tos-cn-i-f042mdwyw7/';
      const before = await show(
        prefix +
          'a'.repeat(32) +
          '~tplv-resize:640:0.image?lk3s=4e54bfa5&x-expires=1&x-signature=first',
      );
      const after = await show(
        prefix +
          (sameObject ? 'a' : 'b').repeat(32) +
          '~tplv-f042mdwyw7-origin:0:0.image?lk3s=4e54bfa5&x-expires=2&x-signature=second&psm=motor.dealer_admin.goapi',
      );
      expect(before.items[0]?.resourceKey === after.items[0]?.resourceKey).toBe(
        sameObject,
      );
    },
  );
}

for (const changed of [false, true]) {
  test(
    'saved cover read waits for captured image only, changed=' + changed,
    async ({ page }) => {
      const f = await fixture(page);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        'https://cover-resource.invalid/readback.png',
        async (route) => {
          await gate;
          await route.fulfill({
            contentType: 'image/png',
            body: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
              'base64',
            ),
          });
        },
      );
      await page.locator('.article-cover-images').evaluate((e) => {
        e.replaceChildren();
        const image = document.createElement('img');
        image.src = 'https://cover-resource.invalid/readback.png';
        e.append(image);
      });
      expect((await readProductionLocalCover(page)).pendingUploads).toBe(true);
      const result = readProductionLocalCover(page, true);
      const timer = setTimeout(async () => {
        if (changed)
          await page
            .locator('.article-cover-images img')
            .evaluate((e) => e.remove());
        release();
      }, 250);
      try {
        const observed = await result;
        expect(observed.known).toBe(!changed);
        expect(observed.pendingUploads).toBe(changed);
        expect(await f.actions()).toEqual([]);
      } finally {
        clearTimeout(timer);
        release();
      }
    },
  );
}
