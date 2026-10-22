import { expect, it } from 'vitest';
import {
  ArticleCursorSchema,
  ArticlePageSchema,
  ArticleSummarySchema,
  ListResultSchema,
} from '../../src/contracts/article-library';

const summary = {
  articleKey: '5197de37-6e42-4d91-a0e2-8ab8cc74cb02',
  externalId: 'synthetic',
  title: '汽车',
  contentDeclaration: 'repost',
  imageCount: 0,
  createdAt: '2026-10-09T00:00:00.000Z',
  articleRevision: 1,
};
const page = {
  items: [summary],
  totalCount: 1,
  membershipRevision: 0,
  pageNumber: 1,
  totalPages: 1,
};
const cursor = {
  createdAt: summary.createdAt,
  articleKey: summary.articleKey,
  membershipRevision: 0,
  pageNumber: 2,
};
it('accepts revision-bearing summaries and consistent count/page metadata', () => {
  expect(ArticleSummarySchema.safeParse(summary).success).toBe(true);
  expect(ArticlePageSchema.safeParse(page).success).toBe(true);
  expect(ArticleCursorSchema.safeParse(cursor).success).toBe(true);
  expect(ListResultSchema.parse({ status: 'stale_cursor' })).toEqual({
    status: 'stale_cursor',
  });
});
it('rejects pages over ten items and obsolete cursors without membership metadata', () => {
  expect(
    ArticlePageSchema.safeParse({ ...page, items: Array(11).fill(summary) })
      .success,
  ).toBe(false);
  expect(
    ArticleCursorSchema.safeParse({
      createdAt: summary.createdAt,
      articleKey: summary.articleKey,
    }).success,
  ).toBe(false);
});
it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
  'rejects unsafe count and membership values: %s',
  (value) => {
    for (const field of ['totalCount', 'membershipRevision'])
      expect(
        ArticlePageSchema.safeParse({ ...page, [field]: value }).success,
      ).toBe(false);
    expect(
      ArticleCursorSchema.safeParse({ ...cursor, membershipRevision: value })
        .success,
    ).toBe(false);
  },
);
it('rejects invalid article revision and page ordinals', () => {
  for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      ArticleSummarySchema.safeParse({ ...summary, articleRevision: value })
        .success,
    ).toBe(false);
    expect(
      ArticlePageSchema.safeParse({ ...page, pageNumber: value }).success,
    ).toBe(false);
  }
  expect(
    ArticleCursorSchema.safeParse({ ...cursor, pageNumber: 1 }).success,
  ).toBe(false);
});
