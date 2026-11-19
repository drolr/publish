import { test, expect, type Page, type ElementHandle } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createProductionCoverDriver,
  assertOwnedCoverModal,
  type CoverStageGate,
  type CoverTerminalDiagnostic,
} from '../../src/infrastructure/platforms/judongche/production-cover-driver';
import { createLocalCoverUploader } from '../../src/infrastructure/platforms/judongche/cover-pages';
import {
  unknownEditorEvidence,
  type ObservedBlock,
} from '../../src/infrastructure/platforms/judongche/content-evidence';
import {
  JudongchePageError,
  assertSafe,
} from '../../src/infrastructure/platforms/judongche/production-state';
import { coverInput } from '../fixtures/judongche-cover';
import { denyExternalNetwork } from './network-policy';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
);
test.beforeEach(async ({ context }) => denyExternalNetwork(context));

async function lifecycle(page: Page, bodyImages = 0, stages?: CoverStageGate) {
  const html = await readFile(
    'tests/fixtures/judongche-pages/production-cover-upload.html',
    'utf8',
  );
  await page.route('https://www.autoengine.com/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.route('https://cover-resource.invalid/**', (r) =>
    r.fulfill({ contentType: 'image/png', body: png }),
  );
  let saves = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/article/create')) saves++;
  });
  await page.goto('https://www.autoengine.com/jdc/dealer/info/Article');
  await page.locator('[contenteditable]').evaluate((body, count) => {
    for (let index = 0; index < count; index++) {
      const image = document.createElement('img');
      image.src = `https://cover-resource.invalid/body-${index}.png`;
      body.append(image);
    }
  }, bodyImages);
  await expect
    .poll(() =>
      page
        .locator('[contenteditable] img')
        .evaluateAll((images) =>
          images.every((i) => (i as HTMLImageElement).complete),
        ),
    )
    .toBe(true);
  let stopped = false;
  const diagnostics: CoverTerminalDiagnostic[] = [];
  const driver = createProductionCoverDriver({
    currentPage: () => page,
    generation: () => 'lifecycle-generation',
    guard: async (proof) => {
      if (stopped) throw new JudongchePageError('STOP_REQUESTED');
      if (proof)
        await assertOwnedCoverModal(page, 'lifecycle-generation', proof);
    },
    readEditor: async () => ({
      ...unknownEditorEvidence(),
      known: true,
      title: await page.locator('textarea').inputValue(),
      blocks: await page.locator('[contenteditable]').evaluate((body) => {
        return Array.from(body.children).map((node): ObservedBlock =>
          node instanceof HTMLImageElement
            ? {
                type: 'image',
                resourceKey: node.currentSrc,
                loaded: node.complete && node.naturalWidth > 0,
              }
            : { type: 'paragraph', text: node.textContent ?? '' },
        );
      }),
      store: {
        storeKey: 'a'.repeat(64),
        displayName: 'fixture',
        identity: { source: 'visible-shop-link' as const, value: '123' },
      },
      contextKey: 'lifecycle-context',
      editorUrl: page.url(),
      pendingUploads: await page.evaluate(
        () =>
          !!(window as unknown as { fixtureUploadPending?: boolean })
            .fixtureUploadPending,
      ),
    }),
    invalidateInspection: () => {},
    terminalDiagnostic: (event) => diagnostics.push(event),
    stages,
  });
  return {
    driver,
    upload: createLocalCoverUploader(driver),
    diagnostics,
    stop: () => {
      stopped = true;
    },
    stopped: () => stopped,
    saves: () => saves,
    actions: () =>
      page.evaluate(() => (window as unknown as { actions: string[] }).actions),
  };
}

// Test-only platform lifecycle: no production method/timeout is replaced.
async function review(page: Page, busy = false, preview = true) {
  await page.locator('[role=dialog]').evaluate(
    (modal, { busy, preview }) => {
      if (busy) modal.insertAdjacentHTML('beforeend', '<progress></progress>');
      if (preview)
        modal.insertAdjacentHTML(
          'beforeend',
          '<img src="https://cover-resource.invalid/cover.png">',
        );
      modal.insertAdjacentHTML(
        'beforeend',
        '<span>上传完成，可以拖拽调整图片顺序</span><label><input type="checkbox">保存到素材库</label><button id="confirm">确定</button><button id="cancel">取消</button>',
      );
      modal.querySelector('#confirm')!.addEventListener('click', () => {
        (window as unknown as { actions: string[] }).actions.push('confirm');
        document
          .querySelector('.article-cover-images')!
          .replaceChildren(modal.querySelector('img')!.cloneNode(true));
        document.querySelector('#layer')!.remove();
      });
      modal.querySelector('#cancel')!.addEventListener('click', () => {
        (window as unknown as { actions: string[] }).actions.push('cancel');
        document.querySelector('#layer')!.remove();
      });
    },
    { busy, preview },
  );
}

