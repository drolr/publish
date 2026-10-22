import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDraftHarness } from '../fixtures/draft-harness';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createDraftController } from '../../src/application/draft-controller';
import { createBatchController } from '../../src/application/batch-controller';
import { createJudongcheAdapter } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';

async function operatorEditor(context: BrowserContext, page: Page) {
  await denyExternalNetwork(context);
  const fixture = await installProductionFixture(context);
  await page.goto(fixture.home);
  const pages = createJudongchePages(
    {
      open: async () => context,
      current: () => context,
      generation: () => 'fixture-generation',
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
  return { pages, fixture };
}

function interceptFinalRead(
  page: Page,
  boundary: 'safety' | 'busy',
  afterRead: () => Promise<void>,
) {
  const evaluate = page.evaluate.bind(page);
  const getByRole = page.getByRole.bind(page);
  let busyReads = 0;
  let intercepted = false;
  const intercept = (work: Promise<unknown>) =>
    work.then(async (value) => {
      if (!intercepted) {
        intercepted = true;
        await afterRead();
      }
      return value;
    });
  // Preserve real browser results; delay/inject only at the awaited API boundary.
  if (boundary === 'safety')
    page.evaluate = new Proxy(evaluate, {
      apply(target, receiver, args) {
        return intercept(
          Reflect.apply(target, receiver, args) as Promise<unknown>,
        );
      },
    });
  else
    page.getByRole = new Proxy(getByRole, {
      apply(target, receiver, args: Parameters<Page['getByRole']>) {
        const locator = Reflect.apply(target, receiver, args) as ReturnType<
          Page['getByRole']
        >;
        if (args[0] === 'button' && args[1]?.name === '存草稿') {
          const evaluateAll = locator.evaluateAll.bind(locator);
          locator.evaluateAll = new Proxy(evaluateAll, {
            apply(read, readReceiver, readArgs) {
              const work = Reflect.apply(
                read,
                readReceiver,
                readArgs,
              ) as Promise<unknown>;
              return ++busyReads === 2 ? intercept(work) : work;
            },
          });
        }
        return locator;
      },
    });
  return () => {
    page.evaluate = evaluate;
    page.getByRole = getByRole;
  };
}

for (const boundary of ['safety', 'busy'] as const) {
  for (const status of [401, 403] as const) {
    test(`final read cannot conceal known access failure: ${boundary} ${status}`, async ({
      context,
      page,
    }) => {
      const { pages } = await operatorEditor(context, page);
      await pages.enterNewEditor(
        'final access failure',
        () => false,
        randomUUID(),
        true,
      );
      await pages.fillTitle('final access failure');
      await pages.appendParagraph('body');
      await pages.inspectEditor();
      let explicitSaves = 0;
      await context.route(
        '**/motor/dealer_admin/go_api/article/create',
        async (route) => {
          const own =
            route.request().postDataJSON().title === 'final access failure';
          if (own) explicitSaves++;
          await route.fulfill({
            status: own ? 200 : status,
            json: { status: 0 },
          });
        },
      );
      const evaluate = page.evaluate.bind(page);
      const restore = interceptFinalRead(page, boundary, async () => {
        await evaluate(async () => {
          await (
            await fetch('/motor/dealer_admin/go_api/article/create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: 'fixture late access' }),
            })
          ).text();
        });
      });
      try {
        await expect(
          pages.saveForOperatorReview!(() => false),
        ).rejects.toMatchObject({
          reason: status === 401 ? 'LOGIN_REQUIRED' : 'PERMISSION_DENIED',
        });
        expect(explicitSaves).toBe(1);
        expect(new URL(page.url()).pathname).toBe('/jdc/dealer/info/Article');
      } finally {
        restore();
      }
    });
  }
}

for (const fault of ['deadline', 'stop'] as const) {
  test(
    'final browser read remains bounded by ' + fault,
    async ({ context, page }) => {
      const { pages, fixture } = await operatorEditor(context, page);
      await pages.enterNewEditor(
        'bounded final read',
        () => false,
        randomUUID(),
        true,
      );
      await pages.fillTitle('bounded final read');
      await pages.appendParagraph('body');
      await pages.inspectEditor();
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const restore = interceptFinalRead(page, 'safety', async () => {
        entered();
        await blocked;
      });
      let stopped = false;
      let outcome: unknown;
      const saving = pages.saveForOperatorReview!(() => stopped).then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      try {
        await started;
        if (fault === 'stop') stopped = true;
        await expect
          .poll(() => outcome, { timeout: fault === 'stop' ? 1500 : 14000 })
          .toMatchObject({
            reason: fault === 'stop' ? 'STOP_REQUESTED' : 'RESULT_AMBIGUOUS',
          });
        expect(fixture.saves()).toBe(1);
        expect(new URL(page.url()).pathname).toBe('/jdc/dealer/info/Article');
        await expect(pages.saveOnce()).rejects.toMatchObject({
          reason: 'RESULT_AMBIGUOUS',
        });
      } finally {
        restore();
        release();
        await saving;
      }
    },
  );
}

for (const observation of [
  'acknowledged',
  'rejected',
  'unknown',
  'pending',
] as const) {
  test(
    'operator settle clock starts after delayed save click: ' + observation,
    async ({ context, page }) => {
      const { pages } = await operatorEditor(context, page);
      await pages.enterNewEditor(
        'delayed save',
        () => false,
        randomUUID(),
        true,
      );
      await pages.fillTitle('delayed save');
      await pages.appendParagraph('body');
      expect((await pages.inspectEditor()).known).toBe(true);
      let requests = 0;
      let clickedAt = 0;
      await context.route(
        '**/motor/dealer_admin/go_api/article/create',
        async (route) => {
          requests++;
          clickedAt = Date.now();
          if (observation === 'pending') return;
          await route.fulfill({
            json:
              observation === 'unknown'
                ? {}
                : { status: observation === 'rejected' ? 5000 : 0 },
          });
        },
      );
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('#save')!;
        button.disabled = true;
        setTimeout(() => {
          button.disabled = false;
        }, 4000);
      });
      const saving = pages.saveForOperatorReview!(() => false);
      if (observation === 'pending') {
        await expect(saving).rejects.toMatchObject({
          reason: 'RESULT_AMBIGUOUS',
        });
        expect(Date.now() - clickedAt).toBeGreaterThanOrEqual(15000);
        expect(new URL(page.url()).pathname).toBe('/jdc/dealer/info/Article');
      } else {
        const result = await saving;
        expect(result.observation).toBe(observation);
        await pages.returnHomeAfterSubmission!(() => false);
        expect(Date.now() - clickedAt).toBeGreaterThanOrEqual(3000);
        expect(Date.parse(result.attemptedAt)).toBeLessThan(clickedAt - 3500);
      }
      await expect(pages.saveOnce()).rejects.toMatchObject({
        reason: 'RESULT_AMBIGUOUS',
      });
      expect(requests).toBe(1);
    },
  );
}

