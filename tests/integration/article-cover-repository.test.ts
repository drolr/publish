import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { executeImportSql } from '../../src/infrastructure/persistence/testing/article-fixtures';
import { coverConfigurationDigest } from '../../src/infrastructure/persistence/article-cover-repository';
const roots: string[] = [];
const stores: ReturnType<typeof openArticleRepository>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const base = resolve('.tmp/covers');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  roots.push(root);
  const db = join(root, 'app.sqlite');
  const s = openArticleRepository(
    db,
    resolve('src/infrastructure/persistence/migrations'),
  );
  stores.push(s);
  const a = s.reserve(randomUUID());
  s.commit(a, {
    articleKey: a.articleKey,
    externalId: a.externalId,
    importId: a.importId,
    title: '封面文章',
    body: [{ type: 'paragraph', text: '正文' }],
    contentDeclaration: 'original',
    createdAt: a.startedAt,
    assets: [],
  });
  return { s, db, key: a.articleKey };
}
function intent(
  key: string,
  mode: 'none' | 'single' | 'triple' = 'none',
  revision = 0,
) {
  return {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    articleKey: key,
    expectedArticleRevision: 1,
    expectedCoverRevision: revision,
    draftRevision: 0,
    mode,
    payloadDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    startedAt: '2026-10-09T00:00:00.000Z',
  };
}
it('immutable_none_versions_receipts preserve article revision and reject operation reuse', () => {
  const { s, key } = setup();
  expect(s.loadCover(key)?.coverRevision).toBe(0);
  const op = intent(key);
  expect(s.beginCoverSave(op).status).toBe('not_started');
  const result = s.commitCoverVersion(op, []);
  expect(result.status).toBe('committed');
  expect(s.readCoverSaveResult(op.operationId)).toEqual(result);
  expect(
    s.beginCoverSave({ ...op, payloadDigest: 'e'.repeat(64) }).status,
  ).toBe('needs_review');
  expect(s.loadEditableArticle(key)?.articleRevision).toBe(1);
  expect(s.loadCover(key)).toMatchObject({
    coverRevision: 1,
    mode: 'none',
    configurationDigest: coverConfigurationDigest(key, 1, 'none', []),
  });
  expect(s.commitCoverVersion(op, [])).toEqual(result);
});
it('CAS deleted_body_changed_cover_changed_and_task_hold preserve previous head', () => {
  for (const sql of [
    'UPDATE articles SET content_revision=2',
    "UPDATE articles SET deleted_at='2026-10-09T00:00:00.000Z'",
    "INSERT INTO judongche_draft_tasks (task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,created_at,updated_at) SELECT 'hold','p',article_key,'judongche','draft','s','{}','{}','d','store-material-first','needs_human','settled',1,0,0,0,1,'[]',created_at,created_at FROM articles",
  ]) {
    const { s, db, key } = setup();
    const op = intent(key);
    s.beginCoverSave(op);
    executeImportSql(db, sql);
    expect(['conflict', 'blocked']).toContain(
      s.commitCoverVersion(op, []).status,
    );
    expect(s.loadArchivedCoverVersion(key, 0)?.coverRevision).toBe(0);
    expect(s.readCoverSaveResult(op.operationId).status).not.toBe('committed');
  }
  const { s, key } = setup();
  const first = intent(key);
  s.beginCoverSave(first);
  s.commitCoverVersion(first, []);
  const stale = intent(key);
  expect(s.beginCoverSave(stale).status).toBe('conflict');
});
it('digest canonicalizes strict metadata field order but preserves triple ordering', () => {
  const key = randomUUID();
  const operationId = randomUUID();
  const assetKey = randomUUID();
  const a = {
    assetKey,
    relativePath: key + '/' + operationId + '/' + assetKey + '.png',
    mime: 'image/png' as const,
    width: 1,
    height: 1,
    byteSize: 68,
    sha256: 'a'.repeat(64),
  };
  const reverse = {
    sha256: a.sha256,
    byteSize: a.byteSize,
    height: a.height,
    width: a.width,
    mime: a.mime,
    relativePath: a.relativePath,
    assetKey: a.assetKey,
  };
  const b = { ...a, assetKey: randomUUID() };
  b.relativePath = key + '/' + operationId + '/' + b.assetKey + '.png';
  const c = { ...a, assetKey: randomUUID() };
  c.relativePath = key + '/' + operationId + '/' + c.assetKey + '.png';
  expect(coverConfigurationDigest(key, 1, 'triple', [a, b, c])).not.toBe(
    coverConfigurationDigest(key, 1, 'triple', [c, b, a]),
  );
  expect(coverConfigurationDigest(key, 1, 'single', [a])).toBe(
    coverConfigurationDigest(key, 1, 'single', [reverse]),
  );
});
it('owned journal declarations cannot change identity or shrink after a file is declared', () => {
  const { s, key } = setup();
  const op = intent(key, 'single');
  s.beginCoverSave(op);
  const assetKey = randomUUID();
  const file = {
    assetKey,
    relativePath: key + '/' + op.operationId + '/' + assetKey + '.png',
    mime: 'image/png' as const,
    width: 1,
    height: 1,
    byteSize: 68,
    sha256: 'a'.repeat(64),
    ownerNonce: randomUUID(),
    fileIdentity: 'file-1',
    complete: false,
  };
  s.markCoverOperation(op.operationId, { ownedFiles: [file] });
  expect(() =>
    s.markCoverOperation(op.operationId, {
      ownedFiles: [{ ...file, fileIdentity: 'file-2' }],
    }),
  ).toThrow();
  expect(() =>
    s.markCoverOperation(op.operationId, { ownedFiles: [] }),
  ).toThrow();
  s.markCoverOperation(op.operationId, {
    ownedFiles: [{ ...file, complete: true }],
  });
  expect(s.readCoverOperation(op.operationId)?.ownedFiles[0].complete).toBe(
    true,
  );
});

it('active tombstone reads reject while immutable receipt and archive version survive', () => {
  const { s, key, db } = setup();
  const op = intent(key);
  s.beginCoverSave(op);
  const committed = s.commitCoverVersion(op, []);
  executeImportSql(
    db,
    "UPDATE articles SET deleted_at='2026-10-09T00:00:00.000Z',content_revision=2",
  );
  expect(s.loadCover(key)).toBeUndefined();
  expect(s.loadEditableArticle(key)).toBeUndefined();
  expect(s.loadArchivedCoverVersion(key, 1)).toMatchObject({
    mode: 'none',
    coverRevision: 1,
    saveOperationId: op.operationId,
  });
  expect(s.readCoverSaveResult(op.operationId)).toEqual(committed);
  expect(s.loadArchivedEditableArticle(key)?.articleRevision).toBe(2);
});
