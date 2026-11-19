import { PersistedEditorBodyV2Schema } from '../../src/contracts/rich-text-body';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { denyExternalNetwork } from './network-policy';
import { installRichFixture } from '../fixtures/judongche-rich';
import {
  richBody,
  richCapabilities,
  richDraftHarness,
} from '../fixtures/rich-draft';
import {
  createAdapterWithPages,
  createJudongcheAdapter,
} from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { createDraftHarness } from '../fixtures/draft-harness';
import { projectRichBody } from '../../src/domain/rich-text-body';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createDraftController } from '../../src/application/draft-controller';
import { createBatchController } from '../../src/application/batch-controller';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import type { RichEditorEvidence } from '../../src/infrastructure/platforms/judongche/rich-content-evidence';
test.beforeEach(async ({ context }) => denyExternalNetwork(context));
function mutation(value: RichEditorEvidence, fault: string) {
  const blocks = value.rich.blocks;
  if (fault === 'whole-bold' && blocks[0].type === 'paragraph')
    blocks[0].content[1].marks = ['bold'];
  if (fault === 'missing-mark' && blocks[0].type === 'paragraph')
    blocks[0].content[0].marks = ['bold'];
  if (fault === 'heading' && blocks[2].type === 'heading')
    blocks[2] = { ...blocks[2], type: 'paragraph' };
  if (fault === 'hand-number')
    blocks[3] = {
      type: 'paragraph',
      content: [{ type: 'text', text: '3. Item', marks: [] }],
    };
  if (
    fault === 'start' &&
    blocks[3].type === 'list' &&
    blocks[3].kind === 'ordered'
  )
    blocks[3].start = 4;
  if (fault === 'quote' && blocks[4].type === 'blockquote')
    blocks[4] = blocks[4].paragraphs[0];
  if (fault === 'empty') blocks.push({ type: 'paragraph', content: [] });
  if (fault === 'unknown') value.rich.formatKnown = false;
  if (fault === 'unknown-node') Reflect.set(blocks[0], 'type', 'unknown');
}
for (const fault of [
  'none',
  'whole-bold',
  'missing-mark',
  'heading',
  'hand-number',
  'start',
  'quote',
  'empty',
  'unknown',
  'unknown-node',
  'missing-method',
  'none-bullet',
  'dom-ol-text',
  'dom-ul-text',
  'dom-li-text',
  'dom-quote-text',
  'dom-ol-style',
  'dom-ul-style',
  'dom-li-style',
  'dom-quote-style',
  'dom-stylesheet',
  'dom-ol-reversed',
  'dom-li-value',
  'dom-combined-review',
])
  test(
    'controlled legacy verified batch: ' + fault,
    async ({ context, page }) => {
      const f = await installRichFixture(context, page),
        h = await createDraftHarness(0);
      const repo = openDraftBatchRepository(
        h.path,
        resolve('src/infrastructure/persistence/migrations'),
      );
      const keys = [h.articleKey, await h.addArticle('Second rich article', 0)];
      const body = structuredClone(richBody);
      const bullet = fault === 'none-bullet' || fault.startsWith('dom-ul');
      if (bullet && body.blocks[3].type === 'list')
        body.blocks[3] = {
          type: 'list',
          kind: 'bullet',
          items: body.blocks[3].items,
        };
      const db = new Database(h.path);
      try {
        for (const key of keys)
          db.prepare(
            'UPDATE articles SET body_json=?,editor_body_json=? WHERE article_key=?',
          ).run(
            JSON.stringify(projectRichBody(body)),
            JSON.stringify(body),
            key,
          );
      } finally {
        db.close();
      }
      const read = f.pages.inspectRichEditor!;
      let domMutated = false;
      let projectionMutations = 0;
      const projectionFault =
        !fault.startsWith('dom-') &&
        !['none', 'none-bullet', 'missing-method'].includes(fault);
      const draftReads: { saves: number; formatKnown: boolean }[] = [];
      const readDraft = f.pages.inspectRichDraft!;
      f.pages.inspectRichDraft = async (ref) => {
        const value = await readDraft(ref);
        draftReads.push({
          saves: f.saves(),
          formatKnown: value?.rich.formatKnown === true,
        });
        return value;
      };
      const savedTaskIds: string[] = [];
      let activeTaskId: string | undefined;
      const save = f.pages.saveOnce;
      f.pages.saveOnce = async () => {
        savedTaskIds.push(activeTaskId!);
        await save();
      };
      f.pages.inspectRichEditor = async () => {
        let value = await read();
        if (value.rich.blocks.length === body.blocks.length) {
          if (fault.startsWith('dom-') && !domMutated) {
            await page.locator('main').evaluate((main, fault) => {
              const list = main.querySelector('ol,ul') as HTMLElement;
              const item = list.querySelector('li')!;
              const quote = main.querySelector('blockquote')!;
              if (fault.endsWith('-text')) {
                const target =
                  fault === 'dom-li-text'
                    ? item
                    : fault === 'dom-quote-text'
                      ? quote
                      : list;
                target.prepend(
                  document.createTextNode('Untracked direct content '),
                );
              } else if (fault.endsWith('-style')) {
                const target =
                  fault === 'dom-li-style'
                    ? item
                    : fault === 'dom-quote-style'
                      ? quote
                      : list;
                (target as HTMLElement).style.fontStyle = 'italic';
              } else if (fault === 'dom-stylesheet') {
                const style = document.createElement('style');
                style.textContent = 'main li p { font-weight:700 }';
                document.head.append(style);
              } else if (fault === 'dom-ol-reversed')
                list.setAttribute('reversed', '');
              else if (fault === 'dom-li-value')
                item.setAttribute('value', '17');
              else if (fault === 'dom-combined-review') {
                list.style.fontWeight = 'bold';
                item.prepend(
                  document.createTextNode('UNEXPECTED DIRECT LI TEXT'),
                );
              }
            }, fault);
            domMutated = true;
            value = await read();
          } else {
            const before = JSON.stringify(value.rich);
            mutation(value, fault);
            if (JSON.stringify(value.rich) !== before) projectionMutations++;
          }
        }
        return value;
      };
      if (fault === 'missing-method') delete f.pages.inspectRichDraft;
      const session = {
        open: async () => context,
        current: () => context,
        generation: () => '11111111-1111-4111-8111-111111111111',
        close: async () => {},
      };
      const adapter = createAdapterWithPages(
        session,
        f.pages,
        richCapabilities,
      );
      let executions = 0;
      const execute = adapter.execute;
      adapter.execute = async (...args) => {
        executions++;
        activeTaskId = args[0].taskId;
        try {
          return await execute(...args);
        } finally {
          activeTaskId = undefined;
        }
      };
      const prep = createDraftPreparation({
        contentCapabilities: () => adapter.contentCapabilities(),
        repository: h.articles,
        covers: h.articles,
        tasks: h.tasks,
        snapshots: h.snapshots,
        newId: randomUUID,
      });
      const draft = createDraftController({
        tasks: h.tasks,
        snapshots: h.snapshots,
        preparation: prep,
        platform: adapter,
        invalidateBrowserHealth: () => {},
        newId: randomUUID,
        now: () => new Date().toISOString(),
        gate: () => 'ready',
      });
      const batch = createBatchController({
        repository: repo,
        draft,
        preparation: prep,
        articles: h.articles,
        snapshots: h.snapshots,
        newId: randomUUID,
        now: () => new Date().toISOString(),
        gate: () => 'ready',
      });
      try {
        const opened = await draft.openDraftSession();
        expect(opened.status).toBe('ok');
        const prepared = await batch.prepare({
          articleKeys: keys,
          bindingToken: opened.view.session.bindingToken!,
        });
        expect(prepared.status).toBe('ready');
        if (prepared.status !== 'ready') throw Error('not prepared');
        expect(
          (
            await batch.start({
              preparationId: prepared.preparation.preparationId,
              requestId: randomUUID(),
            })
          ).status,
        ).toBe('ok');
        await batch.waitForIdle();
        const view = await batch.getCurrent();
        if (fault === 'none' || fault === 'none-bullet' || projectionFault) {
          expect(
            view,
            JSON.stringify({ view, actual: await f.read() }),
          ).toMatchObject({
            state: 'completed',
            counts: { saved: 2, pending: 0, needsHuman: 0 },
          });
          await expect(page.locator('main strong em u')).toHaveCount(1);
          await expect(
            page.locator(bullet ? 'main ul > li > p' : 'main ol > li > p'),
          ).toHaveCount(1);
          expect(f.saves()).toBe(2);
          expect(executions).toBe(2);
          expect(f.enters()).toBe(2);
          expect(savedTaskIds).toEqual(view!.items.map((item) => item.taskId));
          expect(new Set(savedTaskIds).size).toBe(2);
          expect(draftReads).toEqual([
            { saves: 1, formatKnown: true },
            { saves: 2, formatKnown: true },
          ]);
          expect(view!.items.map((item) => h.tasks.get(item.taskId!)!)).toEqual(
            [
              expect.objectContaining({
                state: 'draft_saved',
                saveAttempted: true,
              }),
              expect.objectContaining({
                state: 'draft_saved',
                saveAttempted: true,
              }),
            ],
          );
          if (projectionFault) expect(projectionMutations).toBeGreaterThan(0);
          else expect(projectionMutations).toBe(0);
          expect(domMutated).toBe(false);
          const observed = await f.read();
          expect(observed.rich.formatKnown).toBe(true);
          expect(
            PersistedEditorBodyV2Schema.parse({
              version: 2,
              blocks: observed.rich.blocks,
            }),
          ).toEqual(body);
          await expect(
            page.locator('[data-mark][aria-pressed="true"]'),
          ).toHaveCount(0);
        } else {
          expect(view).toMatchObject({
            state: 'paused',
            counts: { pending: 1, needsHuman: 1 },
          });
          expect(executions).toBe(1);
          expect(f.enters()).toBe(fault === 'missing-method' ? 0 : 1);
          expect(projectionMutations).toBe(0);
          expect(view!.items[1]).toMatchObject({
            state: 'queued',
            taskId: null,
          });
          if (fault.startsWith('dom-')) {
            // This fixture has no operator-submission/manual-review page policy.
            // Its legacy path saves once, then verifies via inspectRichDraft.
            expect(f.saves()).toBe(1);
            expect(savedTaskIds).toEqual([view!.items[0].taskId]);
            expect(draftReads).toEqual([{ saves: 1, formatKnown: false }]);
            expect(h.tasks.get(view!.items[0].taskId!)!).toMatchObject({
              state: 'needs_human',
              saveAttempted: true,
            });
            expect(domMutated).toBe(true);
            expect((await f.read()).rich.formatKnown).toBe(false);
            if (fault.endsWith('-text'))
              await expect(page.locator('main')).toContainText(
                'Untracked direct content ',
              );
            if (fault.endsWith('-style')) {
              const target =
                fault === 'dom-li-style'
                  ? 'main li'
                  : fault === 'dom-quote-style'
                    ? 'main blockquote'
                    : 'main ol,main ul';
              expect(
                await page
                  .locator(target)
                  .first()
                  .evaluate((node) => getComputedStyle(node).fontStyle),
              ).toBe('italic');
            }
            if (fault === 'dom-stylesheet')
              expect(
                await page
                  .locator('main li p')
                  .evaluate((node) => getComputedStyle(node).fontWeight),
              ).toBe('700');
            if (fault === 'dom-ol-reversed')
              await expect(page.locator('main ol')).toHaveAttribute(
                'reversed',
                '',
              );
            if (fault === 'dom-li-value')
              await expect(page.locator('main li')).toHaveAttribute(
                'value',
                '17',
              );
            if (fault === 'dom-combined-review') {
              expect(await page.locator('main ol').textContent()).toContain(
                'UNEXPECTED DIRECT LI TEXT',
              );
              expect(
                await page
                  .locator('main li p')
                  .first()
                  .evaluate((p) => getComputedStyle(p).fontWeight),
              ).toBe('700');
            }
          } else {
            expect(fault).toBe('missing-method');
            expect(f.saves()).toBe(0);
            expect(savedTaskIds).toEqual([]);
            expect(draftReads).toEqual([]);
            expect(h.tasks.get(view!.items[0].taskId!)!).toMatchObject({
              state: 'needs_human',
              saveAttempted: false,
            });
          }
          expect(view!.items[0].reason).toBe('PAGE_CHANGED');
        }
      } finally {
        await batch.stopAndWait();
        repo.close();
        await h.close();
      }
    },
  );
