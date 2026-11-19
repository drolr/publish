import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { installProductionFixture } from '../fixtures/judongche-production';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import { denyExternalNetwork } from './network-policy';

async function editor(
  context: BrowserContext,
  page: Page,
  restoration?: NonNullable<
    Parameters<typeof installProductionFixture>[1]
  >['restoration'],
  observedTrailingParagraphs = false,
) {
  await denyExternalNetwork(context);
  const fixture = await installProductionFixture(context, {
    singleCoverUpload: true,
    restoration,
    observedTrailingParagraphs,
  });
  await page.goto(fixture.home);
  let generation = 'entry-generation';
  const pages = createJudongchePages(
    {
      open: async () => context,
      current: () => context,
      generation: () => generation,
      close: async () => {},
    },
    undefined,
    {
      manualReview: true,
      batchSubmissionReview: 'operator',
      ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
    },
  );
  expect((await pages.probe()).status).toBe('ready');
  return {
    pages,
    fixture,
    changeGeneration: () => {
      generation = 'new-entry-generation';
    },
  };
}

for (const ending of ['write', 'stop', 'failure', 'generation'] as const) {
  test(`entry observation releases page listeners on ${ending}`, async ({
    context,
    page,
  }) => {
    const { pages, changeGeneration } = await editor(context, page);
    const listeners = new Map<string, Set<unknown>>();
    const on = page.on.bind(page),
      off = page.off.bind(page);
    page.on = new Proxy(on, {
      apply(target, receiver, args) {
        const event = String(args[0]);
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(args[1]);
        return Reflect.apply(target, receiver, args);
      },
    });
    page.off = new Proxy(off, {
      apply(target, receiver, args) {
        listeners.get(String(args[0]))?.delete(args[1]);
        return Reflect.apply(target, receiver, args);
      },
    });
    const counts = () =>
      ['request', 'requestfinished', 'requestfailed', 'close'].map(
        (event) => listeners.get(event)?.size ?? 0,
      );
    const before = counts();
    let stopping = false;
    await pages.enterNewEditor('current article', () => stopping, randomUUID());
    expect(counts()).toEqual(before.map((count) => count + 1));
    if (ending === 'write') {
      await pages.fillTitle('current article');
      let entryReads = 0;
      let operationImageReads = 0;
      const evaluate = page.evaluate.bind(page);
      page.evaluate = new Proxy(evaluate, {
        apply(target, receiver, args) {
          if (
            args[1] &&
            typeof args[1] === 'object' &&
            'emptyPlaceholder' in args[1]
          ) {
            if (args[1].imageOnly === false) entryReads++;
            if (args[1].imageOnly === 'all' || args[1].imageOnly === true)
              operationImageReads++;
          }
          return Reflect.apply(target, receiver, args);
        },
      });
      await pages.checkWritingContext!(() => false);
      await pages.appendParagraph('first paragraph');
      await pages.appendParagraph('second paragraph');
      expect(entryReads).toBe(0);
      expect(operationImageReads).toBeGreaterThan(0);
      page.evaluate = evaluate;
    } else {
      if (ending === 'stop') stopping = true;
      if (ending === 'generation') changeGeneration();
      if (ending === 'failure')
        await page.evaluate(() => {
          document.querySelector('#save')!.classList.add('arco-btn-loading');
        });
      await expect(pages.fillTitle('current article')).rejects.toBeTruthy();
    }
    expect(counts()).toEqual(before);
    page.on = on;
    page.off = off;
  });
}

for (const batch of [false, true]) {
  test(`operator writes the selected article with a recovery banner: batch=${batch}`, async ({
    context,
    page,
  }) => {
    const { pages, fixture } = await editor(context, page, { delay: 0 });
    await pages.enterNewEditor(
      'current article',
      () => false,
      randomUUID(),
      batch,
    );
    await expect(page.locator('.publish-message-opr')).toBeVisible();
    await pages.fillTitle('current article');
    await pages.appendParagraph('current first paragraph');
    await expect(page.locator('textarea')).toHaveValue('current article');
    await expect(page.locator('#body')).toHaveText('current first paragraph');
    expect(fixture.undoes()).toBe(0);
    expect(fixture.editorEntries()).toBe(1);
    expect(fixture.saves()).toBe(0);
  });
}

