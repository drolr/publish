import { legacyFixtureSnapshotCapture } from '../fixtures/legacy-snapshot-capture';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDraftHarness } from '../fixtures/draft-harness';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { createBrowserSession } from '../../src/infrastructure/automation/browser-session';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createDraftController } from '../../src/application/draft-controller';
import { createBatchController } from '../../src/application/batch-controller';
import { createJudongcheAdapter } from '../../src/infrastructure/platforms/judongche/draft-adapter';

for (const bodyInputLifecycle of ['rebuild', 'alternating'] as const)
  test(`L01 same controller and session complete A2 then B2 with five images ${bodyInputLifecycle} and single covers`, async ({
    context,
    page,
  }) => {
    test.setTimeout(180000);
    await denyExternalNetwork(context);
    const fixture = await installProductionFixture(context, {
      batchHistory: true,
      singleCoverUpload: true,
      bodyInputLifecycle,
    });
    const h = await createDraftHarness(5, {
      title: 'Lifecycle article A one',
      contentDeclaration: 'repost',
    });
    const repository = openDraftBatchRepository(
      h.path,
      resolve('src/infrastructure/persistence/migrations'),
    );
    let active = 0,
      maxActiveWriter = 0,
      activeTask = '',
      closes = 0;
    const saves = new Map<string, number>();
    const uploadActions: unknown[] = [];
    const bodyCarets: unknown[] = [];
    await context.route(
      '**/motor/dealer_admin/go_api/article/create',
      async (route) => {
        uploadActions.push(
          await page.evaluate(
            () =>
              (window as unknown as { bodyInputActions: unknown })
                .bodyInputActions,
          ),
        );
        await route.fallback();
      },
    );
    const forbidden: string[] = [];
    context.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/article/create')) {
        expect(active).toBe(1);
        saves.set(activeTask, (saves.get(activeTask) ?? 0) + 1);
      }
      if (
        url.pathname.includes('/article/list') ||
        url.pathname.includes('/content/index') ||
        url.pathname.includes('sceneMarketing') ||
        url.searchParams.has('pgc_id')
      )
        forbidden.push(request.url());
    });
    const session = {
      open: async () => context,
      current: () => context,
      generation: () => '11111111-1111-4111-8111-111111111111',
      close: async () => {
        closes++;
      },
    };
    const adapter = createJudongcheAdapter(session, undefined, {
      manualReview: true,
      automaticDraftReview: true,
      batchSubmissionReview: 'operator',
      ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
    });
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (task, hooks) => {
      active++;
      maxActiveWriter = Math.max(maxActiveWriter, active);
      activeTask = task.taskId;
      try {
        return await execute(task, {
          ...hooks,
          checkpoint: async (stage) => {
            // The cover controls may legitimately move selection. Observe the
            // completed body at its real checkpoint before cover interaction.
            if (stage === 'cover')
              bodyCarets.push(
                await page.locator('#body').evaluate((editor) => {
                  const selection = window.getSelection();
                  const images = editor.querySelectorAll('div[__syl_tag]');
                  const last = images[images.length - 1];
                  const anchor = selection?.anchorNode;
                  const focus = selection?.focusNode;
                  const connectedBodyBoundary =
                    editor.isConnected &&
                    !!last?.isConnected &&
                    !!anchor?.isConnected &&
                    !!focus?.isConnected &&
                    editor.contains(last) &&
                    editor.contains(anchor) &&
                    editor.contains(focus);
                  const relation = connectedBodyBoundary
                    ? last.compareDocumentPosition(anchor!)
                    : 0;
                  return {
                    active: document.activeElement === editor,
                    caretInBody:
                      !!selection?.anchorNode &&
                      editor.contains(selection.anchorNode),
                    collapsed: selection?.isCollapsed,
                    connectedBodyBoundary,
                    afterLastImage:
                      connectedBodyBoundary &&
                      !(relation & Node.DOCUMENT_POSITION_DISCONNECTED) &&
                      !!(relation & Node.DOCUMENT_POSITION_FOLLOWING),
                  };
                }),
              );
            await hooks.checkpoint(stage);
          },
        });
      } finally {
        active--;
        activeTask = '';
      }
    };
    // evidenceV1: preserve legacy production-page regression; V2 remains closed.
    legacyFixtureSnapshotCapture(h.snapshots);
    const preparation = createDraftPreparation({
      contentCapabilities: () => adapter.contentCapabilities(),
      repository: h.articles,
      covers: h.articles,
      tasks: h.tasks,
      snapshots: h.snapshots,
      newId: randomUUID,
    });
    const draft = createDraftController({
      invalidateBrowserHealth: () => {},
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
    try {
      const keys = [await h.addArticle('Lifecycle article A one', 5)];
      for (const title of [
        'Lifecycle article A two',
        'Lifecycle article B one',
        'Lifecycle article B two',
      ])
        keys.push(await h.addArticle(title, 5));
      for (const key of keys) await h.setSingleCover(key);
      await page.goto(fixture.home);
      await draft.openDraftSession();
      const ids: string[] = [];
      for (const articleKeys of [keys.slice(0, 2), keys.slice(2)]) {
        const prepared = await batch.prepare({
          articleKeys,
          bindingToken: (await draft.getDraftState()).session.bindingToken!,
        });
        expect(prepared.status, JSON.stringify(prepared)).toBe('ready');
        if (prepared.status !== 'ready') throw Error('Lifecycle not prepared');
        expect(
          await batch.start({
            preparationId: prepared.preparation.preparationId,
            requestId: randomUUID(),
          }),
        ).toMatchObject({ status: 'ok' });
        await batch.waitForIdle();
        const view = (await batch.getCurrent())!;
        expect(view).toMatchObject({
          state: 'completed',
          counts: { attempted: 2, saved: 0, needsHuman: 0 },
        });
        for (const item of view.items) {
          const task = h.tasks.get(item.taskId!)!;
          ids.push(task.taskId);
          expect(task).toMatchObject({
            state: 'submission_recorded',
            saveAttempted: true,
            holdsPlatform: false,
            coverPlan: { snapshot: { mode: 'single', coverRevision: 1 } },
          });
          expect(
            task.snapshot.article.body.filter(
              (block) => block.type === 'image',
            ),
          ).toHaveLength(5);
          // Operator flow records the attempt; remote cover acceptance is pending.
          expect(task.coverPlan?.report).toMatchObject({
            phase: 'pending',
            expectedCount: 1,
            confirmedItems: [
              {
                position: 0,
                assetKey: task.coverPlan!.snapshot.assets[0].assetKey,
              },
            ],
          });
        }
        expect(draft.isBlocked()).toBe(false);
        expect(closes).toBe(0);
        expect(new URL(page.url()).pathname).toBe('/jdc/cps/home');
      }
      expect(new Set(ids).size).toBe(4);
      expect([...saves.keys()]).toEqual(ids);
      expect([...saves.values()]).toEqual([1, 1, 1, 1]);
      expect(maxActiveWriter).toBe(1);
      expect(active).toBe(0);
      expect(fixture.uploads()).toBe(20);
      expect(fixture.saves()).toBe(4);
      expect(uploadActions).toEqual(
        Array.from({ length: 4 }, () => ({
          actions: Array.from({ length: 5 }, (_, index) => ({
            mode:
              bodyInputLifecycle === 'rebuild'
                ? 'rebuilt'
                : ['retained', 'cleared', 'unmounted'][index % 3],
            selected: 1,
            confirmed: 1,
          })),
        })).map((entry) => entry.actions),
      );
      expect(bodyCarets).toEqual(
        Array.from({ length: 4 }, () => ({
          active: true,
          caretInBody: true,
          collapsed: true,
          connectedBodyBoundary: true,
          afterLastImage: true,
        })),
      );
      const observed = fixture.savedArticles();
      expect(observed.map((article) => article.title)).toEqual(
        keys.map((key) => h.articles.loadEditableArticle(key)!.article.title),
      );
      for (const [index, article] of observed.entries()) {
        const actual = await page.evaluate((html) => {
          const node = document.createElement('div');
          node.innerHTML = html;
          return Array.from(node.children).flatMap((block) => {
            const image = block.querySelector('img');
            if (image)
              return [{ type: 'image', value: image.getAttribute('web_uri') }];
            return block.textContent
              ? [{ type: 'paragraph', value: block.textContent }]
              : [];
          });
        }, article.html);
        const expected = h.articles
          .loadEditableArticle(keys[index])!
          .article.body.map((block) => ({
            type: block.type,
            value: block.type === 'paragraph' ? block.text : '',
          }));
        let image = index * 5;
        for (const block of expected)
          if (block.type === 'image') block.value = `body-${++image}`;
        expect(actual).toEqual(expected);
        expect(article.cover).toEqual({
          mode: 'single',
          count: 1,
          loaded: true,
          libraryChecked: false,
        });
      }
      expect(forbidden).toEqual([]);
      expect(fixture.menuInteractions()).toBe(0);
    } finally {
      await batch.stopAndWait();
      repository.close();
      await h.close();
    }
  });