for (const kind of ['title', 'body', 'image', 'cover'] as const) {
  test(
    'operator blocks delayed restored old ' + kind + ' before writing',
    async ({ context, page }) => {
      const { pages, fixture } = await operatorEditor(context, page);
      await context.addInitScript(
        ({ kind }) => {
          if (!location.pathname.endsWith('/Article')) return;
          document.addEventListener('DOMContentLoaded', () =>
            setTimeout(() => {
              if (kind === 'title')
                document.querySelector('textarea')!.value = 'old title';
              if (kind === 'body')
                document.querySelector('#body')!.innerHTML = '<p>old body</p>';
              if (kind === 'image')
                document.querySelector('#body')!.innerHTML =
                  '<p><img width="100" height="100" src="/fixture/image"></p>';
              if (kind === 'cover')
                document.querySelector('.article-cover-images')!.innerHTML =
                  '<img width="100" height="100" src="/fixture/image">';
            }, 200),
          );
        },
        { kind },
      );
      await expect(
        pages.enterNewEditor('new title', () => false, randomUUID(), true),
      ).rejects.toMatchObject({ reason: 'EDITOR_NOT_EMPTY' });
      expect(fixture.saves()).toBe(0);
      expect(fixture.uploads()).toBe(0);
      expect(await page.locator('textarea').inputValue()).not.toBe('new title');
    },
  );
}

