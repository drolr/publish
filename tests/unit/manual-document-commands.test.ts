import type { ConvertedRichPaste } from '../../src/contracts/rich-web-paste';
import { expect, it, vi } from 'vitest';
import {
  createManualArticleController,
  type ManualArticleControllerPorts,
} from '../../src/application/manual-article';
import type { ManualState } from '../../src/contracts/manual-article';
import type {
  DocumentCommand,
  DraftRange,
} from '../../src/contracts/manual-edit';
import type { ManualDocumentServices } from '../../src/application/manual-document-commands';
import type {
  EditableArticle,
  RevisionSaveInput,
  SaveReceipt,
} from '../../src/contracts/article-revision';
import { projectEditorBody } from '../../src/domain/article-edit';
import { WebPasteFailure } from '../../src/domain/web-paste-error';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function session(state: ManualState) {
  if (!('sessionId' in state)) throw Error('Expected session');
  return state;
}
function setup(overrides: Partial<ManualArticleControllerPorts> = {}) {
  let next = 100;
  const ports: ManualArticleControllerPorts = {
    newId: () => id(++next),
    externalExists: () => false,
    gate: () => 'ready',
    chooseImage: async () => undefined,
    readImage: async () => ({ mime: 'image/png', bytes: new Uint8Array([1]) }),
    retainImages: async () => {},
    releaseImages: async () => {},
    save: async () => ({
      status: 'failed',
      code: 'STORAGE_UNAVAILABLE',
      message: 'Unavailable',
    }),
    converter: {
      convert: async () => ({
        version: 2 as const,
        warnings: ['PLAIN_ONLY' as const],
        blocks: [
          {
            type: 'paragraph',
            content: [{ type: 'text' as const, text: 'X', marks: [] }],
          },
        ],
        plainOnly: true,
      }),
    },
    pasteImages: {
      acquire: async () => {
        throw Error('No image');
      },
    },
    fingerprint: (v) => JSON.stringify(v),
    ...overrides,
  };
  return { manual: createManualArticleController(ports), ports };
}
const command = (s: ReturnType<typeof session>, seq = 1): DocumentCommand => ({
  sessionId: s.sessionId,
  expectedDocumentRevision: s.documentRevision,
  clientSequence: seq,
  commandId: s.nextEditCommandId,
});
function range(
  s: ReturnType<typeof session>,
  anchor: number,
  head: number,
): DraftRange {
  return {
    anchor: {
      blockKey: s.draft.blocks[0].blockKey,
      kind: 'text',
      offset: anchor,
    },
    head: { blockKey: s.draft.blocks[0].blockKey, kind: 'text', offset: head },
  };
}
async function flush() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
function services(overrides: Partial<ManualDocumentServices> = {}) {
  const articles = new Map<string, EditableArticle>(),
    receipts = new Map<string, SaveReceipt>();
  let writes = 0;
  const api: ManualDocumentServices = {
    createEditorCompatibilityLease: () => ({}) as never,
    releaseEditorCompatibilityLease: () => {},
    loadEditableArticle: (key) => articles.get(key),
    storedImages: {
      authorizeStored: async () => {
        throw Error('No stored image');
      },
      bindSavedImage: async () => ({}) as never,
      readStored: async () => {
        throw Error('No stored image');
      },
    },
    digest: () => 'a'.repeat(64),
    respondClose: () => true,
    clipboard: {
      isReady: () => true,
      copy: async () => {},
      paste: async () => {
        throw new WebPasteFailure('INPUT_LIMIT');
      },
      drain: async () => {},
    },
    saveRevision: async (input: RevisionSaveInput) => {
      writes++;
      const cmd = input.kind === 'created' ? input.command : input.intent;
      const articleKey =
        input.kind === 'created' ? id(800) : input.identity.articleKey;
      const articleRevision =
        input.kind === 'created' ? 1 : input.intent.baseRevision + 1;
      const receipt: SaveReceipt = {
        ...cmd,
        articleKey,
        externalId:
          input.kind === 'created'
            ? input.externalId
            : input.identity.externalId,
        articleRevision,
        kind: input.kind,
        committedAt: '2026-10-08T00:00:00.000Z',
      };
      articles.set(articleKey, {
        articleRevision,
        editorBody: input.editorBody,
        article: {
          articleKey,
          externalId: receipt.externalId,
          importId: id(801),
          createdAt: receipt.committedAt,
          title: input.title,
          contentDeclaration: input.contentDeclaration,
          body: projectEditorBody(input.editorBody),
          assets: [],
        },
      });
      receipts.set(cmd.operationId, receipt);
      return { status: 'committed', receipt };
    },
    getSaveResult: async (operationId) =>
      receipts.has(operationId)
        ? { status: 'committed', receipt: receipts.get(operationId)! }
        : { status: 'not_started', operationId },
    ...overrides,
  };
  return { api, articles, receipts, writes: () => writes };
}
async function edited(
  text = 'A😀B',
  overrides: Partial<ManualArticleControllerPorts> = {},
) {
  const f = setup(overrides);
  const initial = session((await f.manual.beginManualArticle()).snapshot);
  expect(f.manual.applyManualEdit).toBeTypeOf('function');
  const reply = await f.manual.applyManualEdit(command(initial), {
    ...initial.draft,
    title: 'Title',
    blocks: [
      {
        ...initial.draft.blocks[0],
        type: 'paragraph',
        content: [{ type: 'text', text, marks: [] }],
      },
    ],
  });
  expect(reply.status).toBe('ok');
  return { ...f, state: session(reply.snapshot) };
}
it('unicode_range_rejects_surrogate_split and rejected_splice_preserves_range', async () => {
  const { manual, state } = await edited();
  const result = await manual.spliceManualPaste(
    command(state, 2),
    range(state, 2, 3),
    { html: '', plain: 'X' },
  );
  expect(result.status).toBe('invalid');
  expect(session(result.snapshot).draft).toEqual(state.draft);
  expect(session(result.snapshot).acknowledgedEdit).toEqual(
    state.acknowledgedEdit,
  );
});
it('unknown_edit_ack_never_replays and duplicate command must match payload', async () => {
  const { manual, state } = await edited('before');
  const cmd = command(state, 2);
  const after = {
    ...state.draft,
    blocks: [
      {
        ...state.draft.blocks[0],
        type: 'paragraph' as const,
        content: [{ type: 'text' as const, text: 'after', marks: [] }],
      },
    ],
  };
  expect(
    (await manual.applyManualEdit({ ...cmd, commandId: id(1) }, after)).status,
  ).toBe('conflict');
  expect((await manual.applyManualEdit(cmd, after)).status).toBe('ok');
  expect((await manual.applyManualEdit(cmd, state.draft)).status).toBe(
    'conflict',
  );
  const replay = await manual.applyManualEdit(cmd, after);
  expect(replay.status).toBe('ok');
  expect(session(replay.snapshot).documentRevision).toBe(
    state.documentRevision + 1,
  );
});
it('cancel_before_admission_keeps_selection', async () => {
  let resolve!: (v: ConvertedRichPaste) => void;
  const converted = new Promise<ConvertedRichPaste>((r) => {
    resolve = r;
  });
  const { manual, state } = await edited('before', {
    converter: { convert: () => converted },
  });
  const started = await manual.spliceManualPaste(
    command(state, 2),
    range(state, 1, 4),
    { html: '', plain: 'X' },
  );
  expect(started.status).toBe('started');
  await manual.cancelManualOperation(
    state.sessionId,
    session(started.snapshot).jobId!,
  );
  resolve({
    version: 2 as const,
    warnings: ['PLAIN_ONLY' as const],
    blocks: [
      {
        type: 'paragraph',
        content: [{ type: 'text' as const, text: 'X', marks: [] }],
      },
    ],
    plainOnly: true,
  });
  await flush();
  expect(session(manual.getManualArticleState()).draft).toEqual(state.draft);
  expect(manual.isBlocked()).toBe(false);
  expect((await manual.confirmManualEditorClose('discard')).status).toBe('ok');
  expect(manual.hasSession()).toBe(false);
});
it('forged_image_and_grant_rejected without changing confirmed body', async () => {
  const { manual, state } = await edited('before');
  expect(
    (
      await manual.applyManualEdit(command(state, 2), {
        ...state.draft,
        blocks: [{ blockKey: id(1), type: 'image', imageToken: id(2) }],
      })
    ).status,
  ).toBe('invalid');
  const rejected = session(manual.getManualArticleState());
  const result = await manual.spliceManualPaste(
    command(rejected, rejected.nextClientSequence),
    range(state, 0, 3),
    { kind: 'internal', grantId: id(3) },
  );
  await flush();
  expect(session(manual.getManualArticleState()).draft).toEqual(state.draft);
  expect(['invalid', 'started']).toContain(result.status);
});
it('a reloaded client uses the issued floor after rejection without inventing an acknowledgement', async () => {
  const { manual, state } = await edited('before');
  const old = command(state, 2);
  await manual.applyManualEdit(old, {
    ...state.draft,
    blocks: [{ type: 'image', blockKey: id(1), imageToken: id(2) }],
  });
  const loaded = session(manual.getManualArticleState());
  expect(loaded.nextClientSequence).toBe(3);
  expect(loaded.acknowledgedEdit).toEqual(state.acknowledgedEdit);
  expect(loaded.nextEditCommandId).not.toBe(old.commandId);
  expect((await manual.applyManualEdit(old, state.draft)).status).toBe(
    'conflict',
  );
  expect(
    (await manual.applyManualEdit(command(loaded, 2), state.draft)).status,
  ).toBe('conflict');
  const fresh = { ...loaded.draft, title: 'Fresh client' };
  expect(
    (
      await manual.applyManualEdit(
        command(loaded, loaded.nextClientSequence),
        fresh,
      )
    ).status,
  ).toBe('ok');
  expect(
    session(manual.getManualArticleState()).acknowledgedEdit?.clientSequence,
  ).toBe(3);
});
it('failed_cut_keeps_body', async () => {
  const svc = services({
    clipboard: {
      isReady: () => true,
      copy: async () => {
        throw new WebPasteFailure('INPUT_LIMIT');
      },
      paste: async () => {
        throw new WebPasteFailure('INPUT_LIMIT');
      },
      drain: async () => {},
    },
  });
  const { manual, state } = await edited('before', { documents: svc.api });
  const started = await manual.copyManualSelection(
    command(state, 2),
    range(state, 0, 3),
    true,
  );
  await flush();
  expect(session(manual.getManualArticleState()).draft).toEqual(state.draft);
  expect(['invalid', 'unavailable', 'started']).toContain(started.status);
  expect(manual.isBlocked()).toBe(false);
  expect(session(manual.getManualArticleState()).acknowledgedEdit).toEqual(
    state.acknowledgedEdit,
  );
});
it('pending_cancel_keeps_position and late ready cannot replace a cancelled image position', async () => {
  let ready!: (value: {
    imageToken: string;
    mime: 'image/png';
    width: number;
    height: number;
    byteSize: number;
  }) => void;
  const acquiring = new Promise<{
    imageToken: string;
    mime: 'image/png';
    width: number;
    height: number;
    byteSize: number;
  }>((r) => {
    ready = r;
  });
  let attempts = 0;
  const retained = new Set<string>();
  let finishCleanup!: () => void;
  let holdCleanup = false;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  const { manual, state } = await edited('AB', {
    retainImages: async (_sid, tokens) => {
      if (holdCleanup) await cleanup;
      for (const token of retained)
        if (!tokens.includes(token)) retained.delete(token);
    },
    converter: {
      convert: async () => ({
        version: 2 as const,
        warnings: [],
        blocks: [{ type: 'image', source: 'https://example.invalid/a.png' }],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: () => {
        attempts++;
        if (attempts === 1) return acquiring;
        retained.add(id(91));
        return Promise.resolve({
          imageToken: id(91),
          mime: 'image/png',
          width: 1,
          height: 1,
          byteSize: 1,
        });
      },
    },
  });
  const started = await manual.spliceManualPaste(
    command(state, 2),
    range(state, 1, 1),
    { html: '<img>', plain: '' },
  );
  await flush();
  const pending = session(manual.getManualArticleState());
  expect(pending.draft.blocks.map((b) => b.type)).toEqual([
    'paragraph',
    'image-pending',
    'paragraph',
  ]);
  await manual.cancelManualOperation(
    state.sessionId,
    session(started.snapshot).jobId!,
  );
  holdCleanup = true;
  retained.add(id(90));
  ready({
    imageToken: id(90),
    mime: 'image/png',
    width: 1,
    height: 1,
    byteSize: 1,
  });
  let settled = false;
  const settlement = manual.waitForSettlement().then(() => {
    settled = true;
  });
  await flush();
  expect(settled).toBe(false);
  finishCleanup();
  await settlement;
  holdCleanup = false;
  const cancelled = session(manual.getManualArticleState());
  expect(cancelled.draft).toEqual(pending.draft);
  expect(retained.size).toBe(0);
  expect(cancelled.candidates[0]).toMatchObject({
    candidateId: pending.candidates[0].candidateId,
    blockKey: pending.candidates[0].blockKey,
    state: 'cancelled',
    retryable: true,
  });
  const retryTicket = {
    sessionId: cancelled.sessionId,
    expectedRevision: cancelled.revision,
    commandId: cancelled.nextPasteCommandId,
  };
  const candidateId = cancelled.candidates[0].candidateId;
  expect(
    (await manual.retryManualPasteImage(retryTicket, candidateId)).status,
  ).toBe('started');
  await manual.waitForSettlement();
  const retried = session(manual.getManualArticleState());
  expect(attempts).toBe(2);
  expect(retried.candidates).toEqual([]);
  expect(retried.draft.blocks).toEqual(
    pending.draft.blocks.map((b) =>
      b.type === 'image-pending'
        ? { type: 'image', blockKey: b.blockKey, imageToken: id(91) }
        : b,
    ),
  );
  expect([...retained]).toEqual([id(91)]);
  await manual.retryManualPasteImage(retryTicket, candidateId);
  await manual.waitForSettlement();
  expect(attempts).toBe(2);
});
it('history_tokens_survive_delete_and_save and restoring an invented image key fails', async () => {
  const retainImages = vi.fn(async () => {});
  const svc = services();
  const { manual, state } = await edited('AB', {
    documents: svc.api,
    retainImages,
    chooseImage: async () => ({
      imageToken: id(90),
      mime: 'image/png',
      width: 1,
      height: 1,
      byteSize: 1,
    }),
  });
  await manual.insertManualImage(command(state, 2), range(state, 1, 1));
  await manual.waitForSettlement();
  const withImage = session(manual.getManualArticleState());
  const removed = await manual.applyManualEdit(
    command(withImage, 3),
    state.draft,
  );
  const noImage = session(removed.snapshot);
  expect(noImage.images[0].imageToken).toBe(id(90));
  await manual.commitManualDocument({
    sessionId: noImage.sessionId,
    expectedDocumentRevision: noImage.documentRevision,
    operationId: noImage.nextSaveOperationId,
  });
  await manual.waitForSettlement();
  const saved = session(manual.getManualArticleState());
  expect(saved.saveOutcome?.kind).toBe('created');
  expect(
    (await manual.applyManualEdit(command(saved, 4), withImage.draft)).status,
  ).toBe('ok');
  expect(retainImages).toHaveBeenCalledWith(state.sessionId, [id(90)], {
    preserveHistory: true,
  });
  const restored = session(manual.getManualArticleState());
  expect(
    (
      await manual.applyManualEdit(command(restored, 5), {
        ...restored.draft,
        blocks: restored.draft.blocks.map((b) =>
          b.type === 'image' ? { ...b, blockKey: id(99) } : b,
        ),
      })
    ).status,
  ).toBe('invalid');
});
it('first-save and old receipt replay use current projection and only one commit for an operation', async () => {
  const svc = services();
  const { manual, state } = await edited('before', { documents: svc.api });
  const save = {
    sessionId: state.sessionId,
    expectedDocumentRevision: state.documentRevision,
    operationId: state.nextSaveOperationId,
  };
  expect((await manual.commitManualDocument(save)).status).toBe('started');
  await manual.waitForSettlement();
  const saved = session(manual.getManualArticleState());
  expect(saved.target).toMatchObject({
    kind: 'existing',
    articleKey: id(800),
    baseArticleRevision: 1,
  });
  await manual.applyManualEdit(command(saved, 2), {
    ...saved.draft,
    blocks: [
      {
        ...saved.draft.blocks[0],
        type: 'paragraph',
        content: [{ type: 'text' as const, text: 'later', marks: [] }],
      },
    ],
  });
  const current = session(manual.getManualArticleState());
  const replay = await manual.commitManualDocument(save);
  expect(session(replay.snapshot).draft).toEqual(current.draft);
  expect(svc.writes()).toBe(1);
  expect(
    await manual.getManualSaveResult(state.sessionId, save.operationId),
  ).toMatchObject({ status: 'committed' });
  expect(
    await manual.getManualSaveResult(id(999), save.operationId),
  ).toMatchObject({ status: 'unavailable' });
});
it('shutdown closes normal mutations while only the exact apply-edit flush gate stays available', async () => {
  let closing = false;
  const { manual, state } = await edited('before', {
    gate: () => (closing ? 'unavailable' : 'ready'),
    editGate: () => 'ready',
    closeGate: () => 'ready',
  });
  closing = true;
  const next = { ...state.draft, title: 'Flushed' };
  expect(
    (
      await manual.spliceManualPaste(command(state, 2), range(state, 0, 0), {
        html: '',
        plain: 'X',
      })
    ).status,
  ).toBe('unavailable');
  expect(
    (await manual.insertManualImage(command(state, 2), range(state, 0, 0)))
      .status,
  ).toBe('unavailable');
  expect(
    (await manual.updateManualDraft(state.sessionId, state.revision, next))
      .status,
  ).toBe('unavailable');
  expect((await manual.applyManualEdit(command(state, 2), next)).status).toBe(
    'ok',
  );
  expect((await manual.confirmManualEditorClose('discard')).status).toBe('ok');
  expect(manual.hasSession()).toBe(false);
});
it('unknown writer blocks explicit discard and never clears the confirmed projection', async () => {
  const svc = services({
    saveRevision: async (input) => ({
      status: 'needs_review',
      operationId:
        input.kind === 'created'
          ? input.command.operationId
          : input.intent.operationId,
    }),
  });
  const { manual, state } = await edited('before', { documents: svc.api });
  await manual.commitManualDocument({
    sessionId: state.sessionId,
    expectedDocumentRevision: state.documentRevision,
    operationId: state.nextSaveOperationId,
  });
  await manual.waitForSettlement();
  expect(manual.isBlocked()).toBe(true);
  const blocked = session(manual.getManualArticleState());
  expect(
    (await manual.closeManualEditor(command(blocked, 2), 'discard')).status,
  ).toBe('unavailable');
  expect(session(manual.getManualArticleState()).draft).toEqual(state.draft);
});
it('a fresh sequence cannot reuse an old acknowledged sequence', async () => {
  const { manual, state } = await edited('before');
  const result = await manual.applyManualEdit(command(state, 1), state.draft);
  expect(result.status).toBe('conflict');
});
it('rejects a stale document revision before any picker IO', async () => {
  const chooseImage = vi.fn(async () => undefined);
  const { manual, state } = await edited('before', { chooseImage });
  expect(
    (
      await manual.insertManualImage(
        { ...command(state, 2), expectedDocumentRevision: 0 },
        range(state, 0, 0),
      )
    ).status,
  ).toBe('conflict');
  expect(chooseImage).not.toHaveBeenCalled();
});
it('retained candidate history reserves the shared image budget and keeps a rejected picker from changing body', async () => {
  const chooseImage = vi.fn(async () => ({
    imageToken: id(90),
    mime: 'image/png' as const,
    width: 1,
    height: 1,
    byteSize: 1,
  }));
  const { manual, state } = await edited('before', {
    chooseImage,
    converter: {
      convert: async () => ({
        version: 2 as const,
        warnings: [],
        blocks: Array.from({ length: 200 }, () => ({
          type: 'image' as const,
          source: undefined,
        })),
        plainOnly: false,
      }),
    },
  });
  await manual.spliceManualPaste(command(state, 2), range(state, 0, 0), {
    html: '<img>',
    plain: '',
  });
  await manual.waitForSettlement();
  const pending = session(manual.getManualArticleState());
  expect(pending.candidates).toHaveLength(200);
  await manual.applyManualEdit(
    command(pending, pending.nextClientSequence),
    state.draft,
  );
  const removed = session(manual.getManualArticleState());
  const rejected = await manual.insertManualImage(
    command(removed, removed.nextClientSequence),
    range(removed, 0, 0),
  );
  expect(rejected.status).toBe('invalid');
  expect(session(rejected.snapshot).draft).toEqual(removed.draft);
  expect(session(rejected.snapshot).issues?.[0].message).toContain('结束编辑');
  expect(chooseImage).not.toHaveBeenCalled();
});
it('explicit same-operation retry after confirmed failure commits once and keeps later receipt queries independent of old bodies', async () => {
  const svc = services();
  const successful = svc.api.saveRevision;
  let attempts = 0;
  svc.api.saveRevision = async (input, signal) =>
    ++attempts === 1
      ? {
          status: 'failed',
          operationId:
            input.kind === 'created'
              ? input.command.operationId
              : input.intent.operationId,
        }
      : successful(input, signal);
  const { manual, state } = await edited('before', { documents: svc.api });
  const save = {
    sessionId: state.sessionId,
    expectedDocumentRevision: state.documentRevision,
    operationId: state.nextSaveOperationId,
  };
  await manual.commitManualDocument(save);
  await manual.waitForSettlement();
  expect((await manual.commitManualDocument(save)).status).toBe('started');
  await manual.waitForSettlement();
  expect(svc.writes()).toBe(1);
  const saved = session(manual.getManualArticleState());
  await manual.applyManualEdit(command(saved, saved.nextClientSequence), {
    ...saved.draft,
    title: 'Later body',
  });
  const current = session(manual.getManualArticleState());
  expect(
    await manual.getManualSaveResult(current.sessionId, save.operationId),
  ).toMatchObject({ status: 'committed' });
  expect((await manual.commitManualDocument(save)).status).toBe('ok');
  expect(session(manual.getManualArticleState()).draft).toEqual(current.draft);
  expect(svc.writes()).toBe(1);
});
it('repeated failed saves retry an evicted operation from current confirmed data without restoring an old body', async () => {
  const svc = services();
  const success = svc.api.saveRevision;
  let attempts = 0;
  svc.api.saveRevision = async (input, signal) =>
    ++attempts <= 2
      ? {
          status: 'failed',
          operationId:
            input.kind === 'created'
              ? input.command.operationId
              : input.intent.operationId,
        }
      : success(input, signal);
  const { manual, state } = await edited('current', { documents: svc.api });
  const first = {
    sessionId: state.sessionId,
    expectedDocumentRevision: state.documentRevision,
    operationId: state.nextSaveOperationId,
  };
  await manual.commitManualDocument(first);
  await manual.waitForSettlement();
  const failed = session(manual.getManualArticleState());
  await manual.commitManualDocument({
    ...first,
    operationId: failed.nextSaveOperationId,
  });
  await manual.waitForSettlement();
  expect((await manual.commitManualDocument(first)).status).toBe('started');
  await manual.waitForSettlement();
  expect(svc.writes()).toBe(1);
  expect(session(manual.getManualArticleState()).draft).toEqual(state.draft);
  expect(session(manual.getManualArticleState()).saveOutcome?.operationId).toBe(
    first.operationId,
  );
});

it('canonical paste reports parsing then sequential bounded image progress and retires it on settlement', async () => {
  let finish!: (image: {
    imageToken: string;
    mime: 'image/png';
    width: number;
    height: number;
    byteSize: number;
  }) => void;
  const { manual, state } = await edited('AB', {
    converter: {
      convert: async () => ({
        version: 2 as const,
        warnings: [],
        blocks: [
          { type: 'image', source: 'https://example.invalid/one.png' },
          { type: 'image', source: 'https://example.invalid/two.png' },
          { type: 'image', source: 'blob:unsupported' },
        ],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const started = await manual.spliceManualPaste(
    command(state, 2),
    range(state, 1, 1),
    { html: '<img>', plain: '' },
  );
  expect(session(started.snapshot).pasteProgress).toMatchObject({
    phase: 'parsing',
    admitted: false,
    current: 0,
    total: 0,
  });
  await flush();
  expect(session(manual.getManualArticleState()).pasteProgress).toMatchObject({
    phase: 'images',
    admitted: true,
    current: 1,
    total: 3,
  });
  finish({
    imageToken: id(90),
    mime: 'image/png',
    width: 1,
    height: 1,
    byteSize: 1,
  });
  await flush();
  expect(session(manual.getManualArticleState()).pasteProgress).toMatchObject({
    phase: 'images',
    admitted: true,
    current: 2,
    total: 3,
  });
  await manual.cancelManualOperation(
    state.sessionId,
    session(started.snapshot).jobId!,
  );
  finish({
    imageToken: id(91),
    mime: 'image/png',
    width: 1,
    height: 1,
    byteSize: 1,
  });
  await manual.waitForSettlement();
  const done = session(manual.getManualArticleState());
  expect(done.pasteProgress).toBeUndefined();
  expect(done.candidates).toMatchObject([
    { state: 'cancelled', retryable: true },
    { state: 'failed', reason: 'SOURCE_UNSUPPORTED', retryable: false },
  ]);
});

it('text-only canonical paste keeps parsing feedback while final owned cleanup is still pending', async () => {
  let finish!: () => void;
  let holdSettlement = false;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { manual, state } = await edited('Before', {
    retainImages: async () => {
      if (holdSettlement && session(inspect()).pasteProgress?.admitted)
        await cleanup;
    },
  });
  const inspect = () => manual.getManualArticleState();
  holdSettlement = true;
  await manual.spliceManualPaste(command(state, 2), range(state, 0, 0), {
    html: '',
    plain: 'Text',
  });
  await flush();
  const current = session(inspect());
  expect(current.state).toBe('pasting');
  expect(current.pasteProgress).toMatchObject({
    phase: 'parsing',
    admitted: true,
    current: 0,
    total: 0,
  });
  finish();
  await manual.waitForSettlement();
  expect(session(inspect()).pasteProgress).toBeUndefined();
});

it('V2 controller copies a full versioned fragment and pastes closed paragraphs without merging', async () => {
  let fragment:
    import('../../src/contracts/manual-article').ManualFragmentV2 | undefined;
  const svc = services();
  svc.api.clipboard.copy = async (_session, value) => {
    fragment = structuredClone(value);
  };
  svc.api.clipboard.paste = async () => ({ fragment: fragment!, images: [] });
  const { manual, state } = await edited('AB', { documents: svc.api });
  const blockKey = state.draft.blocks[0].blockKey;
  await manual.copyManualSelection(
    command(state, 2),
    {
      anchor: { kind: 'edge', blockKey, side: 'before' },
      head: { kind: 'edge', blockKey, side: 'after' },
    },
    false,
  );
  await flush();
  expect(fragment).toMatchObject({
    version: 2,
    openStart: false,
    openEnd: false,
    blocks: [{ type: 'paragraph', content: [{ text: 'AB', marks: [] }] }],
  });
  const copied = session(manual.getManualArticleState());
  await manual.spliceManualPaste(
    command(copied, copied.nextClientSequence),
    range(copied, 1, 1),
    { kind: 'internal', grantId: id(99) },
  );
  await flush();
  expect(session(manual.getManualArticleState()).draft.blocks).toMatchObject([
    { type: 'paragraph', content: [{ text: 'A', marks: [] }] },
    { type: 'paragraph', content: [{ text: 'AB', marks: [] }] },
    { type: 'paragraph', content: [{ text: 'B', marks: [] }] },
  ]);
});
it('V2 runtime preserves formatted grant and the unselected suffix', async () => {
  const svc = services();
  svc.api.clipboard.paste = async () => ({
    fragment: {
      version: 2,
      openStart: true,
      openEnd: true,
      blocks: [
        {
          type: 'paragraph',
          blockKey: id(90),
          content: [{ type: 'text', text: 'formatted', marks: ['bold'] }],
        },
      ],
    },
    images: [],
  });
  const { manual, state } = await edited('preserve', { documents: svc.api });
  await manual.spliceManualPaste(command(state, 2), range(state, 0, 4), {
    kind: 'internal',
    grantId: id(99),
  });
  await flush();
  expect(session(manual.getManualArticleState()).draft.blocks).toMatchObject([
    {
      type: 'paragraph',
      content: [
        { text: 'formatted', marks: ['bold'] },
        { text: 'erve', marks: [] },
      ],
    },
  ]);
});

it('V2 runtime admits full tree, format-only revision/save digest and rejects forged nested identity', async () => {
  const svc = services({ digest: (value) => JSON.stringify(value) });
  const { manual } = setup({ documents: svc.api });
  const initial = session((await manual.beginManualArticle()).snapshot);
  const rich = {
    bodyVersion: 2 as const,
    title: 'Rich',
    contentDeclaration: 'repost' as const,
    blocks: [
      {
        type: 'heading' as const,
        blockKey: id(501),
        content: [
          { type: 'text' as const, text: 'A😀B', marks: ['bold' as const] },
        ],
      },
      {
        type: 'list' as const,
        blockKey: id(502),
        kind: 'ordered' as const,
        start: 7,
        items: [
          {
            type: 'paragraph' as const,
            blockKey: id(503),
            content: [{ type: 'text' as const, text: 'item', marks: [] }],
          },
        ],
      },
      {
        type: 'blockquote' as const,
        blockKey: id(504),
        paragraphs: [
          { type: 'paragraph' as const, blockKey: id(505), content: [] },
        ],
      },
    ],
  };
  const first = await manual.applyManualEdit(command(initial), rich);
  expect(first.status).toBe('ok');
  const edited = session(first.snapshot);
  expect(edited.draft).toEqual(rich);
  expect(edited.documentRevision).toBe(1);
  expect(edited.dirty).toBe(true);
  const save = {
    sessionId: edited.sessionId,
    expectedDocumentRevision: edited.documentRevision,
    operationId: edited.nextSaveOperationId,
  };
  expect((await manual.commitManualDocument(save)).status).toBe('started');
  const busy = await manual.applyManualEdit(
    command(session(manual.getManualArticleState()), 2),
    { ...rich, title: 'Busy' },
  );
  expect(busy.status).toBe('busy');
  await manual.waitForSettlement();
  const saved = session(manual.getManualArticleState());
  expect(saved.sessionId).toBe(initial.sessionId);
  expect(saved.target).toMatchObject({
    kind: 'existing',
    articleKey: id(800),
    baseArticleRevision: 1,
  });
  expect(saved.dirty).toBe(false);
  const body = svc.articles.get(id(800))!.editorBody!;
  expect(JSON.stringify(body)).not.toContain('blockKey');
  expect(body).toMatchObject({
    version: 2,
    blocks: [
      { type: 'heading', content: [{ marks: ['bold'] }] },
      { type: 'list', start: 7 },
      { type: 'blockquote' },
    ],
  });
  const next = structuredClone(rich);
  next.blocks[0] = {
    type: 'heading',
    blockKey: id(501),
    content: [{ type: 'text', text: 'A😀B', marks: [] }],
  };
  const changed = session(
    (
      await manual.applyManualEdit(
        command(saved, saved.nextClientSequence),
        next,
      )
    ).snapshot,
  );
  expect(changed.documentRevision).toBe(2);
  expect(changed.dirty).toBe(true);
  await manual.commitManualDocument({
    sessionId: changed.sessionId,
    expectedDocumentRevision: changed.documentRevision,
    operationId: changed.nextSaveOperationId,
  });
  await manual.waitForSettlement();
  const updated = session(manual.getManualArticleState());
  expect(updated.saveOutcome).toMatchObject({
    kind: 'updated',
    articleRevision: 2,
  });
  const digests = [...svc.receipts.values()].map((r) => r.payloadDigest);
  expect(digests[0]).not.toBe(digests[1]);
  const forged = structuredClone(next);
  forged.blocks[1] = {
    type: 'list',
    blockKey: id(502),
    kind: 'ordered',
    start: 7,
    items: [{ type: 'paragraph', blockKey: id(501), content: [] }],
  };
  expect(
    (
      await manual.applyManualEdit(
        command(updated, updated.nextClientSequence),
        forged,
      )
    ).status,
  ).toBe('invalid');
  expect(session(manual.getManualArticleState()).draft).toEqual(next);
});

it('continuous V2 rich paste exposes trusted warnings and explicit plain-only bypasses grants', async () => {
  const seen: unknown[] = [];
  const { manual } = setup({
    converter: {
      convert: async (input) => {
        seen.push(input);
        return input.html
          ? {
              version: 2,
              blocks: [
                {
                  type: 'heading',
                  content: [{ type: 'text', text: 'Rich', marks: ['italic'] }],
                },
              ],
              plainOnly: false,
              warnings: ['HEADING_NORMALIZED'],
            }
          : {
              version: 2,
              blocks: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: input.plain, marks: [] }],
                },
              ],
              plainOnly: true,
              warnings: ['PLAIN_ONLY'],
            };
      },
    },
  });
  const initial = session((await manual.beginManualArticle()).snapshot);
  const point = {
    blockKey: initial.draft.blocks[0].blockKey,
    kind: 'text' as const,
    offset: 0,
  };
  expect(
    (
      await manual.spliceManualPaste(
        command(initial),
        { anchor: point, head: point },
        { html: '<h1>Rich</h1>', plain: 'Rich' },
      )
    ).status,
  ).toBe('started');
  await manual.waitForSettlement();
  const rich = session(manual.getManualArticleState());
  expect(rich.draft.blocks.some((b) => b.type === 'heading')).toBe(true);
  expect(rich.pasteSummary).toMatchObject({
    admitted: true,
    outcome: 'completed',
    warnings: ['HEADING_NORMALIZED'],
  });
  const first = rich.draft.blocks[0];
  const edge = {
    blockKey: first.blockKey,
    kind: 'edge' as const,
    side: 'before' as const,
  };
  await manual.spliceManualPaste(
    command(rich, rich.nextClientSequence),
    { anchor: edge, head: edge },
    { html: '', plain: 'literal private marker text' },
  );
  await manual.waitForSettlement();
  const plain = session(manual.getManualArticleState());
  expect(seen).toHaveLength(2);
  expect(plain.pasteSummary).toMatchObject({
    plainOnly: true,
    warnings: ['PLAIN_ONLY'],
  });
  expect(JSON.stringify(plain)).not.toContain('<h1>');
});

it('failed internal rich admission does not retain fresh image grants in the session', async () => {
  const fresh = {
    imageToken: id(920),
    mime: 'image/png' as const,
    width: 1,
    height: 1,
    byteSize: 1,
  };
  const svc = services({
    clipboard: {
      isReady: () => true,
      copy: async () => {},
      drain: async () => {},
      paste: async () => ({
        fragment: {
          version: 2,
          openStart: false,
          openEnd: false,
          blocks: [
            { type: 'image', blockKey: id(921), imageToken: fresh.imageToken },
          ],
        },
        images: [fresh],
      }),
    },
  });
  const { manual, state } = await edited('preserve', {
    documents: svc.api,
    retainImages: async (_sid, tokens) => {
      if (tokens.includes(fresh.imageToken))
        throw new WebPasteFailure('RECOVERY_REQUIRED');
    },
  });
  await manual.spliceManualPaste(command(state, 2), range(state, 0, 2), {
    kind: 'internal',
    grantId: id(922),
  });
  await manual.waitForSettlement();
  const after = session(manual.getManualArticleState());
  expect(after.draft).toEqual(state.draft);
  expect(after.images).toEqual(state.images);
});

it('cancel during rich grant retention never commits a late fragment or image capability', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (release = r));
  const fresh = {
    imageToken: id(930),
    mime: 'image/png' as const,
    width: 1,
    height: 1,
    byteSize: 1,
  };
  const svc = services({
    clipboard: {
      isReady: () => true,
      copy: async () => {},
      drain: async () => {},
      paste: async () => ({
        fragment: {
          version: 2,
          openStart: false,
          openEnd: false,
          blocks: [
            { type: 'image', blockKey: id(931), imageToken: fresh.imageToken },
          ],
        },
        images: [fresh],
      }),
    },
  });
  const { manual, state } = await edited('preserve', {
    documents: svc.api,
    retainImages: async (_sid, tokens) => {
      if (tokens.includes(fresh.imageToken)) {
        entered();
        await hold;
      }
    },
  });
  const reply = await manual.spliceManualPaste(
    command(state, 2),
    range(state, 0, 2),
    { kind: 'internal', grantId: id(932) },
  );
  await started;
  await manual.cancelManualOperation(
    state.sessionId,
    session(reply.snapshot).jobId!,
  );
  release();
  await manual.waitForSettlement();
  const after = session(manual.getManualArticleState());
  expect(after.draft).toEqual(state.draft);
  expect(after.images).toEqual(state.images);
  expect(after.documentRevision).toBe(state.documentRevision);
  expect(after.pasteSummary).toMatchObject({
    outcome: 'cancelled',
    admitted: false,
    reason: 'CANCELLED',
  });
});
import { convertRichWebPaste } from '../../src/infrastructure/content/web-paste-parser';
it.each([
  '<center>Alpha</center><center>Beta</center>',
  '<p>prefix</p><center>Alpha</center><center>Beta</center>',
])(
  'center converter failure preserves selected body and keys: %s',
  async (html) => {
    const { manual, state } = await edited('original body', {
      converter: { convert: async (input) => convertRichWebPaste(input) },
    });
    const selection = range(state, 2, 7);
    const started = await manual.spliceManualPaste(
      command(state, 2),
      selection,
      { html, plain: 'must not fall back' },
    );
    expect(started.status).toBe('started');
    await flush();
    const after = session(manual.getManualArticleState());
    expect(after.draft).toEqual(state.draft);
    expect(after.documentRevision).toBe(state.documentRevision);
    expect(after.pasteSummary).toMatchObject({
      outcome: 'rejected',
      reason: 'UNSUPPORTED_STRUCTURE',
    });
    // The original key and range remain valid after failure, including valid-prefix input.
    const next = await manual.spliceManualPaste(
      command(after, after.nextClientSequence),
      selection,
      { html: '<p>X</p>', plain: '' },
    );
    expect(next.status).toBe('started');
    await flush();
    expect(session(manual.getManualArticleState()).draft.blocks).toMatchObject([
      { content: [{ text: 'orXl body' }] },
    ]);
  },
);

for (const offset of [0, 2]) {
  it(`boundary residual: actual controller image picker at offset ${offset} does not add empty paragraphs`, async () => {
    const { manual, state } = await edited('AB', {
      chooseImage: async () => ({
        imageToken: id(90),
        mime: 'image/png',
        width: 1,
        height: 1,
        byteSize: 1,
      }),
    });
    const started = await manual.insertManualImage(
      command(state, 2),
      range(state, offset, offset),
    );
    expect(started.status).toBe('started');
    await manual.waitForSettlement();
    const current = session(manual.getManualArticleState());
    expect(
      current.draft.blocks.map((block) =>
        block.type === 'paragraph'
          ? block.content.map((run) => run.text).join('')
          : block.type,
      ),
    ).toEqual(offset === 0 ? ['image', 'AB'] : ['AB', 'image']);
    expect(current.images.map((image) => image.imageToken)).toEqual([id(90)]);
  });
}
it('boundary residual: actual controller closed internal paste into new empty body keeps exact fragment structure', async () => {
  const svc = services();
  svc.api.clipboard.paste = async () => ({
    fragment: {
      version: 2,
      openStart: false,
      openEnd: false,
      blocks: [
        {
          type: 'paragraph',
          blockKey: id(90),
          content: [{ type: 'text', text: 'A', marks: ['bold'] }],
        },
        { type: 'paragraph', blockKey: id(91), content: [] },
        {
          type: 'paragraph',
          blockKey: id(92),
          content: [{ type: 'text', text: 'B', marks: [] }],
        },
      ],
    },
    images: [],
  });
  const { manual } = setup({ documents: svc.api });
  const state = session((await manual.beginManualArticle()).snapshot);
  await manual.spliceManualPaste(command(state), range(state, 0, 0), {
    kind: 'internal',
    grantId: id(99),
  });
  await manual.waitForSettlement();
  expect(session(manual.getManualArticleState()).draft.blocks).toMatchObject([
    { type: 'paragraph', content: [{ text: 'A', marks: ['bold'] }] },
    { type: 'paragraph', content: [] },
    { type: 'paragraph', content: [{ text: 'B', marks: [] }] },
  ]);
});

function manualCoverHarness() {
  const body = services();
  type Configuration =
    import('../../src/contracts/article-cover').StoredCoverConfiguration;
  type Intent = import('../../src/contracts/article-cover').CoverSaveIntent;
  type Result = import('../../src/contracts/article-cover').CoverSaveResult;
  let configuration: Configuration = {
    articleKey: id(800),
    coverRevision: 0,
    mode: 'none',
    assets: [],
    configurationDigest: 'a'.repeat(64),
    saveOperationId: null,
    committedAt: null,
  };
  const intents: Intent[] = [];
  let outcome: 'failed' | 'needs_review' | 'committed' = 'committed';
  const image = {
    bytes: new Uint8Array([1]),
    mime: 'image/png' as const,
    width: 1,
    height: 1,
    sha256: 'a'.repeat(64),
  };
  function result(intent: Intent): Result {
    if (outcome !== 'committed')
      return { status: outcome, operationId: intent.operationId };
    configuration = {
      ...configuration,
      coverRevision: intent.expectedCoverRevision + 1,
      mode: intent.mode,
      assets:
        intent.mode === 'none'
          ? []
          : [
              {
                assetKey: id(901),
                mime: 'image/png',
                width: 1,
                height: 1,
                byteSize: 1,
                sha256: image.sha256,
                relativePath:
                  intent.articleKey +
                  '/' +
                  intent.operationId +
                  '/' +
                  id(901) +
                  '.png',
              },
            ],
      saveOperationId: intent.operationId,
      committedAt: '2026-11-09T00:00:00.000Z',
    };
    return {
      status: 'committed',
      receipt: {
        operationId: intent.operationId,
        articleKey: intent.articleKey,
        coverRevision: configuration.coverRevision,
        configurationDigest: configuration.configurationDigest,
      },
    };
  }
  const covers: import('../../src/application/manual-cover').ManualCoverServices =
    {
      picker: { pick: async () => [image] },
      loadCover: () => configuration,
      readImage: async () => image.bytes,
      save: async (intent) => {
        intents.push(intent);
        return result(intent);
      },
      getSaveResult: async (operationId) =>
        result(intents.find((intent) => intent.operationId === operationId)!),
    };
  return {
    body,
    covers,
    intents,
    image,
    outcome: (value: typeof outcome) => {
      outcome = value;
    },
  };
}
async function pickCover(manual: ReturnType<typeof setup>['manual']) {
  const current = session(manual.getManualArticleState());
  await manual.pickManualCoverImage({
    sessionId: current.sessionId,
    expectedCoverDraftRevision: current.cover?.draftRevision ?? 0,
  });
  await manual.waitForSettlement();
  return session(manual.getManualArticleState());
}
function coverSaveTicket(current: ReturnType<typeof session>) {
  return {
    sessionId: current.sessionId,
    expectedDocumentRevision: current.documentRevision,
    expectedCoverDraftRevision: current.cover!.draftRevision,
    operationId: current.nextSaveOperationId,
  };
}
it('manual cover selection creates no placeholder and retries cover only after body commit', async () => {
  const harness = manualCoverHarness();
  harness.outcome('failed');
  const fixture = await edited('body', {
    documents: { ...harness.body.api, covers: harness.covers },
  });
  const picked = await pickCover(fixture.manual);
  expect(harness.body.writes()).toBe(0);
  expect(harness.intents).toHaveLength(0);
  expect(picked.cover!.dirty).toBe(true);
  const firstTicket = coverSaveTicket(picked);
  expect((await fixture.manual.commitManualDocument(firstTicket)).status).toBe(
    'started',
  );
  await fixture.manual.waitForSettlement();
  let current = session(fixture.manual.getManualArticleState());
  expect(current.dirty).toBe(false);
  expect(current.hasUnsavedChanges).toBe(true);
  expect(current.cover!.outcome!.status).toBe('failed');
  expect(current.target).toMatchObject({
    kind: 'existing',
    articleKey: id(800),
    baseArticleRevision: 1,
  });
  await fixture.manual.commitManualDocument(firstTicket);
  await fixture.manual.waitForSettlement();
  expect(harness.intents).toHaveLength(1);
  harness.outcome('committed');
  await fixture.manual.commitManualDocument(coverSaveTicket(current));
  await fixture.manual.waitForSettlement();
  current = session(fixture.manual.getManualArticleState());
  expect(harness.body.writes()).toBe(1);
  expect(harness.intents).toHaveLength(2);
  expect(current.cover!.dirty).toBe(false);
  expect(current.hasUnsavedChanges).toBe(false);
});
it('missing or stale cover revision rejects Save before body and cover writes', async () => {
  const harness = manualCoverHarness();
  const fixture = await edited('body', {
    documents: { ...harness.body.api, covers: harness.covers },
  });
  const picked = await pickCover(fixture.manual);
  const ticket = coverSaveTicket(picked);
  expect(
    (
      await fixture.manual.commitManualDocument({
        ...ticket,
        expectedCoverDraftRevision: undefined,
      })
    ).status,
  ).toBe('conflict');
  expect(
    (
      await fixture.manual.commitManualDocument({
        ...ticket,
        expectedCoverDraftRevision: 0,
      })
    ).status,
  ).toBe('conflict');
  expect(harness.body.writes()).toBe(0);
  expect(harness.intents).toHaveLength(0);
});
it('unknown cover outcome only queries the original operation and never allows discard or a new write', async () => {
  const harness = manualCoverHarness();
  harness.outcome('needs_review');
  const fixture = await edited('body', {
    documents: { ...harness.body.api, covers: harness.covers },
  });
  const picked = await pickCover(fixture.manual);
  await fixture.manual.commitManualDocument(coverSaveTicket(picked));
  await fixture.manual.waitForSettlement();
  let current = session(fixture.manual.getManualArticleState());
  expect(current.cover!.outcome!.status).toBe('needs_review');
  expect(
    (await fixture.manual.commitManualDocument(coverSaveTicket(current)))
      .status,
  ).toBe('unavailable');
  expect(
    (
      await fixture.manual.closeManualEditor(
        command(current, current.nextClientSequence),
        'discard',
      )
    ).status,
  ).toBe('unavailable');
  expect(harness.intents).toHaveLength(1);
  harness.outcome('committed');
  await fixture.manual.reconcileManualCoverSave(current.sessionId);
  await fixture.manual.waitForSettlement();
  current = session(fixture.manual.getManualArticleState());
  expect(current.hasUnsavedChanges).toBe(false);
  expect(harness.intents).toHaveLength(1);
  expect(harness.body.writes()).toBe(1);
});
it('body failure or unknown result leaves cover unstarted and candidate retained', async () => {
  for (const status of ['failed', 'needs_review'] as const) {
    const harness = manualCoverHarness();
    const fixture = await edited('body', {
      documents: {
        ...harness.body.api,
        covers: harness.covers,
        saveRevision: async (input) => ({
          status,
          operationId:
            input.kind === 'created'
              ? input.command.operationId
              : input.intent.operationId,
        }),
      },
    });
    const picked = await pickCover(fixture.manual);
    await fixture.manual.commitManualDocument(coverSaveTicket(picked));
    await fixture.manual.waitForSettlement();
    const current = session(fixture.manual.getManualArticleState());
    expect(current.target.kind).toBe('new');
    expect(current.cover!.dirty).toBe(true);
    expect(harness.intents).toHaveLength(0);
  }
});
it('late cancelled native cover selection never becomes an accepted candidate', async () => {
  const harness = manualCoverHarness();
  let resolve!: (images: readonly (typeof harness.image)[]) => void;
  harness.covers.picker.pick = () =>
    new Promise((done) => {
      resolve = done;
    });
  const fixture = await edited('body', {
    documents: { ...harness.body.api, covers: harness.covers },
  });
  const started = session(
    (
      await fixture.manual.pickManualCoverImage({
        sessionId: fixture.state.sessionId,
        expectedCoverDraftRevision: 0,
      })
    ).snapshot,
  );
  await flush();
  await fixture.manual.cancelManualOperation(started.sessionId, started.jobId!);
  resolve([harness.image]);
  await fixture.manual.waitForSettlement();
  const current = session(fixture.manual.getManualArticleState());
  expect(current.cover).toMatchObject({
    dirty: false,
    draftRevision: 0,
    mode: 'none',
  });
  expect(current.cover!.image).toBeUndefined();
});
it('restart retains clean body with a dirty cover and explicit discard releases the pending preview', async () => {
  const harness = manualCoverHarness();
  const fixture = setup({
    documents: { ...harness.body.api, covers: harness.covers },
  });
  await fixture.manual.beginManualArticle();
  const picked = await pickCover(fixture.manual);
  expect(picked.dirty).toBe(false);
  await expect(fixture.manual.stopForRestart()).rejects.toThrow();
  expect(fixture.manual.hasSession()).toBe(true);
  expect(fixture.manual.hasUnsavedChanges()).toBe(true);
  const current = session(fixture.manual.getManualArticleState());
  expect(
    (
      await fixture.manual.closeManualEditor(
        command(current, current.nextClientSequence),
        'discard',
      )
    ).status,
  ).toBe('ok');
  expect(
    (
      await fixture.manual.getManualCoverImage(
        current.sessionId,
        current.cover!.image!.imageToken,
      )
    ).status,
  ).toBe('not_found');
});
it('late stored cover reads cannot use changed preview metadata after clear', async () => {
  const harness = manualCoverHarness();
  const fixture = await edited('body', {
    documents: { ...harness.body.api, covers: harness.covers },
  });
  const picked = await pickCover(fixture.manual);
  await fixture.manual.commitManualDocument(coverSaveTicket(picked));
  await fixture.manual.waitForSettlement();
  const saved = session(fixture.manual.getManualArticleState());
  let resolve!: (bytes: Uint8Array) => void;
  harness.covers.readImage = () =>
    new Promise((done) => {
      resolve = done;
    });
  const reading = fixture.manual.getManualCoverImage(
    saved.sessionId,
    saved.cover!.image!.imageToken,
  );
  await flush();
  await fixture.manual.setManualCoverMode(
    {
      sessionId: saved.sessionId,
      expectedCoverDraftRevision: saved.cover!.draftRevision,
    },
    'none',
  );
  resolve(new Uint8Array([1]));
  expect((await reading).status).toBe('not_found');
});

it('save-and-close waits for cover settlement and discard after partial save keeps the committed body', async () => {
  const harness = manualCoverHarness();
  harness.outcome('failed');
  const fixture = await edited('body', {
    documents: { ...harness.body.api, covers: harness.covers },
  });
  await pickCover(fixture.manual);
  await fixture.manual.confirmManualEditorClose('save');
  expect(fixture.manual.hasSession()).toBe(true);
  const partial = session(fixture.manual.getManualArticleState());
  expect(partial.dirty).toBe(false);
  expect(partial.cover!.dirty).toBe(true);
  expect(harness.body.articles.get(id(800))!.article.title).toBe('Title');
  await fixture.manual.confirmManualEditorClose('discard');
  expect(fixture.manual.hasSession()).toBe(false);
  expect(harness.body.articles.has(id(800))).toBe(true);
  expect(harness.covers.loadCover(id(800))!.coverRevision).toBe(0);
  expect(harness.body.writes()).toBe(1);
});

it('cover-only retry rejects a changed article identity without body writes', async () => {
  const harness = manualCoverHarness();
  harness.outcome('failed');
  const fixture = await edited('body', {
    documents: { ...harness.body.api, covers: harness.covers },
  });
  const picked = await pickCover(fixture.manual);
  await fixture.manual.commitManualDocument(coverSaveTicket(picked));
  await fixture.manual.waitForSettlement();
  const partial = session(fixture.manual.getManualArticleState());
  harness.body.articles.get(id(800))!.article.importId = id(999);
  harness.outcome('committed');
  await fixture.manual.commitManualDocument(coverSaveTicket(partial));
  await fixture.manual.waitForSettlement();
  expect(harness.body.writes()).toBe(1);
  expect(harness.intents).toHaveLength(1);
  expect(
    session(fixture.manual.getManualArticleState()).cover!.outcome!.status,
  ).toBe('conflict');
});

it('legacy body APIs cannot mutate a manual owner while its cover result is unknown', async () => {
  const harness = manualCoverHarness();
  harness.outcome('needs_review');
  const fixture = await edited('body', {
    documents: { ...harness.body.api, covers: harness.covers },
  });
  const picked = await pickCover(fixture.manual);
  await fixture.manual.commitManualDocument(coverSaveTicket(picked));
  await fixture.manual.waitForSettlement();
  const unknown = session(fixture.manual.getManualArticleState());
  expect(
    (
      await fixture.manual.updateManualDraft(
        unknown.sessionId,
        unknown.revision,
        { ...unknown.draft, title: 'Must remain frozen' },
      )
    ).status,
  ).toBe('unavailable');
  expect(
    (
      await fixture.manual.startManualPaste(
        {
          sessionId: unknown.sessionId,
          expectedRevision: unknown.revision,
          commandId: unknown.nextPasteCommandId,
        },
        { html: '', plain: 'Must remain frozen' },
      )
    ).status,
  ).toBe('unavailable');
  expect(session(fixture.manual.getManualArticleState()).draft).toEqual(
    unknown.draft,
  );
});

it('canonical native-close dirty decision includes clean body with pending cover and saves both before release', async () => {
  const harness = manualCoverHarness();
  const fixture = await edited('body', {
    documents: { ...harness.body.api, covers: harness.covers },
  });
  const initial = session(fixture.manual.getManualArticleState());
  await fixture.manual.commitManualDocument(coverSaveTicket(initial));
  await fixture.manual.waitForSettlement();
  expect(fixture.manual.hasUnsavedChanges()).toBe(false);
  await pickCover(fixture.manual);
  const coverOnly = session(fixture.manual.getManualArticleState());
  expect(coverOnly.dirty).toBe(false);
  expect(coverOnly.hasUnsavedChanges).toBe(true);
  // Main's native close branch uses this canonical predicate before its choice.
  expect(fixture.manual.hasUnsavedChanges()).toBe(true);
  const saved = await fixture.manual.confirmManualEditorClose('save');
  expect(saved.status).toBe('started');
  expect(fixture.manual.hasSession()).toBe(false);
  expect(harness.body.writes()).toBe(1);
  expect(harness.covers.loadCover(id(800))!.coverRevision).toBe(1);
});