for (const bodyImages of [0, 4, 5]) {
  for (const transition of [
    'progress',
    'preview-mount',
    'clear-before-marker',
    'clear-after-marker',
    'unmount-before-marker',
    'unmount-picker-before-marker',
    'unmount-after-marker',
    'unmount-retained-before-marker',
  ] as const) {
    test(`T2 waits for ${transition} with ${bodyImages} body images`, async ({
      page,
    }) => {
      const f = await lifecycle(page, bodyImages);
      await f.driver.open('single');
      await f.driver.upload(coverInput('single').files);
      const initialBody = await page.locator('[contenteditable]').innerHTML();
      if (transition === 'progress' || transition.endsWith('after-marker'))
        await review(page, true);
      if (transition === 'preview-mount') await review(page, false, false);
      if (transition.startsWith('clear') || transition.startsWith('unmount'))
        await page.locator('input[type=file]').evaluate((input, transition) => {
          if (!transition.includes('retained'))
            (input as HTMLInputElement).value = '';
          if (transition === 'unmount-picker-before-marker') {
            const modal = input.closest('[role=dialog]')!;
            Array.from(modal.querySelectorAll('button'))
              .find((b) => b.textContent?.trim() === '选择图片')!
              .remove();
          }
          if (transition.startsWith('unmount')) input.remove();
        }, transition);
      const completion = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          (async () => {
            if (transition.endsWith('before-marker')) await review(page);
            else
              await page
                .locator('[role=dialog]')
                .evaluate((modal, transition) => {
                  modal.querySelector('progress')?.remove();
                  if (transition === 'preview-mount')
                    modal.insertAdjacentHTML(
                      'beforeend',
                      '<img src="https://cover-resource.invalid/cover.png">',
                    );
                }, transition);
          })().then(resolve, reject);
        }, 1200);
      });
      const outcome = await f.driver.waitForUpload().then(
        (terminal) => terminal,
        () => 'blocked',
      );
      await completion;
      expect(outcome).toBe('complete');
      expect((await f.driver.inspect()).items).toHaveLength(1);
      await f.driver.confirm();
      expect(await f.actions()).toEqual(['open', 'upload', 'confirm']);
      expect(await page.locator('[contenteditable]').innerHTML()).toBe(
        initialBody,
      );
      expect(await page.locator('[contenteditable] img').count()).toBe(
        bodyImages,
      );
      expect(f.saves()).toBe(0);
    });
  }
}

test('T2 scrolls an in-viewport covered slot normally before clicking', async ({
  page,
}) => {
  const f = await lifecycle(page);
  await page.locator('#cover').evaluate((cover) => {
    Object.assign((cover as HTMLElement).style, { marginTop: '420px' });
    document.body.style.minHeight = '2200px';
    const overlay = document.createElement('button');
    overlay.textContent = 'unrelated fixed footer';
    Object.assign(overlay.style, {
      position: 'fixed',
      bottom: '0',
      left: '0',
      width: '100%',
      height: '220px',
      zIndex: '5',
    });
    overlay.onclick = () =>
      (window as unknown as { actions: string[] }).actions.push('foreign');
    document.body.append(overlay);
  });
  const slot = page.locator('.article-cover-add');
  await slot.evaluate((e) => {
    const r = e.getBoundingClientRect();
    if (
      r.top < 0 ||
      r.bottom > innerHeight ||
      e.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      )
    )
      throw new Error('fixture must start covered and inside viewport');
  });
  await f.driver.open('single');
  expect(await f.actions()).toEqual(['open']);
  expect(f.saves()).toBe(0);
});

