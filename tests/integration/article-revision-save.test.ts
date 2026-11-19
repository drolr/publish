import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { upgradeEditorBody } from '../../src/domain/rich-text-body';
import { createArticleLibrary } from '../../src/application/article-library';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revisionRuntime, updateInput, png } from './revision-crash-child';
const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'revision-save-'));
  roots.push(root);
  const runtime = await revisionRuntime(root);
  closers.push(() => runtime.repository.close());
  return runtime;
}
it('same_article_existing_bytes_no_network and no-op base version before equality', async () => {
  const r = await setup();
  const input = await updateInput(r);
  const original = r.article.assets[0];
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('committed');
  expect(
    r.repository.loadEditableArticle(r.article.articleKey)?.articleRevision,
  ).toBe(2);
  expect(r.repository.load(r.article.articleKey)?.assets[0]).toEqual(original);
  expect(await readFile(join(r.root, 'assets', original.relativePath))).toEqual(
    png,
  );
  const unchanged = {
    ...input,
    intent: { ...input.intent, operationId: randomUUID(), baseRevision: 2 },
  };
  expect(
    (await r.service.saveRevision(unchanged, new AbortController().signal))
      .status,
  ).toBe('unchanged');
  expect(
    r.repository.readRevisionOperation(unchanged.intent.operationId),
  ).toBeUndefined();
  expect(
    (
      await r.service.saveRevision(
        {
          ...unchanged,
          intent: {
            ...unchanged.intent,
            operationId: randomUUID(),
            baseRevision: 1,
          },
        },
        new AbortController().signal,
      )
    ).status,
  ).toBe('needs_review');
});
it('new_asset_failure_preserves_old and cross_article_asset_not_deleted', async () => {
  const r = await setup();
  const input = await updateInput(r);
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
  const other = await r.importer.importArticle({
    schema_version: 1,
    article_id: 'other',
    title: 'Other',
    body: [
      { type: 'paragraph', text: 'Other body' },
      { type: 'image', image_id: 'i' },
    ],
    images: [{ image_id: 'i', source: { type: 'local', path: 'unused.png' } }],
  });
  if (other.status !== 'imported') throw Error('seed');
  const otherPath = join(
    r.root,
    'assets',
    other.article.assets[0].relativePath,
  );
  const otherBytes = await readFile(otherPath);
  const before = await readFile(
    join(r.root, 'assets', r.article.assets[0].relativePath),
  );
  const finalize = r.assets.finalizeNewFiles;
  r.assets.finalizeNewFiles = async (...args) => {
    await finalize(...args);
    throw Error('post-rename failure');
  };
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('failed');
  expect(
    r.repository.loadEditableArticle(r.article.articleKey)?.articleRevision,
  ).toBe(1);
  expect(
    await readFile(join(r.root, 'assets', r.article.assets[0].relativePath)),
  ).toEqual(before);
  expect(await readFile(otherPath)).toEqual(otherBytes);
});
it('lost_commit_reply_queries_receipt and cleanup_after_commit_keeps_success', async () => {
  const r = await setup();
  const input = await updateInput(r);
  const commit = r.repository.commitRevision;
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
  r.repository.commitRevision = (...args) => {
    commit(...args);
    throw Error('lost reply');
  };
  r.assets.cleanupOwnedUnreferenced = async () => {
    throw Error('cleanup failure');
  };
  expect(r.service.isReady()).toBe(true);
  const result = await r.service.saveRevision(
    input,
    new AbortController().signal,
  );
  expect(result.status).toBe('committed');
  expect(r.service.isReady()).toBe(false);
  expect((await r.service.getSaveResult(input.intent.operationId)).status).toBe(
    'committed',
  );
  expect(
    r.repository.readRevisionOperation(input.intent.operationId)
      ?.cleanupComplete,
  ).toBe(false);
  const saved = r.repository.load(r.article.articleKey)!;
  expect(saved.assets).toHaveLength(2);
  expect(
    await readFile(join(r.root, 'assets', saved.assets[1].relativePath)),
  ).toEqual(png);
  expect(
    (
      await r.service.saveRevision(
        {
          ...input,
          intent: {
            ...input.intent,
            operationId: randomUUID(),
            baseRevision: 2,
          },
        },
        new AbortController().signal,
      )
    ).status,
  ).toBe('unavailable');
});
it('duplicate pending requests keep the actual writer and retry only the same payload', async () => {
  const r = await setup();
  const input = await updateInput(r);
  const prepare = r.assets.prepare;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => (resume = resolve));
  r.assets.prepare = async (...args) => {
    entered();
    await pause;
    return prepare(...args);
  };
  const first = r.service.saveRevision(input, new AbortController().signal);
  await enteredPromise;
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('pending');
  expect((await r.service.getSaveResult(input.intent.operationId)).status).toBe(
    'pending',
  );
  expect(
    (
      await r.service.saveRevision(
        {
          ...input,
          intent: { ...input.intent, payloadDigest: 'c'.repeat(64) },
        },
        new AbortController().signal,
      )
    ).status,
  ).toBe('needs_review');
  expect((await r.service.getSaveResult(input.intent.operationId)).status).toBe(
    'pending',
  );
  resume();
  expect((await first).status).toBe('committed');
});
it('no-op verification owns admission and rejects changed in-flight payload', async () => {
  const r = await setup();
  const input = await updateInput(r);
  input.title = r.article.title;
  input.contentDeclaration = r.article.contentDeclaration;
  input.editorBody.blocks.shift();
  const prepare = r.assets.prepare;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => (resume = resolve));
  r.assets.prepare = async (...args) => {
    enter();
    await pause;
    return prepare(...args);
  };
  const first = r.service.saveRevision(input, new AbortController().signal);
  await entered;
  expect((await r.service.getSaveResult(input.intent.operationId)).status).toBe(
    'pending',
  );
  const wrong = await r.service.saveRevision(
    { ...input, intent: { ...input.intent, payloadDigest: 'c'.repeat(64) } },
    new AbortController().signal,
  );
  resume();
  expect((await first).status).toBe('unchanged');
  expect(wrong.status).toBe('needs_review');
  expect(
    r.repository.readRevisionOperation(input.intent.operationId),
  ).toBeUndefined();
});
it('first_save_target_switch_duplicate_receipt reserves one identity', async () => {
  const r = await setup();
  let reservations = 0;
  const reserve = r.repository.reserve;
  r.repository.reserve = (id) => {
    reservations++;
    return reserve(id);
  };
  const input = {
    kind: 'created' as const,
    command: {
      operationId: randomUUID(),
      sessionId: randomUUID(),
      documentRevision: 1,
      payloadDigest: 'd'.repeat(64),
    },
    externalId: 'created',
    title: 'Created',
    contentDeclaration: 'original' as const,
    editorBody: upgradeEditorBody(
      {
        version: 1 as const,
        blocks: [
          { type: 'paragraph' as const, text: '正文' },
          { type: 'paragraph' as const, text: '' },
        ],
      },
      [],
    ),
    images: [],
  };
  const result = await r.service.saveRevision(
    input,
    new AbortController().signal,
  );
  expect(result.status).toBe('committed');
  expect(
    await r.service.saveRevision(input, new AbortController().signal),
  ).toEqual(result);
  expect(reservations).toBe(1);
  if (result.status !== 'committed') throw Error('receipt');
  const saved = r.repository.loadEditableArticle(result.receipt.articleKey);
  expect(saved?.articleRevision).toBe(1);
  expect(saved?.editorBody?.blocks).toHaveLength(2);
  expect(
    (
      await r.service.saveRevision(
        {
          ...input,
          command: { ...input.command, payloadDigest: 'e'.repeat(64) },
        },
        new AbortController().signal,
      )
    ).status,
  ).toBe('needs_review');
});
it('undo_image_after_save reuses old bytes and rejects fabricated opaque leases', async () => {
  const r = await setup();
  const input = await updateInput(r);
  const old = input.images[0];
  const removed = {
    ...input,
    images: [],
    editorBody: upgradeEditorBody(
      {
        version: 1 as const,
        blocks: [{ type: 'paragraph' as const, text: 'Only text' }],
      },
      [],
    ),
  };
  await r.images.retain(input.intent.sessionId, [], { preserveHistory: true });
  expect(
    (await r.service.saveRevision(removed, new AbortController().signal))
      .status,
  ).toBe('committed');
  expect(
    await r.images.read(
      input.intent.sessionId,
      r.token,
      new AbortController().signal,
    ),
  ).toMatchObject({ bytes: png });
  const undo = {
    ...input,
    intent: { ...input.intent, operationId: randomUUID(), baseRevision: 2 },
    images: [old],
  };
  expect(
    (await r.service.saveRevision(undo, new AbortController().signal)).status,
  ).toBe('committed');
  expect(r.repository.load(r.article.articleKey)?.assets[0].assetKey).toBe(
    r.article.assets[0].assetKey,
  );
  const forged = {
    ...undo,
    intent: { ...undo.intent, operationId: randomUUID(), baseRevision: 3 },
    title: 'Forged',
    images: [
      {
        kind: 'stored' as const,
        imageId: 'i',
        lease: {} as typeof old extends { lease: infer L } ? L : never,
      },
    ],
  };
  expect(
    (await r.service.saveRevision(forged, new AbortController().signal)).status,
  ).toBe('failed');
});
it('failed first save retries the same operation and original article key only after cleanup', async () => {
  const r = await setup();
  const input = {
    kind: 'created' as const,
    command: {
      operationId: randomUUID(),
      sessionId: randomUUID(),
      documentRevision: 1,
      payloadDigest: 'f'.repeat(64),
    },
    externalId: 'retry-created',
    title: 'Retry',
    contentDeclaration: 'repost' as const,
    editorBody: upgradeEditorBody(
      {
        version: 1 as const,
        blocks: [{ type: 'paragraph' as const, text: 'Body' }],
      },
      [],
    ),
    images: [],
  };
  const finalize = r.formal.finalize;
  r.formal.finalize = async (...args) => {
    await finalize(...args);
    throw Error('pre-commit failure');
  };
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('failed');
  const failed = r.repository.readRevisionOperation(input.command.operationId)!;
  expect(failed.cleanupComplete).toBe(true);
  expect(r.repository.findExternal(input.externalId)).toBeUndefined();
  closers.pop()!();
  const reopened = await revisionRuntime(r.root);
  closers.push(() => reopened.repository.close());
  const result = await reopened.service.saveRevision(
    input,
    new AbortController().signal,
  );
  expect(result.status).toBe('committed');
  if (result.status !== 'committed') throw Error('receipt');
  expect(result.receipt.articleKey).toBe(failed.articleKey);
  expect(result.receipt.articleRevision).toBe(1);
  expect(
    await reopened.service.saveRevision(input, new AbortController().signal),
  ).toEqual(result);
  expect(() =>
    reopened.repository.reserve(input.externalId, {
      revisionOperationId: input.command.operationId,
    }),
  ).toThrow();
});
it('first create images use the trusted session capability before atomic receipt', async () => {
  const r = await setup();
  const sessionId = randomUUID();
  const token = await r.images.authorizeBytes(
    sessionId,
    png,
    new AbortController().signal,
  );
  const input = {
    kind: 'created' as const,
    command: {
      operationId: randomUUID(),
      sessionId,
      documentRevision: 1,
      payloadDigest: 'a'.repeat(64),
    },
    externalId: 'with-image',
    title: 'Image',
    contentDeclaration: 'repost' as const,
    editorBody: upgradeEditorBody(
      {
        version: 1 as const,
        blocks: [
          { type: 'paragraph' as const, text: 'Image body' },
          { type: 'image' as const, imageId: 'new' },
        ],
      },
      [],
    ),
    images: [
      {
        kind: 'temporary' as const,
        sessionId,
        imageToken: token.imageToken,
        imageId: 'new',
      },
    ],
  };
  const importer = (
    await import('../../src/application/article-import')
  ).createArticleImportService(
    r.repository,
    r.formal,
    {
      read: async (source, capability, signal) => {
        if (source.type !== 'local' || capability?.kind !== 'manual-images')
          throw Error('Untrusted capability');
        return r.images.readCapability(capability, source.path, signal);
      },
    },
    r.images,
  );
  await importer.recover();
  const result = await importer.importEditedArticle(
    input,
    new AbortController().signal,
  );
  expect(result.status).toBe('committed');
  if (result.status !== 'committed') throw Error('receipt');
  const article = r.repository.load(result.receipt.articleKey)!;
  expect(
    await readFile(join(r.root, 'assets', article.assets[0].relativePath)),
  ).toEqual(png);
});
it('session release awaits an owned stored-image read before retiring its lease', async () => {
  const r = await setup();
  const input = await updateInput(r);
  const read = r.formal.readImage!;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => (resume = resolve));
  r.formal.readImage = async (...args) => {
    enter();
    await pause;
    return read(...args);
  };
  const reading = r.images
    .read(input.intent.sessionId, r.token, new AbortController().signal)
    .catch(() => undefined);
  await entered;
  let released = false;
  const releasing = r.images.release(input.intent.sessionId).then(() => {
    released = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const retiredBeforeRead = released;
  resume();
  await Promise.all([reading, releasing]);
  expect(retiredBeforeRead).toBe(false);
});
it('stored-image lease from another live session cannot authorize a save', async () => {
  const r = await setup();
  const input = await updateInput(r);
  const original = await readFile(
    join(r.root, 'assets', r.article.assets[0].relativePath),
  );
  input.intent.sessionId = randomUUID();
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('failed');
  expect(
    r.repository.loadEditableArticle(r.article.articleKey)?.articleRevision,
  ).toBe(1);
  expect(
    await readFile(join(r.root, 'assets', r.article.assets[0].relativePath)),
  ).toEqual(original);
});
it('no-op image verification rechecks the base revision after concurrent declaration update', async () => {
  const r = await setup();
  const input = await updateInput(r);
  input.title = r.article.title;
  input.contentDeclaration = r.article.contentDeclaration;
  input.editorBody.blocks.shift();
  const prepare = r.assets.prepare;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => (resume = resolve));
  r.assets.prepare = async (...args) => {
    enter();
    await pause;
    return prepare(...args);
  };
  const saving = r.service.saveRevision(input, new AbortController().signal);
  await entered;
  expect(
    r.repository.setArticleDeclarations!({
      targets: [
        { articleKey: r.article.articleKey, expectedDeclaration: 'repost' },
      ],
      declaration: 'original',
    }).status,
  ).toBe('updated');
  resume();
  expect((await saving).status).toBe('needs_review');
  expect(
    r.repository.loadEditableArticle(r.article.articleKey)?.articleRevision,
  ).toBe(2);
  expect(r.repository.load(r.article.articleKey)?.contentDeclaration).toBe(
    'original',
  );
  expect(
    r.repository.readRevisionOperation(input.intent.operationId),
  ).toBeUndefined();
});
it('cleaned updated retry retires old owned files before a pre-file failure then safely retries again', async () => {
  const r = await setup();
  const input = await updateInput(r);
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
  const finalize = r.assets.finalizeNewFiles;
  r.assets.finalizeNewFiles = async (...args) => {
    await finalize(...args);
    throw Error('after-rename');
  };
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('failed');
  const first = r.repository.readRevisionOperation(input.intent.operationId)!;
  expect(first.cleanupComplete).toBe(true);
  expect(first.ownedFiles).toHaveLength(1);
  r.assets.finalizeNewFiles = finalize;
  const read = r.images.readStored;
  r.images.readStored = async () => {
    throw Error('before-any-new-file');
  };
  const second = await r.service.saveRevision(
    input,
    new AbortController().signal,
  );
  expect(second.status).toBe('failed');
  const failed = r.repository.readRevisionOperation(input.intent.operationId)!;
  expect(failed.ownedFiles).toEqual([]);
  expect(failed.cleanupComplete).toBe(true);
  expect(failed.startedAt).toBe(first.startedAt);
  expect(failed.payloadDigest).toBe(first.payloadDigest);
  r.images.readStored = read;
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('committed');
  expect(
    r.repository.loadEditableArticle(r.article.articleKey)?.articleRevision,
  ).toBe(2);
});
it('retry admission never retires unresolved owned files or committed ownership facts', async () => {
  const r = await setup();
  const input = await updateInput(r);
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
  const finalize = r.assets.finalizeNewFiles;
  const cleanup = r.assets.cleanupOwnedUnreferenced;
  r.assets.finalizeNewFiles = async (...args) => {
    await finalize(...args);
    throw Error('rename-return');
  };
  r.assets.cleanupOwnedUnreferenced = async () => {
    throw Error('cleanup');
  };
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('needs_review');
  const unresolved = r.repository.readRevisionOperation(
    input.intent.operationId,
  )!;
  expect(unresolved.ownedFiles).toHaveLength(1);
  expect(unresolved.cleanupComplete).toBe(false);
  expect(r.repository.beginRevision(input.intent).status).toBe('needs_review');
  expect(r.repository.readRevisionOperation(input.intent.operationId)).toEqual(
    unresolved,
  );
  r.assets.finalizeNewFiles = finalize;
  r.assets.cleanupOwnedUnreferenced = cleanup;
  expect(await r.service.recover()).toBe(true);
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('committed');
  const committed = r.repository.readRevisionOperation(
    input.intent.operationId,
  )!;
  expect(committed.ownedFiles).toHaveLength(1);
  expect(r.repository.beginRevision(input.intent).status).toBe('committed');
  expect(r.repository.readRevisionOperation(input.intent.operationId)).toEqual(
    committed,
  );
});

