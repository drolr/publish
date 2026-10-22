import { expect, it } from 'vitest';
import {
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
  expect(ManualDraftSchema.safeParse(draft).success).toBe(true);
  expect(
    ManualDraftSchema.safeParse({ ...draft, path: 'C:/secret' }).success,
  ).toBe(false);
  expect(
    ManualDraftSchema.safeParse({
      ...draft,
      blocks: [
        { blockKey: id, type: 'image', imageToken: id, path: 'C:/secret' },
      ],
    }).success,
  ).toBe(false);
});
it('enforces UUIDs, unique block keys and code point limits without trimming', () => {
  expect(ManualDraftSchema.parse({ ...draft, title: '  空  ' }).title).toBe(
    '  空  ',
  );
  expect(
    ManualDraftSchema.safeParse({ ...draft, title: '😀'.repeat(512) }).success,
  ).toBe(true);
  expect(
    ManualDraftSchema.safeParse({ ...draft, title: '😀'.repeat(513) }).success,
  ).toBe(false);
  expect(
    ManualDraftSchema.safeParse({
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
  expect(ManualDraftSchema.safeParse({ ...draft, blocks }).success).toBe(false);
  expect(
    ManualDraftSchema.safeParse({
      ...draft,
      blocks: [{ blockKey: id, type: 'paragraph', text: 'x'.repeat(20001) }],
    }).success,
  ).toBe(false);
  expect(
    ManualDraftSchema.safeParse({
      ...draft,
      blocks: Array.from({ length: 1001 }, (_, i) => ({
        blockKey: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        type: 'paragraph',
        text: '',
      })),
    }).success,
  ).toBe(false);
});
it('constrains all nineteen bridge methods and rejects private snapshot metadata', () => {
  expect(Object.keys(manualRequests)).toHaveLength(19);
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
