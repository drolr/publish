import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DeclarationKeysSchema,
  DeclarationChangeSchema,
  DeclarationReadResultSchema,
  DeclarationWriteResultSchema,
} from '../../src/contracts/article-declaration';

const key = randomUUID();
const target = { articleKey: key, expectedDeclaration: 'repost' };
const change = { targets: [target], declaration: 'original' };
const item = {
  articleKey: key,
  title: 'Title',
  externalId: 'news',
  contentDeclaration: 'original',
};
it('accepts one and 100 unique keys and strict declaration changes', () => {
  expect(DeclarationKeysSchema.parse([key])).toEqual([key]);
  expect(
    DeclarationKeysSchema.parse(
      Array.from({ length: 100 }, () => randomUUID()),
    ),
  ).toHaveLength(100);
  expect(DeclarationChangeSchema.parse(change)).toEqual(change);
});
it.each(
  [
    [],
    [key, key],
    ['bad'],
    Array.from({ length: 101 }, () => randomUUID()),
  ].map((keys) => ({ keys })),
)('rejects invalid key collections %#', ({ keys }) => {
  expect(DeclarationKeysSchema.safeParse(keys).success).toBe(false);
});
it.each([
  { ...change, targets: [] },
  { ...change, targets: [target, target] },
  { ...change, targets: [{ ...target, expectedDeclaration: 'unknown' }] },
  { ...change, targets: [{ ...target, title: 'new' }] },
  {
    ...change,
    targets: Array.from({ length: 101 }, () => ({
      ...target,
      articleKey: randomUUID(),
    })),
  },
  { ...change, declaration: 'unknown' },
  { ...change, arbitrary: true },
])('rejects invalid mutations %#', (value) => {
  expect(DeclarationChangeSchema.safeParse(value).success).toBe(false);
});
it('validates safe result unions and count consistency without exposing arbitrary fields', () => {
  const result = {
    status: 'updated',
    items: [item],
    changedCount: 1,
    unchangedCount: 0,
  };
  expect(DeclarationWriteResultSchema.parse(result)).toEqual(result);
  expect(
    DeclarationWriteResultSchema.safeParse({ ...result, changedCount: 2 })
      .success,
  ).toBe(false);
  expect(
    DeclarationWriteResultSchema.safeParse({
      ...result,
      items: [{ ...item, relativePath: 'secret' }],
    }).success,
  ).toBe(false);
  expect(
    DeclarationReadResultSchema.parse({ status: 'ok', items: [item] }),
  ).toEqual({ status: 'ok', items: [item] });
  expect(
    DeclarationReadResultSchema.safeParse({
      status: 'ok',
      items: [{ ...item, title: ' padded ' }],
    }).success,
  ).toBe(false);
  expect(
    DeclarationReadResultSchema.safeParse({ status: 'ok', items: [item, item] })
      .success,
  ).toBe(false);
});
