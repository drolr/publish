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
        blocks: [{ type: 'paragraph', text: 'X' }],
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
    blocks: [{ ...initial.draft.blocks[0], type: 'paragraph', text }],
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
      { ...state.draft.blocks[0], type: 'paragraph' as const, text: 'after' },
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
  let resolve!: (v: {
    blocks: { type: 'paragraph'; text: string }[];
    plainOnly: boolean;
  }) => void;
  const converted = new Promise<{
    blocks: { type: 'paragraph'; text: string }[];
    plainOnly: boolean;
  }>((r) => {
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
  resolve({ blocks: [{ type: 'paragraph', text: 'X' }], plainOnly: true });
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
    blocks: [{ ...saved.draft.blocks[0], type: 'paragraph', text: 'later' }],
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
