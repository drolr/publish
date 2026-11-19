import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type {
  ArticleRepository,
  ImportAttempt,
  StoredArticle,
} from '../../src/domain/ports/article-import';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { openBaselineStore } from '../../src/infrastructure/persistence/database';
import {
  executeImportSql,
  inspectImportDb,
} from '../../src/infrastructure/persistence/testing/article-fixtures';

const base = resolve('.tmp/repository-tests');
const roots: string[] = [];
const stores: ArticleRepository[] = [];
const migrations = resolve('src/infrastructure/persistence/migrations');
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + '\\')) throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function setup() {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  roots.push(root);
  const path = join(root, 'app.sqlite');
  const open = () => {
    const store = openArticleRepository(path, migrations);
    stores.push(store);
    return store;
  };
  return { root, path, open };
}
function article(attempt: ImportAttempt): StoredArticle {
  const assetKey = randomUUID();
  return {
    articleKey: attempt.articleKey,
    externalId: attempt.externalId,
    importId: attempt.importId,
    title: '汽车',
    body: [
      { type: 'paragraph', text: '正文' },
      { type: 'image', image_id: 'front' },
    ],
    contentDeclaration: 'repost',
    createdAt: attempt.startedAt,
    assets: [
      {
        assetKey,
        imageId: 'front',
        relativePath: `${attempt.articleKey}/${assetKey}.png`,
        mime: 'image/png',
        byteSize: 68,
        width: 1,
        height: 1,
        sha256: 'a'.repeat(64),
      },
    ],
  };
}
it('upgrades actual v1, preserves history, commits article and assets together and reopens', () => {
  const { root, path, open } = setup();
  const old = join(root, 'old');
  mkdirSync(old);
  copyFileSync(
    join(migrations, '0001_baseline.sql'),
    join(old, '0001_baseline.sql'),
  );
  openBaselineStore(path, old).close();
  const before = inspectImportDb(path).history;
  const store = open();
  const attempt = store.reserve('news-1');
  const value = article(attempt);
  expect(store.attempts()).toEqual([attempt]);
  store.commit(attempt, value);
  expect(store.attempts()).toEqual([]);
  expect(store.load(value.articleKey)).toEqual(value);
  expect(store.findImport(value.importId)).toEqual(value);
  expect(store.findExternal('news-1')).toEqual(value);
  store.close();
  const reopened = open();
  expect(reopened.getSchemaVersion()).toBe(15);
  expect(reopened.load(value.articleKey)).toEqual(value);
  expect(inspectImportDb(path).history.slice(0, 1)).toEqual(before);
  expect(() => openBaselineStore(path, old)).toThrow(/newer/i);
});
it('persists attempts and statuses and blocks a new reservation while recovery is pending', () => {
  const { open } = setup();
  const store = open();
  const attempt = store.reserve('Case');
  expect(() => store.reserve('Other')).toThrow();
  store.markAttempt(attempt.importId, 'cleanup_required');
  store.close();
  const reopened = open();
  expect(reopened.attempts()).toEqual([
    { ...attempt, status: 'cleanup_required' },
  ]);
  reopened.forgetAttempt(attempt.importId);
  expect(reopened.attempts()).toEqual([]);
});
it('rejects duplicates without overwrite but allows case-distinct external IDs', () => {
  const { open } = setup();
  const store = open();
  const attempt = store.reserve('Case');
  store.commit(attempt, article(attempt));
  expect(() => store.reserve('Case')).toThrow();
  const next = store.reserve('case');
  store.commit(next, article(next));
  expect(store.findExternal('Case')?.articleKey).not.toBe(
    store.findExternal('case')?.articleKey,
  );
});
it('rolls back article and first asset when a later SQL insert fails, retaining the attempt', () => {
  const { path, open } = setup();
  const store = open();
  const attempt = store.reserve('rollback');
  const value = article(attempt);
  const key = randomUUID();
  value.assets.push({
    ...value.assets[0],
    assetKey: key,
    imageId: 'second',
    relativePath: `${attempt.articleKey}/${key}.png`,
  });
  value.body.push({ type: 'image', image_id: 'second' });
  executeImportSql(
    path,
    "CREATE TRIGGER test_fail BEFORE INSERT ON article_assets WHEN NEW.image_id = 'second' BEGIN SELECT RAISE(ABORT, 'sensitive test path'); END;",
  );
  expect(() => store.commit(attempt, value)).toThrow('文章暂时无法保存');
  expect(store.findImport(attempt.importId)).toBeUndefined();
  expect(store.attempts()).toEqual([attempt]);
  expect(inspectImportDb(path).assets).toBe(0);
});
it('rejects a mismatched attempt identity and corrupted stored JSON semantics', () => {
  const { path, open } = setup();
  const store = open();
  const attempt = store.reserve('check');
  const value = article(attempt);
  expect(() =>
    store.commit({ ...attempt, articleKey: randomUUID() }, value),
  ).toThrow();
  store.commit(attempt, value);
  executeImportSql(path, "UPDATE articles SET body_json = '[{}]'");
  expect(() => store.load(value.articleKey)).toThrow('文章暂时无法保存');
});
it('enforces database NOT NULL, enum, positive integer, JSON, unique and foreign-key constraints', () => {
  const { path, open } = setup();
  const store = open();
  const attempt = store.reserve('checks');
  store.commit(attempt, article(attempt));
  for (const sql of [
    'UPDATE articles SET article_key = NULL',
    "UPDATE articles SET content_declaration = 'invalid'",
    "UPDATE articles SET body_json = 'invalid'",
    'UPDATE article_assets SET byte_size = 0',
    'UPDATE article_assets SET width = 1.5',
    "UPDATE article_assets SET article_key = 'missing'",
    "UPDATE article_assets SET mime = 'text/html'",
    'INSERT INTO articles SELECT * FROM articles',
  ])
    expect(() => executeImportSql(path, sql)).toThrow();
});