for (const opened of [true, false]) {
  test(`T2 reconciles a click timeout before any replay; opened=${opened}`, async ({
    page,
  }) => {
    const f = await lifecycle(page);
    if (!opened)
      await page.locator('.article-cover-add').evaluate((e) => {
        (e as HTMLElement).onclick = () =>
          (window as unknown as { actions: string[] }).actions.push('open');
      });
    // Inject lost action acknowledgement AFTER the real normal browser click.
    // Preserve its effects; only its returned promise is a controlled transport fault.
    const node = await page.locator('.article-cover-add').elementHandle();
    const prototype = Object.getPrototypeOf(node) as {
      click: ElementHandle['click'];
    };
    const click = prototype.click;
    prototype.click = async function (this: ElementHandle, options) {
      const slot = await this.evaluate(
        (e) =>
          e instanceof Element && e.classList.contains('article-cover-add'),
      );
      await click.call(this, options);
      if (slot) {
        const error = new Error('controlled lost click acknowledgement');
        error.name = 'TimeoutError';
        throw error;
      }
    };
    try {
      if (opened) {
        await f.driver.open('single');
        expect(await f.driver.inspect()).toMatchObject({
          modal: 'owned',
          settlement: 'settled',
        });
      } else {
        await expect(f.driver.open('single')).rejects.toMatchObject({
          name: 'TimeoutError',
        });
        await expect(f.driver.open('single')).rejects.toThrow();
      }
      expect(await f.actions()).toEqual(['open']);
      expect(f.saves()).toBe(0);
    } finally {
      prototype.click = click;
      await node?.dispose();
    }
  });
}

for (const entry of [
  'nested-scroll',
  'animation',
  'slot-rebuilt',
  'permanent-cover',
] as const) {
  test(`T2 normal entry retains identity through ${entry}`, async ({
    page,
  }) => {
    const f = await lifecycle(page, 0, {
      reserve: async (effect) => {
        if (effect === 'open' && entry === 'slot-rebuilt')
          await page
            .locator('.article-cover-add')
            .evaluate((slot) => slot.replaceWith(slot.cloneNode(true)));
      },
      pause: async () => {},
    });
    await page.locator('#cover').evaluate((cover, entry) => {
      if (entry === 'nested-scroll') {
        const scroller = document.createElement('div');
        Object.assign(scroller.style, {
          height: '160px',
          overflowY: 'auto',
          marginTop: '90px',
        });
        cover.replaceWith(scroller);
        const spacer = document.createElement('div');
        spacer.style.height = '500px';
        scroller.append(spacer, cover);
      }
      if (entry === 'animation') {
        const style = document.createElement('style');
        style.textContent =
          '@keyframes slide { from { transform: translateX(100px) } to { transform: translateX(0) } } .article-cover-add { animation: slide 900ms linear }';
        document.head.append(style);
      }
      if (entry === 'permanent-cover') {
        const blocker = document.createElement('button');
        const rect = cover.getBoundingClientRect();
        Object.assign(blocker.style, {
          position: 'fixed',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          zIndex: '10',
        });
        blocker.textContent = 'unrelated control';
        blocker.onclick = () =>
          (window as unknown as { actions: string[] }).actions.push('foreign');
        document.body.append(blocker);
      }
    }, entry);
    if (entry === 'slot-rebuilt' || entry === 'permanent-cover') {
      await expect(f.driver.open('single')).rejects.toThrow();
      expect(await f.actions()).toEqual([]);
    } else {
      await f.driver.open('single');
      expect(await f.actions()).toEqual(['open']);
    }
    expect(f.saves()).toBe(0);
  });
}

