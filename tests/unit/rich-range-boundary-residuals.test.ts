import { expect, it } from 'vitest';
import type {
  ManualDraftV2,
  ManualFragmentV2,
  ManualRichBlock,
} from '../../src/contracts/manual-article';
import type {
  DraftBoundary,
  DraftRange,
} from '../../src/contracts/manual-edit';
import {
  selectManualRange,
  spliceManualRange,
} from '../../src/domain/manual-draft-range';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const p = (n: number, text: string, heading = false): ManualRichBlock => ({
  type: heading ? 'heading' : 'paragraph',
  blockKey: id(n),
  content: text ? [{ type: 'text', text, marks: ['bold'] }] : [],
});
const image: ManualRichBlock = {
  type: 'image',
  blockKey: id(90),
  imageToken: id(99),
};
const text = (n: number, offset: number): DraftBoundary => ({
  kind: 'text',
  blockKey: id(n),
  offset,
});
const range = (anchor: DraftBoundary, head = anchor): DraftRange => ({
  anchor,
  head,
});
const draft = (blocks: ManualRichBlock[]): ManualDraftV2 => ({
  bodyVersion: 2,
  title: 'Boundary',
  contentDeclaration: 'repost',
  blocks,
});
const fragment = (
  blocks: ManualRichBlock[],
  open = false,
): ManualFragmentV2 => ({ version: 2, blocks, openStart: open, openEnd: open });
function semantics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantics);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'blockKey')
        .map(([key, child]) => [key, semantics(child)]),
    );
  return value;
}
function splice(
  source: ManualDraftV2,
  selected: DraftRange,
  inserted: ManualFragmentV2,
) {
  let next = 100;
  return spliceManualRange(source, selected, inserted, () => id(++next));
}
for (const heading of [false, true]) {
  for (const [position, offset, expected] of [
    ['start', 0, [image, p(1, 'AB', heading)]],
    ['middle', 1, [p(1, 'A', heading), image, p(2, 'B', heading)]],
    ['end', 2, [p(1, 'AB', heading), image]],
  ] as const) {
    it(`boundary residual: image at ${heading ? 'heading' : 'paragraph'} ${position} preserves text and marks without synthetic empty leaves`, () => {
      const source = draft([p(1, 'AB', heading)]);
      expect(
        semantics(
          splice(source, range(text(1, offset)), fragment([image])).blocks,
        ),
      ).toEqual(semantics(expected));
      expect(source.blocks).toEqual([p(1, 'AB', heading)]);
    });
  }
}
it('boundary residual: image occupies an empty insertion paragraph without two padding paragraphs', () => {
  expect(
    semantics(
      splice(draft([p(1, '')]), range(text(1, 0)), fragment([image])).blocks,
    ),
  ).toEqual(semantics([image]));
});
it('boundary residual: closed rich clipboard fragment occupies an empty target and keeps its own leading, inner and trailing empty paragraphs', () => {
  const copied = [p(2, ''), p(3, 'A'), image, p(4, ''), p(5, 'B'), p(6, '')];
  const result = splice(draft([p(1, '')]), range(text(1, 0)), fragment(copied));
  expect(semantics(result.blocks)).toEqual(semantics(copied));
  expect(new Set(result.blocks.map((b) => b.blockKey)).size).toBe(
    copied.length,
  );
});
for (const reverse of [false, true]) {
  it(`boundary residual: closed rich fragment replaces fully selected text with no residual wrappers, reverse=${reverse}`, () => {
    const selected = reverse
      ? range(text(1, 2), text(1, 0))
      : range(text(1, 0), text(1, 2));
    const copied = [p(2, 'X'), image, p(3, 'Y')];
    expect(
      semantics(splice(draft([p(1, 'AB')]), selected, fragment(copied)).blocks),
    ).toEqual(semantics(copied));
  });
}
it('boundary residual: selection across paragraphs preserves only unselected marked text and untouched empty siblings', () => {
  const source = draft([p(1, ''), p(2, 'AB'), p(3, ''), p(4, 'CD'), p(5, '')]);
  const result = splice(
    source,
    range(text(2, 1), text(4, 1)),
    fragment([image]),
  );
  expect(semantics(result.blocks)).toEqual(
    semantics([p(1, ''), p(2, 'A'), image, p(4, 'D'), p(5, '')]),
  );
  expect(result.blocks[0].blockKey).toBe(id(1));
  expect(result.blocks.at(-1)!.blockKey).toBe(id(5));
});
it('boundary residual: original unselected empty paragraphs on both sides of a start insertion survive', () => {
  const result = splice(
    draft([p(1, ''), p(2, 'AB'), p(3, '')]),
    range(text(2, 0)),
    fragment([image]),
  );
  expect(semantics(result.blocks)).toEqual(
    semantics([p(1, ''), image, p(2, 'AB'), p(3, '')]),
  );
  expect(result.blocks[0].blockKey).toBe(id(1));
  expect(result.blocks.at(-1)!.blockKey).toBe(id(3));
});
it('boundary residual: mismatched open heading paste occupies empty paragraph without retaining incompatible padding', () => {
  expect(
    semantics(
      splice(
        draft([p(1, '')]),
        range(text(1, 0)),
        fragment([p(2, 'Heading', true)], true),
      ).blocks,
    ),
  ).toEqual(semantics([p(2, 'Heading', true)]));
});
it('boundary residual: matching open text keeps the original paragraph identity and marks', () => {
  const result = splice(
    draft([p(1, 'AB')]),
    range(text(1, 0)),
    fragment([p(2, 'X')], true),
  );
  expect(result.blocks).toEqual([p(1, 'XAB')]);
});
it('boundary residual: empty-fragment text deletion retains its established editable empty leaf', () => {
  expect(
    splice(draft([p(1, 'AB')]), range(text(1, 0), text(1, 2)), fragment([]))
      .blocks,
  ).toEqual([p(1, '')]);
});
it('boundary residual: splitting an ordered container keeps actual numbering and untouched empty items', () => {
  const list: ManualRichBlock = {
    type: 'list',
    kind: 'ordered',
    start: 7,
    blockKey: id(1),
    items: [p(2, 'A'), p(3, 'BC'), p(4, '')] as Extract<
      ManualRichBlock,
      { type: 'paragraph' }
    >[],
  };
  const copied = p(5, 'H', true);
  const result = splice(draft([list]), range(text(3, 0)), fragment([copied]));
  expect(semantics(result.blocks)).toEqual(
    semantics([
      { ...list, items: [p(2, 'A')] },
      copied,
      { ...list, start: 8, items: [p(3, 'BC'), p(4, '')] },
    ]),
  );
});
it('boundary residual: closed full image-and-rich selection round trips into empty target without adding edge paragraphs', () => {
  const source = draft([
    p(1, 'A'),
    {
      type: 'blockquote',
      blockKey: id(2),
      paragraphs: [p(3, ''), p(4, 'Quote')] as Extract<
        ManualRichBlock,
        { type: 'paragraph' }
      >[],
    },
    image,
    p(5, 'B'),
  ]);
  const copied = selectManualRange(
    source,
    range(
      { kind: 'edge', blockKey: id(1), side: 'before' },
      { kind: 'edge', blockKey: id(5), side: 'after' },
    ),
  );
  const result = splice(draft([p(10, '')]), range(text(10, 0)), copied);
  expect(semantics(result.blocks)).toEqual(semantics(source.blocks));
});

