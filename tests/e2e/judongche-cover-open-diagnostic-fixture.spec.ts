import { defaultUploadWaits } from '../../src/infrastructure/platforms/judongche/upload-waits';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import type { ProbeDiagnostic } from '../../src/infrastructure/platforms/judongche/production-pages';
import { coverInput } from '../fixtures/judongche-cover';
import { denyExternalNetwork } from './network-policy';

for (const fault of ['slot-click', 'modal-visible', 'late-picker'] as const) {
  for (const sinkThrows of fault === 'late-picker' ? [false] : [false, true]) {
    test(`cover open identifies ${fault} timeout without another effect; sink throws=${sinkThrows}`, async ({
      page,
      context,
    }) => {
      await denyExternalNetwork(context);
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
      let saveRequests = 0;
      page.on('request', (request) => {
        if (request.url().endsWith('/article/create')) saveRequests++;
      });
      await page.route('https://www.autoengine.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.goto('https://www.autoengine.com/jdc/dealer/info/Article');
      const diagnostics: ProbeDiagnostic[] = [];
      const pages = createJudongchePages(
        {
          current: () => context,
          generation: () => 'open-diagnostic-generation',
          open: async () => context,
          close: async () => {},
        },
        (event) => {
          diagnostics.push(event);
          if (sinkThrows) throw new Error('private diagnostic sink failure');
        },
        {
          manualReview: true,
          ...(fault === 'late-picker'
            ? { uploadWaits: { ...defaultUploadWaits, imageAction: 350 } }
            : {}),
          ownerConfirmedPilot: { dealerId: '123', storeName: 'fixture' },
        },
      );
      expect((await pages.probe()).status).toBe('ready');
      await pages.enterNewEditor(
        'private diagnostic title',
        () => false,
        'open-diagnostic-task',
      );
      await pages.fillTitle('private diagnostic title');
      await page
        .locator('[contenteditable]')
        .evaluate((element) => (element.innerHTML = '<p>private body</p>'));
      await page.locator('.article-cover-add').evaluate((element, failure) => {
        if (failure === 'slot-click')
          (element as HTMLElement).style.pointerEvents = 'none';
        else if (failure === 'late-picker') {
          const slot = element as HTMLElement;
          const open = slot.onclick!;
          slot.onclick = (event) => {
            setTimeout(() => open.call(slot, event), 850);
          };
        } else
          (element as HTMLElement).onclick = () => {
            (window as unknown as { actions: string[] }).actions.push('open');
          };
      }, fault);
      expect(
        await pages.uploadLocalCover!(coverInput('single'), () => false),
      ).toEqual({ status: 'blocked', reason: 'PAGE_CHANGED' });
      const failures = diagnostics.filter((event) => event.failure);
      expect(failures).toHaveLength(1);
      const firstFailure = failures[0]!;
      expect(firstFailure).toMatchObject({
        operation: 'uploadLocalCover',
        phase: 'local-cover:open',
        exceptionCategory: 'timeout',
        check: 'page-operation-failed',
      });
      expect(diagnostics.find((e) => e.coverClick)?.coverClick).toMatchObject({
        taskId: 'open-diagnostic-task',
        checkpoint: 'open-failed',
        clickReceived: fault !== 'slot-click',
        pickerVisible: false,
        clickToPickerMs: null,
      });
      const boundaries = firstFailure.coverOpen!;
      expect(boundaries).toEqual(expect.any(Array));
      expect(boundaries.at(-1)).toMatchObject({
        phase: fault === 'late-picker' ? 'modal-visible' : fault,
        status: 'failed',
        exceptionCategory: 'timeout',
      });
      expect(boundaries.at(-2)).toMatchObject({
        phase: fault === 'late-picker' ? 'modal-visible' : fault,
        status: 'start',
      });
      expect(
        boundaries.some((event) => event.phase === 'modal-structure'),
      ).toBe(false);
      expect(
        boundaries.some(
          (event) =>
            event.phase === 'slot-click' && event.status === 'returned',
        ),
      ).toBe(fault !== 'slot-click');
      for (let index = 0; index < boundaries.length; index++) {
        expect(boundaries[index]!.elapsedMs).toBeGreaterThanOrEqual(
          index === 0 ? 0 : boundaries[index - 1]!.elapsedMs,
        );
      }
      if (fault === 'late-picker') {
        await expect
          .poll(
            () =>
              diagnostics.find((e) => e.coverClick?.checkpoint === 'follow-up')
                ?.coverClick,
            { timeout: 8000 },
          )
          .toMatchObject({
            clickReceived: true,
            pickerVisible: true,
            taskId: 'open-diagnostic-task',
            interrupted: false,
          });
        expect(
          diagnostics.find((e) => e.coverClick?.checkpoint === 'follow-up')
            ?.coverClick?.clickToPickerMs,
        ).toBeGreaterThanOrEqual(800);
      }
      const serializedFailure = JSON.stringify(firstFailure);
      expect(JSON.stringify(diagnostics)).not.toMatch(
        /private|https:\/\/|assetKey|bytes|TimeoutError|stack/,
      );
      const actions = () =>
        page.evaluate(
          () => (window as unknown as { actions: string[] }).actions,
        );
      expect(await actions()).toEqual(fault === 'slot-click' ? [] : ['open']);
      expect(saveRequests).toBe(0);
      // The existing single-use driver still refuses another open/upload.
      expect(
        await pages.uploadLocalCover!(coverInput('single'), () => false),
      ).toEqual({ status: 'blocked', reason: 'PAGE_CHANGED' });
      expect(await actions()).toEqual(fault === 'slot-click' ? [] : ['open']);
      expect(saveRequests).toBe(0);
      expect(JSON.stringify(firstFailure)).toBe(serializedFailure);
    });
  }
}