test('real isolated persistent context closes and reopens with invalidated generation and restored fixture policy', async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-owned-profile-'));
  const diagnostic: unknown[] = [];
  const started = Date.now();
  let openOrdinal = 1;
  const session = createBrowserSession(join(root, 'profile'), {
    temporaryRoot: join(root, 'health'),
    operationEpoch: () => 0,
    onCapabilityDiagnostic: (event) =>
      diagnostic.push({
        openOrdinal,
        elapsedMs: Date.now() - started,
        ...event,
      }),
  });
  const health: unknown[] = [];
  const unsubscribe = session.subscribeHealth((view) => health.push(view));
  try {
    const first = await session.open();
    await denyExternalNetwork(first);
    const firstFixture = await installProductionFixture(first);
    const page = first.pages()[0] ?? (await first.newPage());
    await page.goto(firstFixture.home);
    await expect(page.getByText('您好！123456 合成门店')).toBeVisible();
    const generation = session.generation();
    let closed = false;
    first.once('close', () => {
      closed = true;
    });
    await session.close();
    expect(closed).toBe(true);
    expect(page.isClosed()).toBe(true);
    expect(session.current()).toBeUndefined();
    expect(session.generation()).not.toBe(generation);
    openOrdinal = 2;
    const second = await session.open();
    expect(second).not.toBe(first);
    expect(session.generation()).not.toBe(generation);
    await denyExternalNetwork(second);
    const nextFixture = await installProductionFixture(second);
    const nextPage = second.pages()[0] ?? (await second.newPage());
    await nextPage.goto(nextFixture.home);
    await expect(nextPage.getByText('您好！123456 合成门店')).toBeVisible();
    await expect(
      nextPage.goto('https://outside-fixture.invalid/'),
    ).rejects.toThrow();
    expect(firstFixture.saves() + nextFixture.saves()).toBe(0);
  } finally {
    console.info(
      'isolated lifecycle health transitions: ' + JSON.stringify(health),
    );
    unsubscribe();
    let sessionClosed = false;
    try {
      await session.close();
      sessionClosed = true;
    } finally {
      try {
        if (sessionClosed) {
          // Retain the profile if owned browser closure is unconfirmed.
          expect(
            resolve(root).startsWith(
              resolve(tmpdir(), 'lifecycle-owned-profile-'),
            ),
          ).toBe(true);
          await rm(root, { recursive: true, force: true });
        }
      } finally {
        console.info(
          'isolated lifecycle capability diagnostic: ' +
            JSON.stringify(diagnostic),
        );
        console.info(
          'isolated lifecycle cleanup: ' +
            JSON.stringify({
              sessionClosed,
              businessAbsent: session.current() === undefined,
              temporaryRootRemoved: !existsSync(root),
            }),
        );
      }
    }
  }
});
