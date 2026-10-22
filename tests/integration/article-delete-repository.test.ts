import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { revisionRuntime, updateInput } from './revision-crash-child';
import {
  executeImportSql,
  inspectDeletionState,
} from '../../src/infrastructure/persistence/testing/article-fixtures';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import { createDraftSnapshotDigest } from '../../src/infrastructure/draft-snapshot-integrity';
import { makeDraftTask } from '../fixtures/draft-task';
import { createArticleLibrary } from '../../src/application/article-library';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'article-delete-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const r = await revisionRuntime(root);
  cleanup.push(() => r.repository.close());
  const command = {
    operationId: randomUUID(),
    articleKey: r.article.articleKey,
    expectedArticleRevision: 1,
  };
  return { ...r, command, path: join(root, 'app.sqlite') };
}
const now = '2026-10-09T00:00:00.000Z';
it('same_command_once persists lost_delete_reply across reopen', async () => {
  const r = await setup();
  const result = r.repository.deleteArticle(r.command, now);
  expect(result).toEqual({
    status: 'deleted',
    operationId: r.command.operationId,
    articleKey: r.command.articleKey,
    articleRevision: 2,
  });
  expect(r.repository.deleteArticle(r.command, now)).toEqual(result);
  expect(inspectDeletionState(r.path)).toMatchObject({
    membershipRevision: 2,
    articles: [{ deleted_at: now, content_revision: 2 }],
    operations: [{ outcome: 'deleted' }],
  });
  r.repository.close();
  const reopened = openArticleRepository(
    r.path,
    resolve('src/infrastructure/persistence/migrations'),
  );
  cleanup.push(() => reopened.close());
  expect(reopened.readDeletionResult(r.command.operationId)).toEqual(result);
  expect(reopened.deleteArticle(r.command, now)).toEqual(result);
  expect(reopened.isArticleDeleted(r.command.articleKey)).toBe(true);
  expect(reopened.findExternalState(r.article.externalId)).toEqual({
    kind: 'deleted',
    article: r.article,
  });
});
it('delete_after_revision_change records conflict without deleting newer content', async () => {
  const r = await setup();
  r.repository.setArticleDeclarations!({
    targets: [
      { articleKey: r.article.articleKey, expectedDeclaration: 'repost' },
    ],
    declaration: 'original',
  });
  expect(r.repository.deleteArticle(r.command, now)).toEqual({
    status: 'conflict',
    operationId: r.command.operationId,
  });
  expect(inspectDeletionState(r.path)).toMatchObject({
    membershipRevision: 1,
    articles: [{ deleted_at: null, content_revision: 2 }],
    operations: [{ outcome: 'conflict' }],
  });
});
it('operation_payload_mismatch never replaces the original receipt', async () => {
  const r = await setup();
  const original = r.repository.deleteArticle(r.command, now);
  expect(
    r.repository.deleteArticle(
      { ...r.command, expectedArticleRevision: 2 },
      now,
    ),
  ).toEqual({ status: 'blocked', operationId: r.command.operationId });
  expect(r.repository.readDeletionResult(r.command.operationId)).toEqual(
    original,
  );
  expect(inspectDeletionState(r.path).operations).toHaveLength(1);
});
it('a fresh operation on an already deleted article conflicts without a second revision', async () => {
  const r = await setup();
  r.repository.deleteArticle(r.command, now);
  const second = {
    ...r.command,
    operationId: randomUUID(),
    expectedArticleRevision: 2,
  };
  expect(r.repository.deleteArticle(second, now).status).toBe('conflict');
  expect(inspectDeletionState(r.path)).toMatchObject({
    membershipRevision: 2,
    articles: [{ content_revision: 2 }],
  });
});
it('not_found has no dangling receipt and lookup is readonly not_started', async () => {
  const r = await setup();
  const command = { ...r.command, articleKey: randomUUID() };
  expect(r.repository.deleteArticle(command, now)).toEqual({
    status: 'not_found',
    operationId: command.operationId,
  });
  expect(r.repository.readDeletionResult(command.operationId)).toEqual({
    status: 'not_started',
    operationId: command.operationId,
  });
  expect(inspectDeletionState(r.path).operations).toEqual([]);
});
it.each(['content', 'membership'])(
  '%s revision overflow fails closed with a durable blocked receipt',
  async (kind) => {
    const r = await setup();
    executeImportSql(
      r.path,
      kind === 'content'
        ? 'UPDATE articles SET content_revision = 9007199254740991'
        : 'UPDATE article_library_meta SET membership_revision = 9007199254740991',
    );
    const command = {
      ...r.command,
      expectedArticleRevision: kind === 'content' ? Number.MAX_SAFE_INTEGER : 1,
    };
    expect(r.repository.deleteArticle(command, now).status).toBe('blocked');
    expect(inspectDeletionState(r.path)).toMatchObject({
      articles: [{ deleted_at: null }],
      operations: [{ outcome: 'blocked' }],
    });
  },
);
it('receipt failure rolls back tombstone, revision and membership together', async () => {
  const r = await setup();
  executeImportSql(
    r.path,
    "CREATE TRIGGER reject_delete_receipt BEFORE INSERT ON article_delete_operations BEGIN SELECT RAISE(ABORT,'synthetic fault'); END",
  );
  expect(r.repository.deleteArticle(r.command, now).status).toBe('unavailable');
  expect(inspectDeletionState(r.path)).toMatchObject({
    membershipRevision: 1,
    articles: [{ deleted_at: null, content_revision: 1 }],
    operations: [],
  });
});
async function taskFor(r: Awaited<ReturnType<typeof setup>>) {
  const tasks = openDraftTaskRepository(
    r.path,
    resolve('src/infrastructure/persistence/migrations'),
  );
  cleanup.push(() => tasks.close());
  const fixture = makeDraftTask();
  const snapshot = {
    version: 1 as const,
    article: r.article,
    digest: createDraftSnapshotDigest(r.article),
  };
  const input = {
    taskId: randomUUID(),
    preparationId: randomUUID(),
    store: fixture.store,
    snapshot,
    expectedArticleRevision: 1,
    now,
  };
  return { tasks, input };
}
it('holds_platform_blocks_delete', async () => {
  const r = await setup();
  const { tasks, input } = await taskFor(r);
  expect(tasks.reserve(input).status).toBe('created');
  expect(r.repository.deleteArticle(r.command, now).status).toBe('blocked');
  expect(inspectDeletionState(r.path)).toMatchObject({
    membershipRevision: 1,
    articles: [{ deleted_at: null }],
    operations: [{ outcome: 'blocked' }],
  });
});
it('deleted article rejects normal reads, declaration, manual revision and new task reserve while archive identity remains', async () => {
  const r = await setup();
  const input = await updateInput(r);
  expect(r.repository.beginRevision(input.intent).status).toBe('not_started');
  const task = await taskFor(r);
  r.repository.deleteArticle(r.command, now);
  expect(
    r.repository.loadEditableArticle(r.article.articleKey),
  ).toBeUndefined();
  expect(
    r.repository.createEditorCompatibilityLease(
      r.article.articleKey,
      randomUUID(),
      2,
    ),
  ).toBeUndefined();
  expect(
    r.repository.getArticleDeclarations!([r.article.articleKey]).status,
  ).toBe('not_found');
  expect(
    r.repository.setArticleDeclarations!({
      targets: [
        { articleKey: r.article.articleKey, expectedDeclaration: 'repost' },
      ],
      declaration: 'original',
    }).status,
  ).toBe('not_found');
  expect(task.tasks.reserve(task.input).status).toBe('stale');
  const library = createArticleLibrary(r.repository, r.formal, r.repository);
  expect((await library.getArticlePreview(r.article.articleKey)).status).toBe(
    'not_found',
  );
  expect(
    (
      await library.getArticleImage(
        r.article.articleKey,
        r.article.assets[0].assetKey,
      )
    ).status,
  ).toBe('not_found');
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('needs_review');
  expect(
    r.repository.beginRevision({
      ...input.intent,
      operationId: randomUUID(),
      baseRevision: 2,
    }).status,
  ).toBe('needs_review');
  expect(r.repository.load(r.article.articleKey)).toEqual(r.article);
  expect(r.repository.findImport(r.article.importId)).toEqual(r.article);
  expect(r.repository.findExternal(r.article.externalId)).toEqual(r.article);
  expect(() => r.repository.reserve(r.article.externalId)).toThrow();
});
it('global holding task blocks deletion of another active article', async () => {
  const r = await setup();
  const { tasks, input } = await taskFor(r);
  tasks.reserve(input);
  const imported = await r.importer.importArticle({
    schema_version: 1,
    article_id: 'another',
    title: 'Another',
    body: [{ type: 'paragraph', text: 'Synthetic' }],
    images: [],
  });
  if (imported.status !== 'imported') throw Error('synthetic seed');
  const command = {
    operationId: randomUUID(),
    articleKey: imported.article.articleKey,
    expectedArticleRevision: 1,
  };
  expect(r.repository.deleteArticle(command, now).status).toBe('blocked');
  expect(r.repository.isArticleDeleted(command.articleKey)).toBe(false);
});
it('trusted CAS refuses tombstone even with its current revision and a preexisting intent', async () => {
  const r = await setup();
  const input = await updateInput(r);
  input.intent.baseRevision = 2;
  expect(r.repository.beginRevision(input.intent).status).toBe('not_started');
  r.repository.deleteArticle(r.command, now);
  const receipt = {
    operationId: input.intent.operationId,
    sessionId: input.intent.sessionId,
    articleKey: r.article.articleKey,
    externalId: r.article.externalId,
    documentRevision: 2,
    articleRevision: 3,
    kind: 'updated' as const,
    payloadDigest: input.intent.payloadDigest,
    committedAt: now,
  };
  const nextArticle = {
    ...r.article,
    title: 'Must not write',
    body: r.article.body,
  };
  const editorBody = {
    version: 1 as const,
    blocks: r.article.body.map((b) =>
      b.type === 'image' ? { type: 'image' as const, imageId: b.image_id } : b,
    ),
  };
  expect(
    r.repository.commitRevision(
      2,
      { intent: input.intent, nextArticle, editorBody },
      receipt,
    ).status,
  ).toBe('conflict');
  expect(r.repository.readSaveReceipt(receipt.operationId)).toBeUndefined();
  expect(r.repository.load(r.article.articleKey)?.title).toBe('Original');
  expect(inspectDeletionState(r.path)).toMatchObject({
    membershipRevision: 2,
    articles: [{ content_revision: 2 }],
  });
});
it('settled draft history, snapshot, remote identity and assets survive deletion and repository restart', async () => {
  const r = await setup();
  const { tasks, input } = await taskFor(r);
  tasks.reserve(input);
  tasks.apply(input.taskId, 0, { type: 'begin' }, now);
  tasks.apply(input.taskId, 1, { type: 'before-save' }, now);
  tasks.apply(
    input.taskId,
    2,
    {
      type: 'evidence',
      evidence: {
        remote: {
          recordKey: 'synthetic-record',
          editUrl: 'https://example.test/draft/1',
        },
        cover: null,
        images: [
          {
            bodyIndex: 1,
            imageId: 'i',
            assetKey: r.article.assets[0].assetKey,
            resourceKey: 'c'.repeat(64),
          },
        ],
      },
    },
    now,
  );
  tasks.apply(input.taskId, 3, { type: 'verify' }, now);
  const original = tasks.apply(
    input.taskId,
    4,
    { type: 'settle', state: 'draft_saved', reason: null },
    now,
  );
  const assets = inspectDeletionState(r.path).assets;
  expect(r.repository.deleteArticle(r.command, now).status).toBe('deleted');
  expect(tasks.get(input.taskId)).toEqual(original);
  expect(
    tasks.findIdentity(r.article.articleKey, input.store.storeKey),
  ).toEqual(original);
  expect(
    tasks.reserve({
      ...input,
      taskId: randomUUID(),
      preparationId: randomUUID(),
      expectedArticleRevision: 2,
    }).status,
  ).toBe('stale');
  expect(inspectDeletionState(r.path).assets).toEqual(assets);
  tasks.close();
  const reopened = openDraftTaskRepository(
    r.path,
    resolve('src/infrastructure/persistence/migrations'),
  );
  cleanup.push(() => reopened.close());
  reopened.recover(now);
  expect(reopened.get(input.taskId)).toEqual(original);
  expect(
    reopened.findIdentity(r.article.articleKey, input.store.storeKey),
  ).toEqual(original);
  expect(await r.importer.recover()).toBe(true);
  await r.formal.verify(r.repository.findImport(r.article.importId)!);
});
