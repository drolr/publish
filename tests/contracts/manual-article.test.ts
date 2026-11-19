import { expect, it } from 'vitest';
import {
  ManualDraftV1Schema as HistoricalManualDraftSchema,
  ManualDraftSchema,
  manualRequests,
  manualResponses,
} from '../../src/contracts/manual-article';

const id = 'cf88b7c0-8521-4b66-8e2b-9b73ad37c853';
const draft = {
  title: '',
  contentDeclaration: 'repost',
  blocks: [{ blockKey: id, type: 'paragraph', text: '' }],
};
it('allows temporarily empty input while rejecting extra privileged fields', () => {
  expect(HistoricalManualDraftSchema.safeParse(draft).success).toBe(true);
  expect(
    HistoricalManualDraftSchema.safeParse({ ...draft, path: 'C:/secret' })
      .success,
  ).toBe(false);
  expect(
    HistoricalManualDraftSchema.safeParse({
      ...draft,
      blocks: [
        { blockKey: id, type: 'image', imageToken: id, path: 'C:/secret' },
      ],
    }).success,
  ).toBe(false);
});
it('enforces UUIDs, unique block keys and code point limits without trimming', () => {
  expect(
    HistoricalManualDraftSchema.parse({ ...draft, title: '  空  ' }).title,
  ).toBe('  空  ');
  expect(
    HistoricalManualDraftSchema.safeParse({ ...draft, title: '😀'.repeat(512) })
      .success,
  ).toBe(true);
  expect(
    HistoricalManualDraftSchema.safeParse({ ...draft, title: '😀'.repeat(513) })
      .success,
  ).toBe(false);
  expect(
    HistoricalManualDraftSchema.safeParse({
      ...draft,
      blocks: [draft.blocks[0], draft.blocks[0]],
    }).success,
  ).toBe(false);
  expect(
    manualRequests.updateManualDraft.safeParse(['foreign', 0, draft]).success,
  ).toBe(false);
  expect(manualRequests.pickManualImage.safeParse([id, -1]).success).toBe(
    false,
  );
});
it('rejects excessive raw draft JSON bytes and count limits', () => {
  const blocks = Array.from({ length: 100 }, (_, i) => ({
    blockKey: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    type: 'paragraph',
    text: '字'.repeat(10000),
  }));
  expect(
    HistoricalManualDraftSchema.safeParse({ ...draft, blocks }).success,
  ).toBe(false);
  expect(
    HistoricalManualDraftSchema.safeParse({
      ...draft,
      blocks: [{ blockKey: id, type: 'paragraph', text: 'x'.repeat(20001) }],
    }).success,
  ).toBe(false);
  expect(
    HistoricalManualDraftSchema.safeParse({
      ...draft,
      blocks: Array.from({ length: 1001 }, (_, i) => ({
        blockKey: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        type: 'paragraph',
        text: '',
      })),
    }).success,
  ).toBe(false);
});
it('constrains all twenty-three bridge methods and rejects private snapshot metadata', () => {
  expect(Object.keys(manualRequests)).toHaveLength(23);
  expect(manualRequests.beginManualArticle.safeParse([{}]).success).toBe(false);
  expect(
    manualResponses.getManualArticleState.safeParse({
      state: 'idle',
      revision: 0,
      path: 'secret',
    }).success,
  ).toBe(false);
  expect(
    manualResponses.updateManualDraft.safeParse({
      status: 'ok',
      snapshot: { state: 'idle', revision: 0 },
    }).success,
  ).toBe(true);
});