test('operator does not acknowledge an unrelated create response before its own save', async ({
  context,
  page,
}) => {
  const { pages } = await operatorEditor(context, page);
  await pages.enterNewEditor('own article', () => false, randomUUID(), true);
  await pages.fillTitle('own article');
  await pages.appendParagraph('body');
  expect((await pages.inspectEditor()).known).toBe(true);
  let requests = 0;
  await context.route(
    '**/motor/dealer_admin/go_api/article/create',
    async (route) => {
      requests++;
      const own = route.request().postDataJSON().title === 'own article';
      await route.fulfill({ json: { status: own ? 5000 : 0 } });
    },
  );
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('#save')!;
    button.disabled = true;
    setTimeout(() => {
      void fetch('/motor/dealer_admin/go_api/article/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'unrelated article',
          html: '<p>other</p>',
        }),
      });
    }, 100);
    setTimeout(() => {
      button.disabled = false;
    }, 400);
  });
  // Two candidate requests cannot be correlated using verified path/method alone.
  expect((await pages.saveForOperatorReview!(() => false)).observation).toBe(
    'unknown',
  );
  expect(requests).toBe(2); // One fixture-owned unrelated request, one actual save.
});

test('operator acknowledges a late sole response within the click-return budget', async ({
  context,
  page,
}) => {
  const { pages } = await operatorEditor(context, page);
  await pages.enterNewEditor('late response', () => false, randomUUID(), true);
  await pages.fillTitle('late response');
  await pages.appendParagraph('body');
  await pages.inspectEditor();
  let requests = 0;
  await context.route(
    '**/motor/dealer_admin/go_api/article/create',
    async (route) => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 12000));
      await route.fulfill({ json: { status: 0 } });
    },
  );
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('#save')!;
    button.disabled = true;
    setTimeout(() => {
      button.disabled = false;
    }, 4000);
  });
  expect((await pages.saveForOperatorReview!(() => false)).observation).toBe(
    'acknowledged',
  );
  await pages.returnHomeAfterSubmission!(() => false);
  expect(requests).toBe(1);
});

test('operator ignores a response whose request predates the save attempt', async ({
  context,
  page,
}) => {
  const { pages } = await operatorEditor(context, page);
  await pages.enterNewEditor(
    'current attempt',
    () => false,
    randomUUID(),
    true,
  );
  await pages.fillTitle('current attempt');
  await pages.appendParagraph('body');
  await pages.inspectEditor();
  let requests = 0;
  let releaseOld!: () => Promise<void>;
  await context.route(
    '**/motor/dealer_admin/go_api/article/create',
    async (route) => {
      requests++;
      if (route.request().postDataJSON().title === 'old attempt') {
        releaseOld = () => route.fulfill({ json: { status: 0 } });
        return;
      }
      await releaseOld();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({ json: { status: 5000 } });
    },
  );
  await page.evaluate(() => {
    void fetch('/motor/dealer_admin/go_api/article/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'old attempt' }),
    });
  });
  await expect.poll(() => requests).toBe(1);
  expect((await pages.saveForOperatorReview!(() => false)).observation).toBe(
    'rejected',
  );
  expect(requests).toBe(2);
});

