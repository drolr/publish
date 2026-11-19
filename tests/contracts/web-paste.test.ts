import { expect, it } from 'vitest';
import {
  ManualDraftSchema,
  manualRequests,
} from '../../src/contracts/manual-article';
import { validateArticlePackage } from '../../src/contracts/article-package';

const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pending = { blockKey: id(), type: 'image-pending', candidateId: id(2) };
const draft = {
  bodyVersion: 2,
  title: '',
  contentDeclaration: 'repost',
  blocks: [pending],
};
const contract = () => import('../../src/contracts/web-paste');

it('reject_forged_candidate_fields', () => {
  expect(ManualDraftSchema.safeParse(draft).success).toBe(true);
  for (const forged of [
    { status: 'ready' },
    { src: 'https://private.example' },
    { path: 'C:/private' },
    { retryable: true },
  ])
    expect(
      ManualDraftSchema.safeParse({
        ...draft,
        blocks: [{ ...pending, ...forged }],
      }).success,
    ).toBe(false);
});
it('paste_input_utf8_boundary', async () => {
  const schemas = await contract();
  expect(schemas?.WebPasteInputSchema).toBeDefined();
  const input = { html: '字'.repeat(699050), plain: 'ab' };
  expect(schemas!.WebPasteInputSchema.safeParse(input).success).toBe(true);
  expect(
    schemas!.WebPasteInputSchema.safeParse({ ...input, plain: 'abc' }).success,
  ).toBe(false);
  expect(
    schemas!.WebPasteInputSchema.safeParse({
      ...input,
      url: 'https://private.example',
    }).success,
  ).toBe(false);
});
it('pending_count_and_snapshot_budget', async () => {
  const schemas = await contract();
  expect(schemas?.DraftSnapshotBudgetSchema).toBeDefined();
  const blocks = Array.from({ length: 199 }, (_, n) => ({
    blockKey: id(n + 10),
    type: 'image',
    imageToken: id(n + 300),
  }));
  const twoPositionsOneImage = [
    ...blocks,
    { ...blocks[0], blockKey: id(900) },
    pending,
  ];
  expect(
    ManualDraftSchema.safeParse({ ...draft, blocks: twoPositionsOneImage })
      .success,
  ).toBe(true);
  expect(
    ManualDraftSchema.safeParse({
      ...draft,
      blocks: [
        ...twoPositionsOneImage,
        { ...pending, blockKey: id(901), candidateId: id(902) },
      ],
    }).success,
  ).toBe(false);
  expect(
    schemas!.DraftSnapshotBudgetSchema.safeParse('x'.repeat(2097150)).success,
  ).toBe(true);
  expect(
    schemas!.DraftSnapshotBudgetSchema.safeParse('x'.repeat(2097151)).success,
  ).toBe(false);
  expect(
    schemas!.DraftSnapshotBudgetSchema.safeParse('字'.repeat(699050)).success,
  ).toBe(true);
  expect(
    schemas!.DraftSnapshotBudgetSchema.safeParse('字'.repeat(699050) + 'a')
      .success,
  ).toBe(false);
});
it('fixed_safe_reply', async () => {
  const schemas = await contract();
  expect(schemas?.CandidateViewSchema).toBeDefined();
  const candidate = {
    candidateId: id(2),
    blockKey: id(),
    state: 'failed',
    retryable: false,
    reason: 'SOURCE_UNSUPPORTED',
  };
  expect(schemas!.CandidateViewSchema.safeParse(candidate).success).toBe(true);
  for (const forged of [
    { reason: 'private exception' },
    { candidateId: 'x'.repeat(1000) },
    { url: 'https://private.example' },
  ])
    expect(
      schemas!.CandidateViewSchema.safeParse({ ...candidate, ...forged })
        .success,
    ).toBe(false);
  expect(
    schemas!.PasteProgressSchema.safeParse({
      jobId: id(),
      kind: 'paste',
      phase: 'images',
      admitted: true,
      current: 201,
      total: 201,
    }).success,
  ).toBe(false);
  expect(
    schemas!.PasteSummarySchema.safeParse({
      jobId: id(),
      kind: 'paste',
      outcome: 'partial',
      admitted: true,
      paragraphs: 0,
      imagePositions: 1,
      unresolved: 1,
      plainOnly: false,
      reason: 'secret',
    }).success,
  ).toBe(false);
});
it('keeps pending out of the external v1 package', () => {
  const valid = {
    schema_version: 1,
    article_id: 'external',
    title: 'title',
    body: [{ type: 'paragraph', text: 'body' }],
    images: [],
  };
  expect(validateArticlePackage(valid).ok).toBe(true);
  expect(
    validateArticlePackage({
      ...valid,
      body: [...valid.body, { type: 'image-pending', candidateId: id() }],
    }).ok,
  ).toBe(false);
});
it('requires bounded command identity and fixes both new bridge request shapes', async () => {
  const schemas = await contract();
  expect(schemas?.PasteCommandSchema).toBeDefined();
  const command = { sessionId: id(), expectedRevision: 0, commandId: id(2) };
  expect(schemas!.PasteCommandSchema.safeParse(command).success).toBe(true);
  expect(
    schemas!.PasteCommandSchema.safeParse({ ...command, expectedRevision: -1 })
      .success,
  ).toBe(false);
  expect(
    manualRequests.startManualPaste.safeParse([
      command,
      { html: '', plain: 'text' },
    ]).success,
  ).toBe(true);
  expect(
    manualRequests.retryManualPasteImage.safeParse([command, 'foreign'])
      .success,
  ).toBe(false);
});
it('bounds worker output paragraphs, image positions, source text and total text', async () => {
  const schemas = await contract();
  expect(schemas?.ConvertedPasteSchema).toBeDefined();
  const blocks = Array.from({ length: 10 }, () => ({
    type: 'paragraph',
    text: '😀'.repeat(20000),
  }));
  expect(
    schemas!.ConvertedPasteSchema.safeParse({ blocks, plainOnly: true })
      .success,
  ).toBe(true);
  expect(
    schemas!.ConvertedPasteSchema.safeParse({
      blocks: [...blocks, { type: 'paragraph', text: 'x' }],
      plainOnly: true,
    }).success,
  ).toBe(false);
  expect(
    schemas!.ConvertedPasteSchema.safeParse({
      blocks: [{ type: 'image', source: undefined }],
      plainOnly: false,
    }).success,
  ).toBe(true);
  expect(
    schemas!.ConvertedPasteSchema.safeParse({
      blocks: [{ type: 'image', source: 'x'.repeat(2097153) }],
      plainOnly: false,
    }).success,
  ).toBe(false);
});

