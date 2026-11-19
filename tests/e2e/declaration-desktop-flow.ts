import { returnToArticlePool } from './focused-editor-navigation';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function checkDeclarationFlow(
  application: ElectronApplication,
  page: Page,
  source: string,
) {
  await page
    .getByRole('region', { name: '文章列表', exact: true })
    .getByRole('button', { name: /^秋日自驾笔记 文章编号/ })
    .click();
  await expect(page.getByLabel('文章声明', { exact: true })).toHaveCount(0);
  await page
    .getByRole('textbox', { name: '文章正文', exact: true })
    .press('Control+End');
  await page.keyboard.insertText('保留旧原创元数据。');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('.editor-save-status')).toHaveText('已保存到本机');
  await returnToArticlePool(page);
  const file = join(source, 'second.json');
  writeFileSync(
    file,
    JSON.stringify({
      schema_version: 1,
      article_id: 'desktop-second',
      title: '城市通勤随记',
      body: [{ type: 'paragraph', text: '记录日常通勤。' }],
      images: [],
      content_declaration: 'repost',
    }),
  );
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, file);
  await page.getByRole('button', { name: '导入文章', exact: true }).click();
  await expect(page.getByLabel('文章标题', { exact: true })).toBeVisible();
  await returnToArticlePool(page);
  await page
    .getByRole('region', { name: '文章列表', exact: true })
    .getByRole('button', { name: /^城市通勤随记 文章编号/ })
    .click();
  await page
    .getByRole('textbox', { name: '文章正文', exact: true })
    .fill('保留旧转载元数据。');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('.editor-save-status')).toHaveText('已保存到本机');
  await returnToArticlePool(page);
  await expect(
    page.getByRole('button', { name: /设为原创|设为转载|保存声明/ }),
  ).toHaveCount(0);
  const list = await page.evaluate(() => window.desktopApi.listArticles());
  if (list.status !== 'ok') throw new Error('list unavailable');
  expect(
    list.page.items.find((article) => article.title === '秋日自驾笔记')
      ?.contentDeclaration,
  ).toBe('original');
  expect(
    list.page.items.find((article) => article.title === '城市通勤随记')
      ?.contentDeclaration,
  ).toBe('repost');
  // Returning to the pool retains the clean manual owner. The compatibility
  // declaration API must stay gated until that owner is explicitly released.
  expect(
    await page.evaluate(
      (keys) => window.desktopApi.getArticleDeclarations(keys),
      list.page.items.map((a) => a.articleKey),
    ),
  ).toEqual({ status: 'unavailable' });
  const retained = await page.evaluate(() =>
    window.desktopApi.getManualArticleState(),
  );
  expect(retained).toMatchObject({
    state: 'editing',
    dirty: false,
    hasUnsavedChanges: false,
  });
  const closed = await page.evaluate(async () => {
    const state = await window.desktopApi.getManualArticleState();
    if (!('sessionId' in state)) throw Error('Expected retained clean owner');
    return window.desktopApi.closeManualEditor(
      {
        sessionId: state.sessionId,
        expectedDocumentRevision: state.documentRevision,
        clientSequence: state.nextClientSequence,
        commandId: state.nextEditCommandId,
      },
      'discard',
    );
  });
  expect(closed).toMatchObject({ status: 'ok', snapshot: { state: 'idle' } });
  // Rebind the UI to that authoritative release before its next selection.
  await page.reload();
  await expect(
    page.getByRole('button', { name: '新建文章', exact: true }),
  ).toBeEnabled();
  const read = await page.evaluate(
    (keys) => window.desktopApi.getArticleDeclarations(keys),
    list.page.items.map((a) => a.articleKey),
  );
  expect(read.status).toBe('ok');
  expect(JSON.stringify(read)).not.toContain(source);
  await expect(
    page.evaluate(() =>
      window.desktopApi.setArticleDeclarations({
        targets: [],
        declaration: 'original',
      }),
    ),
  ).rejects.toThrow();
}