for (const start of [8, 9]) {
  it(`boundary residual: tentative open ordered joins preserve numbering and keys at item start=${start}`, () => {
    const list: ManualRichBlock = {
      type: 'list',
      kind: 'ordered',
      start: 7,
      blockKey: id(1),
      items: [p(2, 'A'), p(3, 'BC'), p(4, '')] as Extract<
        ManualRichBlock,
        { type: 'paragraph' }
      >[],
    };
    const inserted: ManualRichBlock = {
      type: 'list',
      kind: 'ordered',
      start,
      blockKey: id(5),
      items: [p(6, 'X')] as Extract<ManualRichBlock, { type: 'paragraph' }>[],
    };
    const result = splice(
      draft([list]),
      range(text(3, 0)),
      fragment([inserted], true),
    );
    expect(semantics(result.blocks)).toEqual(
      semantics(
        start === 8
          ? [{ ...list, items: [p(2, 'A'), p(3, 'XBC'), p(4, '')] }]
          : [
              { ...list, items: [p(2, 'A')] },
              inserted,
              { ...list, start: 8, items: [p(3, 'BC'), p(4, '')] },
            ],
      ),
    );
    if (start === 8)
      expect(result.blocks).toEqual([
        { ...list, items: [p(2, 'A'), p(3, 'XBC'), p(4, '')] },
      ]);
  });
}
it('boundary residual: removing a boundary-only quote shell keeps an explicitly empty inserted paragraph', () => {
  const quote: ManualRichBlock = {
    type: 'blockquote',
    blockKey: id(1),
    paragraphs: [p(2, '')] as Extract<ManualRichBlock, { type: 'paragraph' }>[],
  };
  expect(
    semantics(
      splice(draft([quote]), range(text(2, 0)), fragment([p(3, '')])).blocks,
    ),
  ).toEqual(semantics([p(3, '')]));
});
