import { expect, it } from 'vitest';
import {
  checkContentSupport,
  submissionContentEquivalent,
} from '../../src/domain/draft-content';
import {
  snapshotImageAt,
  snapshotImageCount,
} from '../../src/contracts/draft-task';
import { makeDraftTask } from '../fixtures/draft-task';
import { upgradeEditorBody } from '../../src/domain/rich-text-body';
it('requires every used feature, including marks inside containers, and accepts plain empty layout', () => {
  expect(
    checkContentSupport(
      { version: 2, blocks: [{ type: 'paragraph', content: [] }] },
      { revision: 'none', features: {} },
    ),
  ).toEqual({ ok: true });
  const body = {
    version: 2 as const,
    blocks: [
      {
        type: 'list' as const,
        kind: 'ordered' as const,
        start: 3,
        items: [
          {
            type: 'paragraph' as const,
            content: [
              {
                type: 'text' as const,
                text: 'A',
                marks: ['bold' as const, 'underline' as const],
              },
            ],
          },
        ],
      },
    ],
  };
  expect(
    checkContentSupport(body, {
      revision: 'partial',
      features: { bold: 'verified' },
    }),
  ).toEqual({ ok: false, missing: ['underline', 'ordered_list'] });
});
it('proves V1/V2 plain equivalence but never treats invisible empty layout as proven equal', () => {
  const old = makeDraftTask().snapshot;
  const next = {
    version: 2 as const,
    article: old.article,
    editorBody: upgradeEditorBody(null, old.article.body),
    digest: 'b'.repeat(64),
  };
  expect(submissionContentEquivalent(old, next)).toBe('equal');
  expect(submissionContentEquivalent(next, old)).toBe('equal');
  next.editorBody.blocks.unshift({ type: 'paragraph', content: [] });
  expect(submissionContentEquivalent(old, next)).toBe('unknown');
  next.editorBody.blocks[0] = {
    type: 'heading',
    content: [{ type: 'text', text: 'heading', marks: [] }],
  };
  expect(submissionContentEquivalent(old, next)).toBe('different');
});
it('uses V2 top-level image positions after containers and empty paragraphs', () => {
  const old = makeDraftTask().snapshot;
  const snapshot = {
    version: 2 as const,
    article: old.article,
    editorBody: {
      version: 2 as const,
      blocks: [
        { type: 'paragraph' as const, content: [] },
        {
          type: 'list' as const,
          kind: 'bullet' as const,
          items: [{ type: 'paragraph' as const, content: [] }],
        },
        { type: 'image' as const, imageId: 'image' },
      ],
    },
    digest: 'a'.repeat(64),
  };
  expect(snapshotImageAt(snapshot, 1)).toBeUndefined();
  expect(snapshotImageAt(snapshot, 2)).toEqual({ imageId: 'image' });
  expect(snapshotImageCount(snapshot)).toBe(1);
});
