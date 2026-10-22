import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { openBaselineStore } from '../../src/infrastructure/persistence/database';
import {
  executeImportSql,
  inspectImportDb,
  seedLegacyStoredArticle,
} from '../../src/infrastructure/persistence/testing/article-fixtures';
import type {
  RevisionIntent,
  SaveReceipt,
} from '../../src/contracts/article-revision';
import type { StoredArticle } from '../../src/contracts/stored-article';
const migrations = resolve('src/infrastructure/persistence/migrations');
const base = resolve('.tmp/article-revisions');
const roots: string[] = [];
const stores: ReturnType<typeof openArticleRepository>[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + '\\')) throw Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function setup(version = 6) {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  roots.push(root);
  const path = join(root, 'app.sqlite');
  if (version < 6) {
    const old = join(root, 'old');
    mkdirSync(old);
    for (const name of readdirSync(migrations).slice(0, version))
      copyFileSync(join(migrations, name), join(old, name));
    openBaselineStore(path, old).close();
  }
  const open = () => {
    const s = openArticleRepository(path, migrations);
    stores.push(s);
    return s;
  };
  return { path, open };
}
function seed(
  s: ReturnType<typeof openArticleRepository>,
  legacyPath?: string,
  positions = 1,
) {
  const a = s.reserve('synthetic-article');
  const key = randomUUID();
  const article: StoredArticle = {
    articleKey: a.articleKey,
    externalId: a.externalId,
    importId: a.importId,
    title: '汽车',
    body: [
      { type: 'paragraph', text: ' 原文😀\n ' },
      ...Array.from({ length: positions }, () => ({
        type: 'image' as const,
        image_id: 'front',
      })),
    ],
    contentDeclaration: 'repost',
    createdAt: a.startedAt,
    assets: [
      {
        assetKey: key,
        imageId: 'front',
        relativePath: `${a.articleKey}/${key}.png`,
        mime: 'image/png',
        byteSize: 68,
        width: 1,
        height: 1,
        sha256: 'a'.repeat(64),
      },
    ],
  };
  if (legacyPath) seedLegacyStoredArticle(legacyPath, article);
  else s.commit(a, article);
  return article;
}
function proposal(article: StoredArticle, baseRevision = 1) {
  const intent: RevisionIntent = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    articleKey: article.articleKey,
    externalId: article.externalId,
    kind: 'updated',
    documentRevision: 2,
    baseRevision,
    payloadDigest: 'b'.repeat(64),
    startedAt: new Date().toISOString(),
  };
  const nextArticle = { ...structuredClone(article), title: '修改' };
  const editorBody = {
    version: 1 as const,
    blocks: [
      { type: 'paragraph' as const, text: '' },
      ...article.body.map((b) =>
        b.type === 'image'
          ? { type: 'image' as const, imageId: b.image_id }
          : b,
      ),
    ],
  };
  const receipt: SaveReceipt = {
    operationId: intent.operationId,
    sessionId: intent.sessionId,
    articleKey: article.articleKey,
    externalId: article.externalId,
    documentRevision: 2,
    articleRevision: baseRevision + 1,
    kind: 'updated',
    payloadDigest: intent.payloadDigest,
    committedAt: new Date().toISOString(),
  };
  return { p: { intent, nextArticle, editorBody }, receipt };
}
it.each([2, 5])(
  'schema%s_to_current_preserves_identity and initial version without mutating task history',
  (version) => {
    const { path, open } = setup(version);
    const old = join(roots.at(-1)!, 'old');
    const pre = openArticleRepository(path, old);
    stores.push(pre);
    const value = seed(pre, path);
    pre.close();
    const store = open();
    expect(store.getSchemaVersion()).toBe(14);
    expect(store.loadEditableArticle(value.articleKey)).toEqual({
      article: value,
      articleRevision: 1,
      editorBody: null,
    });
    expect(store.findImport(value.importId)).toEqual(value);
  },
);
it('atomic_cas_and_receipt_duplicate persists layout, assets and receipt once', () => {
  const { open } = setup();
  const s = open();
  const before = seed(s);
  const { p, receipt } = proposal(before);
  expect(s.beginRevision(p.intent).status).toBe('not_started');
  expect(s.commitRevision(1, p, receipt)).toEqual({
    status: 'committed',
    receipt,
  });
  expect(s.loadEditableArticle(before.articleKey)).toEqual({
    article: p.nextArticle,
    articleRevision: 2,
    editorBody: p.editorBody,
  });
  expect(s.commitRevision(1, p, receipt)).toEqual({
    status: 'already_committed',
    receipt,
  });
  expect(s.loadEditableArticle(before.articleKey)?.articleRevision).toBe(2);
  const stale = proposal(before);
  s.beginRevision(stale.p.intent);
  expect(s.commitRevision(1, stale.p, stale.receipt).status).toBe('conflict');
  s.close();
  expect(open().readSaveReceipt(receipt.operationId)).toEqual(receipt);
});
it('f06_aba_changes_revision only on actual changes preserving layout', () => {
  const { open } = setup();
  const s = open();
  const value = seed(s);
  const { p, receipt } = proposal(value);
  s.beginRevision(p.intent);
  s.commitRevision(1, p, receipt);
  for (const [expected, declaration] of [
    ['repost', 'original'],
    ['original', 'repost'],
    ['repost', 'repost'],
  ] as const)
    s.setArticleDeclarations!({
      targets: [
        { articleKey: value.articleKey, expectedDeclaration: expected },
      ],
      declaration,
    });
  expect(s.loadEditableArticle(value.articleKey)?.articleRevision).toBe(4);
  expect(s.loadEditableArticle(value.articleKey)?.editorBody).toEqual(
    p.editorBody,
  );
  const stale = proposal(p.nextArticle, 2);
  s.beginRevision(stale.p.intent);
  expect(s.commitRevision(2, stale.p, stale.receipt).status).toBe('conflict');
});
it('rolls back full revision on asset failure and rejects mismatched projection/operation', () => {
  const { path, open } = setup();
  const s = open();
  const value = seed(s);
  const { p, receipt } = proposal(value);
  s.beginRevision(p.intent);
  expect(
    s.commitRevision(
      1,
      {
        ...p,
        editorBody: {
          version: 1,
          blocks: [{ type: 'paragraph', text: 'different' }],
        },
      },
      receipt,
    ).status,
  ).toBe('invalid');
  executeImportSql(
    path,
    "CREATE TRIGGER fail_revision BEFORE UPDATE ON articles BEGIN SELECT RAISE(ABORT,'private'); END;",
  );
  expect(s.commitRevision(1, p, receipt).status).toBe('unavailable');
  expect(s.loadEditableArticle(value.articleKey)?.articleRevision).toBe(1);
  expect(s.readSaveReceipt(receipt.operationId)).toBeUndefined();
});

