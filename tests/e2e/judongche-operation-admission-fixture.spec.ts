import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDraftHarness } from '../fixtures/draft-harness';
import { legacyFixtureSnapshotCapture } from '../fixtures/legacy-snapshot-capture';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createDraftController } from '../../src/application/draft-controller';
import { createBatchController } from '../../src/application/batch-controller';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import {
  createAdapterWithPages,
  createJudongcheAdapter,
} from '../../src/infrastructure/platforms/judongche/draft-adapter';

// Minimal controlled toolbar/selection surface. Input remains native Chromium;
// neither insertText nor the production writer/driver is replaced.
async function richControls(page: Page) {
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('#body')!;
    const wrapper = document.createElement('div');
    wrapper.className = 'publish-editor';
    editor.before(wrapper);
    wrapper.append(editor);
    editor.classList.add('ProseMirror');
    editor.addEventListener('mousedown', (event) => {
      const p = (event.target as Element).closest('p');
      if (p?.parentElement !== editor) return;
      const content = p.cloneNode(true) as Element;
      content
        .querySelectorAll('.syl-placeholder, img.ProseMirror-separator')
        .forEach((node) => node.remove());
      if (content.textContent) return;
      event.preventDefault();
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(p);
      range.collapse(true);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
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
}

for (const entry of ['single', 'batch'] as const)
  for (const version of [1, 2] as const)
    for (const cover of ['none', 'success', 'recoverable'] as const)
      for (const fault of [
        'none',
        'verification',
        'login',
        'root',
        'busy',
        'pending-file',
        'unloaded-image',
        'title',
        'body-final',
      ] as const) {
        if (
          fault !== 'none' &&
          (entry !== 'single' || version !== 2 || cover !== 'none')
        )
          continue;
        test(`T3 production controllers body admission: ${entry} V${version} cover=${cover} fault=${fault}`, async ({
          page,
          context,
        }) => {
          test.setTimeout(120000);
          await denyExternalNetwork(context);
          const fixture = await installProductionFixture(context, {
            batchHistory: true,
            observedTrailingParagraphs: true,
            singleCoverUpload: cover !== 'none',
          });
          const h = await createDraftHarness(2, {
            title: 'First T3 article',
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
          let changes = 0,
            creates = 0,
            searches = 0,
            reopens = 0;
          const normalize = async () => {
            await page.locator('#body').evaluate((body) => {
              const paragraph = body.querySelector('p');
              if (paragraph?.textContent) {
                const wrapper = document.createElement('section');
                const text = document.createElement('span');
                text.textContent = paragraph.textContent.toLowerCase();
                wrapper.append(text);
                paragraph.replaceWith(wrapper);
              }
              const tail = document.createElement('p');
              tail.innerHTML = '<br class="ProseMirror-trailingBreak">';
              body.append(tail);
            });
            changes++;
          };
          const diagnostics: unknown[] = [];
          const imageActions: Array<{ selection: number; confirm: number }> =
            [];
          const pages = createJudongchePages(
            session,
            (event) => {
              if (event.failure) diagnostics.push(event);
              if (
                event.check === 'body-image-stage' &&
                event.bodyImage?.stage === 'readback' &&
                event.bodyImage.status === 'completed'
              )
                imageActions.push({
                  selection: event.bodyImage.fileSelectionCount,
                  confirm: event.bodyImage.confirmationCount,
                });
            },
            {
              manualReview: true,
              automaticDraftReview: false,
              batchSubmissionReview: 'operator',
              ownerConfirmedPilot: {
                dealerId: '123456',
                storeName: '合成门店',
              },
            },
            {
              reserve: async (effect) => {
                if (effect !== 'open') await normalize();
              },
              pause: async (stage) => {
                await normalize();
                void stage;
              },
            },
          );
          const enter = pages.enterNewEditor;
          pages.enterNewEditor = async (...args) => {
            await enter(...args);
            if (version === 2) await richControls(page);
            if (cover === 'recoverable')
              await page.evaluate(() => {
                // A genuine rejection is present on the first upload read. Losing a
                // previously pinned successful association must remain blocked.
                document.addEventListener('change', (event) => {
                  const input = event.target as HTMLInputElement;
                  if (input.type !== 'file' || !input.multiple) return;
                  const modal = input.closest('[role=dialog]')!;
                  const alert = document.createElement('div');
                  alert.setAttribute('role', 'alert');
                  alert.textContent = 'synthetic rejection';
                  modal.append(alert);
                  const cancel = Array.from(
                    modal.querySelectorAll('button'),
                  ).find((button) => button.textContent === '取消')!;
                  cancel.onclick = () =>
                    document.querySelector('#cover-layer')!.remove();
                });
              });
          };
          const append = pages.appendImage;
          pages.appendImage = async (...args) => {
            const key = await append(...args);
            await normalize();
            return key;
          };
          const save = pages.saveForOperatorReview!;
          pages.saveForOperatorReview = async (...args) => {
            await normalize();
            const original = page.getByRole.bind(page);
            let reads = 0;
            page.getByRole = new Proxy(original, {
              apply(target, receiver, callArgs: Parameters<Page['getByRole']>) {
                const locator = Reflect.apply(
                  target,
                  receiver,
                  callArgs,
                ) as ReturnType<Page['getByRole']>;
                if (
                  callArgs[0] === 'button' &&
                  callArgs[1]?.name === '存草稿'
                ) {
                  const read = locator.evaluateAll.bind(locator);
                  locator.evaluateAll = new Proxy(read, {
                    apply(work, self, values) {
                      return (
                        Reflect.apply(work, self, values) as Promise<unknown>
                      ).then(async (value) => {
                        if (++reads === 1) await normalize();
                        if (reads === 3 && fault !== 'none')
                          await page.evaluate((fault) => {
                            const body = document.querySelector('#body')!;
                            if (fault === 'title')
                              (
                                document.querySelector(
                                  'textarea',
                                ) as HTMLTextAreaElement
                              ).value = 'Different task title';
                            if (fault === 'body-final')
                              body.querySelector('section')!.textContent =
                                'final body normalization';
                            if (fault === 'root')
                              body.replaceWith(body.cloneNode(true));
                            if (fault === 'busy')
                              document
                                .querySelector('#save')!
                                .setAttribute('aria-busy', 'true');
                            if (fault === 'unloaded-image')
                              (
                                body.querySelector(
                                  '.pgc-image img',
                                ) as HTMLImageElement
                              ).src = '/fixture/pending-editor-resource';
                            if (fault === 'login') {
                              const welcome = document.createElement('div');
                              welcome.textContent = '巨懂车欢迎您';
                              document.body.append(welcome);
                            }
                            if (
                              fault === 'verification' ||
                              fault === 'pending-file'
                            ) {
                              const dialog = document.createElement('div');
                              dialog.setAttribute('role', 'dialog');
                              dialog.innerHTML =
                                fault === 'verification'
                                  ? '请完成安全验证'
                                  : '<input type="file">';
                              document.body.append(dialog);
                            }
                          }, fault);
                        return value;
                      });
                    },
                  });
                }
                return locator;
              },
            });
            try {
              return await save(...args);
            } finally {
              page.getByRole = original;
            }
          };
          context.on('request', (request) => {
            const url = new URL(request.url());
            if (url.pathname.endsWith('/article/create')) creates++;
            if (
              url.pathname.includes('/article/list') ||
              url.pathname === '/fixture/list'
            )
              searches++;
            if (
              url.pathname.endsWith('/Article') &&
              url.searchParams.has('pgc_id')
            )
              reopens++;
          });
          const adapter = createAdapterWithPages(
            session,
            pages,
            createJudongcheAdapter(session).contentCapabilities(),
          );
          if (version === 1) legacyFixtureSnapshotCapture(h.snapshots);
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
            await page.goto(fixture.home);
            const opened = await draft.openDraftSession();
            const keys = [
              h.articleKey,
              await h.addArticle('Second T3 article', 2),
            ];
            if (cover !== 'none')
              for (const key of keys) await h.setSingleCover(key);
            if (entry === 'single') {
              for (const key of keys) {
                const prepared = await draft.prepareDraft(
                  key,
                  (await draft.getDraftState()).session.bindingToken!,
                );
                expect(prepared.status).toBe('ready');
                if (prepared.status !== 'ready') throw Error('prepare');
                expect(
                  (await draft.startDraft(prepared.preparation.preparationId))
                    .status,
                ).toBe('ok');
                await expect
                  .poll(() => draft.isActive(), { timeout: 40000 })
                  .toBe(false);
                if (fault !== 'none' && fault !== 'body-final') {
                  expect(
                    h.tasks.latest(),
                    JSON.stringify(diagnostics),
                  ).toMatchObject({
                    state: 'needs_human',
                    reason:
                      fault === 'verification'
                        ? 'VERIFICATION_REQUIRED'
                        : fault === 'login'
                          ? 'LOGIN_REQUIRED'
                          : fault === 'unloaded-image' || fault === 'title'
                            ? 'CONTENT_MISMATCH'
                            : 'PAGE_CHANGED',
                  });
                  expect(creates).toBe(0);
                  expect(fixture.saves()).toBe(0);
                  expect(imageActions).toEqual([
                    { selection: 1, confirm: 1 },
                    { selection: 1, confirm: 1 },
                  ]);
                  return;
                }
                expect(
                  h.tasks.latest(),
                  JSON.stringify({
                    reason: h.tasks.latest()?.reason,
                    diagnostics,
                  }),
                ).toMatchObject({
                  state: 'submission_recorded',
                  saveAttempted: true,
                  holdsPlatform: false,
                });
              }
            } else {
              const prepared = await batch.prepare({
                articleKeys: keys,
                bindingToken: opened.view.session.bindingToken!,
              });
              expect(prepared.status).toBe('ready');
              if (prepared.status !== 'ready') throw Error('prepare');
              await batch.start({
                preparationId: prepared.preparation.preparationId,
                requestId: randomUUID(),
              });
              await batch.waitForIdle();
              expect(await batch.getCurrent()).toMatchObject({
                state: 'completed',
                counts: { attempted: 2, saved: 0 },
              });
            }
            expect(creates).toBe(2);
            expect(fixture.saves()).toBe(2);
            expect(fixture.uploads()).toBe(4);
            expect(imageActions).toEqual(
              Array.from({ length: 4 }, () => ({ selection: 1, confirm: 1 })),
            );
            expect(changes).toBeGreaterThanOrEqual(8);
            expect(searches).toBe(0);
            expect(reopens).toBe(0);
            expect(h.tasks.latest()!.evidence.images).toHaveLength(2);
            if (cover === 'recoverable')
              expect(h.tasks.latest()!.coverPlan?.report).toMatchObject({
                phase: 'failed',
                reason: 'UPLOAD_REJECTED',
              });
            if (cover === 'success')
              expect(
                h.tasks.latest()!.coverPlan?.report.confirmedItems,
              ).toHaveLength(1);
          } finally {
            repository.close();
            await h.close();
          }
        });
      }

async function plainPosition(page: Page) {
  return page.locator('#body').evaluate((root) => {
    const selection = getSelection(),
      anchor = selection?.anchorNode;
    return {
      active: document.activeElement?.nodeName,
      activeIsRoot: document.activeElement === root,
      anchor: anchor?.nodeName,
      anchorParent: anchor?.parentElement?.nodeName,
      inRoot: !!anchor && root.contains(anchor),
      rootAnchor: anchor === root,
      offset: selection?.anchorOffset,
      collapsed: selection?.isCollapsed,
      paragraphs: Array.from(root.querySelectorAll('p')).map((paragraph) => ({
        contains: !!anchor && paragraph.contains(anchor),
        codeUnits: paragraph.textContent?.length,
        childTags: Array.from(paragraph.childNodes).map(
          (node) => node.nodeName,
        ),
      })),
    };
  });
}

test('T3 legacy plain writer preserves a source blank next to an image', async ({
  page,
  context,
}) => {
  await denyExternalNetwork(context);
  const fixture = await installProductionFixture(context, {
    observedTrailingParagraphs: true,
  });
  await page.goto(fixture.home);
  const pages = createJudongchePages(
    {
      open: async () => context,
      current: () => context,
      generation: () => 'plain-blank',
      close: async () => {},
    },
    undefined,
    {
      manualReview: true,
      ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
    },
  );
  await pages.probe();
  await pages.enterNewEditor('plain blank', () => false, 'plain-blank-task');
  await pages.fillTitle('plain blank');
  await pages.appendParagraph('before').catch(async (error) => {
    throw Error(
      JSON.stringify({
        check: error.check,
        position: await plainPosition(page),
      }),
    );
  });
  await pages.appendParagraph('');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
    'base64',
  );
  const key = await pages.appendImage(new Uint8Array(png), 'image/png');
  await pages.appendParagraph('after').catch(async (error) => {
    throw Error(
      JSON.stringify({
        check: error.check,
        position: await plainPosition(page),
      }),
    );
  });
  expect((await pages.inspectEditor()).blocks).toEqual([
    { type: 'paragraph', text: 'before' },
    { type: 'paragraph', text: '' },
    { type: 'image', resourceKey: key, loaded: true },
    { type: 'paragraph', text: 'after' },
  ]);
});

for (const phase of ['first-line', 'soft-break'] as const)
  for (const fault of [
    'root',
    'caret',
    'caret-outside',
    'caret-middle',
    'multiple-br',
    'role-control',
    'tabindex-control',
    'editable-control',
    'resource-separator',
    'nonexact-placeholder',
    'terminal-br',
    'selection',
    'normalization',
    'stop',
  ] as const) {
    if ((fault === 'stop' || fault === 'terminal-br') && phase !== 'soft-break')
      continue;
    test(`R1 plain native boundary: ${phase} ${fault}`, async ({
      page,
      context,
    }) => {
      await denyExternalNetwork(context);
      const fixture = await installProductionFixture(context, {
        observedTrailingParagraphs: true,
      });
      await page.goto(fixture.home);
      let stopped = false,
        injected = false;
      const late: string[] = [];
      const pages = createJudongchePages(
        {
          open: async () => context,
          current: () => context,
          generation: () => 'plain-boundary',
          close: async () => {},
        },
        undefined,
        {
          manualReview: true,
          ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
        },
      );
      await pages.probe();
      await pages.enterNewEditor('plain boundary', () => stopped, randomUUID());
      await pages.fillTitle('plain boundary');
      await page.locator('#body').evaluate((body) => {
        body.innerHTML =
          '<p>existing</p><p><br class="ProseMirror-trailingBreak"></p>';
      });
      const inject = async () => {
        injected = true;
        if (fault === 'stop') {
          stopped = true;
          return;
        }
        await page.evaluate((fault) => {
          let root = document.querySelector<HTMLElement>('#body')!;
          if (fault === 'root') {
            const replacement = root.cloneNode(true) as HTMLElement;
            root.replaceWith(replacement);
            root = replacement;
          }
          const target = root.children[fault === 'caret' ? 0 : 1]!;
          if (fault === 'normalization') {
            const text = target.firstChild!;
            text.textContent = text.textContent!.toUpperCase();
            const wrapper = document.createElement('span');
            text.before(wrapper);
            wrapper.append(text);
          }
          if (fault === 'multiple-br') {
            const wrapper = document.createElement('span');
            wrapper.innerHTML = '<br><br>';
            target.append(wrapper);
          }
          if (fault === 'terminal-br') {
            const terminal = target.lastChild!;
            if (terminal.nodeName !== 'BR')
              throw Error('native terminal BR missing');
            const wrapper = document.createElement('span');
            terminal.before(wrapper);
            wrapper.append(terminal);
          }
          if (
            fault === 'role-control' ||
            fault === 'tabindex-control' ||
            fault === 'editable-control' ||
            fault === 'resource-separator' ||
            fault === 'nonexact-placeholder'
          ) {
            const addition = document.createElement(
              fault === 'resource-separator' ? 'img' : 'span',
            );
            addition.setAttribute('data-r2-tail', fault);
            if (fault === 'role-control')
              addition.setAttribute('role', 'button');
            if (fault === 'tabindex-control')
              addition.setAttribute('tabindex', '0');
            if (fault === 'editable-control')
              addition.setAttribute('contenteditable', 'true');
            if (fault === 'resource-separator') {
              addition.className = 'ProseMirror-separator';
              addition.setAttribute('alt', '');
              addition.setAttribute('src', '/fixture/image?protected-tail=1');
            }
            if (fault === 'nonexact-placeholder') {
              addition.className = 'syl-placeholder ProseMirror-widget';
              addition.setAttribute('ignoreel', 'true');
              addition.setAttribute('contenteditable', 'false');
              addition.textContent = 'protected tail';
            }
            target.append(addition);
          }
          const selection = getSelection()!,
            range = document.createRange();
          range.selectNodeContents(target);
          if (target.querySelector('[data-r2-tail]')) {
            range.setStartBefore(target.querySelector('[data-r2-tail]')!);
            range.collapse(true);
          } else if (fault === 'caret-middle') {
            range.setStart(target.firstChild!, 1);
            range.collapse(true);
          } else if (fault === 'caret-outside') {
            range.selectNodeContents(document.body);
            range.collapse(false);
          } else if (fault === 'multiple-br') {
            range.setStartBefore(target.lastElementChild!.firstChild!);
            range.collapse(true);
          } else if (fault === 'terminal-br') {
            range.setStartBefore(target.lastElementChild!.firstChild!);
            range.collapse(true);
          } else if (fault !== 'selection') {
            const padding = target.querySelector(
              'br.ProseMirror-trailingBreak',
            );
            if (padding) {
              range.setStartBefore(padding);
              range.collapse(true);
            } else range.collapse(false);
          }
          root.focus();
          selection.removeAllRanges();
          selection.addRange(range);
        }, fault);
      };
      const insert = page.keyboard.insertText.bind(page.keyboard),
        press = page.keyboard.press.bind(page.keyboard);
      page.keyboard.insertText = async (text) => {
        if (injected) late.push('text:' + text);
        await insert(text);
        if (!injected && phase === 'first-line' && text === 'first')
          await inject();
      };
      page.keyboard.press = async (key, options) => {
        if (injected) late.push('key:' + key);
        await press(key, options);
        if (!injected && phase === 'soft-break' && key === 'Shift+Enter')
          await inject();
      };
      try {
        if (fault === 'normalization' || fault === 'terminal-br') {
          await pages.appendParagraph('first\nsecond').catch(async (error) => {
            throw Error(
              JSON.stringify({
                check: error.check,
                position: await plainPosition(page),
              }),
            );
          });
          expect((await pages.inspectEditor()).blocks).toEqual([
            { type: 'paragraph', text: 'existing' },
            {
              type: 'paragraph',
              text:
                (fault === 'normalization' ? 'FIRST' : 'first') + '\nsecond',
            },
          ]);
        } else {
          await expect(
            pages.appendParagraph('first\nsecond'),
          ).rejects.toMatchObject({
            reason: fault === 'stop' ? 'STOP_REQUESTED' : 'PAGE_CHANGED',
          });
          expect(late).toEqual([]);
          if (fault === 'resource-separator')
            await expect(page.locator('[data-r2-tail]')).toHaveAttribute(
              'src',
              '/fixture/image?protected-tail=1',
            );
          if (fault === 'nonexact-placeholder')
            await expect(page.locator('[data-r2-tail]')).toHaveText(
              'protected tail',
            );
        }
        expect(injected).toBe(true);
        expect(fixture.saves()).toBe(0);
        expect(fixture.uploads()).toBe(0);
      } finally {
        page.keyboard.insertText = insert;
        page.keyboard.press = press;
      }
    });
  }
