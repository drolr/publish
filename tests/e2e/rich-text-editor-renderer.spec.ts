import { returnToArticlePool } from './focused-editor-navigation';
import { createHash } from 'node:crypto';
import { manualFixture } from '../helpers/manual-desktop';
import type { ManualDocumentServices } from '../../src/application/manual-document-commands';
import type { ManualFragmentV2 } from '../../src/contracts/manual-article';
import { test, expect } from '@playwright/test';
import {
  setupContinuousFixture,
  mount,
  logs,
  paste,
} from './continuous-editor-fixture';
setupContinuousFixture();
test('unified entry exposes formatting and retains selection for mouse and keyboard commands', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.pressSequentially('abcd');
  await body.press('Control+Home');
  await body.press('Control+Shift+End');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(body.locator('strong')).toHaveText('abcd');
  await expect(body).toBeFocused();
  await expect(
    page.getByRole('button', { name: '加粗', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await body.press('Control+i');
  await body.press('Control+u');
  await expect(body.locator('strong em u, strong u em')).toHaveText('abcd');
  await page.getByRole('button', { name: '小标题', exact: true }).click();
  await expect(body.locator('h2')).toHaveText('abcd');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(body.locator('p strong')).toHaveText('abcd');
  await body.press('Control+Shift+z');
  await expect(body.locator('h2')).toHaveText('abcd');
  await expect(page.getByRole('group', { name: '录入方式' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '插入图片', exact: true }),
  ).toBeVisible();
  expect(await logs(page, 'legacy')).toEqual([]);
});
test('pure-text shortcut routes plain clipboard and warnings accurately once per paste', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.dispatchEvent('keydown', {
    key: 'v',
    ctrlKey: true,
    shiftKey: true,
  });
  await paste(page, 'text', '<p><strong>text</strong></p>');
  await expect.poll(async () => (await logs(page, 'pastes')).length).toBe(1);
  expect((await logs(page, 'pastes'))[0].input).toEqual({
    html: '',
    plain: 'text',
  });
  await page.evaluate(() =>
    Reflect.get(
      window,
      'fixturePatch',
    )({
      pasteSummary: {
        jobId: '99999999-9999-4999-8999-999999999999',
        kind: 'paste',
        outcome: 'completed',
        admitted: true,
        paragraphs: 1,
        imagePositions: 0,
        unresolved: 0,
        plainOnly: false,
        warnings: ['HEADING_NORMALIZED', 'STYLE_NORMALIZED'],
      },
    }),
  );
  await expect(
    page.getByText('标题层级已统一为小标题', { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText('已移除不支持的样式，保留可用的文字格式', { exact: true }),
  ).toHaveCount(1);
});

test('synthetic composition queues toolbar actions without stealing focus or submitting half input', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.pressSequentially('ab');
  await body.press('Control+Home');
  await body.press('Control+Shift+End');
  await body.dispatchEvent('compositionstart');
  await page
    .getByRole('button', { name: '加粗', exact: true })
    .dispatchEvent('mousedown');
  await page
    .getByRole('button', { name: '加粗', exact: true })
    .dispatchEvent('click');
  await expect(body.locator('strong')).toHaveCount(0);
  await expect(body).toBeFocused();
  await body.dispatchEvent('compositionend');
  await expect(body.locator('strong')).toHaveText('ab');
  await expect(page.locator('.editor-save-status')).toHaveAttribute(
    'data-input-pending',
    'false',
  );
});

for (const start of [3, 2147483648, 2147483647, Number.MAX_SAFE_INTEGER]) {
  test(
    'safe integer ordered markers preserve editable content, Enter, history and AST ' +
      start,
    async ({ page }) => {
      await mount(page);
      await page.setViewportSize({ width: 800, height: 600 });
      await page.evaluate((start) => {
        const state = Reflect.get(window, 'fixtureRead')();
        Reflect.get(
          window,
          'fixturePatch',
        )({
          draft: {
            ...state.draft,
            blocks: [
              {
                type: 'list',
                kind: 'ordered',
                start,
                blockKey: '55555555-5555-4555-8555-555555555555',
                items: [
                  {
                    type: 'paragraph',
                    blockKey: '66666666-6666-4666-8666-666666666666',
                    content: [{ type: 'text', text: 'item', marks: [] }],
                  },
                ],
              },
            ],
          },
        });
      }, start);
      const body = page.getByRole('textbox', { name: '文章正文', exact: true });
      const item = body.locator('ol li');
      if (start > 2147483647) {
        await expect(item).toHaveAttribute(
          'data-editor-ordinal',
          String(start),
        );
        expect(
          await item.evaluate((el) => getComputedStyle(el, '::before').content),
        ).toBe(JSON.stringify(String(start) + '.'));
        expect(await body.locator('ol').ariaSnapshot()).toContain(
          String(start) + '.',
        );
      } else {
        await expect(body.locator('ol')).toHaveAttribute(
          'start',
          String(start),
        );
        expect(
          await item.evaluate((el) => getComputedStyle(el).listStyleType),
        ).toBe('decimal');
      }
      await expect(item).toHaveText('item');
      await body.click();
      await body.press('Control+End');
      await page.keyboard.insertText('X');
      await body.press('Enter');
      if (start === Number.MAX_SAFE_INTEGER) await expect(item).toHaveCount(1);
      else {
        await expect(item).toHaveCount(2);
        if (start + 1 > 2147483647)
          await expect(item.nth(1)).toHaveAttribute(
            'data-editor-ordinal',
            String(start + 1),
          );
        await body.press('Control+z');
        await expect(item).toHaveCount(1);
      }
      await expect(item).toHaveText('itemX');
      if (start === Number.MAX_SAFE_INTEGER) {
        await page.keyboard.insertText('Y');
        await expect(item).toHaveText('itemXY');
        await page.screenshot({
          path: '.superpowers/sdd/2026-10-23-rich-text-editor/task-7-large-ordinal.png',
          fullPage: true,
        });
      }
      await expect(page.locator('.editor-save-status')).toHaveAttribute(
        'data-input-pending',
        'false',
      );
      const current = await page.evaluate(() =>
        Reflect.get(window, 'fixtureRead')(),
      );
      expect(current.draft.blocks[0]).toMatchObject({
        type: 'list',
        start,
        items: [
          {
            content: [
              {
                text: start === Number.MAX_SAFE_INTEGER ? 'itemXY' : 'itemX',
                marks: [],
              },
            ],
          },
        ],
      });
      expect(
        await body.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await body.press('Control+Home');
      await body.press('Control+Shift+End');
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(
        start === Number.MAX_SAFE_INTEGER ? 'itemXY' : 'itemX',
      );
      await body.dispatchEvent('copy');
      await expect
        .poll(async () => (await logs(page, 'copies')).length)
        .toBe(1);
      expect((await logs(page, 'copies'))[0].range.head).toMatchObject({
        kind: 'text',
        offset: start === Number.MAX_SAFE_INTEGER ? 6 : 5,
      });
    },
  );
}

test('real V2 controller admits rich toolbar edits, internal cut/paste and undo without changing marks', async ({
  page,
}) => {
  let copied: ManualFragmentV2 | undefined;
  const documents: ManualDocumentServices = {
    createEditorCompatibilityLease: () => {
      throw Error('No existing article');
    },
    releaseEditorCompatibilityLease: () => {},
    loadEditableArticle: () => undefined,
    storedImages: {
      authorizeStored: async () => {
        throw Error('No image');
      },
      bindSavedImage: async () => {
        throw Error('No save');
      },
      readStored: async () => {
        throw Error('No image');
      },
    },
    saveRevision: async () => {
      throw Error('No save');
    },
    getSaveResult: async (operationId) => ({
      status: 'not_started',
      operationId,
    }),
    clipboard: {
      isReady: () => true,
      copy: async (_session, fragment) => {
        copied = structuredClone(fragment);
      },
      paste: async () => {
        if (!copied) throw Error('No copied fragment');
        return { fragment: copied, images: [] };
      },
      drain: async () => {},
    },
    digest: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    respondClose: () => true,
  };
  const { manual } = manualFixture({ documents });
  const runtime = {
    getManualArticleState: () => manual.getManualArticleState(),
    beginManualArticle: () => manual.beginManualArticle(),
    applyManualEdit: manual.applyManualEdit,
    spliceManualPaste: manual.spliceManualPaste,
    copyManualSelection: manual.copyManualSelection,
  };
  await page.exposeFunction(
    'manualRuntimeCall',
    (method: keyof typeof runtime, args: unknown[]) =>
      Reflect.apply(runtime[method], manual, args),
  );
  await mount(page, 'normal', Object.keys(runtime));
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.pressSequentially('rich');
  await body.press('Control+Home');
  await body.press('Control+Shift+End');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect
    .poll(() => {
      const state = manual.getManualArticleState();
      return 'draft' in state ? state.draft.blocks : [];
    })
    .toMatchObject([{ content: [{ text: 'rich', marks: ['bold'] }] }]);
  await body.dispatchEvent('cut');
  await expect(body).toHaveText('');
  expect(copied).toMatchObject({
    version: 2,
    blocks: [{ content: [{ text: 'rich', marks: ['bold'] }] }],
  });
  await body.press('Control+z');
  await expect(body.locator('strong')).toHaveText('rich');
  await body.press('Control+End');
  await paste(
    page,
    'rich',
    '<!--application/x-draft-assistant-fragment:99999999-9999-4999-8999-999999999999-->',
  );
  await expect(body.locator('strong')).toHaveText('richrich');
  await expect
    .poll(() => {
      const state = manual.getManualArticleState();
      return 'draft' in state ? state.draft.blocks : [];
    })
    .toMatchObject([{ content: [{ text: 'richrich', marks: ['bold'] }] }]);
  await body.press('Control+z');
  await expect(body.locator('strong')).toHaveText('rich');
});

test('mixed marks, keyboard toolbar and cross-image format restrictions remain accessible', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.pressSequentially('abcd');
  await body.press('Control+Home');
  await body.press('Shift+ArrowRight');
  await body.press('Shift+ArrowRight');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await body.press('Control+Home');
  await body.press('Control+Shift+End');
  const bold = page.getByRole('button', { name: '加粗', exact: true });
  await expect(bold).toHaveAttribute('aria-pressed', 'mixed');
  await bold.focus();
  await page.keyboard.press('Space');
  await expect(body).toBeFocused();
  await expect(body.locator('strong')).toHaveText('abcd');
  await page.getByRole('button', { name: '插入图片', exact: true }).click();
  await expect(body.getByRole('img')).toHaveCount(1);
  await body.press('Control+a');
  await expect(
    page.getByRole('button', { name: '小标题', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('选区包含图片，请选择不含图片的文字段落后设置格式', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '清除格式', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '清除格式', exact: true }).click();
  await expect(body.getByRole('img')).toHaveCount(1);
  await expect(body.locator('strong')).toHaveCount(0);
});

test('list Enter empty exit, soft break and Backspace never create nested containers', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await page.getByRole('button', { name: '有序列表', exact: true }).click();
  await body.pressSequentially('item');
  await body.press('Shift+Enter');
  await page.keyboard.insertText('line');
  await expect(body.locator('ol li p')).toHaveText('itemline');
  await expect(body.locator('ol li br')).toHaveCount(1);
  await body.press('Enter');
  await expect(body.locator('ol li')).toHaveCount(2);
  await body.press('Enter');
  await expect(body.locator('ol li')).toHaveCount(1);
  await expect(body.locator(':scope > p')).toHaveCount(1);
  await page.keyboard.insertText('outside');
  await page.getByRole('button', { name: '引用', exact: true }).click();
  await body.press('Home');
  await body.press('Backspace');
  await expect(body.locator('blockquote')).toHaveCount(0);
  await expect(body.locator(':scope > p')).toHaveText('outside');
  await expect(body.locator('li li,li blockquote,blockquote ol')).toHaveCount(
    0,
  );
});

test('Enter over selected list text splits the leaf once and undoes to the original selection content', async ({
  page,
}) => {
  await mount(page);
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.pressSequentially('abcd');
  await page.getByRole('button', { name: '有序列表', exact: true }).click();
  await body.press('Home');
  await body.press('ArrowRight');
  await body.press('Shift+ArrowRight');
  await body.press('Shift+ArrowRight');
  await body.press('Enter');
  await expect(body.locator('ol li p')).toHaveText(['a', 'd']);
  await body.press('Control+z');
  await expect(body.locator('ol li p')).toHaveText(['abcd']);
});
import type {
  EditableArticle,
  RevisionSaveInput,
  SaveReceipt,
} from '../../src/contracts/article-revision';
import { projectEditorBody } from '../../src/domain/article-edit';
for (const recovery of ['delete', 'undo'] as const)
  test(
    'real controller blocks over-budget save and return, then recovers by ' +
      recovery,
    async ({ page }) => {
      const articles = new Map<string, EditableArticle>();
      const receipts = new Map<string, SaveReceipt>();
      const saved: RevisionSaveInput[] = [];
      const key = '99999999-9999-4999-8999-999999999999';
      const documents: ManualDocumentServices = {
        createEditorCompatibilityLease: () => ({}) as never,
        releaseEditorCompatibilityLease: () => {},
        loadEditableArticle: (id) => articles.get(id),
        storedImages: {
          authorizeStored: async () => {
            throw Error('no image');
          },
          bindSavedImage: async () => {
            throw Error('no image');
          },
          readStored: async () => {
            throw Error('no image');
          },
        },
        clipboard: {
          isReady: () => true,
          copy: async () => {},
          paste: async () => {
            throw Error('no paste');
          },
          drain: async () => {},
        },
        digest: (value) =>
          createHash('sha256').update(JSON.stringify(value)).digest('hex'),
        respondClose: () => true,
        saveRevision: async (input) => {
          saved.push(structuredClone(input));
          const cmd = input.kind === 'created' ? input.command : input.intent;
          const receipt: SaveReceipt = {
            ...cmd,
            articleKey: key,
            externalId:
              input.kind === 'created'
                ? input.externalId
                : input.identity.externalId,
            articleRevision: 1,
            kind: input.kind,
            committedAt: '2026-10-23T00:00:00.000Z',
          };
          articles.set(key, {
            articleRevision: 1,
            editorBody: input.editorBody,
            article: {
              articleKey: key,
              importId: key,
              externalId: receipt.externalId,
              title: input.title,
              contentDeclaration: input.contentDeclaration,
              body: projectEditorBody(input.editorBody),
              assets: [],
              createdAt: receipt.committedAt,
            },
          });
          receipts.set(cmd.operationId, receipt);
          return { status: 'committed', receipt };
        },
        getSaveResult: async (operationId) =>
          receipts.has(operationId)
            ? { status: 'committed', receipt: receipts.get(operationId)! }
            : { status: 'not_started', operationId },
      };
      const { manual } = manualFixture({ documents });
      const runtime = {
        getManualArticleState: () => manual.getManualArticleState(),
        beginManualArticle: async () => {
          const reply = await manual.beginManualArticle();
          const state = reply.snapshot;
          if (!('sessionId' in state)) throw Error('session');
          return manual.applyManualEdit(
            {
              sessionId: state.sessionId,
              expectedDocumentRevision: state.documentRevision,
              clientSequence: state.nextClientSequence,
              commandId: state.nextEditCommandId,
            },
            {
              ...state.draft,
              title: 'Budget',
              blocks: [
                {
                  type: 'paragraph',
                  blockKey: key,
                  content: [
                    { type: 'text', text: 'a'.repeat(20000), marks: [] },
                  ],
                },
              ],
            },
          );
        },
        applyManualEdit: manual.applyManualEdit,
        commitManualDocument: manual.commitManualDocument,
        getManualSaveResult: manual.getManualSaveResult,
        closeManualEditor: manual.closeManualEditor,
      };
      await page.exposeFunction(
        'manualRuntimeCall',
        (method: keyof typeof runtime, args: unknown[]) =>
          Reflect.apply(runtime[method], manual, args),
      );
      await mount(page, 'normal', Object.keys(runtime));
      const body = page.getByRole('textbox', { name: '文章正文', exact: true });
      await body.press('Control+End');
      await page.keyboard.insertText('x');
      await expect(body).toHaveText('a'.repeat(20000) + 'x');
      await expect(page.locator('[data-input-pending]')).toHaveAttribute(
        'data-input-pending',
        'true',
      );
      await page
        .getByRole('button', { name: '保存到本机', exact: true })
        .click();
      await expect(page.getByRole('alert')).toContainText('超出支持范围');
      expect(saved).toHaveLength(0);
      await page
        .getByRole('button', { name: '返回文章池', exact: true })
        .click();
      const leave = page.getByRole('dialog', { name: '离开当前编辑？' });
      await expect(leave).toBeVisible();
      await leave
        .getByRole('button', { name: '保存并继续', exact: true })
        .click();
      await expect(body).toHaveText('a'.repeat(20000) + 'x');
      expect(saved).toHaveLength(0);
      // Failed save-and-return must preserve the entire local draft and focus view.
      if (await leave.isVisible())
        await leave
          .getByRole('button', { name: '继续编辑', exact: true })
          .click();
      await body.press(recovery === 'delete' ? 'Backspace' : 'Control+z');
      await expect(body).toHaveText('a'.repeat(20000));
      await page
        .getByRole('button', { name: '保存到本机', exact: true })
        .click();
      await expect(page.locator('.editor-save-status')).toHaveText(
        '已保存到本机',
      );
      expect(saved).toHaveLength(1);
      expect(saved[0].editorBody.blocks[0]).toMatchObject({
        content: [{ text: 'a'.repeat(20000), marks: [] }],
      });
      await returnToArticlePool(page);
    },
  );