it('unchanged at same version adds neither version nor receipt nor intent', () => {
  const { open } = setup();
  const s = open();
  const article = seed(s);
  const { p, receipt } = proposal(article);
  p.nextArticle = article;
  p.editorBody = {
    version: 1,
    blocks: article.body.map((b) =>
      b.type === 'image' ? { type: 'image', imageId: b.image_id } : b,
    ),
  };
  expect(s.commitRevision(1, p, receipt).status).toBe('invalid');
  expect(s.loadEditableArticle(article.articleKey)?.articleRevision).toBe(1);
  expect(s.readSaveReceipt(receipt.operationId)).toBeUndefined();
  expect(s.listRevisionOperations()).toEqual([]);
});
it('new receipt commits with original reserve once, rollback and duplicate protection remain atomic', () => {
  const { path, open } = setup();
  const s = open();
  const a = s.reserve('new-public');
  const article: StoredArticle = {
    articleKey: a.articleKey,
    externalId: a.externalId,
    importId: a.importId,
    title: '新文',
    body: [{ type: 'paragraph', text: '正文' }],
    contentDeclaration: 'repost',
    createdAt: a.startedAt,
    assets: [],
  };
  const intent: RevisionIntent = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    articleKey: a.articleKey,
    externalId: a.externalId,
    documentRevision: 3,
    kind: 'created',
    baseRevision: 0,
    payloadDigest: 'c'.repeat(64),
    startedAt: a.startedAt,
  };
  const receipt: SaveReceipt = {
    operationId: intent.operationId,
    sessionId: intent.sessionId,
    articleKey: a.articleKey,
    externalId: a.externalId,
    documentRevision: 3,
    articleRevision: 1,
    kind: 'created',
    payloadDigest: intent.payloadDigest,
    committedAt: new Date().toISOString(),
  };
  const editorBody = {
    version: 1 as const,
    blocks: [
      { type: 'paragraph' as const, text: '' },
      { type: 'paragraph' as const, text: '正文' },
    ],
  };
  expect(s.beginRevision(intent).status).toBe('not_started');
  expect(() =>
    s.commit(a, article, {
      receipt: { ...receipt, documentRevision: 4 },
      editorBody,
    }),
  ).toThrow();
  expect(s.load(article.articleKey)).toBeUndefined();
  expect(s.attempts()).toEqual([a]);
  expect(s.readSaveReceipt(intent.operationId)).toBeUndefined();
  s.commit(a, article, { receipt, editorBody });
  s.commit(a, article, { receipt, editorBody });
  expect(s.readSaveReceipt(intent.operationId)).toEqual(receipt);
  expect(s.attempts()).toEqual([]);
  expect(s.loadEditableArticle(article.articleKey)?.articleRevision).toBe(1);
  const listed = s.list!();
  if (listed.status !== 'ok') throw new Error('Library unavailable');
  expect(listed.page.items).toHaveLength(1);
  expect(listed.page.membershipRevision).toBe(1);
  executeImportSql(path, 'UPDATE articles SET title = title');
  s.close();
  expect(open().readSaveReceipt(intent.operationId)).toEqual(receipt);
});
it('committed cleanup never clears receipt and recovery only lists unresolved operations', () => {
  const { open } = setup();
  const s = open();
  const article = seed(s);
  const { p, receipt } = proposal(article);
  s.beginRevision(p.intent);
  s.commitRevision(1, p, receipt);
  s.markRevisionOperation(receipt.operationId, { status: 'cleanup_required' });
  expect(s.readSaveReceipt(receipt.operationId)).toEqual(receipt);
  expect(() =>
    s.markRevisionOperation(receipt.operationId, { status: 'failed' }),
  ).toThrow();
  expect(() =>
    s.markRevisionOperation(receipt.operationId, {
      committedRevision: null,
    } as never),
  ).toThrow();
  s.markRevisionOperation(receipt.operationId, {
    status: 'committed',
    cleanupComplete: true,
  });
  expect(s.listRevisionOperations()).toEqual([]);
  expect(s.readSaveReceipt(receipt.operationId)).toEqual(receipt);
});
it('same ID requires same intent and proposal, preparing restart never claims a writer', () => {
  const { open } = setup();
  const s = open();
  const article = seed(s);
  const { p, receipt } = proposal(article);
  s.beginRevision(p.intent);
  s.close();
  const reopened = open();
  expect(reopened.beginRevision(p.intent).status).toBe('needs_review');
  expect(
    reopened.beginRevision({ ...p.intent, payloadDigest: 'd'.repeat(64) })
      .status,
  ).toBe('needs_review');
  expect(reopened.commitRevision(1, p, receipt).status).toBe('committed');
  expect(
    reopened.commitRevision(
      1,
      { ...p, nextArticle: { ...p.nextArticle, title: 'changed payload' } },
      receipt,
    ).status,
  ).toBe('invalid');
});
it('two connections CAS one revision, including layout-only changes and immutable assets', () => {
  const { open } = setup();
  const s = open();
  const article = seed(s);
  const other = open();
  const first = proposal(article);
  first.p.nextArticle = article;
  const second = proposal(article);
  s.beginRevision(first.p.intent);
  other.beginRevision(second.p.intent);
  expect(s.commitRevision(1, first.p, first.receipt).status).toBe('committed');
  expect(other.commitRevision(1, second.p, second.receipt).status).toBe(
    'conflict',
  );
  expect(other.loadEditableArticle(article.articleKey)?.articleRevision).toBe(
    2,
  );
  const next = proposal(article, 2);
  s.beginRevision(next.p.intent);
  next.p.nextArticle.assets = [
    { ...article.assets[0], sha256: 'e'.repeat(64) },
  ];
  expect(s.commitRevision(2, next.p, next.receipt).status).toBe('invalid');
});
it('legacy repeated image positions can remain or reduce but cannot grow over new budget', () => {
  const { open } = setup();
  const s = open();
  const article = seed(s, undefined, 201);
  const first = proposal(article);
  s.beginRevision(first.p.intent);
  expect(s.commitRevision(1, first.p, first.receipt).status).toBe('committed');
  const grow = proposal(first.p.nextArticle, 2);
  grow.p.nextArticle.body.push({ type: 'image', image_id: 'front' });
  grow.p.editorBody.blocks.push({ type: 'image', imageId: 'front' });
  s.beginRevision(grow.p.intent);
  expect(s.commitRevision(2, grow.p, grow.receipt).status).toBe('invalid');
  const reduce = proposal(first.p.nextArticle, 2);
  reduce.p.nextArticle.body.pop();
  reduce.p.editorBody.blocks.pop();
  s.beginRevision(reduce.p.intent);
  expect(s.commitRevision(2, reduce.p, reduce.receipt).status).toBe(
    'committed',
  );
  expect(s.loadEditableArticle(article.articleKey)?.article.assets).toEqual(
    article.assets,
  );
});
it('later asset insert and receipt failures roll back article, metadata and version together', () => {
  const { path, open } = setup();
  const s = open();
  const article = seed(s);
  const { p, receipt } = proposal(article);
  const key = randomUUID();
  p.nextArticle.assets.push({
    ...article.assets[0],
    assetKey: key,
    imageId: 'second',
    relativePath: `${article.articleKey}/${key}.png`,
  });
  p.nextArticle.body.push({ type: 'image', image_id: 'second' });
  p.editorBody.blocks.push({ type: 'image', imageId: 'second' });
  s.beginRevision(p.intent);
  executeImportSql(
    path,
    "CREATE TRIGGER fail_asset BEFORE INSERT ON article_assets WHEN NEW.image_id = 'second' BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
  );
  expect(s.commitRevision(1, p, receipt).status).toBe('unavailable');
  expect(s.loadEditableArticle(article.articleKey)).toEqual({
    article,
    articleRevision: 1,
    editorBody: null,
  });
  expect(s.readSaveReceipt(receipt.operationId)).toBeUndefined();
  executeImportSql(
    path,
    "DROP TRIGGER fail_asset; CREATE TRIGGER fail_receipt BEFORE UPDATE ON article_edit_operations WHEN NEW.status = 'committed' BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
  );
  expect(s.commitRevision(1, p, receipt).status).toBe('unavailable');
  expect(s.loadEditableArticle(article.articleKey)).toEqual({
    article,
    articleRevision: 1,
    editorBody: null,
  });
});

