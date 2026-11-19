import { defaultUploadWaits } from '../../src/infrastructure/platforms/judongche/upload-waits';
import { test, expect } from '@playwright/test';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import type { ProbeDiagnostic } from '../../src/infrastructure/platforms/judongche/production-pages';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { draftHarness } from '../fixtures/draft-adapter';

for (const fault of [
  'none',
  'open',
  'file-control',
  'tail',
  'url',
  'document',
  'mount',
  'preview-error',
  'paragraph-replaced',
  'first-focus',
  'later-focus',
  'first-focus-content',
] as const) {
  test(`T1 production diagnostics retain operation stage and exclude private content: ${fault}`, async ({
    context,
    page,
  }) => {
    if (fault === 'open') page.setDefaultTimeout(1000);
    await denyExternalNetwork(context);
    const fixture = await installProductionFixture(context, {
      observedTrailingParagraphs: true,
      changedImageCaret: fault === 'tail',
    });
    await page.goto(fixture.home);
    const events: ProbeDiagnostic[] = [];
    const pages = createJudongchePages(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture',
        close: async () => {},
      },
      (event) => events.push(event),
      {
        manualReview: true,
        ...(fault === 'preview-error'
          ? { uploadWaits: { ...defaultUploadWaits, preview: 800 } }
          : {}),
        ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
      },
    );
    expect((await pages.probe()).status).toBe('ready');
    if (fault === 'mount')
      await context.route('**/jdc/dealer/info/Article', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><div contenteditable="true"><p><br class="ProseMirror-trailingBreak"></p></div>',
        }),
      );
    if (fault === 'mount') {
      await expect(
        pages.enterNewEditor('private title', () => false, 'fixture-task'),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(events.find((e) => e.failure)).toMatchObject({
        operation: 'enterNewEditor',
        phase: 'editor-entry-title-mount',
        exceptionCategory: 'timeout',
        editorMount: {
          titleFirstVisibleMs: null,
          bodyFirstVisibleMs: expect.any(Number),
          controls: { visibleBodies: 1, visibleTextareas: 0 },
        },
      });
      expect(fixture.saves()).toBe(0);
      expect(JSON.stringify(events)).not.toMatch(
        /private|https:|assetKey|bytes|stack|TimeoutError/,
      );
      return;
    }
    await pages.enterNewEditor('private title', () => false, 'fixture-task');
    if (
      fault === 'first-focus' ||
      fault === 'first-focus-content' ||
      fault === 'later-focus'
    ) {
      await pages.fillTitle('private title');
      if (fault === 'later-focus') await pages.appendParagraph('earlier text');
      await page.locator('#body').evaluate((el, addContent) => {
        el.addEventListener(
          'click',
          () => {
            if (addContent) el.firstElementChild!.textContent = 'existing text';
            document.querySelector('textarea')!.focus();
          },
          { once: true },
        );
      }, fault === 'first-focus-content');
      if (fault === 'first-focus' || fault === 'later-focus') {
        await pages.appendParagraph('private first');
        const paragraphs = page.locator('#body > p');
        await expect(paragraphs).toHaveText(
          fault === 'later-focus'
            ? ['earlier text', 'private first', '']
            : ['private first', ''],
        );
        expect(
          events.filter((e) => e.check === 'paragraph-write-observed').at(-1)
            ?.paragraphWrite?.samples,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ stage: 'after-focus-restore' }),
          ]),
        );
      } else {
        await expect(
          pages.appendParagraph('private first'),
        ).rejects.toMatchObject({ check: 'paragraph-target-changed' });
        await expect(page.locator('#body')).toHaveText('existing text');
      }
      return;
    }
    if (fault === 'paragraph-replaced') {
      await pages.fillTitle('private title');
      await pages.appendParagraph('private first');
      const completed = events.find(
        (e) => e.check === 'paragraph-write-observed',
      );
      expect(completed?.paragraphWrite?.samples).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: 'after-click' }),
          expect.objectContaining({
            stage: 'after-paste',
            result: {
              result: 'ok',
              sample: expect.objectContaining({ matchesExpected: true }),
            },
          }),
        ]),
      );
      // Replace the paragraph once the text exists, before the post-paste guard.
      await page.locator('#body').evaluate((root) => {
        const tail = root.lastElementChild!;
        root.addEventListener(
          'input',
          () => {
            tail.replaceWith(tail.cloneNode(true));
          },
          { once: true },
        );
      });
      await expect(
        pages.appendParagraph('private second'),
      ).rejects.toMatchObject({ check: 'paragraph-target-changed' });
      const failed = events.find((e) => e.failure)?.paragraphWrite;
      expect(failed?.stage).toBe('after-paste');
      expect(failed?.samples.at(-1)?.result.sample).toMatchObject({
        sameTarget: false,
        targetConnected: false,
        matchesExpected: true,
      });
      expect(JSON.stringify(events)).not.toContain('private');
      expect(fixture.saves()).toBe(0);
      return;
    }
    if (fault === 'url')
      await page.evaluate(() =>
        history.replaceState({}, '', '/private-location'),
      );
    if (fault === 'document') await page.reload();
    if (fault === 'url' || fault === 'document') {
      await expect(pages.fillTitle('private title')).rejects.toMatchObject({
        reason: 'PAGE_CHANGED',
      });
      expect(events.find((e) => e.failure)).toMatchObject({
        operation: 'fillTitle',
        phase: fault === 'url' ? 'guard-safety' : 'guard-document-version',
        check:
          fault === 'url'
            ? 'url-not-allowed'
            : 'guard-document-version-changed',
      });
    } else {
      if (fault === 'open')
        await page
          .locator('.syl-toolbar-tool.image button')
          .evaluate((e) => ((e as HTMLButtonElement).disabled = true));
      if (fault === 'file-control')
        await page
          .locator('.syl-toolbar-tool.image button')
          .evaluate((e) => ((e as HTMLElement).onclick = () => {}));
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
        'base64',
      );
      if (fault === 'preview-error') {
        await page.route('**/fixture/image?*', (route) =>
          route.fulfill({ status: 404, body: '' }),
        );
        await expect(pages.appendImage(png, 'image/png')).rejects.toBeDefined();
        const errors = events.filter((e) => e.check === 'preview-image-error');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          imageIndex: 1,
          previewErrorAt: expect.any(Number),
        });
        expect(fixture.saves()).toBe(0);
        return;
      }
      if (fault === 'none') {
        // The first dialog renders the same native button with a child label.
        await page.evaluate(() => {
          const observer = new MutationObserver(() => {
            const button = document.querySelector('[role=dialog] button');
            if (button?.textContent !== '确定') return;
            observer.disconnect();
            const span = document.createElement('span');
            span.textContent = '确定';
            button.replaceChildren(span);
          });
          observer.observe(document.body, { subtree: true, childList: true });
        });
        await pages.appendImage(png, 'image/png');
        await pages.appendImage(png, 'image/png');
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
        const imageEvents = events.filter((e) => e.bodyImage);
        expect(imageEvents.every((e) => e.operation === 'appendImage')).toBe(
          true,
        );
        const imageIndices = imageEvents.map((e) => e.bodyImage!.index);
        expect([...new Set(imageIndices)]).toEqual([1, 2]);
        expect(imageIndices).toEqual([...imageIndices].sort());
        for (const index of [1, 2]) {
          const perImage = imageEvents.filter(
            (e) => e.bodyImage!.index === index,
          );
          expect(
            perImage
              .filter((e) => e.check === 'body-image-stage')
              .map((e) => [e.bodyImage!.stage, e.bodyImage!.status]),
          ).toEqual(
            stages.flatMap((stage) =>
              // Open completes in the history only after file-control ownership
              // is proven; it must not be completed merely by clicking the tool.
              stage === 'open'
                ? [[stage, 'waiting']]
                : [
                    [stage, 'waiting'],
                    [stage, 'completed'],
                  ],
            ),
          );
          const diagnostic = perImage.at(-1)!.bodyImage!;
          expect(diagnostic.confirmButton).toMatchObject({
            matches: 1,
            nestedLabel: index === 1,
          });
          expect(diagnostic.confirmTrace?.map((step) => step.step)).toEqual([
            'check-dialog',
            'check-library',
            'wait-button',
            'button-bound',
            'recheck-preview',
            'click-started',
            'click-returned',
            'dialog-closed',
          ]);
          for (const stage of stages) {
            const waiting = perImage.find(
              (e) =>
                e.check === 'body-image-stage' &&
                e.bodyImage!.stage === stage &&
                e.bodyImage!.status === 'waiting',
            )!.bodyImage!;
            const completed = perImage
              .flatMap((e) => e.bodyImage!.stages)
              .find(
                (entry) =>
                  entry.stage === stage && entry.status === 'completed',
              );
            expect(completed).toMatchObject({
              stageStartedAt: waiting.stageStartedAt,
              stageElapsedMs: expect.any(Number),
            });
            expect(completed!.stageElapsedMs).toBeGreaterThanOrEqual(0);
          }
          expect(perImage.at(-1)!.bodyImage).toMatchObject({
            index,
            stage: 'readback',
            status: 'completed',
            fileSelectionCount: 1,
            confirmationCount: 1,
            stages: stages.map((stage) => ({ stage, status: 'completed' })),
          });
        }
        expect(events.some((e) => e.failure)).toBe(false);
      } else {
        await expect(pages.appendImage(png, 'image/png')).rejects.toBeDefined();
        expect(events.find((e) => e.failure)).toMatchObject({
          operation: 'appendImage',
          bodyImage: {
            index: 1,
            stage: fault === 'tail' ? 'tail-finalization' : fault,
            status: 'failed',
          },
        });
      }
    }
    expect(fixture.saves()).toBe(0);
    expect(JSON.stringify(events)).not.toMatch(
      /private|https:|assetKey|bytes|stack|TimeoutError/,
    );
  });
}

