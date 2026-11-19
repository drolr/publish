import { describe, expect, it } from 'vitest';
import {
  PersistedEditorBodySchema,
  PersistedEditorBodyV2Schema,
} from '../../src/contracts/rich-text-body';

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text, marks: [] }] : [],
});
const body = (blocks: unknown[]) => ({ version: 2, blocks });
const accepts = (blocks: unknown[]) =>
  PersistedEditorBodyV2Schema.safeParse(body(blocks)).success;

describe('restricted rich body contracts', () => {
  it('roundtrips supported blocks, combined marks, LF and empty paragraphs exactly', () => {
    const input = body([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: ' A\n😀 ',
            marks: ['bold', 'italic', 'underline'],
          },
        ],
      },
      paragraph(''),
      {
        type: 'heading',
        content: [{ type: 'text', text: '小标题', marks: [] }],
      },
      {
        type: 'list',
        kind: 'ordered',
        start: 3,
        items: [paragraph('三'), paragraph('四\n续')],
      },
      { type: 'list', kind: 'bullet', items: [paragraph('点')] },
      { type: 'blockquote', paragraphs: [paragraph('引'), paragraph('')] },
      { type: 'image', imageId: 'front' },
    ]);
    expect(
      PersistedEditorBodyV2Schema.parse(JSON.parse(JSON.stringify(input))),
    ).toEqual(input);
    expect(
      PersistedEditorBodySchema.parse({
        version: 1,
        blocks: [{ type: 'paragraph', text: '旧' }],
      }),
    ).toEqual({ version: 1, blocks: [{ type: 'paragraph', text: '旧' }] });
  });

  it('canonicalizes duplicate marks and adjacent equivalent runs without changing ranges', () => {
    expect(
      PersistedEditorBodyV2Schema.parse(
        body([
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: ' A',
                marks: ['underline', 'bold', 'bold'],
              },
              { type: 'text', text: '\nB ', marks: ['bold', 'underline'] },
              { type: 'text', text: 'C', marks: ['italic'] },
            ],
          },
        ]),
      ),
    ).toEqual(
      body([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: ' A\nB ', marks: ['bold', 'underline'] },
            { type: 'text', text: 'C', marks: ['italic'] },
          ],
        },
      ]),
    );
  });

  it.each([
    [
      {
        type: 'list',
        kind: 'bullet',
        items: [{ type: 'list', kind: 'bullet', items: [paragraph('x')] }],
      },
    ],
    [{ type: 'blockquote', paragraphs: [{ type: 'heading', content: [] }] }],
    [{ type: 'blockquote', paragraphs: [{ type: 'image', imageId: 'front' }] }],
    [{ type: 'list', kind: 'bullet', start: 1, items: [paragraph('x')] }],
    [{ type: 'list', kind: 'bullet', items: [] }],
    [{ type: 'blockquote', paragraphs: [] }],
    [{ type: 'list', kind: 'ordered', start: 0, items: [paragraph('x')] }],
    [{ type: 'list', kind: 'ordered', start: 1.5, items: [paragraph('x')] }],
    [
      {
        type: 'list',
        kind: 'ordered',
        start: Number.MAX_SAFE_INTEGER,
        items: [paragraph('x'), paragraph('y')],
      },
    ],
    [{ type: 'paragraph', content: [{ type: 'text', text: '', marks: [] }] }],
    [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: ['link'] }],
      },
    ],
    [{ type: 'paragraph', content: [], html: '<b>x</b>' }],
    [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [], href: 'secret' }],
      },
    ],
    [{ type: 'image', imageId: 'front', source: 'secret' }],
  ])(
    'rejects unsupported, recursive, empty or unknown structure %#',
    (block) => {
      expect(accepts([block])).toBe(false);
    },
  );

  it('allows the last safe ordered-list number and rejects unsafe starts', () => {
    expect(
      accepts([
        {
          type: 'list',
          kind: 'ordered',
          start: Number.MAX_SAFE_INTEGER - 1,
          items: [paragraph('x'), paragraph('y')],
        },
      ]),
    ).toBe(true);
    expect(
      accepts([
        {
          type: 'list',
          kind: 'ordered',
          start: Number.MAX_SAFE_INTEGER + 1,
          items: [paragraph('x')],
        },
      ]),
    ).toBe(false);
    expect(
      PersistedEditorBodyV2Schema.safeParse({ ...body([]), html: '' }).success,
    ).toBe(false);
  });

  it('counts code points across runs including LF, astral pairs and legacy lone surrogates', () => {
    expect(accepts([paragraph('😀'.repeat(20000))])).toBe(true);
    expect(accepts([paragraph('😀'.repeat(20001))])).toBe(false);
    expect(accepts([paragraph('\n'.repeat(19999) + 'a')])).toBe(true);
    expect(accepts([paragraph('\n'.repeat(20000) + 'a')])).toBe(false);
    expect(accepts([paragraph('\ud800'.repeat(20000))])).toBe(true);
    expect(
      accepts([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a'.repeat(10000), marks: ['bold'] },
            { type: 'text', text: 'b'.repeat(10001), marks: [] },
          ],
        },
      ]),
    ).toBe(false);
  });

  it('enforces whole-document text and all top-level and child paragraph budgets', () => {
    expect(
      accepts(Array.from({ length: 10 }, () => paragraph('a'.repeat(20000)))),
    ).toBe(true);
    expect(
      accepts([
        ...Array.from({ length: 10 }, () => paragraph('a'.repeat(20000))),
        paragraph('a'),
      ]),
    ).toBe(false);
    expect(accepts(Array.from({ length: 1000 }, () => paragraph('')))).toBe(
      true,
    );
    expect(accepts(Array.from({ length: 1001 }, () => paragraph('')))).toBe(
      false,
    );
    expect(
      accepts([
        {
          type: 'list',
          kind: 'bullet',
          items: Array.from({ length: 999 }, () => paragraph('')),
        },
      ]),
    ).toBe(true);
    expect(
      accepts([
        {
          type: 'list',
          kind: 'bullet',
          items: Array.from({ length: 1000 }, () => paragraph('')),
        },
      ]),
    ).toBe(false);
    expect(
      accepts([
        {
          type: 'blockquote',
          paragraphs: Array.from({ length: 1000 }, () => paragraph('')),
        },
      ]),
    ).toBe(false);
  });

  it('checks exact UTF8 JSON 2MiB boundary before run merging', () => {
    const input = body(
      Array.from({ length: 100 }, () => ({
        type: 'paragraph',
        content: Array.from({ length: 400 }, () => ({
          type: 'text',
          text: 'a',
          marks: [],
        })),
      })),
    ) as {
      version: number;
      blocks: {
        type: string;
        content: { type: string; text: string; marks: never[] }[];
      }[];
    };
    let remaining =
      2 * 1024 * 1024 -
      new TextEncoder().encode(JSON.stringify(input)).byteLength;
    for (const block of input.blocks) {
      const count = Math.min(Math.floor(remaining / 6), 19000);
      block.content[0].text += '\u0000'.repeat(count);
      remaining -= count * 6;
    }
    input.blocks.at(-1)!.content[0].text += 'a'.repeat(remaining);
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(
      2 * 1024 * 1024,
    );
    expect(PersistedEditorBodyV2Schema.safeParse(input).success).toBe(true);
    const multibyte = structuredClone(input);
    multibyte.blocks.at(-1)!.content[0].text = multibyte.blocks
      .at(-1)!
      .content[0].text.replace('a', '汉');
    expect(JSON.stringify(multibyte).length).toBe(2 * 1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(multibyte)).byteLength).toBe(
      2 * 1024 * 1024 + 2,
    );
    expect(PersistedEditorBodyV2Schema.safeParse(multibyte).success).toBe(
      false,
    );
    input.blocks.at(-1)!.content[0].text += 'a';
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(
      2 * 1024 * 1024 + 1,
    );
    expect(PersistedEditorBodyV2Schema.safeParse(input).success).toBe(false);
  });

  it('rejects excessive inline nodes even when normalization would merge them', () => {
    expect(
      accepts([
        {
          type: 'paragraph',
          content: Array.from({ length: 200001 }, () => ({
            type: 'text',
            text: 'a',
            marks: [],
          })),
        },
      ]),
    ).toBe(false);
  });
});