it('canonical proposal digest tolerates metadata order on duplicate commit without new revision', () => {
  const { open } = setup();
  const s = open();
  const article = seed(s);
  const { p, receipt } = proposal(article);
  const key = randomUUID();
  p.nextArticle.assets.push({
    ...article.assets[0],
    assetKey: key,
    imageId: 'second',
    relativePath: `${article.articleKey}/${key}.png`,
  });
  p.nextArticle.body.push({ type: 'image', image_id: 'second' });
  p.editorBody.blocks.push({ type: 'image', imageId: 'second' });
  s.beginRevision(p.intent);
  expect(s.commitRevision(1, p, receipt).status).toBe('committed');
  expect(
    s.commitRevision(
      1,
      {
        ...p,
        nextArticle: {
          ...p.nextArticle,
          assets: [...p.nextArticle.assets].reverse(),
        },
      },
      receipt,
    ).status,
  ).toBe('already_committed');
  expect(s.loadEditableArticle(article.articleKey)?.articleRevision).toBe(2);
});

it.each(['same-external', 'different-external'])(
  'rejects abandoned intent A when committing reserved B (%s) without changing any persisted state',
  (variant) => {
    const { path, open } = setup();
    const s = open();
    const existing = seed(s);
    const first = s.reserve('abandoned-public');
    const intent: RevisionIntent = {
      operationId: randomUUID(),
      sessionId: randomUUID(),
      articleKey: first.articleKey,
      externalId: first.externalId,
      documentRevision: 1,
      kind: 'created',
      baseRevision: 0,
      payloadDigest: 'f'.repeat(64),
      startedAt: first.startedAt,
    };
    const receipt: SaveReceipt = {
      operationId: intent.operationId,
      sessionId: intent.sessionId,
      articleKey: intent.articleKey,
      externalId: intent.externalId,
      documentRevision: 1,
      articleRevision: 1,
      kind: 'created',
      payloadDigest: intent.payloadDigest,
      committedAt: new Date().toISOString(),
    };
    expect(s.beginRevision(intent).status).toBe('not_started');
    s.forgetAttempt(first.importId);
    const current = s.reserve(
      variant === 'same-external' ? first.externalId : 'reserved-other-public',
    );
    const assetKey = randomUUID();
    const article: StoredArticle = {
      ...existing,
      articleKey: current.articleKey,
      externalId: current.externalId,
      importId: current.importId,
      createdAt: current.startedAt,
      assets: [
        {
          ...existing.assets[0],
          assetKey,
          relativePath: `${current.articleKey}/${assetKey}.png`,
        },
      ],
    };
    const editorBody = {
      version: 1 as const,
      blocks: article.body.map((b) =>
        b.type === 'image'
          ? { type: 'image' as const, imageId: b.image_id }
          : b,
      ),
    };
    const before = {
      operations: s.listRevisionOperations(),
      attempts: s.attempts(),
      articles: s.list!(),
      db: inspectImportDb(path),
    };
    expect(() => s.commit(current, article, { receipt, editorBody })).toThrow(
      '文章暂时无法保存',
    );
    expect(s.load(current.articleKey)).toBeUndefined();
    expect(s.load(first.articleKey)).toBeUndefined();
    expect(s.readSaveReceipt(intent.operationId)).toBeUndefined();
    expect(s.load(existing.articleKey)).toEqual(existing);
    expect({
      operations: s.listRevisionOperations(),
      attempts: s.attempts(),
      articles: s.list!(),
      db: inspectImportDb(path),
    }).toEqual(before);
  },
);
it('rejects matching-key intent and receipt with wrong external identity before first-save commit', () => {
  const { path, open } = setup();
  const s = open();
  const attempt = s.reserve('current-public');
  const article: StoredArticle = {
    articleKey: attempt.articleKey,
    externalId: attempt.externalId,
    importId: attempt.importId,
    title: '正文',
    body: [{ type: 'paragraph', text: 'synthetic' }],
    contentDeclaration: 'repost',
    createdAt: attempt.startedAt,
    assets: [],
  };
  const intent: RevisionIntent = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    articleKey: attempt.articleKey,
    externalId: attempt.externalId,
    documentRevision: 1,
    kind: 'created',
    baseRevision: 0,
    payloadDigest: 'f'.repeat(64),
    startedAt: attempt.startedAt,
  };
  s.beginRevision(intent);
  // Infrastructure corruption fixture isolates externalId validation while articleKey matches.
  executeImportSql(
    path,
    "UPDATE article_edit_operations SET external_id = 'wrong-public'",
  );
  const receipt: SaveReceipt = {
    operationId: intent.operationId,
    sessionId: intent.sessionId,
    articleKey: intent.articleKey,
    externalId: 'wrong-public',
    documentRevision: 1,
    articleRevision: 1,
    kind: 'created',
    payloadDigest: intent.payloadDigest,
    committedAt: new Date().toISOString(),
  };
  const before = {
    operations: s.listRevisionOperations(),
    attempts: s.attempts(),
    db: inspectImportDb(path),
  };
  expect(() =>
    s.commit(attempt, article, {
      receipt,
      editorBody: {
        version: 1,
        blocks: article.body.map((b) =>
          b.type === 'image'
            ? { type: 'image' as const, imageId: b.image_id }
            : b,
        ),
      },
    }),
  ).toThrow('文章暂时无法保存');
  expect(s.load(article.articleKey)).toBeUndefined();
  expect(s.readSaveReceipt(intent.operationId)).toBeUndefined();
  expect({
    operations: s.listRevisionOperations(),
    attempts: s.attempts(),
    db: inspectImportDb(path),
  }).toEqual(before);
});
