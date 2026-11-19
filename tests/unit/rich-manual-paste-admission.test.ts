import { expect, it } from 'vitest';
import { admitRichManualPaste } from '../../src/application/manual-paste-admission';
import type {
  ManualDraftV2,
  ManualImage,
} from '../../src/contracts/manual-article';
import type { CandidateView } from '../../src/contracts/web-paste';
import type { ConvertedRichPaste } from '../../src/contracts/rich-web-paste';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = (text: string) => ({ type: 'text' as const, text, marks: [] });
const context = () => ({
  draft: {
    bodyVersion: 2,
    title: 'Title',
    contentDeclaration: 'repost',
    blocks: [{ type: 'paragraph', blockKey: id(1), content: [run('AB')] }],
  } as ManualDraftV2,
  images: [] as ManualImage[],
  candidates: [] as CandidateView[],
});
let next = 100;
const newId = () => id(++next);
const range = {
  anchor: { kind: 'text' as const, blockKey: id(1), offset: 1 },
  head: { kind: 'text' as const, blockKey: id(1), offset: 1 },
};
it('admit rich paste retains heading/list/marks/LF and allocates all structural keys and image placeholders', () => {
  const source = context();
  const paste: ConvertedRichPaste = {
    version: 2,
    plainOnly: false,
    warnings: ['HEADING_NORMALIZED'],
    blocks: [
      { type: 'heading', content: [{ ...run('h\nq'), marks: ['bold'] }] },
      {
        type: 'list',
        kind: 'ordered',
        start: 8,
        items: [{ type: 'paragraph', content: [run('next')] }],
      },
      { type: 'image', source: 'https://example.com/p.png' },
    ],
  };
  const admitted = admitRichManualPaste(source, paste, newId);
  expect(admitted.draft.blocks[1]).toMatchObject({
    type: 'heading',
    content: [{ text: 'h\nq', marks: ['bold'] }],
  });
  expect(admitted.draft.blocks[2]).toMatchObject({
    type: 'list',
    kind: 'ordered',
    start: 8,
    items: [{ blockKey: expect.any(String) }],
  });
  expect(admitted.draft.blocks[3]).toEqual({
    type: 'image-pending',
    blockKey: admitted.candidates[0].blockKey,
    candidateId: admitted.candidates[0].candidateId,
  });
  expect(admitted.items).toEqual([
    {
      candidateId: admitted.candidates[0].candidateId,
      source: 'https://example.com/p.png',
    },
  ]);
  expect(JSON.stringify(admitted.draft)).not.toContain('https://');
  expect(admitted.warnings).toEqual(['HEADING_NORMALIZED']);
  expect(source.draft.blocks).toHaveLength(1);
});
it('plain text conversion merges open text ends without changing LF or empty paragraphs', () => {
  const paste: ConvertedRichPaste = {
    version: 2,
    plainOnly: true,
    warnings: ['PLAIN_ONLY'],
    blocks: [
      { type: 'paragraph', content: [run('x\ny')] },
      { type: 'paragraph', content: [] },
    ],
  };
  const admitted = admitRichManualPaste(context(), paste, newId, range);
  expect(admitted.draft.blocks).toMatchObject([
    { type: 'paragraph', content: [{ text: 'Ax\ny' }] },
    { type: 'paragraph', content: [{ text: 'B' }] },
  ]);
});
it('unsupported or over-budget rich proposals preserve the selected original atomically', () => {
  const source = context();
  const before = structuredClone(source);
  const paste: ConvertedRichPaste = {
    version: 2,
    plainOnly: false,
    warnings: [],
    blocks: [{ type: 'paragraph', content: [run('x'.repeat(20001))] }],
  };
  expect(() => admitRichManualPaste(source, paste, newId, range)).toThrow();
  expect(source).toEqual(before);
});
it('list/quote insertion does not count them as images but image positions remain bounded', () => {
  const paste: ConvertedRichPaste = {
    version: 2,
    plainOnly: false,
    warnings: [],
    blocks: Array.from({ length: 20 }, () => ({
      type: 'blockquote',
      paragraphs: [{ type: 'paragraph', content: [run('x')] }],
    })),
  };
  expect(admitRichManualPaste(context(), paste, newId).candidates).toEqual([]);
  const source = context();
  source.draft.blocks = Array.from({ length: 200 }, (_, n) => ({
    type: 'image',
    blockKey: id(n + 1),
    imageToken: id(800),
  }));
  expect(() =>
    admitRichManualPaste(
      source,
      {
        version: 2,
        plainOnly: false,
        warnings: [],
        blocks: [{ type: 'image', source: undefined }],
      },
      newId,
    ),
  ).toThrow();
});
it('rejects image placement within a list before image acquisition', () => {
  const source = context();
  source.draft.blocks = [
    {
      type: 'list',
      kind: 'bullet',
      blockKey: id(2),
      items: [{ type: 'paragraph', blockKey: id(1), content: [run('AB')] }],
    },
  ];
  expect(() =>
    admitRichManualPaste(
      source,
      {
        version: 2,
        plainOnly: false,
        warnings: [],
        blocks: [{ type: 'image', source: 'https://example.com/i.png' }],
      },
      newId,
      range,
    ),
  ).toThrow();
});

it('range admission returns candidate keys from the final rekeyed document', () => {
  const result = admitRichManualPaste(
    context(),
    {
      version: 2,
      plainOnly: false,
      warnings: [],
      blocks: [{ type: 'image', source: 'https://example.com/new.png' }],
    },
    newId,
    range,
  );
  const pending = result.draft.blocks.find((b) => b.type === 'image-pending');
  expect(result.candidates[0]).toMatchObject({ blockKey: pending!.blockKey });
});
