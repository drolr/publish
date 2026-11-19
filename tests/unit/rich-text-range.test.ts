import { describe, expect, it } from 'vitest';
import {
  ManualDraftV2Schema,
  ManualFragmentV2Schema,
  type ManualDraftV2,
} from '../../src/contracts/manual-article';
import {
  selectManualRange,
  spliceManualRange,
} from '../../src/domain/manual-draft-range';
import type {
  DraftBoundary,
  DraftRange,
} from '../../src/contracts/manual-edit';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = (
  text: string,
  marks: ('bold' | 'italic' | 'underline')[] = [],
) => ({ type: 'text' as const, text, marks });
const p = (n: number, text: string) => ({
  type: 'paragraph' as const,
  blockKey: id(n),
  content: text ? [run(text)] : [],
});
const draft = (blocks: ManualDraftV2['blocks']): ManualDraftV2 => ({
  bodyVersion: 2,
  title: 'Title',
  contentDeclaration: 'repost',
  blocks,
});
const text = (n: number, offset: number): DraftBoundary => ({
  kind: 'text',
  blockKey: id(n),
  offset,
});
const edge = (n: number, side: 'before' | 'after'): DraftBoundary => ({
  kind: 'edge',
  blockKey: id(n),
  side,
});
const range = (anchor: DraftBoundary, head: DraftBoundary): DraftRange => ({
  anchor,
  head,
});
let next = 100;
const newId = () => id(++next);