test('cover diagnostic classifies a data preview without retaining its address', async ({
  page,
}) => {
  const f = await lifecycle(page);
  await f.driver.open('single');
  await f.driver.upload(coverInput('single').files);
  await review(page, false);
  await page.locator('[role=dialog] img').evaluate(async (image, bytes) => {
    const img = image as HTMLImageElement;
    img.src = 'data:image/png;base64,' + bytes;
    await img.decode();
  }, png.toString('base64'));
  await expect(f.driver.waitForUpload()).rejects.toMatchObject({
    check: 'cover-terminal-resource-invalid',
  });
  expect(f.diagnostics.at(-1)).toMatchObject({
    previewSourceKind: 'data',
    previewResourceValid: false,
  });
  expect(JSON.stringify(f.diagnostics)).not.toContain('base64');
});
for (const state of ['uploading', 'unknown', 'rejected'] as const) {
  test(`T2 observes ${state} independently of an empty file control and honours stop`, async ({
    page,
  }) => {
    const f = await lifecycle(page);
    await f.driver.open('single');
    await f.driver.upload(coverInput('single').files);
    await review(page, state === 'uploading');
    await page.locator('[role=dialog]').evaluate((modal, state) => {
      (modal.querySelector('input[type=file]') as HTMLInputElement).value = '';
      modal.querySelector('img')!.remove();
      modal.querySelector('span')!.remove();
      if (state === 'rejected')
        modal.insertAdjacentHTML(
          'beforeend',
          '<div role="alert">合成拒绝</div>',
        );
    }, state);
    if (state === 'rejected') {
      expect(await f.driver.waitForUpload()).toBe('rejected');
      expect(f.diagnostics.at(-1)?.state).toBe('rejected');
      await f.driver.cancel();
      expect((await f.driver.inspect()).settlement).toBe('settled');
      expect(await f.actions()).toEqual(['open', 'upload', 'cancel']);
    } else {
      const waiting = f.driver.waitForUpload();
      await expect.poll(() => f.diagnostics.at(-1)?.state).toBe(state);
      f.stop();
      await expect(waiting).rejects.toMatchObject({ reason: 'STOP_REQUESTED' });
      expect(await f.actions()).toEqual(['open', 'upload']);
    }
    expect(f.saves()).toBe(0);
  });
}

