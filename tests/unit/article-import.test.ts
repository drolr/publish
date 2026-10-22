import { describe, expect, it, vi } from 'vitest';
import { createArticleImportService } from '../../src/application/article-import';
import { ImportFailure } from '../../src/domain/import-error';
import type {
  ArticleRepository,
  AssetStore,
  ImportAttempt,
  StoredArticle,
} from '../../src/domain/ports/article-import';
const input = {
  schema_version: 1,
  article_id: 'a',
  title: 'Title',
  body: [{ type: 'paragraph', text: 'Body' }],
  images: [],
};
const attempt: ImportAttempt = {
  importId: '70f104f1-409d-45f2-ab25-c09ccdb8c04b',
  articleKey: 'cf88b7c0-8521-4b66-8e2b-9b73ad37c853',
  externalId: 'a',
  startedAt: '2026-09-16T00:00:00.000Z',
  status: 'preparing',
};
function setup() {
  let saved: StoredArticle | undefined;
  let attempts: ImportAttempt[] = [];
  const repository: ArticleRepository = {
    reserve: vi.fn(() => {
      attempts.push(attempt);
      return attempt;
    }),
    findExternal: vi.fn(() => saved),
    findExternalState: vi.fn(() =>
      saved ? { kind: 'active' as const, article: saved } : undefined,
    ),
    findImport: vi.fn(() => saved),
    load: vi.fn(() => saved),
    attempts: vi.fn(() => attempts),
    commit: vi.fn((_attempt, article) => {
      saved = article;
      attempts = [];
    }),
    markAttempt: vi.fn(),
    forgetAttempt: vi.fn(() => {
      attempts = [];
    }),
    getSchemaVersion: () => 2,
    close() {},
  };
  const assets: AssetStore = {
    prepare: vi.fn(async () => {}),
    put: vi.fn(),
    finalize: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    verify: vi.fn(async () => {}),
  };
  const reader = { read: vi.fn(async () => new Uint8Array([1])) };
  const service = createArticleImportService(repository, assets, reader);
  return { service, repository, assets, reader };
}
describe('article import orchestration', () => {
  it('stops before writing the image which would exceed the article byte budget', async () => {
    const { service, assets, reader, repository } = setup();
    await service.recover();
    reader.read.mockResolvedValue(new Uint8Array(20 * 1024 * 1024));
    vi.mocked(assets.put).mockImplementation(async (_a, imageId, bytes) => ({
      imageId,
      assetKey: attempt.articleKey,
      relativePath: 'unused',
      mime: 'image/png',
      width: 1,
      height: 1,
      byteSize: bytes.length,
      sha256: 'a'.repeat(64),
    }));
    const images = Array.from({ length: 11 }, (_, index) => ({
      image_id: `i${index}`,
      source: { type: 'remote', url: 'https://example.com/image' },
    }));
    const result = await service.importArticle({
      ...input,
      images,
      body: [
        ...input.body,
        ...images.map((image) => ({ type: 'image', image_id: image.image_id })),
      ],
    });
    expect(result).toMatchObject({
      status: 'failed',
      code: 'IMAGE_LIMIT_EXCEEDED',
      imageIndex: 10,
    });
    expect(assets.put).toHaveBeenCalledTimes(10);
    expect(repository.commit).not.toHaveBeenCalled();
    expect(assets.cleanup).toHaveBeenCalled();
  });
  it('propagates the ten-minute article deadline and does not start later images', async () => {
    const { service, reader, assets } = setup();
    await service.recover();
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(deadline.signal);
    reader.read.mockImplementation(async () => {
      deadline.abort();
      throw new Error('timeout');
    });
    try {
      const images = ['one', 'two'].map((image_id) => ({
        image_id,
        source: { type: 'remote', url: 'https://example.com/image' },
      }));
      expect(
        await service.importArticle({
          ...input,
          images,
          body: [
            ...input.body,
            ...images.map((image) => ({
              type: 'image',
              image_id: image.image_id,
            })),
          ],
        }),
      ).toMatchObject({ status: 'failed', code: 'IMAGE_UNAVAILABLE' });
      expect(timeout).toHaveBeenCalledWith(600000);
      expect(reader.read).toHaveBeenCalledTimes(1);
      expect(assets.cleanup).toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });
  it('requires startup recovery, then imports pure text and rejects duplicate before IO', async () => {
    const { service, assets } = setup();
    expect(await service.importArticle(input)).toMatchObject({
      status: 'failed',
      code: 'RECOVERY_REQUIRED',
    });
    expect(await service.recover()).toBe(true);
    expect(await service.importArticle(input)).toMatchObject({
      status: 'imported',
      article: { externalId: 'a', assets: [] },
    });
    vi.mocked(assets.verify).mockRejectedValue(new Error('missing old image'));
    expect(await service.importArticle(input)).toMatchObject({
      status: 'already_exists',
    });
    expect(assets.verify).not.toHaveBeenCalled();
    expect(assets.prepare).toHaveBeenCalledTimes(1);
  });
  it('invalid input creates no attempt', async () => {
    const { service, repository } = setup();
    await service.recover();
    expect(await service.importArticle({})).toMatchObject({
      status: 'invalid',
    });
    expect(repository.reserve).not.toHaveBeenCalled();
  });
  it('cleans a failed image and hides underlying paths', async () => {
    const { service, assets, reader, repository } = setup();
    await service.recover();
    reader.read.mockRejectedValue(new Error('C:/secret/token'));
    const result = await service.importArticle({
      ...input,
      body: [...input.body, { type: 'image', image_id: 'i' }],
      images: [
        {
          image_id: 'i',
          source: { type: 'remote', url: 'https://example.com/i' },
        },
      ],
    });
    expect(result).toMatchObject({ status: 'failed', imageIndex: 0 });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(assets.cleanup).toHaveBeenCalledWith(attempt);
    expect(repository.forgetAttempt).toHaveBeenCalled();
    expect(repository.commit).not.toHaveBeenCalled();
  });
  it('keeps committed assets when acknowledgement throws and cancellation arrives', async () => {
    const { service, repository, assets } = setup();
    await service.recover();
    const original = repository.commit;
    const controller = new AbortController();
    repository.commit = (a, article) => {
      original(a, article);
      controller.abort();
      throw new Error('ack lost');
    };
    expect(
      await service.importArticle(input, { signal: controller.signal }),
    ).toMatchObject({ status: 'imported' });
    expect(assets.cleanup).not.toHaveBeenCalled();
  });
  it('preserves files and blocks further imports when commit cannot be resolved', async () => {
    const { service, repository, assets } = setup();
    await service.recover();
    repository.commit = () => {
      throw new Error('uncertain');
    };
    repository.findImport = () => {
      throw new Error('offline');
    };
    expect(await service.importArticle(input)).toMatchObject({
      status: 'failed',
      code: 'RECOVERY_REQUIRED',
    });
    expect(assets.cleanup).not.toHaveBeenCalled();
    expect(await service.importArticle(input)).toMatchObject({
      status: 'failed',
      code: 'RECOVERY_REQUIRED',
    });
  });
  it('retains attempt when cleanup fails, then startup recovery can clean it', async () => {
    const { service, assets, repository } = setup();
    await service.recover();
    vi.mocked(assets.finalize).mockRejectedValueOnce(new Error('disk'));
    vi.mocked(assets.cleanup).mockRejectedValueOnce(new Error('locked'));
    expect(await service.importArticle(input)).toMatchObject({
      status: 'failed',
      code: 'RECOVERY_REQUIRED',
    });
    expect(repository.forgetAttempt).not.toHaveBeenCalled();
    expect(await service.recover()).toBe(true);
  });
  it('cancels before SQL and does not reserve for an already cancelled caller', async () => {
    const { service, assets, repository } = setup();
    await service.recover();
    const controller = new AbortController();
    controller.abort();
    expect(
      await service.importArticle(input, { signal: controller.signal }),
    ).toEqual({ status: 'cancelled' });
    expect(repository.reserve).not.toHaveBeenCalled();
    const during = new AbortController();
    assets.finalize = async () => {
      during.abort();
    };
    expect(
      await service.importArticle(input, { signal: during.signal }),
    ).toEqual({ status: 'cancelled' });
    expect(repository.commit).not.toHaveBeenCalled();
    expect(assets.cleanup).toHaveBeenCalled();
  });
  it('serializes concurrent imports and verifies persisted reads', async () => {
    const { service, assets } = setup();
    await service.recover();
    const results = await Promise.all([
      service.importArticle(input),
      service.importArticle(input),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'imported',
      'already_exists',
    ]);
    expect(await service.load(attempt.articleKey)).toMatchObject({
      externalId: 'a',
    });
    vi.mocked(assets.verify).mockRejectedValue(new Error('tampered'));
    await expect(service.load(attempt.articleKey)).rejects.toEqual(
      new ImportFailure('STORAGE_UNAVAILABLE'),
    );
  });
});
