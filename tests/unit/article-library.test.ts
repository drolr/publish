import { expect, it, vi } from 'vitest';
import { createArticleLibrary } from '../../src/application/article-library';
import type {
  ArticleRepository,
  AssetStore,
  StoredArticle,
} from '../../src/domain/ports/article-import';
const articleKey = '5197de37-6e42-4d91-a0e2-8ab8cc74cb02';
const assetKey = '58cfdfd2-f598-4e0b-b3df-2c432a9f72d6';
const article: StoredArticle = {
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
      byteSize: 1,
      width: 1,
      height: 1,
      sha256: 'a'.repeat(64),
    },
  ],
};
function setup() {
  const repository = {
    load: vi.fn(() => article),
    list: vi.fn(() => ({
      status: 'ok',
      page: {
        items: [],
        totalCount: 0,
        membershipRevision: 0,
        pageNumber: 1,
        totalPages: 1,
      },
    })),
  } as unknown as ArticleRepository;
  const assets = {
    verify: vi.fn(async () => {}),
    readImage: vi.fn(async () => new Uint8Array([1])),
  } as unknown as AssetStore;
  return {
    repository,
    assets,
    library: createArticleLibrary(repository, assets, {
      loadEditableArticle: () => ({
        article,
        articleRevision: 3,
        editorBody: null,
      }),
    }),
  };
}
it('validates and projects preview without exposing internal storage or import data', async () => {
  const { library, assets } = setup();
  const result = await library.getArticlePreview(articleKey);
  expect(result.status).toBe('ok');
  expect(result).toMatchObject({
    status: 'ok',
    article: { articleRevision: 3 },
  });
  expect(assets.verify).toHaveBeenCalled();
  for (const secret of ['relativePath', 'importId', 'sha256'])
    expect(JSON.stringify(result)).not.toContain(secret);
});
it('fails closed when preview is damaged and does not download it', async () => {
  const { library, assets } = setup();
  vi.mocked(assets.verify).mockRejectedValue(new Error('secret path'));
  expect(await library.getArticlePreview(articleKey)).toEqual({
    status: 'unavailable',
  });
});
it('bounds full-article preview verification and releases its slot', async () => {
  const { library, assets } = setup();
  let finish!: () => void;
  vi.mocked(assets.verify).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = library.getArticlePreview(articleKey);
  expect(await library.getArticlePreview(articleKey)).toEqual({
    status: 'busy',
  });
  finish();
  expect((await first).status).toBe('ok');
  expect((await library.getArticlePreview(articleKey)).status).toBe('ok');
});
it('reads summaries independently, and rejects another article asset', async () => {
  const { library, assets } = setup();
  expect(await library.listArticles()).toEqual({
    status: 'ok',
    page: {
      items: [],
      totalCount: 0,
      membershipRevision: 0,
      pageNumber: 1,
      totalPages: 1,
    },
  });
  expect(assets.verify).not.toHaveBeenCalled();
  expect(await library.getArticleImage(articleKey, articleKey)).toEqual({
    status: 'not_found',
  });
  expect(assets.readImage).not.toHaveBeenCalled();
});
it('allows only one image read in flight and releases slot on failure', async () => {
  const { library, assets } = setup();
  let reject!: (error: Error) => void;
  vi.mocked(assets.readImage!).mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const pending = library.getArticleImage(articleKey, assetKey);
  expect(await library.getArticleImage(articleKey, assetKey)).toEqual({
    status: 'busy',
  });
  reject(new Error('path'));
  expect(await pending).toEqual({ status: 'unavailable' });
  expect(await library.getArticleImage(articleKey, assetKey)).toMatchObject({
    status: 'ok',
  });
});
