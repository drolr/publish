import { expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import {
  draftV2ToEditor,
  editorToDraftV2,
} from '../../src/renderer/editor/editor-codec';
import { ManualDraftV2Schema } from '../../src/contracts/manual-article';
import { DraftSnapshotV2Schema } from '../../src/contracts/draft-task';
import { createDraftSnapshotPort } from '../../src/infrastructure/assets/draft-snapshot';
import { createDraftSnapshotV2Digest } from '../../src/infrastructure/draft-snapshot-integrity';
import { PersistedEditorBodyV2Schema } from '../../src/contracts/rich-text-body';
import { projectRichBody } from '../../src/domain/rich-text-body';
import { convertRichWebPaste } from '../../src/infrastructure/content/web-paste-parser';
import { budgetSnapshot as snapshot } from '../fixtures/rich-budget';
const key = '11111111-1111-4111-8111-111111111111';
it('retains complete over-budget editor input for session rejection and incoming projection', () => {
  const draft = ManualDraftV2Schema.parse({
    bodyVersion: 2,
    title: 'Title',
    contentDeclaration: 'repost',
    blocks: [
      {
        type: 'paragraph',
        blockKey: key,
        content: [{ type: 'text', text: 'a'.repeat(20000), marks: [] }],
      },
    ],
  });
  const state = EditorState.create({ doc: draftV2ToEditor(draft) });
  const doc = state.apply(state.tr.insertText('x', 20001)).doc;
  const raw = editorToDraftV2(doc, draft);
  expect(ManualDraftV2Schema.safeParse(raw).success).toBe(false);
  expect(draftV2ToEditor(raw).textContent).toBe('a'.repeat(20000) + 'x');
});
it('rejects a legal rich body and manual draft when the complete snapshot exceeds 2MiB', async () => {
  const value = snapshot();
  expect(PersistedEditorBodyV2Schema.safeParse(value.editorBody).success).toBe(
    true,
  );
  expect(
    ManualDraftV2Schema.safeParse({
      bodyVersion: 2,
      title: 'Title',
      contentDeclaration: 'repost',
      blocks: value.editorBody.blocks.map((b, i) => ({
        ...b,
        blockKey: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      })),
    }).success,
  ).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(2097152);
  expect(DraftSnapshotV2Schema.safeParse(value).success).toBe(false);
  const port = createDraftSnapshotPort({} as never);
  await expect(
    port.capture({
      article: value.article,
      editorBody: value.editorBody,
      articleRevision: 1,
    }),
  ).rejects.toMatchObject({ code: 'INPUT_UNSUPPORTED' });
  await expect(port.verify(value)).rejects.toMatchObject({
    code: 'INPUT_UNSUPPORTED',
  });
});
it('accepts exactly 2MiB and rejects the next byte for a complete V2 snapshot', () => {
  const value = snapshot(49500);
  const extra = 2097152 - Buffer.byteLength(JSON.stringify(value));
  const leaf = value.editorBody.blocks[0];
  if (leaf.type !== 'paragraph') throw Error('leaf');
  leaf.content[0].text += 'a'.repeat(Math.floor(extra / 2));
  value.article.body = projectRichBody(value.editorBody);
  value.article.title += 'a'.repeat(extra % 2);
  value.digest = createDraftSnapshotV2Digest(value.article, value.editorBody);
  expect(Buffer.byteLength(JSON.stringify(value))).toBe(2097152);
  expect(DraftSnapshotV2Schema.safeParse(value).success).toBe(true);
  value.article.title += 'a';
  expect(DraftSnapshotV2Schema.safeParse(value).success).toBe(false);
});
it.each([
  '<center>Alpha</center><center>Beta</center>',
  '<p>prefix</p><center>Alpha</center><center>Beta</center>',
])('rejects the whole center paste: %s', async (html) => {
  expect(() => convertRichWebPaste({ html, plain: '' })).toThrowError(
    'UNSUPPORTED_STRUCTURE',
  );
});

import {
  EditorSession,
  type EditorSessionState,
} from '../../src/renderer/editor/editor-session';
import { editorSchema } from '../../src/renderer/editor/editor-schema';
it.each(['aggregate', 'format'] as const)(
  'keeps %s overflow local and blocks IPC until corrected',
  async (kind) => {
    const draft = ManualDraftV2Schema.parse({
      bodyVersion: 2,
      title: 'Title',
      contentDeclaration: 'repost',
      blocks:
        kind === 'format'
          ? snapshot(45000).editorBody.blocks.map((b, i) => ({
              ...b,
              blockKey: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
            }))
          : Array.from({ length: 20 }, (_, i) => ({
              type: 'paragraph',
              blockKey: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
              content: [{ type: 'text', text: 'a'.repeat(10000), marks: [] }],
            })),
    });
    const state = EditorState.create({ doc: draftV2ToEditor(draft) });
    const changed = state.apply(
      kind === 'format'
        ? state.tr.addMark(
            1,
            state.doc.content.size - 1,
            editorSchema.marks.underline.create(),
          )
        : state.tr.insertText('x', 1),
    );
    const raw = editorToDraftV2(changed.doc, draft);
    expect(ManualDraftV2Schema.safeParse(raw).success).toBe(false);
    expect(draftV2ToEditor(raw).eq(changed.doc)).toBe(true);
    let calls = 0;
    const main: EditorSessionState = {
      state: 'editing',
      revision: 1,
      sessionId: key,
      nextPasteCommandId: key,
      nextEditCommandId: key,
      nextClientSequence: 1,
      nextSaveOperationId: key,
      candidates: [],
      externalId: 'test',
      target: { kind: 'new' },
      documentRevision: 0,
      acknowledgedEdit: null,
      draft,
      images: [],
      dirty: false,
    };
    const session = new EditorSession(
      {
        applyManualEdit: async (command, value) => {
          calls++;
          return {
            status: 'ok',
            snapshot: {
              ...main,
              draft: value,
              revision: 2,
              documentRevision: 1,
              nextClientSequence: 2,
              acknowledgedEdit: {
                commandId: command.commandId,
                clientSequence: command.clientSequence,
              },
            },
          };
        },
      },
      () => {},
    );
    try {
      session.accept(main);
      session.change(raw);
      expect(await session.flush()).toBe(false);
      expect(calls).toBe(0);
      expect(session.unsynced).toBe(true);
      expect(session.draft).toEqual(raw);
      expect(session.notice).toContain('超出支持范围');
      session.accept({ ...main, revision: 2 });
      expect(session.draft).toEqual(raw);
      session.change({ ...draft, title: 'Corrected' });
      expect(await session.flush()).toBe(true);
      expect(calls).toBe(1);
      expect(session.unsynced).toBe(false);
    } finally {
      session.dispose();
    }
  },
);
