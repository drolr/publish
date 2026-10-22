import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function checkDeclarationFlow(
  application: ElectronApplication,
  page: Page,
  source: string,
) {
  await page
    .getByRole('button')
    .filter({ hasText: '秋日自驾笔记' })
    .first()
    .click();
  await page.getByLabel('文章声明', { exact: true }).selectOption('original');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect
    .poll(async () => {
      const result = await page.evaluate(() =>
        window.desktopApi.listArticles(),
      );
      return result.status === 'ok'
        ? result.page.items[0].contentDeclaration
        : result.status;
    })
    .toBe('original');
  await page.getByRole('button', { name: '结束编辑', exact: true }).click();
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
  await page.getByRole('button', { name: '结束编辑', exact: true }).click();
  await page
    .getByRole('checkbox', { name: '选择 秋日自驾笔记', exact: true })
    .check();
  await page
    .getByRole('checkbox', { name: '选择 城市通勤随记', exact: true })
    .check();
  await page.getByRole('button', { name: '设为原创', exact: true }).click();
  await page.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect
    .poll(async () => {
      const result = await page.evaluate(() =>
        window.desktopApi.listArticles(),
      );
      return result.status === 'ok'
        ? result.page.items.map((a) => a.contentDeclaration)
        : [];
    })
    .toEqual(['original', 'original']);
  const list = await page.evaluate(() => window.desktopApi.listArticles());
  if (list.status !== 'ok') throw new Error('list unavailable');
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
