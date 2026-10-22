import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { createManualTempStore } from '../../src/infrastructure/assets/manual-temp-store';
import { createManualImageSource } from '../../src/infrastructure/assets/manual-image-source';
import { createRevisionAssetStore } from '../../src/infrastructure/assets/revision-asset-store';
import { createArticleImportService } from '../../src/application/article-import';
import { createArticleRevisionService } from '../../src/application/article-revision';
import type { RevisionSaveInput } from '../../src/contracts/article-revision';
export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);
export async function revisionRuntime(root: string) {
  const repository = openArticleRepository(
    join(root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  const formal = createAssetStore(join(root, 'assets'));
  const temp = createManualTempStore(root);
  await temp.recover();
  const images = createManualImageSource(temp, formal);
  const importer = createArticleImportService(repository, formal, {
    read: async () => png,
  });
  await importer.recover();
  let article = repository.findExternal('synthetic');
  if (!article) {
    const result = await importer.importArticle({
      schema_version: 1,
      article_id: 'synthetic',
      title: 'Original',
      body: [
        { type: 'paragraph', text: ' 原文😀\n ' },
        { type: 'image', image_id: 'i' },
      ],
      images: [
        { image_id: 'i', source: { type: 'local', path: 'unused.png' } },
      ],
    });
    if (result.status !== 'imported') throw Error('seed');
    article = result.article;
  }
  const assets = createRevisionAssetStore(
    join(root, 'assets'),
    repository,
    images,
  );
  const service = createArticleRevisionService(
    repository,
    assets,
    importer.importEditedArticle,
  );
  await service.recover();
  return {
    root,
    repository,
    formal,
    temp,
    images,
    importer,
    assets,
    service,
    article,
    token: '',
  };
}
export async function updateInput(
  r: Awaited<ReturnType<typeof revisionRuntime>>,
): Promise<Extract<RevisionSaveInput, { kind: 'updated' }>> {
  const sessionId = randomUUID();
  const authorized = await r.images.authorizeStored(
    sessionId,
    r.article,
    r.article.assets[0].assetKey,
    new AbortController().signal,
  );
  r.token = authorized.image.imageToken;
  return {
    kind: 'updated',
    intent: {
      operationId: randomUUID(),
      sessionId,
      articleKey: r.article.articleKey,
      externalId: r.article.externalId,
      kind: 'updated',
      documentRevision: 2,
      baseRevision: 1,
      payloadDigest: 'b'.repeat(64),
      startedAt: new Date().toISOString(),
    },
    identity: {
      articleKey: r.article.articleKey,
      externalId: r.article.externalId,
      importId: r.article.importId,
      createdAt: r.article.createdAt,
    },
    title: 'Updated',
    contentDeclaration: 'original',
    editorBody: {
      version: 1,
      blocks: [
        { type: 'paragraph', text: '' },
        { type: 'paragraph', text: ' 原文😀\n ' },
        { type: 'image', imageId: 'i' },
      ],
    },
    images: [{ kind: 'stored', imageId: 'i', lease: authorized.lease }],
  };
}
if (process.argv[2] === 'revision-crash')
  void (async () => {
    const [, root, phase] = process.argv.slice(2);
    const r = await revisionRuntime(root);
    const input = await updateInput(r);
    input.intent.operationId = process.argv[5];
    const token = await r.images.authorizeBytes(
      input.intent.sessionId,
      png,
      new AbortController().signal,
    );
    input.images.push({
      kind: 'temporary',
      imageId: 'new',
      sessionId: input.intent.sessionId,
      imageToken: token.imageToken,
    });
    input.editorBody.blocks.push({ type: 'image', imageId: 'new' });
    const checkpoint = async () => {
      process.send?.('checkpoint');
      await new Promise<void>(() => {
        setInterval(() => {}, 1000);
      });
    };
    const prepare = r.assets.prepare;
    r.assets.prepare = async (...args) => {
      const result = await prepare(...args);
      if (phase === 'prepare') await checkpoint();
      return result;
    };
    const finalize = r.assets.finalizeNewFiles;
    r.assets.finalizeNewFiles = async (...args) => {
      if (phase === 'finalize') await checkpoint();
      await finalize(...args);
      if (phase === 'before') await checkpoint();
    };
    const cleanup = r.assets.cleanupOwnedUnreferenced;
    r.assets.cleanupOwnedUnreferenced = async (...args) => {
      if (phase === 'after') await checkpoint();
      await cleanup(...args);
      if (phase === 'cleanup') await checkpoint();
    };
    await r.service.saveRevision(input, new AbortController().signal);
  })().catch(() => process.exit(2));
