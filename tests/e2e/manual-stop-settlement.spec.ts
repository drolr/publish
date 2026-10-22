import { expect, test } from '@playwright/test';
import { mount, body } from './article-workspace-fixture';
import { manualFixture, deferred, imported } from '../helpers/manual-desktop';
import { createOperationControl } from '../../src/application/operation-control';
import type { ManualDocumentServices } from '../../src/application/manual-document-commands';
import type { ManualDraft } from '../../src/contracts/manual-article';
import type { DocumentCommand } from '../../src/contracts/manual-edit';

for (const releaseFails of [false, true]) {
  test(`clean flush seals title and body through actual image release ${releaseFails ? 'failure and retained review' : 'and the final idle poll'}`, async ({
    page,
  }) => {
    const release = deferred<void>(),
      idleRead = deferred<void>();
    let releaseStarted = false,
      flushAcknowledged = false,
      allowIdle = false;
    let flushReply: ((flushed: boolean) => void) | undefined;
    if (imported.status !== 'imported') throw Error('Expected fixture article');
    const article = {
      ...imported.article,
      articleKey: '11111111-1111-4111-8111-111111111111',
      title: '真实控制器文章',
      body: [{ type: 'paragraph' as const, text: '释放前正文' }],
    };
    const documents: ManualDocumentServices = {
      loadEditableArticle: () => ({
        article,
        articleRevision: 1,
        editorBody: null,
      }),
      createEditorCompatibilityLease: () => undefined,
      releaseEditorCompatibilityLease: () => {},
      storedImages: {
        authorizeStored: async () => {
          throw Error('No image in this article');
        },
        bindSavedImage: async () => {
          throw Error('No save in this scenario');
        },
        readStored: async () => {
          throw Error('No image in this article');
        },
      },
      clipboard: {
        isReady: () => true,
        copy: async () => {},
        paste: async () => {
          throw Error('No paste in this scenario');
        },
        drain: async () => {},
      },
      digest: JSON.stringify,
      saveRevision: async () => {
        throw Error('No save in this scenario');
      },
      getSaveResult: async (operationId) => ({
        status: 'not_started',
        operationId,
      }),
      respondClose: (_request, _session, _revision, status) => {
        flushAcknowledged = status === 'flushed';
        flushReply?.(flushAcknowledged);
        return true;
      },
    };
    const { manual } = manualFixture({
      documents,
      flushForRestart: () =>
        new Promise<boolean>((resolve) => {
          flushReply = resolve;
          void page.evaluate(() => Reflect.get(window, 'workspaceClose')());
        }),
      releaseImages: async () => {
        releaseStarted = true;
        await release.promise;
        if (releaseFails) throw Error('Unknown resource ownership');
      },
    });
    await manual.openManualArticle(article.articleKey);
    await manual.waitForSettlement();
    const operations = createOperationControl({
      manual: {
        requestStop: () => {},
        settle: manual.stopForRestart,
        state: () =>
          manual.isActive()
            ? 'active'
            : manual.hasSession()
              ? 'needs_review'
              : 'idle',
      },
    });
    const edits: ManualDraft[] = [];
    await page.exposeFunction('settlementRead', async () => {
      if (manual.getManualArticleState().state === 'idle' && !allowIdle)
        await idleRead.promise;
      return manual.getManualArticleState();
    });
    await page.exposeFunction(
      'settlementEdit',
      (c: DocumentCommand, d: ManualDraft) => {
        edits.push(d);
        return manual.applyManualEdit(c, d);
      },
    );
    await page.exposeFunction('settlementReply', manual.respondManualClose);
    await page.exposeFunction('settlementStop', operations.requestStopAll);
    await page.exposeFunction(
      'settlementOperation',
      operations.getOperationControlState,
    );
    await page.exposeFunction('settlementOpen', manual.openManualArticle);
    await mount(page);
    await expect(body(page)).toBeEditable();
    await page.evaluate(() => {
      Object.assign(window.desktopApi, {
        getManualArticleState: Reflect.get(window, 'settlementRead'),
        applyManualEdit: Reflect.get(window, 'settlementEdit'),
        respondManualClose: Reflect.get(window, 'settlementReply'),
        requestStopAll: Reflect.get(window, 'settlementStop'),
        getOperationControlState: Reflect.get(window, 'settlementOperation'),
        openManualArticle: Reflect.get(window, 'settlementOpen'),
      });
    });
    const title = page.getByLabel('文章标题');
    await expect(title).toHaveValue(article.title);
    await expect(body(page)).toContainText('释放前正文');
    await page
      .getByRole('button', { name: '停止并初始化', exact: true })
      .click();
    await expect.poll(() => releaseStarted && flushAcknowledged).toBe(true);
    expect((await operations.getOperationControlState()).phase).toBe(
      'stopping',
    );

    async function attemptInput() {
      await title.focus();
      await page.keyboard.insertText('不应接收的新标题');
      await body(page).focus();
      await page.keyboard.insertText('不应接收的新正文');
      await expect(title).toHaveValue(article.title);
      await expect(body(page)).toHaveText('释放前正文');
      await expect(title).toBeDisabled();
      await expect(body(page)).not.toBeEditable();
      expect(edits).toEqual([]);
    }
    await attemptInput();
    release.resolve();
    if (releaseFails) {
      await expect
        .poll(async () => (await operations.getOperationControlState()).phase)
        .toBe('needs_review');
      expect(manual.isBlocked()).toBe(true);
      expect(manual.hasSession()).toBe(true);
      await expect(
        page.getByRole('region', { name: '全局操作状态' }),
      ).toContainText('正文编辑与图片');
      await attemptInput();
      expect(manual.getManualArticleState()).toMatchObject({
        state: 'editing',
        draft: { title: article.title, blocks: [{ text: '释放前正文' }] },
      });
      return;
    }
    await expect
      .poll(async () => (await operations.getOperationControlState()).phase)
      .toBe('stopped');
    // The old DOM can remain visible until the manual-state poll returns. It must
    // stay sealed even after the operation-control poll reports completion.
    await expect(
      page.getByRole('region', { name: '全局操作状态' }),
    ).toContainText('已停止并初始化');
    await attemptInput();
    allowIdle = true;
    idleRead.resolve();
    await expect(body(page)).toHaveCount(0);
    await page.getByRole('button', { name: /文章1 文章编号/ }).click();
    await expect(title).toHaveValue(article.title);
    await expect(body(page)).toBeEditable();
    await expect(body(page)).toHaveText('释放前正文');
    expect(edits).toEqual([]);
  });
}
