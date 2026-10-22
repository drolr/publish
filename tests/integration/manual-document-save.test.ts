import { afterEach, expect, it } from 'vitest';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import type { RevisionSaveInput } from '../../src/contracts/article-revision';
import { revisionRuntime, png } from './revision-crash-child';
import { createManualArticleController } from '../../src/application/manual-article';
import { createArticleImportService } from '../../src/application/article-import';
import { createArticleRevisionService } from '../../src/application/article-revision';
import { createManualClipboard } from '../../src/infrastructure/content/manual-clipboard';
import {
  ManualStateSchema,
  type ManualState,
} from '../../src/contracts/manual-article';
import type {
  WebPasteConverter,
  WebPasteImageReader,
} from '../../src/domain/ports/web-paste';
import type { DocumentCommand } from '../../src/contracts/manual-edit';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const session = (s: ManualState) => {
  if (!('sessionId' in s)) throw Error('Expected session');
  return s;
};
const command = (
  s: ReturnType<typeof session>,
  clientSequence: number,
): DocumentCommand => ({
  sessionId: s.sessionId,
  expectedDocumentRevision: s.documentRevision,
  commandId: s.nextEditCommandId,
  clientSequence,
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'manual-document-'));
  const r = await revisionRuntime(root);
  const importer = createArticleImportService(
    r.repository,
    r.formal,
    {
      read: async (source, capability, signal) =>
        capability && source.type === 'local'
          ? r.images.readCapability(capability as never, source.path, signal)
          : png,
    },
    r.images,
  );
  expect(await importer.recover()).toBe(true);
  const revision = createArticleRevisionService(
    r.repository,
    r.assets,
    importer.importEditedArticle,
  );
  expect(await revision.recover()).toBe(true);
  let grant = '';
  const clipboard = createManualClipboard(r.images, {
    write: async (id) => {
      grant = id;
    },
  });
  const converter: WebPasteConverter = {
    convert: async () => ({
      blocks: [{ type: 'paragraph', text: 'Paste' }],
      plainOnly: true,
    }),
  };
  const pasteImages: WebPasteImageReader = {
    acquire: async () => {
      throw Error('Network forbidden');
    },
  };
  const manual = createManualArticleController({
    newId: randomUUID,
    externalExists: (id) => !!r.repository.findExternal(id),
    gate: () =>
      revision.isReady() && clipboard.isReady() ? 'ready' : 'unavailable',
    chooseImage: async (sid, signal) =>
      r.images.authorizeBytes(sid, png, signal),
    readImage: (sid, token, signal) => r.images.read(sid, token, signal),
    retainImages: (...args) => r.images.retain(...args),
    releaseImages: (sid) => r.images.release(sid),
    save: (input, sid, signal) =>
      importer.importArticle(input, {
        capability: r.images.capability(sid),
        signal,
      }),
    fingerprint: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    converter,
    pasteImages,
    documents: {
      createEditorCompatibilityLease:
        r.repository.createEditorCompatibilityLease,
      releaseEditorCompatibilityLease:
        r.repository.releaseEditorCompatibilityLease,
      loadEditableArticle: r.repository.loadEditableArticle,
      storedImages: r.images,
      saveRevision: revision.saveRevision,
      getSaveResult: revision.getSaveResult,
      clipboard,
      digest: (value) =>
        createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      respondClose: () => false,
    },
  });
  cleanup.push(async () => {
    await manual.waitForSettlement();
    try {
      await manual.stopAndWait();
    } catch {
      const state = manual.getManualArticleState();
      if ('sessionId' in state) await r.images.release(state.sessionId);
    }
    await clipboard.drain();
    r.repository.close();
    if (!root.startsWith(join(tmpdir(), 'manual-document-')))
      throw Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...r,
    manual,
    revision,
    clipboard,
    converter,
    pasteImages,
    grant: () => grant,
  };
}
async function commit(manual: Awaited<ReturnType<typeof setup>>['manual']) {
  const s = session(manual.getManualArticleState());
  const command = {
    sessionId: s.sessionId,
    expectedDocumentRevision: s.documentRevision,
    operationId: s.nextSaveOperationId,
  };
  expect((await manual.commitManualDocument(command)).status).toBe('started');
  await manual.waitForSettlement();
  return command;
}
it('edits a legacy article in the canonical session and undo restores original saved image ID and bytes', async () => {
  const r = await setup();
  expect((await r.manual.openManualArticle(r.article.articleKey)).status).toBe(
    'started',
  );
  const opening = session(r.manual.getManualArticleState());
  expect(opening.operationKind).toBe('open');
  expect(opening.draft.title).toBe(r.article.title);
  await r.manual.waitForSettlement();
  const original = session(r.manual.getManualArticleState()),
    token = original.images[0].imageToken;
  const draft = {
    ...original.draft,
    title: 'Edited',
    blocks: original.draft.blocks.filter((b) => b.type !== 'image'),
  };
  expect(
    (await r.manual.applyManualEdit(command(original, 1), draft)).status,
  ).toBe('ok');
  const saved = await commit(r.manual);
  const current = session(r.manual.getManualArticleState());
  expect(current.target).toMatchObject({
    kind: 'existing',
    baseArticleRevision: 2,
  });
  expect(current.images[0].imageToken).toBe(token);
  expect(r.repository.load(r.article.articleKey)?.assets).toEqual([]);
  expect(
    (
      await r.manual.applyManualEdit(command(current, 2), {
        ...original.draft,
        title: 'Edited',
      })
    ).status,
  ).toBe('ok');
  await commit(r.manual);
  const restored = r.repository.loadEditableArticle(r.article.articleKey)!;
  expect(restored.articleRevision).toBe(3);
  expect(restored.article.assets).toEqual(r.article.assets);
  expect(
    await readFile(join(r.root, 'assets', r.article.assets[0].relativePath)),
  ).toEqual(png);
  const replay = await r.manual.commitManualDocument(saved);
  expect(session(replay.snapshot).target).toMatchObject({
    baseArticleRevision: 3,
  });
  expect(
    r.repository.loadEditableArticle(r.article.articleKey)?.articleRevision,
  ).toBe(3);
});
it('a formal version change during saved-image binding keeps the receipt base and blocks silent rebasing', async () => {
  const r = await setup();
  const initial = session((await r.manual.beginManualArticle()).snapshot);
  await r.manual.applyManualEdit(command(initial, 1), {
    ...initial.draft,
    title: 'New',
    blocks: [{ ...initial.draft.blocks[0], type: 'paragraph', text: 'Body' }],
  });
  const text = session(r.manual.getManualArticleState());
  const end = {
    blockKey: text.draft.blocks[0].blockKey,
    kind: 'edge' as const,
    side: 'after' as const,
  };
  await r.manual.insertManualImage(command(text, 2), {
    anchor: end,
    head: end,
  });
  await r.manual.waitForSettlement();
  const bind = r.images.bindSavedImage;
  r.images.bindSavedImage = async (...args) => {
    const lease = await bind(...args);
    expect(
      r.repository.setArticleDeclarations!({
        targets: [
          { articleKey: args[1].articleKey, expectedDeclaration: 'repost' },
        ],
        declaration: 'original',
      }).status,
    ).toBe('updated');
    return lease;
  };
  const saved = await commit(r.manual);
  const current = session(r.manual.getManualArticleState());
  expect(current.saveOutcome).toMatchObject({
    kind: 'created',
    articleRevision: 1,
  });
  expect(current.target).toMatchObject({ baseArticleRevision: 1 });
  expect(current.draft.contentDeclaration).toBe('repost');
  expect(
    r.repository.loadEditableArticle(current.saveOutcome!.articleKey)
      ?.articleRevision,
  ).toBe(2);
  expect(r.manual.isBlocked()).toBe(true);
  expect(
    (await r.manual.closeManualEditor(command(current, 3), 'discard')).status,
  ).toBe('unavailable');
  expect(
    await r.manual.getManualSaveResult(current.sessionId, saved.operationId),
  ).toMatchObject({ status: 'committed', receipt: { articleRevision: 1 } });
  expect(
    (
      await r.manual.closeManualEditor(
        command(current, current.nextClientSequence),
        'discard',
      )
    ).status,
  ).toBe('ok');
  expect(r.manual.isBlocked()).toBe(false);
  expect(
    r.repository.loadEditableArticle(current.saveOutcome!.articleKey)
      ?.articleRevision,
  ).toBe(2);
  await r.manual.openManualArticle(current.saveOutcome!.articleKey);
  await r.manual.waitForSettlement();
  expect(
    session(r.manual.getManualArticleState()).draft.contentDeclaration,
  ).toBe('original');
});
it('legacy 201 positions reduce-save-undo-save keeps identity and original bytes without granting position 202', async () => {
  const r = await setup();
  const imported = await r.importer.importArticle({
    schema_version: 1,
    article_id: 'legacy-repeated',
    title: 'Legacy repeated',
    content_declaration: 'repost',
    body: [
      { type: 'paragraph', text: 'Body' },
      ...Array.from({ length: 201 }, () => ({ type: 'image', image_id: 'i' })),
    ],
    images: [{ image_id: 'i', source: { type: 'local', path: 'unused.png' } }],
  });
  if (imported.status !== 'imported') throw Error('Seed');
  await r.manual.openManualArticle(imported.article.articleKey);
  await r.manual.waitForSettlement();
  const original = session(r.manual.getManualArticleState());
  expect(original.draft.blocks).toHaveLength(202);
  expect(original.images).toHaveLength(1);
  const reduced = {
    ...original.draft,
    blocks: original.draft.blocks.slice(0, 101),
  };
  expect(
    (
      await r.manual.applyManualEdit(
        command(original, original.nextClientSequence),
        reduced,
      )
    ).status,
  ).toBe('ok');
  await commit(r.manual);
  const saved = session(r.manual.getManualArticleState());
  expect(
    (
      await r.manual.applyManualEdit(
        command(saved, saved.nextClientSequence),
        original.draft,
      )
    ).status,
  ).toBe('ok');
  await commit(r.manual);
  const restored = session(r.manual.getManualArticleState());
  expect(restored.saveOutcome?.articleRevision).toBe(3);
  const formal = r.repository.load(imported.article.articleKey)!;
  expect(formal.body.filter((b) => b.type === 'image')).toHaveLength(201);
  expect(formal.assets).toEqual(imported.article.assets);
  expect(
    await readFile(join(r.root, 'assets', formal.assets[0].relativePath)),
  ).toEqual(png);
  const extra = {
    ...original.draft,
    blocks: [
      ...original.draft.blocks,
      { ...original.draft.blocks[1], blockKey: randomUUID() },
    ],
  };
  expect(
    (
      await r.manual.applyManualEdit(
        command(restored, restored.nextClientSequence),
        extra,
      )
    ).status,
  ).toBe('invalid');
});
it('compatibility witness denies forged, foreign session/instance and revoked leases while normal no-lease growth stays closed', async () => {
  const r = await setup();
  const imported = await r.importer.importArticle({
    schema_version: 1,
    article_id: 'witness',
    title: 'Witness',
    content_declaration: 'repost',
    body: [
      { type: 'paragraph', text: 'Body' },
      ...Array.from({ length: 201 }, () => ({ type: 'image', image_id: 'i' })),
    ],
    images: [{ image_id: 'i', source: { type: 'local', path: 'unused.png' } }],
  });
  if (imported.status !== 'imported') throw Error('Seed');
  const sid = randomUUID(),
    article = imported.article;
  const proof = r.repository.createEditorCompatibilityLease(
    article.articleKey,
    sid,
    1,
  )!;
  const authorized = await r.images.authorizeStored(
    sid,
    article,
    article.assets[0].assetKey,
    new AbortController().signal,
  );
  const input = (
    positions: number,
    baseRevision: number,
  ): Extract<RevisionSaveInput, { kind: 'updated' }> => ({
    kind: 'updated',
    intent: {
      operationId: randomUUID(),
      sessionId: sid,
      articleKey: article.articleKey,
      externalId: article.externalId,
      kind: 'updated',
      documentRevision: 1,
      baseRevision,
      payloadDigest: 'f'.repeat(64),
      startedAt: new Date().toISOString(),
    },
    identity: {
      articleKey: article.articleKey,
      externalId: article.externalId,
      importId: article.importId,
      createdAt: article.createdAt,
    },
    title: article.title,
    contentDeclaration: article.contentDeclaration,
    editorBody: {
      version: 1,
      blocks: [
        { type: 'paragraph', text: 'Body' },
        ...Array.from({ length: positions }, () => ({
          type: 'image' as const,
          imageId: 'i',
        })),
      ],
    },
    images: [{ kind: 'stored', imageId: 'i', lease: authorized.lease }],
  });
  expect(
    (await r.revision.saveRevision(input(100, 1), new AbortController().signal))
      .status,
  ).toBe('committed');
  const restored = input(201, 2);
  for (const lease of [
    {} as never,
    r.repository.createEditorCompatibilityLease(
      article.articleKey,
      randomUUID(),
      2,
    )!,
    r.repository.createEditorCompatibilityLease(r.article.articleKey, sid, 1)!,
  ]) {
    const attempted = {
      ...restored,
      intent: { ...restored.intent, operationId: randomUUID() },
      compatibilityLease: lease,
    };
    expect(
      (await r.revision.saveRevision(attempted, new AbortController().signal))
        .status,
    ).toBe('needs_review');
    expect(
      r.repository.readRevisionOperation(attempted.intent.operationId),
    ).toBeUndefined();
    r.repository.releaseEditorCompatibilityLease(lease);
  }
  const foreign = openArticleRepository(
    join(r.root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  const foreignProof = foreign.createEditorCompatibilityLease(
    article.articleKey,
    sid,
    2,
  )!;
  foreign.close();
  expect(
    (
      await r.revision.saveRevision(
        { ...restored, compatibilityLease: foreignProof },
        new AbortController().signal,
      )
    ).status,
  ).toBe('needs_review');
  expect(
    (
      await r.revision.saveRevision(
        {
          ...restored,
          intent: { ...restored.intent, operationId: randomUUID() },
        },
        new AbortController().signal,
      )
    ).status,
  ).toBe('failed');
  expect(
    r.repository.loadEditableArticle(article.articleKey)?.articleRevision,
  ).toBe(2);
  const tooMany = input(202, 2);
  expect(
    (
      await r.revision.saveRevision(
        { ...tooMany, compatibilityLease: proof },
        new AbortController().signal,
      )
    ).status,
  ).toBe('failed');
  const fresh = r.repository.createEditorCompatibilityLease(
    article.articleKey,
    sid,
    2,
  )!;
  expect(
    (
      await r.revision.saveRevision(
        { ...input(201, 2), compatibilityLease: fresh },
        new AbortController().signal,
      )
    ).status,
  ).toBe('failed');
  expect(
    (
      await r.revision.saveRevision(
        { ...input(201, 2), compatibilityLease: proof },
        new AbortController().signal,
      )
    ).status,
  ).toBe('committed');
  r.repository.releaseEditorCompatibilityLease(proof);
  expect(
    (
      await r.revision.saveRevision(
        { ...input(200, 3), compatibilityLease: proof },
        new AbortController().signal,
      )
    ).status,
  ).toBe('needs_review');
  await r.images.release(sid);
});
it('a cleanup failure cannot be cleared by querying a receipt and discarding a version conflict', async () => {
  const r = await setup();
  const initial = session((await r.manual.beginManualArticle()).snapshot);
  await r.manual.applyManualEdit(command(initial, 1), {
    ...initial.draft,
    title: 'Conflict',
    blocks: [{ ...initial.draft.blocks[0], type: 'paragraph', text: 'Body' }],
  });
  const text = session(r.manual.getManualArticleState());
  const end = {
    blockKey: text.draft.blocks[0].blockKey,
    kind: 'edge' as const,
    side: 'after' as const,
  };
  await r.manual.insertManualImage(command(text, 2), {
    anchor: end,
    head: end,
  });
  await r.manual.waitForSettlement();
  const bind = r.images.bindSavedImage,
    retain = r.images.retain;
  r.images.bindSavedImage = async (...args) => {
    const lease = await bind(...args);
    r.repository.setArticleDeclarations!({
      targets: [
        { articleKey: args[1].articleKey, expectedDeclaration: 'repost' },
      ],
      declaration: 'original',
    });
    r.images.retain = async () => {
      throw Error('Owned cleanup unknown');
    };
    return lease;
  };
  const saved = await commit(r.manual);
  r.images.retain = retain;
  const current = session(r.manual.getManualArticleState());
  expect(current.saveOutcome?.kind).toBe('created');
  expect(
    await r.manual.getManualSaveResult(current.sessionId, saved.operationId),
  ).toMatchObject({ status: 'committed' });
  expect(r.manual.canDiscardVerifiedConflict()).toBe(false);
  expect(
    (
      await r.manual.closeManualEditor(
        command(current, current.nextClientSequence),
        'discard',
      )
    ).status,
  ).toBe('unavailable');
  expect(r.manual.isBlocked()).toBe(true);
});
it('a noncanonical title is a known invalid save before any article or receipt exists', async () => {
  const r = await setup();
  const initial = session((await r.manual.beginManualArticle()).snapshot);
  await r.manual.applyManualEdit(command(initial, 1), {
    ...initial.draft,
    title: '  Title  ',
    blocks: [{ ...initial.draft.blocks[0], type: 'paragraph', text: 'Body' }],
  });
  const s = session(r.manual.getManualArticleState());
  const save = {
    sessionId: s.sessionId,
    expectedDocumentRevision: s.documentRevision,
    operationId: s.nextSaveOperationId,
  };
  expect((await r.manual.commitManualDocument(save)).status).toBe('invalid');
  expect(r.manual.isBlocked()).toBe(false);
  expect(r.repository.findExternal(s.externalId)).toBeUndefined();
  expect(r.repository.readSaveReceipt(save.operationId)).toBeUndefined();
  expect(session(r.manual.getManualArticleState()).draft).toEqual(s.draft);
  const invalid = session(r.manual.getManualArticleState());
  expect(invalid.nextSaveOperationId).not.toBe(save.operationId);
  await r.manual.applyManualEdit(command(invalid, invalid.nextClientSequence), {
    ...invalid.draft,
    title: 'Title',
  });
  await commit(r.manual);
  expect(session(r.manual.getManualArticleState()).saveOutcome?.kind).toBe(
    'created',
  );
});
it('existing raw-title validation and blank-title discard preserve the formal row without unknown locks', async () => {
  const r = await setup();
  await r.manual.openManualArticle(r.article.articleKey);
  await r.manual.waitForSettlement();
  const original = session(r.manual.getManualArticleState());
  await r.manual.applyManualEdit(
    command(original, original.nextClientSequence),
    { ...original.draft, title: ' Bad ' },
  );
  const edited = session(r.manual.getManualArticleState());
  const commandSave = {
    sessionId: edited.sessionId,
    expectedDocumentRevision: edited.documentRevision,
    operationId: edited.nextSaveOperationId,
  };
  expect((await r.manual.commitManualDocument(commandSave)).status).toBe(
    'invalid',
  );
  expect(
    r.repository.loadEditableArticle(r.article.articleKey)?.articleRevision,
  ).toBe(1);
  expect(
    r.repository.readRevisionOperation(commandSave.operationId),
  ).toBeUndefined();
  expect(
    await r.manual.getManualSaveResult(
      edited.sessionId,
      commandSave.operationId,
    ),
  ).toEqual({ status: 'not_started', operationId: commandSave.operationId });
  const rejected = session(r.manual.getManualArticleState());
  expect(rejected.issues?.[0].message).toContain('标题');
  expect(
    (
      await r.manual.closeManualEditor(
        command(rejected, rejected.nextClientSequence),
        'discard',
      )
    ).status,
  ).toBe('ok');
  const blank = session((await r.manual.beginManualArticle()).snapshot);
  expect(
    (
      await r.manual.commitManualDocument({
        sessionId: blank.sessionId,
        expectedDocumentRevision: blank.documentRevision,
        operationId: blank.nextSaveOperationId,
      })
    ).status,
  ).toBe('invalid');
  const validated = session(r.manual.getManualArticleState());
  expect(r.manual.isBlocked()).toBe(false);
  expect(
    (
      await r.manual.closeManualEditor(
        command(validated, validated.nextClientSequence),
        'discard',
      )
    ).status,
  ).toBe('ok');
  expect(r.repository.load(r.article.articleKey)).toEqual(r.article);
});
it('atomic stale-base preflight creates no intent and permits only verified discard/reopen of the newer row', async () => {
  const r = await setup();
  await r.manual.openManualArticle(r.article.articleKey);
  await r.manual.waitForSettlement();
  const original = session(r.manual.getManualArticleState());
  await r.manual.applyManualEdit(
    command(original, original.nextClientSequence),
    { ...original.draft, title: 'Local unsaved title' },
  );
  r.repository.setArticleDeclarations!({
    targets: [
      { articleKey: r.article.articleKey, expectedDeclaration: 'repost' },
    ],
    declaration: 'original',
  });
  const local = session(r.manual.getManualArticleState());
  const attempted = {
    sessionId: local.sessionId,
    expectedDocumentRevision: local.documentRevision,
    operationId: local.nextSaveOperationId,
  };
  expect((await r.manual.commitManualDocument(attempted)).status).toBe(
    'conflict',
  );
  expect(
    r.repository.readRevisionOperation(attempted.operationId),
  ).toBeUndefined();
  expect(r.repository.readSaveReceipt(attempted.operationId)).toBeUndefined();
  expect(
    (
      await r.manual.closeManualEditor(
        command(local, local.nextClientSequence),
        'discard',
      )
    ).status,
  ).toBe('unavailable');
  expect(
    await r.manual.getManualSaveResult(local.sessionId, attempted.operationId),
  ).toEqual({ status: 'not_started', operationId: attempted.operationId });
  const current = session(r.manual.getManualArticleState());
  expect(current.draft).toEqual(local.draft);
  expect(
    (
      await r.manual.closeManualEditor(
        command(current, current.nextClientSequence),
        'discard',
      )
    ).status,
  ).toBe('ok');
  await r.manual.openManualArticle(r.article.articleKey);
  await r.manual.waitForSettlement();
  const reopened = session(r.manual.getManualArticleState());
  expect(reopened.target).toMatchObject({ baseArticleRevision: 2 });
  expect(reopened.draft.title).toBe(r.article.title);
  expect(reopened.draft.contentDeclaration).toBe('original');
});
it('legacy picker and paste invalidate an outstanding document ticket without acknowledging that different action', async () => {
  const r = await setup();
  const initial = session((await r.manual.beginManualArticle()).snapshot);
  await r.manual.applyManualEdit(command(initial, initial.nextClientSequence), {
    ...initial.draft,
    title: 'Interleaved',
    blocks: [{ ...initial.draft.blocks[0], type: 'paragraph', text: 'Body' }],
  });
  const before = session(r.manual.getManualArticleState()),
    held = command(before, before.nextClientSequence);
  expect(
    r.manual.pickManualImage(before.sessionId, before.revision).status,
  ).toBe('started');
  await r.manual.waitForSettlement();
  const picked = session(r.manual.getManualArticleState());
  expect(picked.documentRevision).toBe(before.documentRevision + 1);
  expect(picked.nextEditCommandId).not.toBe(held.commandId);
  expect(picked.acknowledgedEdit?.commandId).not.toBe(held.commandId);
  expect((await r.manual.applyManualEdit(held, before.draft)).status).toBe(
    'conflict',
  );
  const next = command(picked, picked.nextClientSequence);
  await r.manual.startManualPaste(
    {
      sessionId: picked.sessionId,
      expectedRevision: picked.revision,
      commandId: picked.nextPasteCommandId,
    },
    { html: '', plain: 'Paste' },
  );
  await r.manual.waitForSettlement();
  const pasted = session(r.manual.getManualArticleState());
  expect(pasted.documentRevision).toBe(picked.documentRevision + 1);
  expect(pasted.nextEditCommandId).not.toBe(next.commandId);
  expect((await r.manual.applyManualEdit(next, picked.draft)).status).toBe(
    'conflict',
  );
  expect(ManualStateSchema.safeParse(pasted).success).toBe(true);
});
it('continuous legacy full-update cannot forge image keys and legacy existing-save updates one identity/receipt', async () => {
  const r = await setup();
  await r.manual.openManualArticle(r.article.articleKey);
  await r.manual.waitForSettlement();
  const opened = session(r.manual.getManualArticleState());
  expect(
    (
      await r.manual.updateManualDraft(opened.sessionId, opened.revision, {
        ...opened.draft,
        blocks: opened.draft.blocks.map((b) =>
          b.type === 'image' ? { ...b, blockKey: randomUUID() } : b,
        ),
      })
    ).status,
  ).toBe('invalid');
  const before = session(r.manual.getManualArticleState());
  const held = command(before, before.nextClientSequence);
  const updated = await r.manual.updateManualDraft(
    before.sessionId,
    before.revision,
    {
      ...before.draft,
      title: 'Legacy revision',
      contentDeclaration: 'original',
    },
  );
  expect(updated.status).toBe('ok');
  const dirty = session(updated.snapshot);
  expect(dirty.nextEditCommandId).not.toBe(held.commandId);
  expect((await r.manual.applyManualEdit(held, before.draft)).status).toBe(
    'conflict',
  );
  expect(
    r.manual.saveManualArticle(dirty.sessionId, dirty.revision).status,
  ).toBe('started');
  await r.manual.waitForSettlement();
  const saved = session(r.manual.getManualArticleState());
  expect(saved.state).toBe('editing');
  expect(saved.jobId).toBeUndefined();
  expect(r.manual.isActive()).toBe(false);
  expect(saved.saveOutcome).toMatchObject({
    kind: 'updated',
    articleKey: r.article.articleKey,
    articleRevision: 2,
  });
  expect(r.repository.load(r.article.articleKey)).toMatchObject({
    importId: r.article.importId,
    externalId: r.article.externalId,
    createdAt: r.article.createdAt,
    title: 'Legacy revision',
    contentDeclaration: 'original',
  });
  expect(
    r.manual.saveManualArticle(dirty.sessionId, dirty.revision).status,
  ).toBe('ok');
  await r.manual.waitForSettlement();
  expect(
    r.repository.loadEditableArticle(r.article.articleKey)?.articleRevision,
  ).toBe(2);
  expect(
    r.repository.readSaveReceipt(saved.saveOutcome!.operationId),
  ).toMatchObject({ articleKey: r.article.articleKey, articleRevision: 2 });
});
async function grantTarget(
  r: Awaited<ReturnType<typeof setup>>,
  candidates: number,
  ownImage: boolean,
  twoSourceImages = false,
) {
  await r.manual.openManualArticle(r.article.articleKey);
  await r.manual.waitForSettlement();
  let from = session(r.manual.getManualArticleState());
  if (twoSourceImages) {
    const bytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const authorize = r.images.authorizeBytes;
    r.images.authorizeBytes = (sid, _bytes, signal) =>
      authorize(sid, bytes, signal);
    const end = {
      blockKey: from.draft.blocks.at(-1)!.blockKey,
      kind: 'edge' as const,
      side: 'after' as const,
    };
    await r.manual.insertManualImage(command(from, from.nextClientSequence), {
      anchor: end,
      head: end,
    });
    await r.manual.waitForSettlement();
    r.images.authorizeBytes = authorize;
    from = session(r.manual.getManualArticleState());
  }
  await r.manual.copyManualSelection(
    command(from, from.nextClientSequence),
    {
      anchor: {
        blockKey: from.draft.blocks[0].blockKey,
        kind: 'edge',
        side: 'before',
      },
      head: {
        blockKey: from.draft.blocks.at(-1)!.blockKey,
        kind: 'edge',
        side: 'after',
      },
    },
    false,
  );
  await r.manual.waitForSettlement();
  const copied = session(r.manual.getManualArticleState());
  await r.manual.closeManualEditor(
    command(copied, copied.nextClientSequence),
    'discard',
  );
  const to = session((await r.manual.beginManualArticle()).snapshot);
  await r.manual.applyManualEdit(command(to, to.nextClientSequence), {
    ...to.draft,
    title: 'Target',
    blocks: [{ ...to.draft.blocks[0], type: 'paragraph', text: 'Target body' }],
  });
  if (ownImage) {
    const bytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const authorize = r.images.authorizeBytes;
    r.images.authorizeBytes = (sid, _bytes, signal) =>
      authorize(sid, bytes, signal);
    const s = session(r.manual.getManualArticleState()),
      end = {
        blockKey: s.draft.blocks[0].blockKey,
        kind: 'edge' as const,
        side: 'after' as const,
      };
    await r.manual.insertManualImage(command(s, s.nextClientSequence), {
      anchor: end,
      head: end,
    });
    await r.manual.waitForSettlement();
    r.images.authorizeBytes = authorize;
  }
  if (candidates) {
    r.converter.convert = async () => ({
      blocks: Array.from({ length: candidates }, () => ({
        type: 'image',
        source: undefined,
      })),
      plainOnly: false,
    });
    const s = session(r.manual.getManualArticleState()),
      point = {
        blockKey: s.draft.blocks[0].blockKey,
        kind: 'text' as const,
        offset: 0,
      };
    await r.manual.spliceManualPaste(
      command(s, s.nextClientSequence),
      { anchor: point, head: point },
      { html: '<img>', plain: '' },
    );
    await r.manual.waitForSettlement();
    const pending = session(r.manual.getManualArticleState());
    expect(ManualStateSchema.safeParse(pending).success).toBe(true);
    await r.manual.applyManualEdit(
      command(pending, pending.nextClientSequence),
      {
        ...pending.draft,
        blocks: pending.draft.blocks.filter((b) => b.type !== 'image-pending'),
      },
    );
  }
  return session(r.manual.getManualArticleState());
}
it('internal grant respects 200 retained candidates before target preparation and returns queryable snapshots', async () => {
  const r = await setup(),
    target = await grantTarget(r, 200, false);
  expect(target.candidates).toHaveLength(200);
  const authorize = r.images.authorizeBytes;
  let prepared = 0;
  r.images.authorizeBytes = async (...args) => {
    if (args[0] === target.sessionId) prepared++;
    return authorize(...args);
  };
  const point = {
    blockKey: target.draft.blocks[0].blockKey,
    kind: 'text' as const,
    offset: 0,
  };
  const started = await r.manual.spliceManualPaste(
    command(target, target.nextClientSequence),
    { anchor: point, head: point },
    { kind: 'internal', grantId: r.grant() },
  );
  expect(ManualStateSchema.safeParse(started.snapshot).success).toBe(true);
  await r.manual.waitForSettlement();
  const rejected = session(r.manual.getManualArticleState());
  expect(rejected.draft).toEqual(target.draft);
  expect(rejected.documentRevision).toBe(target.documentRevision);
  expect(prepared).toBe(0);
  expect(ManualStateSchema.safeParse(rejected).success).toBe(true);
});
it('same-target internal grant reuse adds zero unique tokens at a full retained budget', async () => {
  const r = await setup(),
    target = await grantTarget(r, 0, false);
  const point = {
    blockKey: target.draft.blocks[0].blockKey,
    kind: 'text' as const,
    offset: 0,
  };
  await r.manual.spliceManualPaste(
    command(target, target.nextClientSequence),
    { anchor: point, head: point },
    { kind: 'internal', grantId: r.grant() },
  );
  await r.manual.waitForSettlement();
  const first = session(r.manual.getManualArticleState()),
    token = first.images[0].imageToken;
  r.converter.convert = async () => ({
    blocks: Array.from({ length: 199 }, () => ({
      type: 'image',
      source: undefined,
    })),
    plainOnly: false,
  });
  await r.manual.spliceManualPaste(
    command(first, first.nextClientSequence),
    { anchor: point, head: point },
    { html: '<img>', plain: '' },
  );
  await r.manual.waitForSettlement();
  const pending = session(r.manual.getManualArticleState());
  await r.manual.applyManualEdit(command(pending, pending.nextClientSequence), {
    ...pending.draft,
    blocks: pending.draft.blocks.filter((b) => b.type !== 'image-pending'),
  });
  const full = session(r.manual.getManualArticleState());
  const authorize = r.images.authorizeBytes;
  let prepared = 0;
  r.images.authorizeBytes = async (...args) => {
    if (args[0] === full.sessionId) prepared++;
    return authorize(...args);
  };
  const now = {
    blockKey: full.draft.blocks[0].blockKey,
    kind: 'text' as const,
    offset: 0,
  };
  await r.manual.spliceManualPaste(
    command(full, full.nextClientSequence),
    { anchor: now, head: now },
    { kind: 'internal', grantId: r.grant() },
  );
  await r.manual.waitForSettlement();
  const pasted = session(r.manual.getManualArticleState());
  expect(pasted.images).toHaveLength(1);
  expect(pasted.images[0].imageToken).toBe(token);
  expect(prepared).toBe(0);
  expect(ManualStateSchema.safeParse(pasted).success).toBe(true);
});
it('mixed near-limit occupancy rejects two truly new grant images before any target preparation', async () => {
  const r = await setup(),
    target = await grantTarget(r, 198, true, true);
  expect(target.images).toHaveLength(1);
  expect(target.candidates).toHaveLength(198);
  const authorize = r.images.authorizeBytes;
  let prepared = 0;
  r.images.authorizeBytes = async (...args) => {
    if (args[0] === target.sessionId) prepared++;
    return authorize(...args);
  };
  const point = {
    blockKey: target.draft.blocks[0].blockKey,
    kind: 'text' as const,
    offset: 0,
  };
  const started = await r.manual.spliceManualPaste(
    command(target, target.nextClientSequence),
    { anchor: point, head: point },
    { kind: 'internal', grantId: r.grant() },
  );
  expect(ManualStateSchema.safeParse(started.snapshot).success).toBe(true);
  await r.manual.waitForSettlement();
  const state = session(r.manual.getManualArticleState());
  expect(prepared).toBe(0);
  expect(state.draft).toEqual(target.draft);
  expect(state.documentRevision).toBe(target.documentRevision);
  expect(ManualStateSchema.safeParse(state).success).toBe(true);
});
it('first same-live-session Cut/Paste at full occupancy preserves the exact origin token without new authorization', async () => {
  const r = await setup();
  await r.manual.openManualArticle(r.article.articleKey);
  await r.manual.waitForSettlement();
  let state = session(r.manual.getManualArticleState());
  r.converter.convert = async () => ({
    blocks: Array.from({ length: 199 }, () => ({
      type: 'image',
      source: undefined,
    })),
    plainOnly: false,
  });
  const point = {
    blockKey: state.draft.blocks[0].blockKey,
    kind: 'text' as const,
    offset: 0,
  };
  await r.manual.spliceManualPaste(
    command(state, state.nextClientSequence),
    { anchor: point, head: point },
    { html: '<img>', plain: '' },
  );
  await r.manual.waitForSettlement();
  state = session(r.manual.getManualArticleState());
  await r.manual.applyManualEdit(command(state, state.nextClientSequence), {
    ...state.draft,
    blocks: state.draft.blocks.filter((b) => b.type !== 'image-pending'),
  });
  state = session(r.manual.getManualArticleState());
  const originalToken = state.images[0].imageToken,
    image = state.draft.blocks.find((b) => b.type === 'image')!;
  await r.manual.copyManualSelection(
    command(state, state.nextClientSequence),
    {
      anchor: { blockKey: image.blockKey, kind: 'edge', side: 'before' },
      head: { blockKey: image.blockKey, kind: 'edge', side: 'after' },
    },
    true,
  );
  await r.manual.waitForSettlement();
  const cut = session(r.manual.getManualArticleState());
  expect(cut.images).toHaveLength(1);
  expect(cut.candidates).toHaveLength(199);
  const authorize = r.images.authorizeBytes;
  let prepared = 0;
  r.images.authorizeBytes = async (...args) => {
    if (args[0] === cut.sessionId) prepared++;
    return authorize(...args);
  };
  const target = {
    blockKey: cut.draft.blocks[0].blockKey,
    kind: 'text' as const,
    offset: 0,
  };
  await r.manual.spliceManualPaste(
    command(cut, cut.nextClientSequence),
    { anchor: target, head: target },
    { kind: 'internal', grantId: r.grant() },
  );
  await r.manual.waitForSettlement();
  const pasted = session(r.manual.getManualArticleState());
  expect(prepared).toBe(0);
  expect(pasted.images).toHaveLength(1);
  expect(pasted.images[0].imageToken).toBe(originalToken);
  expect(pasted.draft.blocks.find((b) => b.type === 'image')).toMatchObject({
    imageToken: originalToken,
  });
  expect(ManualStateSchema.safeParse(pasted).success).toBe(true);
});
it('hash-equivalent target ownership is reused before capacity admission and changed origin bytes are never reused', async () => {
  const r = await setup(),
    target = await grantTarget(r, 0, false);
  const own = await r.images.authorizeBytes(
    target.sessionId,
    png,
    new AbortController().signal,
  );
  // A main-owned picker source can return an already-deduplicated target token.
  const authorize = r.images.authorizeBytes;
  r.images.authorizeBytes = async () => own;
  const end = {
    blockKey: target.draft.blocks[0].blockKey,
    kind: 'edge' as const,
    side: 'after' as const,
  };
  await r.manual.insertManualImage(command(target, target.nextClientSequence), {
    anchor: end,
    head: end,
  });
  await r.manual.waitForSettlement();
  r.images.authorizeBytes = authorize;
  const current = session(r.manual.getManualArticleState());
  const point = {
    blockKey: current.draft.blocks[0].blockKey,
    kind: 'text' as const,
    offset: 0,
  };
  let prepared = 0;
  r.images.authorizeBytes = async (...args) => {
    if (args[0] === current.sessionId) prepared++;
    return authorize(...args);
  };
  await r.manual.spliceManualPaste(
    command(current, current.nextClientSequence),
    { anchor: point, head: point },
    { kind: 'internal', grantId: r.grant() },
  );
  await r.manual.waitForSettlement();
  const deduped = session(r.manual.getManualArticleState());
  expect(prepared).toBe(0);
  expect(deduped.images).toHaveLength(1);
  expect(deduped.images[0].imageToken).toBe(own.imageToken);
  await r.manual.closeManualEditor(
    command(deduped, deduped.nextClientSequence),
    'discard',
  );
  await r.manual.openManualArticle(r.article.articleKey);
  await r.manual.waitForSettlement();
  const original = session(r.manual.getManualArticleState());
  const image = original.draft.blocks.find((b) => b.type === 'image')!;
  await r.manual.copyManualSelection(
    command(original, original.nextClientSequence),
    {
      anchor: { blockKey: image.blockKey, kind: 'edge', side: 'before' },
      head: { blockKey: image.blockKey, kind: 'edge', side: 'after' },
    },
    true,
  );
  await r.manual.waitForSettlement();
  const cut = session(r.manual.getManualArticleState());
  await writeFile(
    join(r.root, 'assets', r.article.assets[0].relativePath),
    Buffer.concat([png, Buffer.from([3])]),
  );
  const before = cut.draft,
    at = {
      blockKey: cut.draft.blocks[0].blockKey,
      kind: 'text' as const,
      offset: 0,
    };
  await r.manual.spliceManualPaste(
    command(cut, cut.nextClientSequence),
    { anchor: at, head: at },
    { kind: 'internal', grantId: r.grant() },
  );
  await r.manual.waitForSettlement();
  expect(session(r.manual.getManualArticleState()).draft).toEqual(before);
  await writeFile(
    join(r.root, 'assets', r.article.assets[0].relativePath),
    png,
  );
});
it('legacy ready progress and no-op updates keep document tickets stable, while repeated/unchanged legacy saves settle', async () => {
  const r = await setup();
  const initial = session((await r.manual.beginManualArticle()).snapshot);
  await r.manual.applyManualEdit(command(initial, initial.nextClientSequence), {
    ...initial.draft,
    title: 'Legacy progress',
    blocks: [{ ...initial.draft.blocks[0], type: 'paragraph', text: 'Body' }],
  });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  r.pasteImages.acquire = async (sid, _source, signal) => {
    await wait;
    return r.images.authorizeBytes(sid, png, signal);
  };
  r.converter.convert = async () => ({
    blocks: [{ type: 'image', source: 'https://example.invalid/image.png' }],
    plainOnly: false,
  });
  const before = session(r.manual.getManualArticleState());
  const legacy = {
    sessionId: before.sessionId,
    expectedRevision: before.revision,
    commandId: before.nextPasteCommandId,
  };
  await r.manual.startManualPaste(legacy, { html: '<img>', plain: '' });
  for (let n = 0; n < 20; n++) await Promise.resolve();
  const admitted = session(r.manual.getManualArticleState());
  expect(admitted.documentRevision).toBe(before.documentRevision + 1);
  expect(ManualStateSchema.safeParse(admitted).success).toBe(true);
  release();
  await r.manual.waitForSettlement();
  const ready = session(r.manual.getManualArticleState());
  expect(ready.documentRevision).toBe(admitted.documentRevision);
  expect(ready.nextEditCommandId).toBe(admitted.nextEditCommandId);
  expect(
    (await r.manual.startManualPaste(legacy, { html: '<img>', plain: '' }))
      .status,
  ).toBe('ok');
  const noop = await r.manual.updateManualDraft(
    ready.sessionId,
    ready.revision,
    ready.draft,
  );
  const same = session(noop.snapshot);
  expect(same.documentRevision).toBe(ready.documentRevision);
  expect(same.nextEditCommandId).toBe(ready.nextEditCommandId);
  const saveRevision = same.revision;
  expect(r.manual.saveManualArticle(same.sessionId, saveRevision).status).toBe(
    'started',
  );
  await r.manual.waitForSettlement();
  const created = session(r.manual.getManualArticleState());
  expect(created.saveOutcome?.kind).toBe('created');
  expect(created.jobId).toBeUndefined();
  expect(r.manual.saveManualArticle(same.sessionId, saveRevision).status).toBe(
    'ok',
  );
  expect(
    r.manual.saveManualArticle(created.sessionId, created.revision).status,
  ).toBe('started');
  await r.manual.waitForSettlement();
  const unchanged = session(r.manual.getManualArticleState());
  expect(unchanged.saveOutcome?.kind).toBe('unchanged');
  expect(unchanged.saveOutcome?.articleRevision).toBe(1);
  expect(
    r.repository.readSaveReceipt(unchanged.saveOutcome!.operationId),
  ).toBeUndefined();
  expect(ManualStateSchema.safeParse(unchanged).success).toBe(true);
});
it('legacy mutators preserve the verified loaded-201 ceiling and reject extra or forged positions', async () => {
  const r = await setup();
  const imported = await r.importer.importArticle({
    schema_version: 1,
    article_id: 'legacy-ceiling-round1',
    title: 'Legacy ceiling',
    content_declaration: 'repost',
    body: [
      { type: 'paragraph', text: 'Body' },
      ...Array.from({ length: 201 }, () => ({ type: 'image', image_id: 'i' })),
    ],
    images: [{ image_id: 'i', source: { type: 'local', path: 'unused.png' } }],
  });
  if (imported.status !== 'imported') throw Error('Seed');
  await r.manual.openManualArticle(imported.article.articleKey);
  await r.manual.waitForSettlement();
  const original = session(r.manual.getManualArticleState());
  expect(
    (
      await r.manual.updateManualDraft(original.sessionId, original.revision, {
        ...original.draft,
        blocks: [
          ...original.draft.blocks,
          { ...original.draft.blocks[1], blockKey: randomUUID() },
        ],
      })
    ).status,
  ).toBe('invalid');
  const before = session(r.manual.getManualArticleState());
  expect(
    r.manual.pickManualImage(before.sessionId, before.revision).status,
  ).toBe('started');
  await r.manual.waitForSettlement();
  const rejected = session(r.manual.getManualArticleState());
  expect(rejected.draft).toEqual(before.draft);
  expect(rejected.documentRevision).toBe(before.documentRevision);
  expect(ManualStateSchema.safeParse(rejected).success).toBe(true);
  const reduced = await r.manual.updateManualDraft(
    rejected.sessionId,
    rejected.revision,
    { ...rejected.draft, blocks: rejected.draft.blocks.slice(0, 101) },
  );
  const fewer = session(reduced.snapshot);
  expect(
    r.manual.saveManualArticle(fewer.sessionId, fewer.revision).status,
  ).toBe('started');
  await r.manual.waitForSettlement();
  const saved = session(r.manual.getManualArticleState());
  expect(
    (
      await r.manual.updateManualDraft(
        saved.sessionId,
        saved.revision,
        original.draft,
      )
    ).status,
  ).toBe('ok');
  const restored = session(r.manual.getManualArticleState());
  expect(
    r.manual.saveManualArticle(restored.sessionId, restored.revision).status,
  ).toBe('started');
  await r.manual.waitForSettlement();
  expect(
    r.repository.loadEditableArticle(imported.article.articleKey)
      ?.articleRevision,
  ).toBe(3);
  expect(
    r.repository
      .load(imported.article.articleKey)
      ?.body.filter((b) => b.type === 'image'),
  ).toHaveLength(201);
});
it('first Cut/Paste with 200 actual owned tokens preserves the selected origin rather than another equal-hash token', async () => {
  const r = await setup();
  const initial = session((await r.manual.beginManualArticle()).snapshot);
  const sourceFile = join(r.root, 'owned-local-source.png');
  await writeFile(sourceFile, png);
  const byteAuthorizer = r.images.authorizeBytes;
  // Exercise 200 genuine registry slots without repeatedly rewriting a temp manifest.
  r.images.authorizeBytes = (sid, bytes, signal) =>
    sid === initial.sessionId
      ? r.images.authorize(sid, sourceFile, signal)
      : byteAuthorizer(sid, bytes, signal);
  await r.manual.applyManualEdit(command(initial, initial.nextClientSequence), {
    ...initial.draft,
    title: 'Full owned token budget',
    blocks: [{ ...initial.draft.blocks[0], type: 'paragraph', text: 'Body' }],
  });
  for (let n = 0; n < 200; n++) {
    const state = session(r.manual.getManualArticleState());
    expect(
      r.manual.pickManualImage(state.sessionId, state.revision).status,
    ).toBe('started');
    await r.manual.waitForSettlement();
    expect(
      ManualStateSchema.safeParse(r.manual.getManualArticleState()).success,
    ).toBe(true);
  }
  const full = session(r.manual.getManualArticleState()),
    image = full.draft.blocks[151];
  if (image.type !== 'image') throw Error('Image');
  const origin = image.imageToken;
  expect(full.images).toHaveLength(200);
  expect(origin).not.toBe(full.images[0].imageToken);
  await r.manual.copyManualSelection(
    command(full, full.nextClientSequence),
    {
      anchor: { blockKey: image.blockKey, kind: 'edge', side: 'before' },
      head: { blockKey: image.blockKey, kind: 'edge', side: 'after' },
    },
    true,
  );
  await r.manual.waitForSettlement();
  const cut = session(r.manual.getManualArticleState());
  const authorize = r.images.authorizeBytes;
  let prepared = 0;
  r.images.authorizeBytes = async (...args) => {
    if (args[0] === cut.sessionId) prepared++;
    return authorize(...args);
  };
  const at = {
    blockKey: cut.draft.blocks[0].blockKey,
    kind: 'text' as const,
    offset: 0,
  };
  await r.manual.spliceManualPaste(
    command(cut, cut.nextClientSequence),
    { anchor: at, head: at },
    { kind: 'internal', grantId: r.grant() },
  );
  await r.manual.waitForSettlement();
  const pasted = session(r.manual.getManualArticleState());
  expect(prepared).toBe(0);
  expect(pasted.images).toHaveLength(200);
  expect(pasted.draft.blocks.find((b) => b.type === 'image')).toMatchObject({
    imageToken: origin,
  });
  expect(ManualStateSchema.safeParse(pasted).success).toBe(true);
}, 20_000);
it('a legacy mixed frame containing a newly authorized image can be restored after reduction/save', async () => {
  const r = await setup();
  const imported = await r.importer.importArticle({
    schema_version: 1,
    article_id: 'mixed-legacy',
    title: 'Mixed',
    content_declaration: 'repost',
    body: [
      { type: 'paragraph', text: 'Body' },
      ...Array.from({ length: 201 }, () => ({ type: 'image', image_id: 'i' })),
    ],
    images: [{ image_id: 'i', source: { type: 'local', path: 'unused.png' } }],
  });
  if (imported.status !== 'imported') throw Error('Seed');
  await r.manual.openManualArticle(imported.article.articleKey);
  await r.manual.waitForSettlement();
  const opened = session(r.manual.getManualArticleState());
  const image = opened.draft.blocks[1];
  expect(
    (
      await r.manual.insertManualImage(
        command(opened, opened.nextClientSequence),
        {
          anchor: { blockKey: image.blockKey, kind: 'edge', side: 'before' },
          head: { blockKey: image.blockKey, kind: 'edge', side: 'after' },
        },
      )
    ).status,
  ).toBe('started');
  await r.manual.waitForSettlement();
  await commit(r.manual);
  const mixed = session(r.manual.getManualArticleState());
  const mixedAssets = r.repository.load(imported.article.articleKey)!.assets;
  expect(mixedAssets).toHaveLength(2);
  await r.manual.applyManualEdit(command(mixed, mixed.nextClientSequence), {
    ...mixed.draft,
    blocks: mixed.draft.blocks.slice(0, 101),
  });
  await commit(r.manual);
  const reduced = session(r.manual.getManualArticleState());
  expect(
    (
      await r.manual.applyManualEdit(
        command(reduced, reduced.nextClientSequence),
        mixed.draft,
      )
    ).status,
  ).toBe('ok');
  await commit(r.manual);
  const restored = r.repository.loadEditableArticle(
    imported.article.articleKey,
  )!;
  expect(restored.articleRevision).toBe(4);
  expect(restored.article.assets).toEqual(mixedAssets);
  expect(restored.article.body.filter((b) => b.type === 'image')).toHaveLength(
    201,
  );
});
it('real stored-image grant survives source discard, issues target temp token, then saves and binds in that same slot', async () => {
  const r = await setup();
  await r.manual.openManualArticle(r.article.articleKey);
  await r.manual.waitForSettlement();
  const from = session(r.manual.getManualArticleState());
  const selection = {
    anchor: {
      blockKey: from.draft.blocks[0].blockKey,
      kind: 'edge' as const,
      side: 'before' as const,
    },
    head: {
      blockKey: from.draft.blocks.at(-1)!.blockKey,
      kind: 'edge' as const,
      side: 'after' as const,
    },
  };
  await r.manual.copyManualSelection(command(from, 1), selection, false);
  await r.manual.waitForSettlement();
  const copied = session(r.manual.getManualArticleState());
  await r.manual.closeManualEditor(command(copied, 2), 'discard');
  const to = session((await r.manual.beginManualArticle()).snapshot);
  const range = {
    anchor: {
      blockKey: to.draft.blocks[0].blockKey,
      kind: 'text' as const,
      offset: 0,
    },
    head: {
      blockKey: to.draft.blocks[0].blockKey,
      kind: 'text' as const,
      offset: 0,
    },
  };
  await r.manual.spliceManualPaste(command(to, 1), range, {
    kind: 'internal',
    grantId: r.grant(),
  });
  await r.manual.waitForSettlement();
  const pasted = session(r.manual.getManualArticleState());
  expect(pasted.images[0].imageToken).not.toBe(from.images[0].imageToken);
  await r.manual.applyManualEdit(command(pasted, 2), {
    ...pasted.draft,
    title: 'Copied article',
  });
  await commit(r.manual);
  const saved = session(r.manual.getManualArticleState());
  expect(saved.saveOutcome?.kind).toBe('created');
  expect(saved.images[0].imageToken).toBe(pasted.images[0].imageToken);
  await r.manual.applyManualEdit(command(saved, 3), {
    ...saved.draft,
    title: 'Copy revision',
  });
  await commit(r.manual);
  const edited = session(r.manual.getManualArticleState());
  expect(edited.saveOutcome?.kind).toBe('updated');
  expect(edited.target).toMatchObject({ baseArticleRevision: 2 });
  const formal = r.repository.load(edited.saveOutcome!.articleKey)!;
  expect(formal.assets[0].imageId).toBe(pasted.images[0].imageToken);
  expect(
    await readFile(join(r.root, 'assets', formal.assets[0].relativePath)),
  ).toEqual(png);
});

it.each(['moved', 'deleted', 'changed'] as const)(
  'committed local token reads formal preview and clipboard bytes after fixture source is %s',
  async (mode) => {
    const r = await setup();
    const file = join(r.root, 'external-fixture.png');
    await writeFile(file, png);
    const authorizeBytes = r.images.authorizeBytes;
    r.images.authorizeBytes = (sid, _bytes, signal) =>
      r.images.authorize(sid, file, signal);
    const initial = session((await r.manual.beginManualArticle()).snapshot);
    await r.manual.applyManualEdit(command(initial, 1), {
      ...initial.draft,
      title: 'Fixture',
      blocks: [{ ...initial.draft.blocks[0], type: 'paragraph', text: 'Body' }],
    });
    const text = session(r.manual.getManualArticleState());
    const end = {
      blockKey: text.draft.blocks[0].blockKey,
      kind: 'edge' as const,
      side: 'after' as const,
    };
    await r.manual.insertManualImage(command(text, 2), {
      anchor: end,
      head: end,
    });
    await r.manual.waitForSettlement();
    r.images.authorizeBytes = authorizeBytes;
    const before = session(r.manual.getManualArticleState());
    const token = before.images[0].imageToken;
    await commit(r.manual);
    const saved = session(r.manual.getManualArticleState());
    expect(saved.saveOutcome?.kind).toBe('created');
    expect(saved.images.map((i) => i.imageToken)).toEqual([token]);
    const formal = r.repository.load(saved.saveOutcome!.articleKey)!;
    expect(
      await readFile(join(r.root, 'assets', formal.assets[0].relativePath)),
    ).toEqual(png);
    if (mode === 'moved') await rename(file, file + '.moved');
    if (mode === 'deleted') await rm(file);
    if (mode === 'changed') await writeFile(file, Buffer.alloc(png.length));
    expect(
      (
        await r.images.read(
          saved.sessionId,
          token,
          new AbortController().signal,
        )
      ).bytes,
    ).toEqual(png);
    expect(await r.manual.getManualImage(saved.sessionId, token)).toEqual({
      status: 'ok',
      mime: 'image/png',
      bytes: png,
    });
    const image = saved.draft.blocks.find((b) => b.type === 'image')!;
    expect(
      (
        await r.manual.copyManualSelection(
          command(saved, saved.nextClientSequence),
          {
            anchor: { blockKey: image.blockKey, kind: 'edge', side: 'before' },
            head: { blockKey: image.blockKey, kind: 'edge', side: 'after' },
          },
          false,
        )
      ).status,
    ).toBe('started');
    await r.manual.waitForSettlement();
    expect(r.manual.isBlocked()).toBe(false);
    const target = randomUUID();
    const pasted = await r.clipboard.paste(
      r.grant(),
      target,
      new AbortController().signal,
      [],
    );
    expect(
      (
        await r.images.read(
          target,
          pasted.images[0].imageToken,
          new AbortController().signal,
        )
      ).bytes,
    ).toEqual(png);
    await r.images.release(target);
    const copied = session(r.manual.getManualArticleState());
    expect(
      (
        await r.manual.closeManualEditor(
          command(copied, copied.nextClientSequence),
          'discard',
        )
      ).status,
    ).toBe('ok');
    await expect(
      r.images.read(saved.sessionId, token, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    expect(
      await readFile(join(r.root, 'assets', formal.assets[0].relativePath)),
    ).toEqual(png);
  },
);
