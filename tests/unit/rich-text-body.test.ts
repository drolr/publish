import { expect, it } from 'vitest';
import type { PersistedEditorBodyV2 } from '../../src/contracts/rich-text-body';
import { PersistedEditorBodyV1Schema } from '../../src/contracts/manual-edit';
import {
  normalizeRichBody,
  upgradeEditorBody,
  projectRichBody,
  richBodyEquals,
  richPlainText,
} from '../../src/domain/rich-text-body';

it('projects headings, list items and quote paragraphs in order, omitting only legacy-empty text', () => {
  const rich: PersistedEditorBodyV2 = {
    version: 2,
    blocks: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: ' A\nB ', marks: ['bold'] }],
      },
      { type: 'heading', content: [{ type: 'text', text: '标题', marks: [] }] },
      {
        type: 'list',
        kind: 'ordered',
        start: 3,
        items: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '三', marks: ['italic'] }],
          },
          { type: 'paragraph', content: [] },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '四', marks: [] }],
          },
        ],
      },
      { type: 'image', imageId: 'front' },
      {
        type: 'blockquote',
        paragraphs: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: ' \n ', marks: [] }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '引', marks: ['underline'] }],
          },
        ],
      },
    ],
  };
  expect(projectRichBody(rich)).toEqual([
    { type: 'paragraph', text: ' A\nB ' },
    { type: 'paragraph', text: '标题' },
    { type: 'paragraph', text: '三' },
    { type: 'paragraph', text: '四' },
    { type: 'image', image_id: 'front' },
    { type: 'paragraph', text: '引' },
  ]);
  expect(
    richPlainText([
      { type: 'text', text: ' A\n', marks: [] },
      { type: 'text', text: '😀 ', marks: ['bold'] },
    ]),
  ).toBe(' A\n😀 ');
});

it('upgrades V1 and NULL legacy bodies in memory and preserves whitespace and repeated image positions', () => {
  const legacy = [
    { type: 'paragraph' as const, text: ' 旧\n😀 ' },
    { type: 'image' as const, image_id: 'front' },
  ];
  expect(upgradeEditorBody(null, legacy)).toEqual({
    version: 2,
    blocks: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: ' 旧\n😀 ', marks: [] }],
      },
      { type: 'image', imageId: 'front' },
    ],
  });
  const v1 = PersistedEditorBodyV1Schema.parse({
    version: 1,
    blocks: [
      { type: 'paragraph', text: '' },
      ...Array.from({ length: 201 }, () => ({
        type: 'image',
        imageId: 'front',
      })),
    ],
  });
  expect(upgradeEditorBody(v1, legacy)).toEqual({
    version: 2,
    blocks: [
      { type: 'paragraph', content: [] },
      ...Array.from({ length: 201 }, () => ({
        type: 'image',
        imageId: 'front',
      })),
    ],
  });
  expect(v1.version).toBe(1);
});

it('keeps ten maximum-LF legacy paragraphs compact below unchanged snapshot budget', () => {
  const text = '\n'.repeat(19999) + 'a';
  const v1 = PersistedEditorBodyV1Schema.parse({
    version: 1,
    blocks: Array.from({ length: 10 }, () => ({ type: 'paragraph', text })),
  });
  const upgraded = upgradeEditorBody(v1, []);
  expect(upgraded.blocks).toHaveLength(10);
  for (const block of upgraded.blocks)
    expect(block).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text, marks: [] }],
    });
  expect(
    new TextEncoder().encode(JSON.stringify(upgraded)).byteLength,
  ).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it('compares normalized rich semantics including format, LF, empty paragraphs and start', () => {
  const input: PersistedEditorBodyV2 = {
    version: 2,
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'A', marks: ['underline', 'bold', 'bold'] },
          { type: 'text', text: '\nB', marks: ['bold', 'underline'] },
        ],
      },
    ],
  };
  const expected: PersistedEditorBodyV2 = {
    version: 2,
    blocks: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'A\nB', marks: ['bold', 'underline'] }],
      },
    ],
  };
  expect(normalizeRichBody(input)).toEqual(expected);
  expect(upgradeEditorBody(input, [])).toEqual(expected);
  expect(richBodyEquals(input, expected)).toBe(true);
  expect(
    richBodyEquals(expected, {
      version: 2,
      blocks: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'A\nB', marks: [] }],
        },
      ],
    }),
  ).toBe(false);
  expect(
    richBodyEquals(expected, {
      ...expected,
      blocks: [...expected.blocks, { type: 'paragraph', content: [] }],
    }),
  ).toBe(false);
  expect(
    richBodyEquals(expected, {
      version: 2,
      blocks: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'AB', marks: ['bold', 'underline'] }],
        },
      ],
    }),
  ).toBe(false);
  expect(
    richBodyEquals(
      {
        version: 2,
        blocks: [
          {
            type: 'list',
            kind: 'ordered',
            start: 3,
            items: [{ type: 'paragraph', content: [] }],
          },
        ],
      },
      {
        version: 2,
        blocks: [
          {
            type: 'list',
            kind: 'ordered',
            start: 4,
            items: [{ type: 'paragraph', content: [] }],
          },
        ],
      },
    ),
  ).toBe(false);
  expect(input.blocks[0]).toEqual({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'A', marks: ['underline', 'bold', 'bold'] },
      { type: 'text', text: '\nB', marks: ['bold', 'underline'] },
    ],
  });
});