test('response after the settle deadline cannot revive or replay the attempt', async ({
  context,
  page,
}) => {
  const { pages } = await operatorEditor(context, page);
  await pages.enterNewEditor(
    'expired response',
    () => false,
    randomUUID(),
    true,
  );
  await pages.fillTitle('expired response');
  await pages.appendParagraph('body');
  await pages.inspectEditor();
  let requests = 0;
  let releaseLate!: () => Promise<void>;
  await context.route(
    '**/motor/dealer_admin/go_api/article/create',
    async (route) => {
      requests++;
      releaseLate = () => route.fulfill({ json: { status: 0 } });
    },
  );
  await expect(pages.saveForOperatorReview!(() => false)).rejects.toMatchObject(
    { reason: 'RESULT_AMBIGUOUS' },
  );
  const finished = page.waitForResponse(
    '**/motor/dealer_admin/go_api/article/create',
  );
  await releaseLate();
  await finished;
  await expect(pages.saveOnce()).rejects.toMatchObject({
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(requests).toBe(1);
  expect(new URL(page.url()).pathname).toBe('/jdc/dealer/info/Article');
});

test('a request arriving during the final busy read keeps aggregation bounded', async ({
  context,
  page,
}) => {
  const { pages } = await operatorEditor(context, page);
  await pages.enterNewEditor('late inflight', () => false, randomUUID(), true);
  await pages.fillTitle('late inflight');
  await pages.appendParagraph('body');
  await pages.inspectEditor();
  let requests = 0;
  let releaseLate: (() => Promise<void>) | undefined;
  await context.route(
    '**/motor/dealer_admin/go_api/article/create',
    async (route) => {
      requests++;
      if (route.request().postDataJSON().title === 'fixture late inflight') {
        releaseLate = () => route.fulfill({ json: { status: 0 } });
        return;
      }
      await route.fulfill({ json: { status: 0 } });
    },
  );
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('#save')!;
    const classes = button.classList;
    let clicked = false,
      sent = false;
    button.addEventListener(
      'click',
      () => {
        clicked = true;
      },
      { once: true },
    );
    // Real DOM read boundary: inject a fixture-owned request after inflight.size
    // was checked, while the adapter evaluates the final button busy state.
    Object.defineProperty(button, 'classList', {
      get() {
        if (clicked && !sent) {
          sent = true;
          void fetch('/motor/dealer_admin/go_api/article/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'fixture late inflight' }),
          });
        }
        return classes;
      },
    });
  });
  let outcome: unknown;
  const saving = pages.saveForOperatorReview!(() => false).then(
    (value) => {
      outcome = value;
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  try {
    await expect.poll(() => requests).toBe(2);
    await expect
      .poll(() => outcome, { timeout: 17000 })
      .toMatchObject({ reason: 'RESULT_AMBIGUOUS' });
    expect(new URL(page.url()).pathname).toBe('/jdc/dealer/info/Article');
    await expect(pages.saveOnce()).rejects.toMatchObject({
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(requests).toBe(2); // One explicit save plus the fixture-owned late request.
  } finally {
    await releaseLate?.();
    await saving;
  }
});

for (const observation of ['acknowledged', 'rejected', 'unknown'] as const) {
  test(
    'ordinary single operator submission permits the next article without review: ' +
      observation,
    async ({ context, page }) => {
      await denyExternalNetwork(context);
      const fixture = await installProductionFixture(context, {
        batchHistory: true,
        saveFailureAt: observation === 'rejected' ? 1 : undefined,
      });
      if (observation === 'unknown')
        await context.route(
          '**/motor/dealer_admin/go_api/article/create',
          (route) => route.fulfill({ json: { unexpected: true } }),
        );
      let searches = 0,
        reopens = 0,
        saveRequests = 0;
      context.on('request', (r) => {
        const u = new URL(r.url());
        if (
          u.pathname.includes('/article/list') ||
          u.pathname === '/fixture/list' ||
          u.pathname.endsWith('/content/index')
        )
          searches++;
        if (u.pathname.endsWith('/Article') && u.searchParams.has('pgc_id'))
          reopens++;
        if (u.pathname.endsWith('/article/create')) saveRequests++;
      });
      const h = await createDraftHarness(2, {
        title: 'First ordinary single article',
        contentDeclaration: 'repost',
      });
      const adapter = createJudongcheAdapter(
        {
          open: async () => context,
          current: () => context,
          generation: () => '11111111-1111-4111-8111-111111111111',
          close: async () => {},
        },
        undefined,
        {
          manualReview: true,
          automaticDraftReview: false,
          batchSubmissionReview: 'operator',
          ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
        },
      );
      const preparation = createDraftPreparation({
        repository: h.articles,
        covers: h.articles,
        tasks: h.tasks,
        snapshots: h.snapshots,
        newId: randomUUID,
      });
      const draft = createDraftController({
        tasks: h.tasks,
        snapshots: h.snapshots,
        preparation,
        platform: adapter,
        newId: randomUUID,
        now: () => new Date().toISOString(),
        gate: () => 'ready',
        controlledPilot: { storeIdentity: '123456' },
      });
      try {
        await page.goto(fixture.home);
        await draft.openDraftSession();
        const second = await h.addArticle('Second ordinary single article');
        for (const key of [h.articleKey, second]) {
          const prepared = await draft.prepareDraft(
            key,
            (await draft.getDraftState()).session.bindingToken!,
          );
          expect(prepared.status).toBe('ready');
          if (prepared.status !== 'ready') throw Error('not prepared');
          expect(
            (await draft.startDraft(prepared.preparation.preparationId)).status,
          ).toBe('ok');
          await expect
            .poll(() => draft.isActive(), { timeout: 12000 })
            .toBe(false);
          expect(h.tasks.latest()).toMatchObject({
            state: 'submission_recorded',
            stage: 'settled',
            saveAttempted: true,
            holdsPlatform: false,
            evidence: {
              submission: {
                observation:
                  observation === 'rejected' && key === second
                    ? 'acknowledged'
                    : observation,
              },
            },
          });
          expect(draft.isBlocked()).toBe(false);
          expect(new URL(page.url()).pathname).toBe('/jdc/cps/home');
        }
        expect(saveRequests).toBe(2);
        expect(fixture.saves()).toBe(observation === 'unknown' ? 0 : 2);
        expect(searches).toBe(0);
        expect(reopens).toBe(0);
        expect(fixture.menuInteractions()).toBe(0);
      } finally {
        await draft.stopAndWait();
        await h.close();
      }
    },
  );
}

for (const fault of [
  'none',
  'late-entry',
  'late-entry-safety',
  'rejected',
  'unknown',
  'auth',
  'forbidden',
  'unbound-auth',
  'unbound-forbidden',
  'busy',
  'pending',
  'wait-stop',
  'home-failure',
  'home-stop',
  'click-timeout',
  'old-title',
  'old-body',
  'old-image',
  'old-cover',
  'stop',
] as const) {
  test('operator batch home reset: ' + fault, async ({ context, page }) => {
    await denyExternalNetwork(context);
    let requestStop = () => {};
    const fixture = await installProductionFixture(context, {
      batchHistory: true,
      saveFailureAt: fault === 'rejected' ? 1 : undefined,
      afterSave: () => {
        if (fault === 'busy')
          void page.evaluate(() => {
            const b = document.querySelector('#save')!;
            b.setAttribute('aria-busy', 'true');
            setTimeout(() => b.removeAttribute('aria-busy'), 4000);
          });
        if (fault === 'stop') requestStop();
        if (fault === 'wait-stop') setTimeout(() => requestStop(), 500);
      },
    });
    if (fault === 'home-failure' || fault === 'home-stop')
      await context.route('**/jdc/cps/home', async (route) => {
        if (fixture.saves() === 0) return route.fallback();
        if (fault === 'home-failure') return route.abort();
        requestStop();
        return route.fallback();
      });
    if (fault === 'unknown' || fault === 'pending')
      await context.route(
        '**/motor/dealer_admin/go_api/article/create',
        (route) =>
          fault === 'pending'
            ? undefined
            : route.fulfill({ json: { unexpected: true } }),
      );
    if (
      fault === 'auth' ||
      fault === 'forbidden' ||
      fault.startsWith('unbound-')
    )
      await context.route(
        '**/motor/dealer_admin/go_api/article/create',
        (route) =>
          route.fulfill({
            status:
              fault.startsWith('unbound-') &&
              route.request().postDataJSON().title === 'fixture unrelated'
                ? 200
                : fault.endsWith('auth')
                  ? 401
                  : 403,
            json: { status: 1 },
          }),
      );
    const probeCount = () =>
      diagnostic.filter(
        (e) =>
          e !== null &&
          typeof e === 'object' &&
          Reflect.get(e, 'operation') === 'probe',
      ).length;
    let probesAtEntry = 0;
    const probesDuringWriting: number[] = [];
    context.on('request', (r) => {
      const pathname = new URL(r.url()).pathname;
      if (pathname.endsWith('/Article')) probesAtEntry = probeCount();
      if (pathname.endsWith('/article/create'))
        probesDuringWriting.push(probeCount() - probesAtEntry);
    });
    let editorEntries = 0,
      homeEntries = 0,
      marketingEntries = 0,
      searches = 0,
      reopens = 0,
      saveClicks = 0,
      explicitSaveRequests = 0;
    context.on('request', (r) => {
      const u = new URL(r.url());
      if (
        u.pathname.includes('/article/list') ||
        u.pathname === '/fixture/list'
      )
        searches++;
      if (u.pathname.endsWith('/Article') && u.searchParams.has('pgc_id'))
        reopens++;
      if (u.pathname.endsWith('/cps/home')) homeEntries++;
      if (u.pathname.endsWith('/sceneMarketing')) marketingEntries++;
      if (u.pathname.endsWith('/article/create')) {
        saveClicks++;
        if (r.postDataJSON().title !== 'fixture unrelated')
          explicitSaveRequests++;
      }
    });
    await context.addInitScript(
      ({ fault }) => {
        // Owner-confirmed single and batch enter the verified editor directly.
        // Delay the actual second editor controls, not a legacy marketing card.
        if (location.pathname !== '/jdc/dealer/info/Article') return;
        const count =
          Number(sessionStorage.getItem('operatorEntries') || '0') + 1;
        sessionStorage.setItem('operatorEntries', String(count));
        if (fault.startsWith('unbound-'))
          document.addEventListener('DOMContentLoaded', () => {
            const button = document.querySelector<HTMLButtonElement>('#save')!;
            const actualSave = button.onclick!;
            button.onclick = (event) => {
              void fetch('/motor/dealer_admin/go_api/article/create', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ title: 'fixture unrelated' }),
              });
              setTimeout(() => actualSave.call(button, event), 100);
            };
          });
        if (fault === 'click-timeout')
          document.addEventListener('DOMContentLoaded', () => {
            document.querySelector<HTMLButtonElement>('#save')!.disabled = true;
          });
        if (count >= 2 && fault.startsWith('late-entry'))
          document.addEventListener('DOMContentLoaded', () => {
            const controls = [
              document.querySelector('textarea')!,
              document.querySelector('#body')!,
            ];
            controls.forEach((control) => control.remove());
            setTimeout(() => {
              controls.forEach((control) => document.body.append(control));
              if (fault === 'late-entry-safety') {
                const dialog = document.createElement('div');
                dialog.setAttribute('role', 'dialog');
                dialog.textContent = '安全验证';
                document.body.append(dialog);
              }
            }, 500);
          });
        if (count < 2 || !fault.startsWith('old-')) return;
        document.addEventListener('DOMContentLoaded', () => {
          if (fault === 'old-title')
            document.querySelector('textarea')!.value = 'old title';
          if (fault === 'old-body')
            document.querySelector('#body')!.innerHTML = '<p>old body</p>';
          if (fault === 'old-image')
            document.querySelector('#body')!.innerHTML =
              '<p><img width="100" height="100" src="/fixture/image"></p>';
          if (fault === 'old-cover')
            document.querySelector('.article-cover-images')!.innerHTML =
              '<img width="100" height="100" src="/fixture/image">';
        });
      },
      { fault },
    );
    context.on('request', (r) => {
      if (new URL(r.url()).pathname.endsWith('/Article')) editorEntries++;
    });
    const h = await createDraftHarness(2, {
      title: 'First operator batch article',
      contentDeclaration: 'repost',
    });
    const repository = openDraftBatchRepository(
      h.path,
      resolve('src/infrastructure/persistence/migrations'),
    );
    const session = {
      open: async () => context,
      current: () => context,
      generation: () => '11111111-1111-4111-8111-111111111111',
      close: async () => {},
    };
    const diagnostic: unknown[] = [];
    const adapter = createJudongcheAdapter(
      session,
      (event) => diagnostic.push(event),
      {
        manualReview: true,
        automaticDraftReview: true,
        batchSubmissionReview: 'operator',
        ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
      },
    );
    const preparation = createDraftPreparation({
      repository: h.articles,
      covers: h.articles,
      tasks: h.tasks,
      snapshots: h.snapshots,
      newId: randomUUID,
    });
    const draft = createDraftController({
      tasks: h.tasks,
      snapshots: h.snapshots,
      preparation,
      platform: adapter,
      newId: randomUUID,
      now: () => new Date().toISOString(),
      gate: () => 'ready',
      controlledPilot: { storeIdentity: '123456' },
    });
    const batch = createBatchController({
      repository,
      draft,
      preparation,
      articles: h.articles,
      snapshots: h.snapshots,
      newId: randomUUID,
      now: () => new Date().toISOString(),
      gate: () => 'ready',
    });
    requestStop = () => batch.requestStop();
    try {
      await page.goto(fixture.home);
      const opened = await draft.openDraftSession();
      const second = await h.addArticle('Second operator batch article');
      const offered = await batch.prepare({
        articleKeys: [h.articleKey, second],
        bindingToken: opened.view.session.bindingToken!,
      });
      expect(offered.status).toBe('ready');
      if (offered.status !== 'ready') return;
      await batch.start({
        preparationId: offered.preparation.preparationId,
        requestId: randomUUID(),
      });
      await batch.waitForIdle();
      const view = await batch.getCurrent();
      if (
        fault === 'none' ||
        fault === 'late-entry' ||
        fault === 'rejected' ||
        fault === 'unknown' ||
        fault === 'busy'
      ) {
        expect(view, JSON.stringify(diagnostic.slice(-3))).toMatchObject({
          state: 'completed',
          counts: { attempted: 2, saved: 0 },
          items: [
            {
              state: 'submission_recorded',
              submission: {
                observation:
                  fault === 'rejected'
                    ? 'rejected'
                    : fault === 'unknown'
                      ? 'unknown'
                      : 'acknowledged',
              },
            },
            { state: 'submission_recorded' },
          ],
        });
        expect(saveClicks).toBe(2);
        expect(editorEntries).toBe(2);
        expect(homeEntries).toBeGreaterThanOrEqual(3);
        expect(new URL(page.url()).pathname).toBe('/jdc/cps/home');
      } else {
        expect(view).toMatchObject({
          state: 'paused',
          counts: { needsHuman: 1 },
        });
        expect(saveClicks).toBe(
          fault === 'click-timeout' ? 0 : fault.startsWith('unbound-') ? 2 : 1,
        );
        if (fault === 'click-timeout' || fault.startsWith('home-')) {
          expect(view?.items[0]?.state).not.toBe('submission_recorded');
          expect(h.tasks.latest()).toMatchObject({ saveAttempted: true });
          expect(editorEntries).toBe(1);
        }
        if (fault === 'stop' || fault === 'wait-stop') {
          expect(editorEntries).toBe(1);
          expect(homeEntries).toBe(1);
          expect(new URL(page.url()).pathname).toBe('/jdc/dealer/info/Article');
        }
        if (fault.startsWith('old-')) {
          expect(view?.items[0]?.state).toBe('submission_recorded');
          expect(view?.reason).toBe('EDITOR_NOT_EMPTY');
        }
        if (fault === 'late-entry-safety') {
          expect(view?.reason).toBe('VERIFICATION_REQUIRED');
          expect(editorEntries).toBe(2);
        }
        if (
          fault === 'auth' ||
          fault === 'forbidden' ||
          fault.startsWith('unbound-')
        ) {
          expect(view?.reason).toBe(
            fault.endsWith('auth') ? 'LOGIN_REQUIRED' : 'PERMISSION_DENIED',
          );
          expect(editorEntries).toBe(1);
          expect(homeEntries).toBe(1);
          expect(h.tasks.latest()).toMatchObject({ saveAttempted: true });
        }
      }
      expect(probesDuringWriting.every((count) => count === 0)).toBe(true);
      expect(explicitSaveRequests).toBe(
        view?.state === 'completed' ? 2 : fault === 'click-timeout' ? 0 : 1,
      );
      expect(marketingEntries).toBe(0);
      expect(searches).toBe(0);
      expect(reopens).toBe(0);
      expect(fixture.menuInteractions()).toBe(0);
      expect(fixture.uploads()).toBe(2);
    } finally {
      await batch.stopAndWait();
      repository.close();
      await h.close();
    }
  });
}