describe('versioned rich sessions and structural ranges', () => {
  it('validates shared rich shapes, canonical marks and all nested unique keys', () => {
    const source = draft([
      {
        ...p(1, ''),
        content: [
          run('A', ['italic', 'bold', 'bold']),
          run('B', ['bold', 'italic']),
        ],
      },
    ]);
    expect(ManualDraftV2Schema.parse(source).blocks[0]).toEqual({
      ...p(1, ''),
      content: [run('AB', ['bold', 'italic'])],
    });
    expect(
      ManualDraftV2Schema.safeParse(
        draft([
          { type: 'blockquote', blockKey: id(1), paragraphs: [p(1, 'x')] },
        ]),
      ).success,
    ).toBe(false);
    expect(
      ManualDraftV2Schema.safeParse(
        draft([
          {
            type: 'list',
            kind: 'ordered',
            start: Number.MAX_SAFE_INTEGER,
            blockKey: id(1),
            items: [p(2, 'a'), p(3, 'b')],
          },
        ]),
      ).success,
    ).toBe(false);
  });
  it('slices partial bold emoji and LF with reverse selection without mutating the source', () => {
    const source = draft([
      {
        ...p(1, ''),
        content: [run('a'), run('😀\nb', ['bold']), run('c', ['italic'])],
      },
    ]);
    const before = structuredClone(source);
    const result = selectManualRange(source, range(text(1, 5), text(1, 1)));
    expect(result).toEqual({
      version: 2,
      openStart: true,
      openEnd: true,
      blocks: [{ ...p(1, ''), content: [run('😀\nb', ['bold'])] }],
    });
    result.blocks[0].blockKey = id(90);
    expect(source).toEqual(before);
  });
  it('preserves ancestors, quote paragraphs, empty leaves and actual ordered-list start', () => {
    const source = draft([
      p(1, 'head'),
      {
        type: 'list',
        kind: 'ordered',
        start: 7,
        blockKey: id(2),
        items: [p(3, 'first'), p(4, 'second'), p(5, 'third')],
      },
      {
        type: 'blockquote',
        blockKey: id(6),
        paragraphs: [p(7, ''), p(8, 'tail')],
      },
    ]);
    const result = selectManualRange(source, range(text(4, 2), text(8, 2)));
    expect(result).toEqual({
      version: 2,
      openStart: true,
      openEnd: true,
      blocks: [
        {
          type: 'list',
          kind: 'ordered',
          start: 8,
          blockKey: id(2),
          items: [p(4, 'cond'), p(5, 'third')],
        },
        {
          type: 'blockquote',
          blockKey: id(6),
          paragraphs: [p(7, ''), p(8, 'ta')],
        },
      ],
    });
    expect(ManualFragmentV2Schema.parse(result)).toEqual(result);
  });
  it('does not merge closed whole paragraphs and rekeys every inserted node', () => {
    const source = draft([p(1, 'AB')]);
    const fragment = {
      version: 2 as const,
      openStart: false,
      openEnd: false,
      blocks: [p(2, 'copied')],
    };
    const result = spliceManualRange(
      source,
      range(text(1, 1), text(1, 1)),
      fragment,
      newId,
    );
    expect(
      result.blocks.map((b) =>
        b.type === 'paragraph' ? b.content.map((r) => r.text).join('') : b.type,
      ),
    ).toEqual(['A', 'copied', 'B']);
    expect(result.blocks[1].blockKey).not.toBe(id(2));
    expect(new Set(result.blocks.map((b) => b.blockKey)).size).toBe(3);
    expect(source.blocks).toEqual([p(1, 'AB')]);
  });
  it('pastes open text back into matching contexts and preserves marks', () => {
    const source = draft([{ ...p(1, ''), content: [run('AB', ['italic'])] }]);
    const fragment = {
      version: 2 as const,
      openStart: true,
      openEnd: true,
      blocks: [{ ...p(2, ''), content: [run('😀', ['bold'])] }],
    };
    expect(
      spliceManualRange(source, range(text(1, 1), text(1, 1)), fragment, newId)
        .blocks,
    ).toEqual([
      {
        ...p(1, ''),
        content: [
          run('A', ['italic']),
          run('😀', ['bold']),
          run('B', ['italic']),
        ],
      },
    ]);
  });
  it('merges open list items only when their numbering and context agree', () => {
    const source = draft([
      {
        type: 'list',
        kind: 'ordered',
        start: 4,
        blockKey: id(1),
        items: [p(2, 'AB'), p(3, 'next')],
      },
    ]);
    const matching = {
      version: 2 as const,
      openStart: true,
      openEnd: true,
      blocks: [
        {
          type: 'list' as const,
          kind: 'ordered' as const,
          start: 4,
          blockKey: id(5),
          items: [p(6, 'X')],
        },
      ],
    };
    const result = spliceManualRange(
      source,
      range(text(2, 1), text(2, 1)),
      matching,
      newId,
    );
    expect(result.blocks).toEqual([
      {
        type: 'list',
        kind: 'ordered',
        start: 4,
        blockKey: id(1),
        items: [p(2, 'AXB'), p(3, 'next')],
      },
    ]);
    const mismatched = structuredClone(matching);
    mismatched.blocks[0].start = 9;
    expect(
      spliceManualRange(
        source,
        range(text(2, 1), text(2, 1)),
        mismatched,
        newId,
      ).blocks,
    ).toHaveLength(3);
  });
  it('deletes across marked runs atomically and never splits a surrogate pair', () => {
    const source = draft([
      { ...p(1, ''), content: [run('a😀', ['bold']), run('bc', ['italic'])] },
    ]);
    const empty = {
      version: 2 as const,
      blocks: [],
      openStart: false,
      openEnd: false,
    };
    expect(
      spliceManualRange(source, range(text(1, 1), text(1, 4)), empty, newId)
        .blocks,
    ).toEqual([
      { ...p(1, ''), content: [run('a', ['bold']), run('c', ['italic'])] },
    ]);
    for (const bad of [
      range(text(1, 2), text(1, 3)),
      range(text(99, 0), text(1, 0)),
      range(text(1, 99), text(1, 0)),
    ]) {
      const before = structuredClone(source);
      expect(() => spliceManualRange(source, bad, empty, newId)).toThrow();
      expect(source).toEqual(before);
    }
  });
  it('rejects container text boundaries and image insertion within containers', () => {
    const source = draft([
      { type: 'blockquote', blockKey: id(1), paragraphs: [p(2, 'abc')] },
    ]);
    expect(() =>
      selectManualRange(source, range(text(1, 0), edge(1, 'after'))),
    ).toThrow();
    const image = {
      version: 2 as const,
      openStart: false,
      openEnd: false,
      blocks: [{ type: 'image' as const, blockKey: id(3), imageToken: id(4) }],
    };
    expect(() =>
      spliceManualRange(source, range(text(2, 1), text(2, 1)), image, newId),
    ).toThrow();
    expect(
      spliceManualRange(
        source,
        range(edge(1, 'before'), edge(1, 'after')),
        image,
        newId,
      ).blocks[0].type,
    ).toBe('image');
  });
  it('closed whole containers and reverse boundaries preserve their structure', () => {
    const source = draft([
      {
        type: 'list',
        kind: 'ordered',
        start: 20,
        blockKey: id(1),
        items: [p(2, 'a'), p(3, 'b')],
      },
    ]);
    expect(
      selectManualRange(source, range(edge(1, 'after'), edge(1, 'before'))),
    ).toEqual({
      version: 2,
      openStart: false,
      openEnd: false,
      blocks: source.blocks,
    });
  });
  it('validates the entire candidate before replacing any original selection', () => {
    const source = draft([p(1, 'preserved')]);
    const before = structuredClone(source);
    const oversize = {
      version: 2 as const,
      openStart: false,
      openEnd: false,
      blocks: [p(2, 'x'.repeat(20001))],
    };
    expect(() =>
      spliceManualRange(
        source,
        range(edge(1, 'before'), edge(1, 'after')),
        oversize,
        newId,
      ),
    ).toThrow();
    expect(source).toEqual(before);
  });
});