import {
  ManualDraftV1Schema,
  ManualDraftV2Schema,
  ManualFragmentV2Schema,
  isManualImageBlock,
} from '../../src/contracts/manual-article';
const richId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const richParagraph = (n: number, text = '') => ({
  type: 'paragraph' as const,
  blockKey: richId(n),
  content: text ? [{ type: 'text' as const, text, marks: [] }] : [],
});
const richDraft = (blocks: unknown[]) => ({
  bodyVersion: 2,
  title: '',
  contentDeclaration: 'repost',
  blocks,
});
it('V2 draft is production while V1 remains explicit historical compatibility', () => {
  const value = richDraft([richParagraph(1)]);
  expect(ManualDraftV1Schema).toBe(HistoricalManualDraftSchema);
  expect(ManualDraftSchema).toBe(ManualDraftV2Schema);
  expect(ManualDraftV2Schema.safeParse(value).success).toBe(true);
  expect(ManualDraftSchema.safeParse(value).success).toBe(true);
  expect(ManualDraftV1Schema.safeParse(value).success).toBe(false);
  expect(
    manualRequests.applyManualEdit.safeParse([
      {
        sessionId: id,
        commandId: id,
        clientSequence: 1,
        expectedDocumentRevision: 0,
      },
      value,
    ]).success,
  ).toBe(true);
  expect(
    ManualDraftV2Schema.safeParse({
      ...value,
      html: '<b>not a stored body</b>',
    }).success,
  ).toBe(false);
});
it('V2 block budget counts every container and nested paragraph, with unique keys across the whole tree', () => {
  const list = (count: number) => ({
    type: 'list',
    kind: 'bullet',
    blockKey: richId(0),
    items: Array.from({ length: count }, (_, n) => richParagraph(n + 1)),
  });
  expect(ManualDraftV2Schema.safeParse(richDraft([list(999)])).success).toBe(
    true,
  );
  expect(ManualDraftV2Schema.safeParse(richDraft([list(1000)])).success).toBe(
    false,
  );
  expect(
    ManualDraftV2Schema.safeParse(richDraft([list(1), richParagraph(1)]))
      .success,
  ).toBe(false);
  expect(
    ManualDraftV2Schema.safeParse(
      richDraft([
        {
          type: 'blockquote',
          blockKey: richId(2),
          paragraphs: [
            { type: 'image', blockKey: richId(3), imageToken: richId(4) },
          ],
        },
      ]),
    ).success,
  ).toBe(false);
});
it('V2 retains repeated-image legacy layouts but image guards and new fragment edges stay explicit', () => {
  const positions = Array.from({ length: 201 }, (_, n) => ({
    type: 'image',
    blockKey: richId(n),
    imageToken: id,
  }));
  expect(ManualDraftV2Schema.safeParse(richDraft(positions)).success).toBe(
    true,
  );
  expect(
    ManualFragmentV2Schema.safeParse({
      version: 2,
      blocks: [positions[0]],
      openStart: true,
      openEnd: false,
    }).success,
  ).toBe(false);
  expect(isManualImageBlock({ type: 'heading' })).toBe(false);
  expect(isManualImageBlock({ type: 'list' })).toBe(false);
  expect(isManualImageBlock({ type: 'image-pending' })).toBe(true);
});
it('V2 validates UTF8 bytes before mark normalization, and keeps paragraph and global code point limits', () => {
  expect(
    ManualDraftV2Schema.safeParse(
      richDraft([richParagraph(1, '😀'.repeat(20000))]),
    ).success,
  ).toBe(true);
  expect(
    ManualDraftV2Schema.safeParse(
      richDraft([richParagraph(1, '😀'.repeat(20001))]),
    ).success,
  ).toBe(false);
  expect(
    ManualDraftV2Schema.safeParse(
      richDraft(
        Array.from({ length: 11 }, (_, n) =>
          richParagraph(n, 'x'.repeat(20000)),
        ),
      ),
    ).success,
  ).toBe(false);
  const oversized = {
    ...richParagraph(1, 'x'),
    content: [
      { type: 'text', text: 'x', marks: Array<string>(400000).fill('bold') },
    ],
  };
  expect(ManualDraftV2Schema.safeParse(richDraft([oversized])).success).toBe(
    false,
  );
});

it('manual cover bridge bounds edits and preview bytes without exposing file paths or enabling new triple edits', () => {
  const command = { sessionId: id, expectedCoverDraftRevision: 0 };
  expect(manualRequests.pickManualCoverImage.safeParse([command]).success).toBe(
    true,
  );
  expect(
    manualRequests.pickManualCoverImage.safeParse([
      { ...command, path: 'private' },
    ]).success,
  ).toBe(false);
  expect(
    manualRequests.setManualCoverMode.safeParse([command, 'triple']).success,
  ).toBe(false);
  expect(
    manualRequests.setManualCoverMode.safeParse([command, 'single']).success,
  ).toBe(true);
  expect(
    manualRequests.getManualCoverImage.safeParse(['../private', id]).success,
  ).toBe(false);
  expect(
    manualResponses.getManualCoverImage.safeParse({
      status: 'ok',
      mime: 'image/png',
      bytes: new Uint8Array([1]),
      path: 'private',
    }).success,
  ).toBe(false);
  expect(
    manualResponses.getManualCoverImage.safeParse({
      status: 'ok',
      mime: 'image/png',
      bytes: new Uint8Array(10_000_001),
    }).success,
  ).toBe(false);
});