it('rejects excessive decoded pixel area in a safe manual image', async () => {
  const { ManualImageSchema } =
    await import('../../src/contracts/manual-article');
  const image = {
    imageToken: id(),
    mime: 'image/png',
    width: 5000,
    height: 5000,
    byteSize: 1,
  };
  expect(ManualImageSchema.safeParse(image).success).toBe(true);
  expect(ManualImageSchema.safeParse({ ...image, height: 5001 }).success).toBe(
    false,
  );
});

it('bounds session candidate lists with ready image ownership and rejects private response fields', async () => {
  const { ManualStateSchema } =
    await import('../../src/contracts/manual-article');
  const snapshot = {
    state: 'editing',
    revision: 1,
    sessionId: id(),
    target: { kind: 'new' },
    documentRevision: 0,
    acknowledgedEdit: null,
    nextEditCommandId: id(5),
    nextClientSequence: 1,
    nextSaveOperationId: id(6),
    externalId: 'manual-' + id(),
    nextPasteCommandId: id(3),
    draft: {
      bodyVersion: 2,
      title: '',
      contentDeclaration: 'repost',
      blocks: [],
    },
    images: [
      {
        imageToken: id(4),
        mime: 'image/png',
        width: 1,
        height: 1,
        byteSize: 1,
      },
    ],
    candidates: Array.from({ length: 199 }, (_, n) => ({
      candidateId: id(n + 20),
      blockKey: id(n + 300),
      state: 'failed',
      reason: 'SOURCE_UNSUPPORTED',
      retryable: false,
    })),
    dirty: true,
  };
  expect(ManualStateSchema.safeParse(snapshot).success).toBe(true);
  expect(
    ManualStateSchema.safeParse({ ...snapshot, nextClientSequence: 0 }).success,
  ).toBe(false);
  expect(
    ManualStateSchema.safeParse({
      ...snapshot,
      acknowledgedEdit: { clientSequence: 1, commandId: id(7) },
    }).success,
  ).toBe(false);
  expect(
    ManualStateSchema.safeParse({
      ...snapshot,
      candidates: [
        ...snapshot.candidates,
        {
          candidateId: id(999),
          blockKey: id(998),
          state: 'cancelled',
          retryable: true,
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    ManualStateSchema.safeParse({ ...snapshot, html: '<p>private</p>' })
      .success,
  ).toBe(false);
});

it('normalizes a missing trusted image source to the explicit undefined source slot', async () => {
  const { ConvertedPasteSchema } =
    await import('../../src/contracts/web-paste');
  expect(
    ConvertedPasteSchema.parse({
      blocks: [{ type: 'image' }],
      plainOnly: false,
    }).blocks,
  ).toStrictEqual([{ type: 'image', source: undefined }]);
});

const richContract = () => import('../../src/contracts/rich-web-paste');
it('rich contract preserves source slots and canonical marks without accepting original HTML', async () => {
  const { ConvertedRichPasteSchema } = await richContract();
  const result = ConvertedRichPasteSchema.parse({
    version: 2,
    plainOnly: false,
    warnings: ['STYLE_NORMALIZED'],
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '甲', marks: ['italic', 'bold', 'bold'] },
          { type: 'text', text: '乙', marks: ['bold', 'italic'] },
        ],
      },
      { type: 'image', source: 'relative' },
    ],
  });
  expect(result.blocks).toStrictEqual([
    {
      type: 'paragraph',
      content: [{ type: 'text', text: '甲乙', marks: ['bold', 'italic'] }],
    },
    { type: 'image', source: 'relative' },
  ]);
  expect(
    ConvertedRichPasteSchema.safeParse({ ...result, html: '<b>甲</b>' })
      .success,
  ).toBe(false);
  expect(
    ConvertedRichPasteSchema.safeParse({
      ...result,
      warnings: ['PRIVATE_HTML'],
    }).success,
  ).toBe(false);
  expect(
    ConvertedRichPasteSchema.safeParse({
      ...result,
      warnings: ['STYLE_NORMALIZED', 'STYLE_NORMALIZED'],
    }).success,
  ).toBe(false);
  expect(
    ConvertedRichPasteSchema.safeParse({ ...result, plainOnly: true }).success,
  ).toBe(false);
});
it('rich contract counts all nested leaves, image positions, inline nodes and original source bytes', async () => {
  const { ConvertedRichPasteSchema } = await richContract();
  const base = { version: 2, plainOnly: false, warnings: [] };
  const paragraph = { type: 'paragraph', content: [] };
  expect(
    ConvertedRichPasteSchema.safeParse({
      ...base,
      blocks: [
        {
          type: 'list',
          kind: 'bullet',
          items: Array.from({ length: 999 }, () => paragraph),
        },
      ],
    }).success,
  ).toBe(true);
  expect(
    ConvertedRichPasteSchema.safeParse({
      ...base,
      blocks: [
        {
          type: 'list',
          kind: 'bullet',
          items: Array.from({ length: 1000 }, () => paragraph),
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    ConvertedRichPasteSchema.safeParse({
      ...base,
      blocks: Array.from({ length: 201 }, () => ({
        type: 'image',
        source: 'x',
      })),
    }).success,
  ).toBe(false);
  expect(
    ConvertedRichPasteSchema.safeParse({
      ...base,
      blocks: [{ type: 'image', source: 'x'.repeat(2097152) }],
    }).success,
  ).toBe(false);
  expect(
    ConvertedRichPasteSchema.safeParse({
      ...base,
      blocks: [
        {
          type: 'paragraph',
          content: Array.from({ length: 200001 }, () => ({
            type: 'text',
            text: 'x',
            marks: [],
          })),
        },
      ],
    }).success,
  ).toBe(false);
});
