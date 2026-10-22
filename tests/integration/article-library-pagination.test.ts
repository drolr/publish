import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createArticleLibrary } from '../../src/application/article-library';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import {
  executeImportSql,
  duringLibrarySnapshot,
} from '../../src/infrastructure/persistence/testing/article-fixtures';
import type { ArticlePage } from '../../src/contracts/article-library';
import type { StoredArticle } from '../../src/contracts/stored-article';
import type { AssetStore } from '../../src/domain/ports/article-import';

const base = resolve('.tmp/library-pagination');
const roots: string[] = [];
const stores: ReturnType<typeof openArticleRepository>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + sep)) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function setup() {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  roots.push(root);
  const path = join(root, 'app.sqlite');
  const open = () => {
    const store = openArticleRepository(
      path,
      resolve('src/infrastructure/persistence/migrations'),
    );
    stores.push(store);
    return store;
  };
  const store = open();
  const library = createArticleLibrary(
    store,
    {
      verify: async () => {},
    } as unknown as AssetStore,
    store,
  );
  return { path, store, library, open };
}
function commit(
  store: ReturnType<typeof openArticleRepository>,
  id: string = randomUUID(),
) {
  const attempt = store.reserve(id);
  const article: StoredArticle = {
    articleKey: attempt.articleKey,
    importId: attempt.importId,
    externalId: attempt.externalId,
    title: '汽车',
    body: [{ type: 'paragraph', text: '正文' }],
    contentDeclaration: 'repost',
    createdAt: '2026-10-09T00:00:00.000Z',
    assets: [],
  };
  store.commit(attempt, article);
  return article;
}
async function firstPage(
  library: ReturnType<typeof createArticleLibrary>,
): Promise<ArticlePage> {
  const result = await library.listArticles();
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('Library unavailable');
  return result.page;
}
it.each([
  { count: 0, sizes: [0] },
  { count: 1, sizes: [1] },
  { count: 10, sizes: [10] },
  { count: 11, sizes: [10, 1] },
  { count: 20, sizes: [10, 10] },
  { count: 21, sizes: [10, 10, 1] },
])('page_boundaries: $count committed articles', async ({ count, sizes }) => {
  const { store, library } = setup();
  for (let i = 0; i < count; i++) commit(store);
  const pending = store.reserve('uncommitted');
  let page = await firstPage(library);
  for (let index = 0; index < sizes.length; index++) {
    expect(page).toMatchObject({
      totalCount: count,
      totalPages: sizes.length,
      pageNumber: index + 1,
      membershipRevision: count,
    });
    expect(page.items).toHaveLength(sizes[index]);
    expect(page.items.every((item) => item.articleRevision === 1)).toBe(true);
    if (index === sizes.length - 1) {
      expect(page.nextCursor).toBeUndefined();
    } else {
      expect(page.nextCursor).toMatchObject({
        membershipRevision: count,
        pageNumber: index + 2,
      });
      const result = await library.listArticles(page.nextCursor);
      if (result.status !== 'ok') throw new Error('Library unavailable');
      page = result.page;
    }
  }
  store.forgetAttempt(pending.importId);
});
it('same_timestamp_21_rows: visits every key once in descending key order', async () => {
  const { store, library, path } = setup();
  const keys = Array.from({ length: 21 }, () => commit(store).articleKey);
  // Summary pagination must not load body JSON.
  executeImportSql(path, "UPDATE articles SET body_json = '[{}]'");
  const seen: string[] = [];
  let page = await firstPage(library);
  while (true) {
    seen.push(...page.items.map((item) => item.articleKey));
    if (!page.nextCursor) break;
    const result = await library.listArticles(page.nextCursor);
    if (result.status !== 'ok') throw new Error('Library unavailable');
    page = result.page;
  }
  expect(seen).toEqual(keys.sort().reverse());
  expect(new Set(seen).size).toBe(21);
});
it('membership_change_resets_cursor: new commit invalidates the old cursor across reopen', async () => {
  const { store, library, open } = setup();
  for (let i = 0; i < 11; i++) commit(store);
  const previous = await firstPage(library);
  commit(store);
  expect(await library.listArticles(previous.nextCursor)).toEqual({
    status: 'stale_cursor',
  });
  const reopened = open();
  expect(reopened.list!(previous.nextCursor)).toEqual({
    status: 'stale_cursor',
  });
  expect(await firstPage(library)).toMatchObject({
    totalCount: 12,
    membershipRevision: 12,
    pageNumber: 1,
  });
});
it('count_and_rows_one_snapshot: concurrent WAL commit cannot split count and page items', async () => {
  const { path, store, library, open } = setup();
  commit(store);
  executeImportSql(path, 'PRAGMA journal_mode = WAL');
  const writer = open();
  const inserted = duringLibrarySnapshot(
    () => commit(writer),
    () => store.list!(),
  );
  expect(inserted).toMatchObject({
    status: 'ok',
    page: { totalCount: 1, membershipRevision: 1, pageNumber: 1 },
  });
  if (inserted.status !== 'ok') throw new Error('Library unavailable');
  expect(inserted.page.items).toHaveLength(1);
  expect(await firstPage(library)).toMatchObject({
    totalCount: 2,
    membershipRevision: 2,
  });
});
it('summary and preview revisions change without changing membership or invalidating cursors', async () => {
  const { store, library } = setup();
  const article = commit(store, 'original');
  for (let i = 0; i < 10; i++) commit(store);
  const previous = await firstPage(library);
  expect(() => store.reserve('original')).toThrow();
  expect(
    store.setArticleDeclarations!({
      targets: [
        { articleKey: article.articleKey, expectedDeclaration: 'repost' },
      ],
      declaration: 'original',
    }).status,
  ).toBe('updated');
  expect((await library.listArticles(previous.nextCursor)).status).toBe('ok');
  expect(await firstPage(library)).toMatchObject({
    totalCount: 11,
    membershipRevision: 11,
  });
  expect(await library.getArticlePreview(article.articleKey)).toMatchObject({
    status: 'ok',
    article: { articleRevision: 2, contentDeclaration: 'original' },
  });
});
it('rejects unsafe membership overflow atomically without creating an article', async () => {
  const { store, library, path } = setup();
  executeImportSql(
    path,
    'UPDATE article_library_meta SET membership_revision = 9007199254740991',
  );
  const attempt = store.reserve('overflow');
  expect(() =>
    store.commit(attempt, {
      articleKey: attempt.articleKey,
      importId: attempt.importId,
      externalId: attempt.externalId,
      title: '汽车',
      body: [{ type: 'paragraph', text: '正文' }],
      contentDeclaration: 'repost',
      createdAt: attempt.startedAt,
      assets: [],
    }),
  ).toThrow();
  expect(store.load(attempt.articleKey)).toBeUndefined();
  expect(await firstPage(library)).toMatchObject({
    totalCount: 0,
    membershipRevision: Number.MAX_SAFE_INTEGER,
  });
});