for (const unmount of [false, true]) {
  test(`T2 a second selection signal before terminal blocks without retry; unmount=${unmount}`, async ({
    page,
  }) => {
    const f = await lifecycle(page);
    await f.driver.open('single');
    const input = await page.locator('input[type=file]').elementHandle();
    await f.driver.upload(coverInput('single').files);
    await input!.evaluate((node, unmount) => {
      (node as HTMLInputElement).value = '';
      if (unmount) node.remove();
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, unmount);
    await expect(f.driver.waitForUpload()).rejects.toMatchObject({
      reason: 'PAGE_CHANGED',
    });
    expect(await f.actions()).toEqual(['open', 'upload']);
    expect(f.saves()).toBe(0);
    await input?.dispose();
  });
}

test('T2 an unbound loading placeholder may rebuild before the first complete association', async ({
  page,
}) => {
  const f = await lifecycle(page);
  await f.driver.open('single');
  await f.driver.upload(coverInput('single').files);
  await review(page, true);
  const waiting = f.driver.waitForUpload();
  await expect.poll(() => f.diagnostics.at(-1)?.state).toBe('uploading');
  await page.locator('[role=dialog]').evaluate((modal) => {
    modal
      .querySelector('img')!
      .replaceWith(modal.querySelector('img')!.cloneNode(true));
    modal.querySelector('progress')!.remove();
  });
  expect(await waiting).toBe('complete');
  await f.driver.confirm();
  expect(await f.actions()).toEqual(['open', 'upload', 'confirm']);
  expect(f.saves()).toBe(0);
});

for (const fault of [
  'missing-evidence',
  'second-signal',
  'outer-layer',
  'unknown-control',
  'security',
  'stop',
] as const) {
  test(`T2 fileless transition cannot authorize effects after ${fault}`, async ({
    page,
  }) => {
    const f = await lifecycle(page, 0, {
      reserve: async (effect) => {
        if (effect === 'upload' && fault === 'missing-evidence')
          await page.locator('input[type=file]').evaluate((input) => {
            document.addEventListener(
              'input',
              (event) => {
                if (event.target !== input) return;
                const transfer = new DataTransfer();
                transfer.items.add(
                  new File(['wrong'], 'wrong.png', { type: 'image/png' }),
                );
                (input as HTMLInputElement).files = transfer.files;
              },
              { capture: true, once: true },
            );
          });
      },
      pause: async (stage) => {
        if (stage !== 'after-selection') return;
        await review(page, fault === 'stop');
        await page.locator('input[type=file]').evaluate((input, fault) => {
          (input as HTMLInputElement).value = '';
          input.remove();
          if (fault === 'second-signal')
            input.dispatchEvent(new Event('input'));
        }, fault);
        if (fault === 'outer-layer')
          await page
            .locator('.arco-modal-mask')
            .evaluate((mask) => mask.replaceWith(mask.cloneNode(true)));
        if (fault === 'unknown-control')
          await page
            .locator('[role=dialog]')
            .evaluate((modal) =>
              modal.insertAdjacentHTML(
                'beforeend',
                '<button>未知操作</button>',
              ),
            );
        if (fault === 'security')
          await page
            .locator('[role=dialog]')
            .evaluate((modal) =>
              modal.insertAdjacentHTML('beforeend', '<div>安全验证</div>'),
            );
        if (fault === 'stop') f.stop();
      },
    });
    expect(await f.upload(coverInput('single'), f.stopped)).toMatchObject({
      status: 'blocked',
      reason:
        fault === 'stop'
          ? 'STOP_REQUESTED'
          : fault === 'security'
            ? 'VERIFICATION_REQUIRED'
            : 'PAGE_CHANGED',
    });
    expect(await f.actions()).toEqual(['open', 'upload']);
    expect(f.saves()).toBe(0);
  });
}

test('T2 fileless dialog is not recognized without the verified selected-file modal proof', async ({
  page,
}) => {
  const f = await lifecycle(page);
  await f.driver.open('single');
  await page.locator('input[type=file]').evaluate((node) => node.remove());
  await expect(assertSafe(page, true)).rejects.toMatchObject({
    reason: 'PAGE_CHANGED',
  });
  await expect(f.driver.confirm()).rejects.toThrow();
  await expect(f.driver.cancel()).rejects.toThrow();
  expect(await f.actions()).toEqual(['open']);
  expect(f.saves()).toBe(0);
});

test('T2 modal closure cannot mask an independently observed pending upload for a fallback proof', async ({
  page,
}) => {
  const f = await lifecycle(page, 0, {
    reserve: async () => {},
    pause: async (stage) => {
      if (stage !== 'after-selection') return;
      await review(page);
      await page.locator('[role=dialog]').evaluate((modal) => {
        modal.insertAdjacentHTML(
          'beforeend',
          '<div role="alert">合成拒绝</div>',
        );
        modal.querySelector('#cancel')!.addEventListener('click', () => {
          (
            window as unknown as { fixtureUploadPending: boolean }
          ).fixtureUploadPending = true;
        });
      });
    },
  });
  expect(await f.upload(coverInput('single'), f.stopped)).toMatchObject({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(await f.actions()).toEqual(['open', 'upload', 'cancel']);
  expect(f.saves()).toBe(0);
});

test('T2 explicit rejection becomes recoverable only after clean cancellation readback', async ({
  page,
}) => {
  const f = await lifecycle(page, 0, {
    reserve: async () => {},
    pause: async (stage) => {
      if (stage !== 'after-selection') return;
      await review(page);
      await page
        .locator('[role=dialog]')
        .evaluate((modal) =>
          modal.insertAdjacentHTML(
            'beforeend',
            '<div role="alert">合成拒绝</div>',
          ),
        );
    },
  });
  expect(await f.upload(coverInput('single'), f.stopped)).toMatchObject({
    status: 'recoverable_failure',
    reason: 'UPLOAD_REJECTED',
    safeEditorProof: { modalClosed: true, uploadsSettled: true },
  });
  expect(await f.actions()).toEqual(['open', 'upload', 'cancel']);
  expect(f.saves()).toBe(0);
});

test('T2 the previously recognized completed fileless dialog does not require a retained picker', async ({
  page,
}) => {
  const f = await lifecycle(page, 0, {
    reserve: async () => {},
    pause: async (stage) => {
      if (stage !== 'after-selection') return;
      await review(page);
      await expect(page.locator('[role=dialog] img')).toHaveJSProperty(
        'complete',
        true,
      );
      await page
        .locator('input[type=file]')
        .evaluate((input) => input.remove());
      await page
        .getByRole('button', { name: '选择图片', exact: true })
        .evaluate((button) => button.remove());
    },
  });
  expect((await f.upload(coverInput('single'), f.stopped)).status).toBe(
    'completed',
  );
  expect(await f.actions()).toEqual(['open', 'upload', 'confirm']);
  expect(f.saves()).toBe(0);
});
