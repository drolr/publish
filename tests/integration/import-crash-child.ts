import { join, resolve } from 'node:path';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { createArticleImportService } from '../../src/application/article-import';
import type { AssetStore } from '../../src/domain/ports/article-import';

const [root, phase] = process.argv.slice(2);
const repository = openArticleRepository(
  join(root, 'app.sqlite'),
  resolve('src/infrastructure/persistence/migrations'),
);
const assets = createAssetStore(join(root, 'assets'));
const checkpoint = async () => {
  process.send?.('checkpoint');
  await new Promise<void>(() => {
    setInterval(() => {}, 1000);
  });
};
const wrapped: AssetStore = {
  ...assets,
  async prepare(attempt, signal) {
    if (phase === 'reserved') await checkpoint();
    await assets.prepare(attempt, signal);
    if (phase === 'prepared') await checkpoint();
  },
  async put(attempt, id, bytes, signal) {
    if (phase === 'writing') {
      // Actual partial file and still-open handle; parent kills this process.
      const handle = await open(
        join(
          root,
          'assets',
          '.staging',
          attempt.importId,
          `${randomUUID()}.png`,
        ),
        'wx',
      );
      await handle.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      await checkpoint();
    }
    const asset = await assets.put(attempt, id, bytes, signal);
    return asset;
  },
  async finalize(attempt, signal) {
    await assets.finalize(attempt, signal);
    if (phase === 'renamed' || phase === 'before-commit') await checkpoint();
  },
};
const service = createArticleImportService(repository, wrapped, {
  read: async () =>
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
      'base64',
    ),
});
async function main() {
  if (!(await service.recover())) throw new Error('recovery');
  const result = await service.importArticle({
    schema_version: 1,
    article_id: 'crash',
    title: 'Title',
    content_declaration: 'repost',
    body: [
      { type: 'paragraph', text: 'Body' },
      { type: 'image', image_id: 'i' },
    ],
    images: [
      {
        image_id: 'i',
        source: { type: 'remote', url: 'https://example.com/i' },
      },
    ],
  });
  if (result.status !== 'imported') throw new Error(JSON.stringify(result));
  await checkpoint();
}
void main().catch(() => process.exit(2));
