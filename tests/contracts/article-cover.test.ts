import { expect, it } from 'vitest';
import {
  CoverConfigurationSchema,
  CoverDraftSchema,
  CoverSaveCommandSchema,
  CoverEditReplySchema,
} from '../../src/contracts/article-cover';
import { randomUUID } from 'node:crypto';
const asset = () => ({
  assetKey: randomUUID(),
  relativePath: `${randomUUID()}/${randomUUID()}/${randomUUID()}.png`,
  mime: 'image/png',
  width: 1,
  height: 1,
  byteSize: 68,
  sha256: 'a'.repeat(64),
});
it('single_triple_exact_count validates persisted covers but allows incomplete edit drafts', () => {
  const base = {
    articleKey: randomUUID(),
    coverRevision: 1,
    configurationDigest: 'b'.repeat(64),
    saveOperationId: randomUUID(),
    committedAt: '2026-10-09T00:00:00.000Z',
  };
  for (const [mode, count, valid] of [
    ['none', 0, true],
    ['none', 1, false],
    ['single', 1, true],
    ['single', 2, false],
    ['triple', 2, false],
    ['triple', 3, true],
    ['triple', 4, false],
  ] as const)
    expect(
      CoverConfigurationSchema.safeParse({
        ...base,
        mode,
        assets: Array.from({ length: count }, () => {
          const a = asset();
          return {
            ...a,
            relativePath:
              base.articleKey +
              '/' +
              base.saveOperationId +
              '/' +
              a.assetKey +
              '.png',
          };
        }),
      }).success,
    ).toBe(valid);
  expect(
    CoverDraftSchema.safeParse({ mode: 'triple', imageTokens: [randomUUID()] })
      .success,
  ).toBe(true);
  expect(
    CoverDraftSchema.safeParse({ mode: 'none', imageTokens: [randomUUID()] })
      .success,
  ).toBe(false);
});
it('strict cover commands reject paths and unsafe revisions', () => {
  expect(
    CoverSaveCommandSchema.safeParse({
      sessionId: randomUUID(),
      operationId: randomUUID(),
      expectedDraftRevision: 0,
    }).success,
  ).toBe(true);
  expect(
    CoverSaveCommandSchema.safeParse({
      sessionId: randomUUID(),
      operationId: randomUUID(),
      expectedDraftRevision: 0,
      path: 'C:/foreign',
    }).success,
  ).toBe(false);
  expect(
    CoverSaveCommandSchema.safeParse({
      sessionId: randomUUID(),
      operationId: randomUUID(),
      expectedDraftRevision: Number.MAX_SAFE_INTEGER + 1,
    }).success,
  ).toBe(false);
});
import {
  CoverReadResultSchema,
  CoverImageResultSchema,
  CoverTaskSnapshotSchema,
} from '../../src/contracts/article-cover';
it('safe views enforce exact counts and reject private metadata and excessive pixels', () => {
  const image = {
    assetKey: randomUUID(),
    mime: 'image/png',
    width: 1,
    height: 1,
  };
  expect(
    CoverReadResultSchema.safeParse({
      status: 'ok',
      configuration: {
        articleKey: randomUUID(),
        coverRevision: 1,
        mode: 'triple',
        images: [image],
      },
    }).success,
  ).toBe(false);
  expect(
    CoverImageResultSchema.safeParse({
      status: 'ok',
      mime: 'image/png',
      bytes: new Uint8Array(10_000_001),
    }).success,
  ).toBe(false);
  expect(
    CoverReadResultSchema.safeParse({
      status: 'ok',
      configuration: {
        articleKey: randomUUID(),
        coverRevision: 1,
        mode: 'single',
        images: [{ ...image, relativePath: 'private' }],
      },
    }).success,
  ).toBe(false);
  const key = randomUUID();
  const id = randomUUID();
  const a = {
    ...asset(),
    assetKey: id,
    relativePath: key + '/' + randomUUID() + '/different.png',
  };
  expect(
    CoverTaskSnapshotSchema.safeParse({
      version: 1,
      articleKey: key,
      coverRevision: 1,
      mode: 'single',
      assets: [a],
      digest: 'c'.repeat(64),
    }).success,
  ).toBe(false);
});

it('safe optional image failure is bounded to an invalid session notice and rejects raw details', () => {
  const state = {
    status: 'open',
    sessionId: randomUUID(),
    articleKey: randomUUID(),
    baseArticleRevision: 1,
    baseCoverRevision: 0,
    draftRevision: 0,
    draft: { mode: 'triple', imageTokens: [] },
    dirty: false,
    images: [],
    notice: 'image_invalid',
  };
  expect(CoverEditReplySchema.safeParse(state).success).toBe(true);
  expect(
    CoverEditReplySchema.safeParse({
      ...state,
      imageFailure: { position: 1, reason: 'IMAGE_INVALID' },
    }).success,
  ).toBe(true);
  for (const invalid of [
    { position: -1, reason: 'IMAGE_INVALID' },
    { position: 3, reason: 'IMAGE_INVALID' },
    { position: 1, reason: 'raw error' },
    { position: 1, reason: 'IMAGE_INVALID', path: 'C:/secret' },
  ])
    expect(
      CoverEditReplySchema.safeParse({ ...state, imageFailure: invalid })
        .success,
    ).toBe(false);
  expect(
    CoverEditReplySchema.safeParse({
      ...state,
      notice: null,
      imageFailure: { position: 1, reason: 'IMAGE_INVALID' },
    }).success,
  ).toBe(false);
  expect(
    CoverEditReplySchema.safeParse({
      status: 'idle',
      notice: 'image_invalid',
      imageFailure: { position: 1, reason: 'IMAGE_INVALID' },
    }).success,
  ).toBe(false);
});