it('commits pure text and preserves repeated image references without duplicated assets', () => {
  const { open } = setup();
  const store = open();
  const textAttempt = store.reserve('text');
  const text = article(textAttempt);
  text.assets = [];
  text.body = [{ type: 'paragraph', text: '正文' }];
  store.commit(textAttempt, text);
  expect(store.load(text.articleKey)).toEqual(text);
  const imageAttempt = store.reserve('images');
  const image = article(imageAttempt);
  image.body.push({ type: 'image', image_id: 'front' });
  store.commit(imageAttempt, image);
  expect(store.load(image.articleKey)).toEqual(image);
});

it('refuses a forged asset path and invalid recovery records without leaking input', () => {
  const { path, open } = setup();
  const store = open();
  const attempt = store.reserve('safe');
  const value = article(attempt);
  value.assets[0].relativePath = '../private/token.png';
  expect(() => store.commit(attempt, value)).toThrow('文章暂时无法保存');
  expect(store.findImport(attempt.importId)).toBeUndefined();
  executeImportSql(
    path,
    "UPDATE article_import_attempts SET article_key = '../private'",
  );
  expect(() => store.attempts()).toThrow('文章暂时无法保存');
  expect(() => store.reserve('new')).toThrow('文章暂时无法保存');
});

it('never discards a contradictory attempt that references an existing committed article', () => {
  const { path, open } = setup();
  const store = open();
  const attempt = store.reserve('committed');
  store.commit(attempt, article(attempt));
  executeImportSql(
    path,
    `INSERT INTO article_import_attempts VALUES ('${attempt.importId}', '${attempt.articleKey}', '${attempt.externalId}', '${attempt.startedAt}', 'needs_review')`,
  );
  expect(() => store.forgetAttempt(attempt.importId)).toThrow();
  expect(store.attempts()).toHaveLength(1);
  expect(store.findImport(attempt.importId)).toBeDefined();
});

it('returns a fixed safe error after the connection becomes unavailable', () => {
  const { open } = setup();
  const store = open();
  store.close();
  expect(() => store.findExternal('private-url-token')).toThrow(
    '文章暂时无法保存，请检查本地存储后重试。',
  );
});