for (const activity of [
  'dialog',
  'cover-pending',
  'save-busy',
  'save-missing',
  'save-duplicate',
  'security',
  'url',
] as const) {
  test(`entry rejects active or unconfirmed state without undo: ${activity}`, async ({
    context,
    page,
  }) => {
    const { pages, fixture } = await editor(context, page, { delay: 0 });
    await context.addInitScript(
      ({ activity }) => {
        document.addEventListener('DOMContentLoaded', () => {
          if (!location.pathname.endsWith('/Article')) return;
          if (activity === 'dialog' || activity === 'security') {
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.textContent =
              activity === 'security' ? '安全验证' : '上传图片';
            document.body.append(dialog);
          }
          if (activity === 'cover-pending')
            document.querySelector('.article-cover-images')!.innerHTML =
              '<progress></progress>';
          if (activity === 'save-busy')
            document.querySelector('#save')!.classList.add('arco-btn-loading');
          if (activity === 'save-missing')
            document.querySelector('#save')!.remove();
          if (activity === 'save-duplicate')
            document
              .querySelector('#save')!
              .after(document.querySelector('#save')!.cloneNode(true));
          if (activity === 'url')
            history.replaceState(null, '', location.pathname + '?pgc_id=501');
        });
      },
      { activity },
    );
    await expect(
      pages.enterNewEditor('current article', () => false, randomUUID(), true),
    ).rejects.toMatchObject({
      reason: activity.startsWith('save-')
        ? 'RESULT_AMBIGUOUS'
        : activity === 'security'
          ? 'VERIFICATION_REQUIRED'
          : 'PAGE_CHANGED',
    });
    expect(fixture.undoes()).toBe(0);
    expect(fixture.saves()).toBe(0);
  });
}

for (const boundary of [
  'navigation',
  'first-write',
  'last-busy-read',
] as const) {
  test(`observed create remains owned through ${boundary}`, async ({
    context,
    page,
  }) => {
    const { pages, fixture } = await editor(
      context,
      page,
      boundary === 'first-write' ? undefined : { delay: 0 },
    );
    let pending: Route | undefined;
    await context.route(
      '**/motor/dealer_admin/go_api/article/create',
      (route) => {
        pending = route;
      },
    );
    const create = async () => {
      const request = page.waitForRequest((r) =>
        r.url().endsWith('/article/create'),
      );
      await page.evaluate(() => {
        void fetch('/motor/dealer_admin/go_api/article/create', {
          method: 'POST',
        });
      });
      await request;
    };
    if (boundary === 'navigation')
      await context.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          if (location.pathname.endsWith('/Article'))
            void fetch('/motor/dealer_admin/go_api/article/create', {
              method: 'POST',
            });
        });
      });
    const getByRole = page.getByRole.bind(page);
    let injected = false;
    if (boundary === 'last-busy-read')
      page.getByRole = new Proxy(getByRole, {
        apply(target, receiver, args: Parameters<Page['getByRole']>) {
          const locator = Reflect.apply(target, receiver, args) as ReturnType<
            Page['getByRole']
          >;
          if (args[1]?.name === '存草稿') {
            const evaluateAll = locator.evaluateAll.bind(locator);
            locator.evaluateAll = new Proxy(evaluateAll, {
              async apply(read, readReceiver, readArgs) {
                const result = await Reflect.apply(
                  read,
                  readReceiver,
                  readArgs,
                );
                if (!injected) {
                  injected = true;
                  await create();
                }
                return result;
              },
            });
          }
          return locator;
        },
      });
    try {
      if (boundary === 'first-write') {
        await pages.enterNewEditor(
          'current article',
          () => false,
          randomUUID(),
        );
        await create();
        await expect(pages.fillTitle('current article')).rejects.toMatchObject({
          reason: 'RESULT_AMBIGUOUS',
        });
      } else
        await expect(
          pages.enterNewEditor('current article', () => false, randomUUID()),
        ).rejects.toMatchObject({ reason: 'RESULT_AMBIGUOUS' });
      expect(fixture.undoes()).toBe(0);
      expect(fixture.saves()).toBe(0);
      expect(await page.locator('textarea').inputValue()).not.toBe(
        'current article',
      );
    } finally {
      page.getByRole = getByRole;
      await pending?.fulfill({ json: { status: 0 } }).catch(() => {});
    }
  });
}