test('T1 adapter internal mismatch reaches the production first-error sink without content or a save', async ({
  context,
  page,
}) => {
  await denyExternalNetwork(context);
  const fixture = await installProductionFixture(context, {
    observedTrailingParagraphs: true,
  });
  await page.goto(fixture.home);
  const events: ProbeDiagnostic[] = [];
  const session = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture',
    close: async () => {},
  };
  const pages = createJudongchePages(session, (event) => events.push(event), {
    manualReview: true,
    ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
  });
  const h = draftHarness();
  const probe = await pages.probe();
  expect(probe.status).toBe('ready');
  if (probe.status !== 'ready') return;
  h.task.store = probe.store;
  h.task.snapshot.article.body = [
    { type: 'paragraph', text: 'private article body' },
  ];
  h.task.snapshot.article.assets = [];
  h.durable().snapshot = structuredClone(h.task.snapshot);
  h.durable().store = structuredClone(h.task.store);
  const append = pages.appendParagraph;
  let titleChanged = false;
  pages.appendParagraph = async (text) => {
    await append(text);
    // Exercise the production operation identity reader after a real DOM edit.
    await page.locator('textarea:visible').fill('private changed title');
    titleChanged = true;
  };
  expect(
    await createAdapterWithPages(session, pages).execute(h.task, h.hooks),
  ).toEqual({ status: 'blocked', reason: 'CONTENT_MISMATCH' });
  expect(titleChanged).toBe(true);
  await expect(page.locator('textarea:visible')).toHaveValue(
    'private changed title',
  );
  expect(events.filter((e) => e.failure)).toEqual([
    expect.objectContaining({
      operation: 'adapterValidation',
      phase: 'adapter-content-validation',
      reason: 'CONTENT_MISMATCH',
      exceptionCategory: 'platform-guard',
    }),
  ]);
  expect(fixture.saves()).toBe(0);
  expect(JSON.stringify(events)).not.toMatch(
    /private|https:|assetKey|bytes|stack/,
  );
});

test('business session becomes ready while a home image is still loading', async ({
  context,
  page,
}) => {
  await denyExternalNetwork(context);
  const fixture = await installProductionFixture(context);
  const pendingImage = new URL('/fixture/pending-home-image', fixture.home)
    .href;
  await context.route(fixture.home, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<main>首页</main><img src="/fixture/pending-home-image">',
    }),
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route(pendingImage, async (route) => {
    await pending;
    await route.abort().catch(() => {});
  });
  page.setDefaultNavigationTimeout(2500);
  const pages = createJudongchePages(
    {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture',
      close: async () => {},
    },
    undefined,
    {
      manualReview: true,
      ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
    },
  );
  try {
    expect((await pages.probe()).status).toBe('ready');
    expect(await page.evaluate(() => document.readyState)).toBe('interactive');
  } finally {
    release();
  }
});
