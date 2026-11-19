import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ArticleRepository,
  AssetStore,
  StoredArticle,
} from '../../src/domain/ports/article-import';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { executeImportSql } from '../../src/infrastructure/persistence/testing/article-fixtures';
import { createArticleImportService } from '../../src/application/article-import';
import { createArticleLibrary } from '../../src/application/article-library';

const base = resolve('.tmp/declaration-tests');
const roots: string[] = [];
const stores: ArticleRepository[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + '\\')) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function setup() {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  roots.push(root);
  const path = join(root, 'app.sqlite');
  const open = () => {
    const repo = openArticleRepository(
      path,
      resolve('src/infrastructure/persistence/migrations'),
    );
    stores.push(repo);
    return repo;
  };
  const repo = open();
  function add(
    externalId: string,
    contentDeclaration: 'original' | 'repost' = 'repost',
  ) {
    const attempt = repo.reserve(externalId);
    const assetKey = randomUUID();
    const article: StoredArticle = {
      articleKey: attempt.articleKey,
      externalId,
      importId: attempt.importId,
      title: externalId,
      body: [
        { type: 'paragraph', text: 'Body' },
        { type: 'image', image_id: 'img' },
      ],
      contentDeclaration,
      createdAt: attempt.startedAt,
      assets: [
        {
          assetKey,
          imageId: 'img',
          relativePath: `${attempt.articleKey}/${assetKey}.png`,
          mime: 'image/png',
          byteSize: 3,
          width: 1,
          height: 1,
          sha256: 'a'.repeat(64),
        },
      ],
    };
    repo.commit(attempt, article);
    return article;
  }
  return { root, path, repo, open, add };
}
function target(article: StoredArticle) {
  return {
    articleKey: article.articleKey,
    expectedDeclaration: article.contentDeclaration,
  };
}
it('atomically changes a mixed selection, counts no-ops, preserves all other fields and reopens', () => {
  const { repo, add, open, root } = setup();
  const first = add('first');
  const second = add('second', 'original');
  const untouched = add('untouched');
  mkdirSync(join(root, 'assets', first.articleKey), { recursive: true });
  const bytesPath = join(root, 'assets', first.assets[0].relativePath);
  const bytes = Buffer.from([1, 2, 3]);
  writeFileSync(bytesPath, bytes);
  const result = repo.setArticleDeclarations!({
    targets: [target(first), target(second)],
    declaration: 'original',
  });
  expect(result).toMatchObject({
    status: 'updated',
    changedCount: 1,
    unchangedCount: 1,
  });
  expect(repo.load(first.articleKey)).toEqual({
    ...first,
    contentDeclaration: 'original',
  });
  expect(repo.load(second.articleKey)).toEqual(second);
  expect(repo.load(untouched.articleKey)).toEqual(untouched);
  expect(readFileSync(bytesPath)).toEqual(bytes);
  repo.close();
  const reopened = open();
  expect(reopened.load(first.articleKey)).toEqual({
    ...first,
    contentDeclaration: 'original',
  });
  expect(reopened.getSchemaVersion()).toBe(15);
});
it('rejects any missing target before writes and reads never return partial success', () => {
  const { repo, add } = setup();
  const first = add('first');
  const missing = randomUUID();
  const targets = [
    target(first),
    { articleKey: missing, expectedDeclaration: 'repost' as const },
  ];
  expect(
    repo.setArticleDeclarations!({ targets, declaration: 'original' }),
  ).toEqual({ status: 'not_found', articleKeys: [missing] });
  expect(repo.getArticleDeclarations!([first.articleKey, missing])).toEqual({
    status: 'not_found',
    articleKeys: [missing],
  });
  expect(repo.load(first.articleKey)).toEqual(first);
});
it('rejects stale expectations before any write, including conflicting same-value targets', () => {
  const { repo, add } = setup();
  const first = add('first');
  const second = add('second', 'original');
  expect(
    repo.setArticleDeclarations!({
      targets: [
        target(first),
        { articleKey: second.articleKey, expectedDeclaration: 'repost' },
      ],
      declaration: 'original',
    }),
  ).toEqual({ status: 'conflict', articleKeys: [second.articleKey] });
  expect(repo.load(first.articleKey)).toEqual(first);
  expect(repo.load(second.articleKey)).toEqual(second);
});
it('rolls back earlier updates when later SQL fails and sanitizes the error', () => {
  const { repo, add, path } = setup();
  const first = add('first');
  const second = add('second');
  executeImportSql(
    path,
    "CREATE TRIGGER fail_second BEFORE UPDATE ON articles WHEN OLD.external_id = 'second' BEGIN SELECT RAISE(ABORT, 'private path token'); END;",
  );
  expect(
    repo.setArticleDeclarations!({
      targets: [target(first), target(second)],
      declaration: 'original',
    }),
  ).toEqual({ status: 'unavailable' });
  expect(repo.load(first.articleKey)).toEqual(first);
  expect(repo.load(second.articleKey)).toEqual(second);
});
it('does not issue SQL updates for same-value targets', () => {
  const { repo, add, path } = setup();
  const first = add('first');
  executeImportSql(
    path,
    "CREATE TRIGGER reject_update BEFORE UPDATE ON articles BEGIN SELECT RAISE(ABORT, 'must not update'); END;",
  );
  expect(
    repo.setArticleDeclarations!({
      targets: [target(first)],
      declaration: 'repost',
    }),
  ).toMatchObject({ status: 'updated', changedCount: 0, unchangedCount: 1 });
});
it('validates all persisted declarations before writes and fails closed after close', () => {
  const { repo, add, path } = setup();
  const first = add('first');
  const second = add('second');
  executeImportSql(
    path,
    "PRAGMA ignore_check_constraints = ON; UPDATE articles SET content_declaration = 'invalid' WHERE external_id = 'second';",
  );
  expect(
    repo.setArticleDeclarations!({
      targets: [target(first), target(second)],
      declaration: 'original',
    }),
  ).toEqual({ status: 'unavailable' });
  expect(repo.load(first.articleKey)).toEqual(first);
  expect(repo.getArticleDeclarations!([second.articleKey])).toEqual({
    status: 'unavailable',
  });
  repo.close();
  expect(repo.getArticleDeclarations!([first.articleKey])).toEqual({
    status: 'unavailable',
  });
});
it('reads and changes declarations despite corrupt body/assets while preview remains unavailable', async () => {
  const { repo, add, path } = setup();
  const first = add('first');
  executeImportSql(path, "UPDATE articles SET body_json = '[{}]';");
  const verify = vi.fn(async () => {
    throw new Error('missing image');
  });
  const library = createArticleLibrary(
    repo,
    {
      verify,
    } as unknown as AssetStore,
    repo,
  );
  expect(repo.getArticleDeclarations!([first.articleKey])).toMatchObject({
    status: 'ok',
    items: [{ articleKey: first.articleKey, contentDeclaration: 'repost' }],
  });
  expect(
    repo.setArticleDeclarations!({
      targets: [target(first)],
      declaration: 'original',
    }),
  ).toMatchObject({ status: 'updated' });
  expect(await library.getArticlePreview(first.articleKey)).toEqual({
    status: 'unavailable',
  });
  expect(verify).not.toHaveBeenCalled();
});
it('retains human declaration when same external ID is imported again without reading assets', async () => {
  const { repo, add } = setup();
  const first = add('news');
  expect(
    repo.setArticleDeclarations!({
      targets: [target(first)],
      declaration: 'original',
    }),
  ).toMatchObject({ status: 'updated' });
  const read = vi.fn(async () => new Uint8Array());
  const service = createArticleImportService(repo, {} as AssetStore, { read });
  expect(await service.recover()).toBe(true);
  const result = await service.importArticle({
    schema_version: 1,
    article_id: 'news',
    title: 'replacement',
    body: [{ type: 'paragraph', text: 'new' }],
    images: [],
    content_declaration: 'repost',
  });
  expect(result).toMatchObject({
    status: 'already_exists',
    article: { ...first, contentDeclaration: 'original' },
  });
  expect(read).not.toHaveBeenCalled();
});
it('supports the 100 item boundary and returns items in request order', () => {
  const { repo, add } = setup();
  const articles = Array.from({ length: 100 }, (_, i) =>
    add(`article-${i}`, i % 2 ? 'original' : 'repost'),
  ).reverse();
  const result = repo.setArticleDeclarations!({
    targets: articles.map(target),
    declaration: 'repost',
  });
  expect(result).toMatchObject({
    status: 'updated',
    changedCount: 50,
    unchangedCount: 50,
  });
  if (result.status !== 'updated') throw new Error('Expected update');
  expect(result.items.map((item) => item.articleKey)).toEqual(
    articles.map((article) => article.articleKey),
  );
  expect(
    repo.getArticleDeclarations!(articles.map((article) => article.articleKey)),
  ).toEqual({ status: 'ok', items: result.items });
});
it('rejects malformed direct repository requests without changing durable data', () => {
  const { repo, add } = setup();
  const first = add('first');
  expect(repo.getArticleDeclarations!([])).toEqual({ status: 'unavailable' });
  expect(
    repo.getArticleDeclarations!([first.articleKey, first.articleKey]),
  ).toEqual({ status: 'unavailable' });
  expect(
    repo.setArticleDeclarations!({
      targets: [target(first), target(first)],
      declaration: 'original',
    }),
  ).toEqual({ status: 'unavailable' });
  expect(repo.load(first.articleKey)).toEqual(first);
});
it('does not inspect missing image bytes while modifying valid article metadata', async () => {
  const { repo, add } = setup();
  const first = add('first');
  const verify = vi.fn(async () => {
    throw new Error('missing image');
  });
  const library = createArticleLibrary(
    repo,
    {
      verify,
    } as unknown as AssetStore,
    repo,
  );
  expect(
    repo.setArticleDeclarations!({
      targets: [target(first)],
      declaration: 'original',
    }),
  ).toMatchObject({ status: 'updated' });
  expect(verify).not.toHaveBeenCalled();
  expect(await library.getArticlePreview(first.articleKey)).toEqual({
    status: 'unavailable',
  });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(repo.load(first.articleKey)).toEqual({
    ...first,
    contentDeclaration: 'original',
  });
});