test('production factory declares verified rich capabilities and still fails closed before its unwired writer', async () => {
  const h = richDraftHarness({
    version: 2,
    blocks: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Plain', marks: [] }],
      },
    ],
  });
  const adapter = createJudongcheAdapter({
    open: async () => {
      throw Error('production opened');
    },
    current: () => {
      throw Error('production read');
    },
    generation: () => '11111111-1111-4111-8111-111111111111',
    close: async () => {},
  });
  const declared = {
    revision: 'judongche-rich-v1',
    features: {
      bold: 'verified',
      italic: 'verified',
      underline: 'verified',
      heading: 'verified',
      ordered_list: 'verified',
      bullet_list: 'verified',
      blockquote: 'verified',
    },
  };
  expect(adapter.contentCapabilities()).toEqual(declared);
  const capabilities = adapter.contentCapabilities();
  capabilities.revision = 'mutated';
  delete capabilities.features.bold;
  expect(adapter.contentCapabilities()).toEqual(declared);
  expect(await adapter.execute(h.task, h.hooks)).toMatchObject({
    status: 'blocked',
  });
  expect(h.calls).toEqual([]);
});
test('normal UI checks stop between individual mark operations and long-list items', async ({
  context,
  page,
}) => {
  const f = await installRichFixture(context, page);
  let stopped = false;
  const setMark = f.port.setMark;
  f.port.setMark = async (...args) => {
    await setMark(...args);
    if (args[0] === 'italic') stopped = true;
  };
  await expect(
    f.pages.appendTextBlock!(
      richBody
        .blocks[0] as import('../../src/contracts/rich-text-body').RichTextBlock,
      () => stopped,
    ),
  ).rejects.toMatchObject({ reason: 'STOP_REQUESTED' });
  expect(await page.locator('main').innerText()).toBe('');
  expect(f.saves()).toBe(0);
  stopped = false;
  await page.goto('https://www.autoengine.com/jdc/dealer/info/Article');
  f.port.setMark = setMark;
  const next = f.port.nextTextLeaf;
  let leaves = 0;
  f.port.nextTextLeaf = async () => {
    await next();
    leaves++;
    if (leaves === 3) stopped = true;
  };
  await expect(
    f.pages.appendTextBlock!(
      {
        type: 'list',
        kind: 'ordered',
        start: 7,
        items: Array.from({ length: 100 }, () => ({
          type: 'paragraph',
          content: [{ type: 'text', text: 'Item', marks: [] }],
        })),
      },
      () => stopped,
    ),
  ).rejects.toMatchObject({ reason: 'STOP_REQUESTED' });
  expect(leaves).toBe(3);
  expect(await page.locator('main ol p').count()).toBe(4);
  expect(f.saves()).toBe(0);
});

for (const [state, reason] of [
  ['login', 'LOGIN_REQUIRED'],
  ['changed', 'PAGE_CHANGED'],
] as const)
  test(
    'normal UI pauses on ' + reason + ' between mark actions',
    async ({ context, page }) => {
      const f = await installRichFixture(context, page),
        setMark = f.port.setMark;
      f.port.setMark = async (...args) => {
        await setMark(...args);
        if (args[0] === 'bold')
          await page
            .locator('body')
            .evaluate(
              (body, state) => body.setAttribute('data-state', state),
              state,
            );
      };
      await expect(
        f.pages.appendTextBlock!(
          richBody
            .blocks[0] as import('../../src/contracts/rich-text-body').RichTextBlock,
          () => false,
        ),
      ).rejects.toMatchObject({ reason });
      expect(
        await page.locator('[data-mark="italic"]').getAttribute('aria-pressed'),
      ).toBe('false');
      expect(f.saves()).toBe(0);
    },
  );
