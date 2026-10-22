import { expect, it } from 'vitest';
import { StoredArticleSchema } from '../../src/contracts/stored-article';
const articleKey = '5197de37-6e42-4d91-a0e2-8ab8cc74cb02';
const assetKey = '58cfdfd2-f598-4e0b-b3df-2c432a9f72d6';
const article = {
  articleKey,
  importId: '37f4cc77-7d4a-45f1-b552-4bad4430c45a',
  externalId: 'a',
  title: 'Title',
  body: [
    { type: 'paragraph', text: 'text' },
    { type: 'image', image_id: 'i' },
  ],
  contentDeclaration: 'repost',
  createdAt: '2026-09-16T00:00:00.000Z',
  assets: [
    {
      assetKey,
      imageId: 'i',
      relativePath: `${articleKey}/${assetKey}.png`,
      mime: 'image/png',
      byteSize: 80,
      width: 1,
      height: 1,
      sha256: 'a'.repeat(64),
    },
  ],
};
it('accepts normalized storage data including repeated references', () => {
  expect(StoredArticleSchema.safeParse(article).success).toBe(true);
  expect(
    StoredArticleSchema.safeParse({
      ...article,
      body: [...article.body, article.body[1]],
    }).success,
  ).toBe(true);
});
it.each([
  { ...article, title: ' title ' },
  { ...article, assets: [] },
  { ...article, assets: [...article.assets, ...article.assets] },
  { ...article, source_url: 'https://secret.invalid' },
  ...[
    '../foreign.png',
    `/root/${assetKey}.png`,
    `${articleKey}/${assetKey}.jpg`,
  ].map((relativePath) => ({
    ...article,
    assets: [{ ...article.assets[0], relativePath }],
  })),
  {
    ...article,
    assets: [{ ...article.assets[0], width: 10000, height: 10000 }],
  },
])('rejects corrupted or noncanonical stored records %#', (invalid) => {
  expect(StoredArticleSchema.safeParse(invalid).success).toBe(false);
});