it.each(['null', 'v1'] as const)(
  'rich save leaves legacy %s body and revision unchanged',
  async (version) => {
    const r = await setup();
    const original = {
      version: 1 as const,
      blocks: [
        { type: 'paragraph' as const, text: ' 原文😀\n ' },
        { type: 'image' as const, imageId: 'i' },
      ],
    };
    if (version === 'v1') {
      const db = new Database(join(r.root, 'app.sqlite'));
      db.prepare('UPDATE articles SET editor_body_json = ?').run(
        JSON.stringify(original),
      );
      db.close();
    }
    const input = await updateInput(r);
    const result = await r.service.saveRevision(
      {
        ...input,
        title: r.article.title,
        contentDeclaration: r.article.contentDeclaration,
        editorBody: upgradeEditorBody(original, r.article.body),
      },
      new AbortController().signal,
    );
    expect(result.status).toBe('unchanged');
    expect(
      r.repository.loadEditableArticle(r.article.articleKey),
    ).toMatchObject({
      articleRevision: 1,
      editorBody: version === 'null' ? null : original,
    });
  },
);
it('rich marks-only save increments the same identity and preview uses the authoritative body', async () => {
  const r = await setup();
  const input = await updateInput(r);
  const editorBody = upgradeEditorBody(null, r.article.body);
  const paragraph = editorBody.blocks[0];
  if (paragraph.type !== 'paragraph') throw Error('fixture');
  paragraph.content[0].marks = ['bold', 'italic', 'underline'];
  const rich = {
    ...input,
    title: r.article.title,
    contentDeclaration: r.article.contentDeclaration,
    editorBody,
  };
  expect(
    (await r.service.saveRevision(rich, new AbortController().signal)).status,
  ).toBe('committed');
  expect(r.repository.loadEditableArticle(r.article.articleKey)).toEqual({
    article: r.article,
    articleRevision: 2,
    editorBody,
  });
  const preview = await createArticleLibrary(
    r.repository,
    r.formal,
    r.repository,
  ).getArticlePreview(r.article.articleKey);
  expect(preview).toMatchObject({ status: 'ok', article: { editorBody } });
  const reopened = openArticleRepository(
    join(r.root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  try {
    expect(reopened.loadEditableArticle(r.article.articleKey)).toEqual({
      article: r.article,
      articleRevision: 2,
      editorBody,
    });
  } finally {
    reopened.close();
  }
  expect(await r.service.recover()).toBe(true);
  const db = new Database(join(r.root, 'app.sqlite'));
  paragraph.content[0].marks = [];
  db.prepare('UPDATE articles SET editor_body_json=?').run(
    JSON.stringify(editorBody),
  );
  db.close();
  r.repository.markRevisionOperation(input.intent.operationId, {
    status: 'needs_review',
  });
  expect(await r.service.recover()).toBe(false);
});
it('first rich save retains headings, list starts, quotes, empty paragraphs and soft breaks after reopen', async () => {
  const r = await setup();
  const editorBody = {
    version: 2 as const,
    blocks: [
      {
        type: 'heading' as const,
        content: [
          { type: 'text' as const, text: '小标题', marks: ['bold' as const] },
        ],
      },
      {
        type: 'list' as const,
        kind: 'ordered' as const,
        start: 7,
        items: [
          {
            type: 'paragraph' as const,
            content: [{ type: 'text' as const, text: 'a\nb', marks: [] }],
          },
        ],
      },
      {
        type: 'blockquote' as const,
        paragraphs: [{ type: 'paragraph' as const, content: [] }],
      },
      { type: 'paragraph' as const, content: [] },
    ],
  };
  const input = {
    kind: 'created' as const,
    command: {
      operationId: randomUUID(),
      sessionId: randomUUID(),
      documentRevision: 2,
      payloadDigest: 'e'.repeat(64),
    },
    externalId: 'rich-created',
    title: '富文本',
    contentDeclaration: 'original' as const,
    editorBody,
    images: [],
  };
  expect(
    (await r.service.saveRevision(input, new AbortController().signal)).status,
  ).toBe('committed');
  const article = r.repository.findExternal('rich-created')!;
  expect(
    r.repository.loadEditableArticle(article.articleKey)?.editorBody,
  ).toEqual(editorBody);
  expect(article.body).toEqual([
    { type: 'paragraph', text: '小标题' },
    { type: 'paragraph', text: 'a\nb' },
  ]);
  const declarations = r.repository.setArticleDeclarations!({
    targets: [
      { articleKey: article.articleKey, expectedDeclaration: 'original' },
    ],
    declaration: 'repost',
  });
  expect(declarations.status).toBe('updated');
  expect(
    r.repository.loadArchivedEditableArticle(article.articleKey)?.editorBody,
  ).toEqual(editorBody);
  expect(await r.service.recover()).toBe(true);
  const reopened = openArticleRepository(
    join(r.root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  try {
    expect(
      reopened.loadArchivedEditableArticle(article.articleKey)?.editorBody,
    ).toEqual(editorBody);
  } finally {
    reopened.close();
  }
});
