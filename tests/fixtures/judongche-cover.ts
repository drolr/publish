import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  createLocalCoverUploader,
  type CoverPageDriver,
  type CoverUploadInput,
} from '../../src/infrastructure/platforms/judongche/cover-pages';
import { JudongchePageError } from '../../src/infrastructure/platforms/judongche/production-state';
import { unknownEditorEvidence } from '../../src/infrastructure/platforms/judongche/content-evidence';

export type SyntheticCoverOptions = {
  partial?: boolean;
  rejected?: boolean;
  unreadable?: boolean;
  disabled?: boolean;
  unchecked?: boolean;
  late?: boolean;
  modalStays?: boolean;
  drift?: 'generation' | 'context' | 'store' | 'body' | 'title';
};
// Every DOM selector and positive/negative state below is SYNTHETIC. Never wired
// into createJudongchePages, never a production contract or G1 evidence.
export async function installCoverFixture(
  page: Page,
  options: SyntheticCoverOptions = {},
) {
  const html = (
    await readFile('tests/fixtures/judongche-pages/cover-upload.html', 'utf8')
  ).replace(/\/\*OPTIONS\*\/\s*\{\}/, JSON.stringify(options));
  await page.route('https://cover-fixture.invalid/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto('https://cover-fixture.invalid/editor');
  const reads: string[] = [];
  const driver: CoverPageDriver = {
    async guard() {
      if ((await page.locator('#synthetic-editor').count()) !== 1)
        throw new JudongchePageError('PAGE_CHANGED');
    },
    async inspect() {
      const data = await page.evaluate(() => {
        const w = window as unknown as {
          coverItems: unknown[];
          coverMode: 'single' | 'triple' | null;
          uploadResult: 'complete' | 'incomplete' | 'rejected' | null;
        };
        const e = document.querySelector<HTMLElement>('#synthetic-editor')!;
        const library = document.querySelector<HTMLInputElement>('#library');
        return {
          generation: e.dataset.generation!,
          context: e.dataset.context!,
          store: e.dataset.store!,
          settlement: e.dataset.settlement as 'pending' | 'settled' | 'unknown',
          title: document.querySelector<HTMLTextAreaElement>('#title')!.value,
          body: document.querySelector('#body p')!.textContent!,
          modal: document.querySelector<HTMLElement>('#cover-modal')!.hidden
            ? ('closed' as const)
            : ('owned' as const),
          libraryChecked: library?.checked ?? null,
          items: w.coverItems,
          mode: w.coverMode,
          result: w.uploadResult,
        };
      });
      reads.push('read:' + data.libraryChecked);
      return {
        generation: data.generation,
        editor: {
          ...unknownEditorEvidence(),
          known: true,
          store: {
            storeKey: createHash('sha256').update(data.store).digest('hex'),
            displayName: '合成门店',
            identity: { source: 'visible-shop-link', value: data.store },
          },
          contextKey: data.context,
          editorUrl: page.url(),
          title: data.title,
          blocks: [{ type: 'paragraph', text: data.body }],
          pendingUploads: data.settlement !== 'settled',
        },
        modal: data.modal,
        settlement: data.settlement,
        mode: data.mode,
        result: data.result,
        libraryChecked: data.libraryChecked,
        items: data.items as Awaited<
          ReturnType<CoverPageDriver['inspect']>
        >['items'],
      };
    },
    async open(mode) {
      await page
        .getByRole('radio', {
          name: mode === 'single' ? '合成单图' : '合成三图',
        })
        .check();
      await page.locator('#open').click();
    },
    async upload(files) {
      await page.locator('#cover-input').setInputFiles(
        files.map((f) => ({
          name: f.assetKey + (f.mime === 'image/png' ? '.png' : '.jpg'),
          mimeType: f.mime,
          buffer: Buffer.from(f.bytes),
        })),
      );
    },
    async waitForUpload() {
      await page.waitForFunction(
        () =>
          (window as unknown as { uploadResult: unknown }).uploadResult !==
          null,
        {},
        { timeout: 3000 },
      );
    },
    async uncheckLibrary() {
      if (await page.locator('#library').isEnabled())
        await page.locator('#library').uncheck();
    },
    async confirm() {
      reads.push('confirm');
      await page.locator('#confirm').click();
    },
    async cancel() {
      await page.locator('#cancel').click();
    },
  };
  const upload = createLocalCoverUploader(driver);
  return {
    driver,
    localCoverUpload: 'supported' as const,
    uploadLocalCover: upload,
    upload,
    reads,
    actions: () =>
      page.evaluate(() => (window as unknown as { actions: string[] }).actions),
  };
}
export function coverInput(
  mode: 'single' | 'triple',
  sameBytes = false,
): CoverUploadInput {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
    'base64',
  );
  return {
    mode,
    files: Array.from({ length: mode === 'single' ? 1 : 3 }, (_, position) => {
      const bytes = Buffer.concat([
        png,
        Buffer.from(sameBytes ? 'same' : String(2 - position)),
      ]);
      return {
        position,
        assetKey: '00000000-0000-4000-8000-00000000000' + (2 - position),
        mime: 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
      };
    }),
  };
}
