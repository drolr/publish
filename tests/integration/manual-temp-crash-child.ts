/** Owned test process only. Never accepts a production userData path. */
import fs from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManualTempStore } from '../../src/infrastructure/assets/manual-temp-store';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { createArticleImportService } from '../../src/application/article-import';
const [input, phase] = process.argv.slice(2);
const base = resolve('.tmp/manual-temp');
const root = resolve(input);
if (
  !root.startsWith(base + sep) ||
  !['sealed', 'unsealed', 'committed'].includes(phase)
)
  throw Error('unowned crash target');
const checkpoint = async () => {
  process.send?.('checkpoint');
  await new Promise<void>(() => {
    setInterval(() => {}, 1000);
  });
};
async function main() {
  const store = createManualTempStore(root);
  if (!(await store.recover())) throw Error('recover');
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
    'base64',
  );
  if (phase === 'unsealed') {
    const open = fs.open;
    fs.open = async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.bin') && args[1] === 'wx') {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          await checkpoint();
        };
      }
      return handle;
    };
  }
  const ref = await store.put(
    randomUUID(),
    bytes,
    new AbortController().signal,
  );
  if (phase === 'committed') {
    const repository = openArticleRepository(
      join(root, 'app.sqlite'),
      resolve('src/infrastructure/persistence/migrations'),
    );
    const service = createArticleImportService(
      repository,
      createAssetStore(join(root, 'assets')),
      { read: (_source, _capability, signal) => store.read(ref, signal) },
    );
    if (!(await service.recover())) throw Error('formal recover');
    const result = await service.importArticle({
      schema_version: 1,
      article_id: 'crash',
      title: 'Crash boundary',
      content_declaration: 'repost',
      body: [
        { type: 'paragraph', text: 'Body' },
        { type: 'image', image_id: 'i' },
      ],
      images: [
        {
          image_id: 'i',
          source: { type: 'remote', url: 'https://example.com/fixture' },
        },
      ],
    });
    if (result.status !== 'imported') throw Error(result.status);
  }
  await checkpoint();
}
void main().catch((error) => {
  console.error(error);
  process.exit(2);
});
