import { expect, it, vi } from 'vitest';
import { createArticleDeclarations } from '../../src/application/article-declaration';
import type { ArticleRepository } from '../../src/domain/ports/article-import';
const key = '5197de37-6e42-4d91-a0e2-8ab8cc74cb02';
const otherKey = '58cfdfd2-f598-4e0b-b3df-2c432a9f72d6';
const item = {
  articleKey: key,
  title: 'Title',
  externalId: 'a',
  contentDeclaration: 'original' as const,
};
const change = {
  targets: [{ articleKey: key, expectedDeclaration: 'repost' as const }],
  declaration: 'original' as const,
};
function setup(gate: () => 'ready' | 'busy' | 'unavailable' = () => 'ready') {
  const read = vi.fn(() => ({ status: 'ok', items: [item] }));
  const write = vi.fn(() => ({
    status: 'updated',
    items: [item],
    changedCount: 1,
    unchangedCount: 0,
  }));
  const repository = {
    getArticleDeclarations: read,
    setArticleDeclarations: write,
  } as unknown as ArticleRepository;
  return { read, write, service: createArticleDeclarations(repository, gate) };
}
it('provides synchronous reads and writes using only dedicated declaration ports', () => {
  const { service } = setup();
  expect(service.getArticleDeclarations([key])).toEqual({
    status: 'ok',
    items: [item],
  });
  expect(service.setArticleDeclarations(change)).toEqual({
    status: 'updated',
    items: [item],
    changedCount: 1,
    unchangedCount: 0,
  });
});
it.each(['busy', 'unavailable'] as const)(
  'rejects writes immediately when %s',
  (state) => {
    const { service, write } = setup(() => state);
    expect(service.setArticleDeclarations(change)).toEqual({ status: state });
    expect(write).not.toHaveBeenCalled();
  },
);
it('does not invoke repository for invalid input or missing capabilities', () => {
  const { service, read, write } = setup();
  expect(service.getArticleDeclarations([])).toEqual({ status: 'unavailable' });
  expect(service.setArticleDeclarations({ ...change, targets: [] })).toEqual({
    status: 'unavailable',
  });
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  const absent = createArticleDeclarations(
    {} as ArticleRepository,
    () => 'ready',
  );
  expect(absent.getArticleDeclarations([key])).toEqual({
    status: 'unavailable',
  });
  expect(absent.setArticleDeclarations(change)).toEqual({
    status: 'unavailable',
  });
});
it('sanitizes exceptions and rejects results that do not match the requested keys', () => {
  const { service, read, write } = setup();
  read.mockImplementation(() => {
    throw new Error('private token');
  });
  expect(service.getArticleDeclarations([key])).toEqual({
    status: 'unavailable',
  });
  write.mockImplementation(() => {
    throw new Error('private token');
  });
  expect(service.setArticleDeclarations(change)).toEqual({
    status: 'unavailable',
  });
  read.mockReturnValue({
    status: 'ok',
    items: [{ ...item, articleKey: otherKey }],
  });
  expect(service.getArticleDeclarations([key])).toEqual({
    status: 'unavailable',
  });
});
it('reads fail closed during shutdown or when the gate throws', () => {
  const { service, read } = setup(() => 'unavailable');
  expect(service.getArticleDeclarations([key])).toEqual({
    status: 'unavailable',
  });
  expect(read).not.toHaveBeenCalled();
  const failed = setup(() => {
    throw new Error('private');
  });
  expect(failed.service.setArticleDeclarations(change)).toEqual({
    status: 'unavailable',
  });
});
it.each([
  { status: 'not_found', articleKeys: [otherKey] },
  { status: 'conflict', articleKeys: [otherKey] },
  {
    status: 'updated',
    items: [{ ...item, articleKey: otherKey }],
    changedCount: 1,
    unchangedCount: 0,
  },
  {
    status: 'updated',
    items: [{ ...item, contentDeclaration: 'repost' }],
    changedCount: 1,
    unchangedCount: 0,
  },
  { status: 'updated', items: [item], changedCount: 2, unchangedCount: 0 },
  { status: 'unavailable', secret: 'private' },
])('rejects malformed or unrelated repository write result %#', (response) => {
  const repo = {
    setArticleDeclarations: () => response,
  } as unknown as ArticleRepository;
  expect(
    createArticleDeclarations(repo, () => 'ready').setArticleDeclarations(
      change,
    ),
  ).toEqual({ status: 'unavailable' });
});
it.each(['conflict', 'not_found'] as const)(
  'returns valid %s keys only from the request',
  (status) => {
    const repo = {
      setArticleDeclarations: () => ({ status, articleKeys: [key] }),
    } as unknown as ArticleRepository;
    expect(
      createArticleDeclarations(repo, () => 'ready').setArticleDeclarations(
        change,
      ),
    ).toEqual({ status, articleKeys: [key] });
  },
);
