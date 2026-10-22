import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { revisionRuntime, updateInput, png } from './revision-crash-child';
import { executeImportSql } from '../../src/infrastructure/persistence/testing/article-fixtures';
const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it('unresolved committed receipt with changed formal digest keeps receipt but closes recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revision-digest-'));
  roots.push(root);
  const r = await revisionRuntime(root);
  closers.push(() => r.repository.close());
  const input = await updateInput(r);
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('committed');
  r.repository.markRevisionOperation(input.intent.operationId, {
    cleanupComplete: false,
  });
  executeImportSql(
    join(root, 'app.sqlite'),
    "UPDATE articles SET title = 'Corrupted' WHERE external_id = 'synthetic'",
  );
  expect(await r.service.recover()).toBe(false);
  expect((await r.service.getSaveResult(input.intent.operationId)).status).toBe(
    'committed',
  );
});
it.each(['before', 'after'])(
  'real process exit %s commit retains old bytes and receipts',
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'revision-crash-'));
    roots.push(root);
    const initial = await revisionRuntime(root);
    const original = initial.article;
    initial.repository.close();
    const id = randomUUID();
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('tests/integration/revision-crash-child.ts'),
        'revision-crash',
        root,
        phase,
        id,
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('checkpoint timeout'));
      }, 20000);
      child.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error(`early exit ${code}`));
      });
    });
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
    const r = await revisionRuntime(root);
    closers.push(() => r.repository.close());
    expect(await r.service.recover()).toBe(true);
    expect(
      await readFile(join(root, 'assets', original.assets[0].relativePath)),
    ).toEqual(png);
    expect(
      r.repository.loadEditableArticle(original.articleKey)?.articleRevision,
    ).toBe(phase === 'after' ? 2 : 1);
    expect((await r.service.getSaveResult(id)).status).toBe(
      phase === 'after' ? 'committed' : 'failed',
    );
  },
);
it('cleaned failed restart lookup is failed; orphan preparing is never pending and readonly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revision-lookup-'));
  roots.push(root);
  const r = await revisionRuntime(root);
  closers.push(() => r.repository.close());
  const input = await updateInput(r);
  r.repository.beginRevision(input.intent);
  const before = r.repository.readRevisionOperation(input.intent.operationId);
  expect((await r.service.getSaveResult(input.intent.operationId)).status).toBe(
    'needs_review',
  );
  expect(r.repository.readRevisionOperation(input.intent.operationId)).toEqual(
    before,
  );
  expect(await r.service.recover()).toBe(true);
  expect((await r.service.getSaveResult(input.intent.operationId)).status).toBe(
    'failed',
  );
  expect(r.repository.listRevisionOperations()).toEqual([]);
  expect((await r.service.getSaveResult(randomUUID())).status).toBe(
    'not_started',
  );
});

it('archived_article_internal_recovery retains bytes and immutable save receipts after deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revision-archive-'));
  roots.push(root);
  const r = await revisionRuntime(root);
  closers.push(() => r.repository.close());
  const input = await updateInput(r);
  const saved = await r.service.saveRevision(
    input,
    new AbortController().signal,
  );
  expect(saved.status).toBe('committed');
  r.repository.markRevisionOperation(input.intent.operationId, {
    cleanupComplete: false,
  });
  const command = {
    operationId: randomUUID(),
    articleKey: r.article.articleKey,
    expectedArticleRevision: 2,
  };
  expect(
    r.repository.deleteArticle(command, new Date().toISOString()).status,
  ).toBe('deleted');
  expect(await r.service.recover()).toBe(true);
  expect(r.repository.readSaveReceipt(input.intent.operationId)).toMatchObject({
    articleRevision: 2,
  });
  expect(
    r.repository.loadArchivedEditableArticle(r.article.articleKey)
      ?.articleRevision,
  ).toBe(3);
  expect(await r.importer.recover()).toBe(true);
  expect(
    await readFile(join(root, 'assets', r.article.assets[0].relativePath)),
  ).toEqual(png);
  expect(
    r.repository.loadEditableArticle(r.article.articleKey),
  ).toBeUndefined();
});
it('archived recovery keeps committed journal-owned final files across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revision-archive-owned-'));
  roots.push(root);
  const r = await revisionRuntime(root);
  closers.push(() => r.repository.close());
  const input = await updateInput(r);
  const image = await r.images.authorizeBytes(
    input.intent.sessionId,
    png,
    new AbortController().signal,
  );
  input.images.push({
    kind: 'temporary',
    imageId: 'new',
    sessionId: input.intent.sessionId,
    imageToken: image.imageToken,
  });
  input.editorBody.blocks.push({ type: 'image', imageId: 'new' });
  const cleanup = r.assets.cleanupOwnedUnreferenced;
  r.assets.cleanupOwnedUnreferenced = async () => {
    throw Error('synthetic exit before cleanup');
  };
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('committed');
  r.assets.cleanupOwnedUnreferenced = cleanup;
  const formal = r.repository.load(r.article.articleKey)!;
  expect(formal.assets).toHaveLength(2);
  expect(
    r.repository.deleteArticle(
      {
        operationId: randomUUID(),
        articleKey: r.article.articleKey,
        expectedArticleRevision: 2,
      },
      new Date().toISOString(),
    ).status,
  ).toBe('deleted');
  r.repository.close();
  const reopened = await revisionRuntime(root);
  closers.push(() => reopened.repository.close());
  expect(reopened.service.isReady()).toBe(true);
  expect(
    reopened.repository.readSaveReceipt(input.intent.operationId)
      ?.articleRevision,
  ).toBe(2);
  expect(
    reopened.repository.readRevisionOperation(input.intent.operationId)
      ?.cleanupComplete,
  ).toBe(true);
  expect(
    reopened.repository.loadArchivedEditableArticle(r.article.articleKey)
      ?.article.assets,
  ).toEqual(formal.assets);
  for (const asset of formal.assets)
    expect(await readFile(join(root, 'assets', asset.relativePath))).toEqual(
      png,
    );
});
