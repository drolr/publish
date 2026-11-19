import { returnToArticlePool } from './focused-editor-navigation';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
/** Full local UI -> validated IPC -> SQLite/assets; never opens a merchant browser. */
export async function checkSharedCoverDesktop(executablePath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'shared-cover-native-')),
    userData = join(root, 'profile');
  if (
    resolve(root) !== root ||
    !root.startsWith(join(tmpdir(), 'shared-cover-native-'))
  )
    throw Error('Unexpected test root');
  const image = join(root, 'common.png');
  mkdirSync(userData);
  await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 38, g: 104, b: 72 },
    },
  })
    .png()
    .toFile(image);
  const app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + userData],
  });
  try {
    const page = await app.firstWindow();
    const remote: string[] = [];
    page.on('request', (r) => {
      if (/^https?:/.test(r.url())) remote.push(r.url());
    });
    for (let i = 1; i <= 2; i++) {
      const file = join(root, 'article-' + i + '.json');
      writeFileSync(
        file,
        JSON.stringify({
          schema_version: 1,
          article_id: 'shared-native-' + i,
          title: '所选封面本机验证' + i,
          content_declaration: 'repost',
          body: [
            { type: 'paragraph', text: '原始图文顺序保留' },
            { type: 'image', image_id: 'body' },
          ],
          images: [
            { image_id: 'body', source: { type: 'local', path: 'common.png' } },
          ],
        }),
      );
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        });
      }, file);
      await page.getByRole('button', { name: '导入文章', exact: true }).click();
      await expect(page.getByLabel('文章标题')).toHaveValue(
        '所选封面本机验证' + i,
      );
      await returnToArticlePool(page);
    }
    await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
    await page
      .getByRole('checkbox', { name: '选择 所选封面本机验证1', exact: true })
      .check();
    await page
      .getByRole('checkbox', { name: '选择 所选封面本机验证2', exact: true })
      .check();
    await app.evaluate(({ dialog }, image) => {
      Reflect.set(globalThis, 'sharedChooserCount', 0);
      dialog.showOpenDialog = async () => {
        Reflect.set(
          globalThis,
          'sharedChooserCount',
          Reflect.get(globalThis, 'sharedChooserCount') + 1,
        );
        return { canceled: false, filePaths: [image] };
      };
    }, image);
    await page
      .getByRole('button', { name: '为所选文章选择同一张封面' })
      .click();
    await expect(
      page.getByRole('group', { name: '统一封面确认' }),
    ).toContainText('所选 2 篇，其中 0 篇已有封面将被替换');
    const list = await page.evaluate(() => window.desktopApi.listArticles());
    if (list.status !== 'ok') throw Error('List');
    const keys = list.page.items.map((a) => a.articleKey);
    for (const key of keys)
      expect(
        await page.evaluate(
          (key) => window.desktopApi.getArticleCover(key),
          key,
        ),
      ).toMatchObject({ configuration: { coverRevision: 0, mode: 'none' } });
    await page.getByRole('button', { name: '确认应用到所选文章' }).click();
    await expect(
      page.getByText(/已为所选 2 篇文章保存同一张本地封面/),
    ).toBeVisible();
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'sharedChooserCount')),
    ).toBe(1);
    await expect(page.locator('.batch-cover-list img')).toHaveCount(2);
    await expect
      .poll(() =>
        page
          .locator('.batch-cover-list img')
          .evaluateAll((images) =>
            images.every(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    const hashes: string[] = [];
    for (const key of keys) {
      const c = await page.evaluate(
        (key) => window.desktopApi.getArticleCover(key),
        key,
      );
      if (
        c.status !== 'ok' ||
        c.configuration.mode !== 'single' ||
        c.configuration.images.length !== 1
      )
        throw Error('Cover');
      const bytes = await page.evaluate(async (c) => {
        const r = await window.desktopApi.getCoverImage({
          kind: 'stored',
          articleKey: c.articleKey,
          coverRevision: c.coverRevision,
          assetKey: c.images[0].assetKey,
        });
        if (r.status !== 'ok') throw Error('Image');
        return Array.from(r.bytes);
      }, c.configuration);
      hashes.push(
        createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
      );
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(remote).toEqual([]);
    await page.setViewportSize({ width: 800, height: 600 });
    const stop = page.getByRole('button', {
      name: /停止所有未完成操作|停止并初始化/,
      exact: true,
    });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const box = await stop.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    await stop.click();
    await expect(page.getByRole('status', { name: '停止状态' })).toContainText(
      '已停止并释放占用',
    );
  } finally {
    await app.close();
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}
