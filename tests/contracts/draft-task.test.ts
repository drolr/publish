import { describe, expect, it } from 'vitest';
import {
  DraftTaskSchema,
  TaskViewSchema,
  draftRequests,
  TaskEventSchema,
} from '../../src/contracts/draft-task';
import { makeDraftTask } from '../fixtures/draft-task';

describe('draft contracts', () => {
  it('accepts the synthetic baseline and rejects unknown private fields', () => {
    const task = makeDraftTask();
    expect(DraftTaskSchema.safeParse(task).success).toBe(true);
    for (const key of ['password', 'cookie', 'token']) {
      expect(
        DraftTaskSchema.safeParse({ ...task, [key]: 'secret' }).success,
      ).toBe(false);
      expect(
        DraftTaskSchema.safeParse({
          ...task,
          store: { ...task.store, [key]: 'secret' },
        }).success,
      ).toBe(false);
    }
  });
  it('bounds private fields and requires exact snapshot identity', () => {
    const task = makeDraftTask();
    expect(
      DraftTaskSchema.safeParse({ ...task, articleKey: task.taskId }).success,
    ).toBe(false);
    expect(
      DraftTaskSchema.safeParse({
        ...task,
        store: { ...task.store, displayName: 'x'.repeat(201) },
      }).success,
    ).toBe(false);
    expect(
      DraftTaskSchema.safeParse({
        ...task,
        store: {
          ...task.store,
          identity: { source: 'visible-shop-link', value: 'x'.repeat(2001) },
        },
      }).success,
    ).toBe(false);
    expect(
      DraftTaskSchema.safeParse({ ...task, reason: 'raw error' }).success,
    ).toBe(false);
  });
  it('rejects URL/path and excess arguments at every request boundary', () => {
    for (const schema of Object.values(draftRequests)) {
      expect(schema.safeParse(['https://example.test/edit']).success).toBe(
        false,
      );
      expect(schema.safeParse(['C:/private/data']).success).toBe(false);
      expect(
        schema.safeParse([
          makeDraftTask().taskId,
          makeDraftTask().taskId,
          'extra',
        ]).success,
      ).toBe(false);
    }
    expect(
      draftRequests.prepareDraft.safeParse([
        makeDraftTask().articleKey,
        makeDraftTask().preparationId,
      ]).success,
    ).toBe(true);
    expect(draftRequests.getDraftState.safeParse([]).success).toBe(true);
  });
  it('does not allow private fields in public views or arbitrary events', () => {
    const task = makeDraftTask();
    const view = {
      taskId: task.taskId,
      articleKey: task.articleKey,
      title: task.snapshot.article.title,
      storeName: task.store.displayName,
      state: task.state,
      stage: task.stage,
      revision: 0,
      possibleRemoteEffect: false,
      stopRequested: false,
      platformPaused: false,
      reason: null,
      canOpenDraft: false,
    };
    expect(TaskViewSchema.parse(view)).toEqual(view);
    for (const key of ['identity', 'editUrl', 'assets', 'hash', 'snapshot'])
      expect(
        TaskViewSchema.safeParse({ ...view, [key]: 'private' }).success,
      ).toBe(false);
    expect(
      TaskEventSchema.safeParse({ type: 'update', possibleRemoteEffect: false })
        .success,
    ).toBe(false);
  });
  it('rejects checkpoint and occupancy inconsistencies', () => {
    for (const overrides of [
      { saveAttempted: true },
      { holdsPlatform: false },
      { state: 'failed', possibleRemoteEffect: true, holdsPlatform: false },
      { state: 'draft_saved', holdsPlatform: false },
    ])
      expect(
        DraftTaskSchema.safeParse({ ...makeDraftTask(), ...overrides }).success,
      ).toBe(false);
  });
});

it('accepts observed identifier queries but rejects credential URL components', () => {
  const task = makeDraftTask();
  const withUrl = (editUrl: string) => ({
    ...task,
    state: 'running',
    possibleRemoteEffect: true,
    evidence: {
      ...task.evidence,
      remote: { recordKey: 'synthetic-record', editUrl },
    },
  });
  expect(
    DraftTaskSchema.safeParse(
      withUrl('https://example.test/edit?pgc_id=record&pgc_status=opaque'),
    ).success,
  ).toBe(true);
  for (const url of [
    'http://example.test/edit',
    'https://user:pass@example.test/edit',
    'https://example.test/edit#secret',
    'https://example.test/edit?access_token=secret',
    'https://example.test/edit?session_id=secret',
    'https://example.test/\nedit',
  ])
    expect(DraftTaskSchema.safeParse(withUrl(url)).success).toBe(false);
});
it('rejects successful persisted tasks missing complete evidence', () => {
  expect(
    DraftTaskSchema.safeParse(
      makeDraftTask({
        state: 'draft_saved',
        stage: 'settled',
        possibleRemoteEffect: true,
        holdsPlatform: false,
      }),
    ).success,
  ).toBe(false);
});

it('rejects a persisted queued task carrying prior execution or evidence', () => {
  for (const overrides of [
    { possibleRemoteEffect: true },
    { stage: 'editor' },
    {
      evidence: {
        remote: { recordKey: 'record', editUrl: 'https://example.test/edit' },
        images: [],
        cover: null,
      },
    },
  ])
    expect(
      DraftTaskSchema.safeParse({ ...makeDraftTask(), ...overrides }).success,
    ).toBe(false);
});
it('allows complete associations for repeated body images beyond the distinct asset count', () => {
  const task = makeDraftTask();
  const assetKey = '55555555-5555-4555-8555-555555555555';
  const article = {
    ...task.snapshot.article,
    body: [
      ...Array.from({ length: 201 }, () => ({
        type: 'image' as const,
        image_id: 'photo',
      })),
      { type: 'paragraph' as const, text: '离线测试正文。' },
    ],
    assets: [
      {
        assetKey,
        imageId: 'photo',
        relativePath: `${task.articleKey}/${assetKey}.png`,
        mime: 'image/png' as const,
        byteSize: 100,
        width: 10,
        height: 10,
        sha256: 'c'.repeat(64),
      },
    ],
  };
  expect(
    DraftTaskSchema.safeParse({
      ...task,
      state: 'running',
      stage: 'verify',
      possibleRemoteEffect: true,
      snapshot: { version: 1, article, digest: 'd'.repeat(64) },
      evidence: {
        remote: null,
        cover: null,
        images: Array.from({ length: 201 }, (_, bodyIndex) => ({
          bodyIndex,
          imageId: 'photo',
          assetKey,
          resourceKey: 'a'.repeat(64),
        })),
      },
    }).success,
  ).toBe(true);
});

it('V2 image evidence uses top-level positions instead of the flattened compatibility projection', () => {
  const task = makeDraftTask();
  const assetKey = '55555555-5555-4555-8555-555555555555';
  task.snapshot.article.body.push({ type: 'image', image_id: 'image' });
  task.snapshot.article.assets.push({
    assetKey,
    imageId: 'image',
    relativePath: task.articleKey + '/' + assetKey + '.png',
    mime: 'image/png',
    byteSize: 1,
    width: 1,
    height: 1,
    sha256: 'a'.repeat(64),
  });
  task.snapshot = {
    version: 2,
    article: task.snapshot.article,
    digest: 'a'.repeat(64),
    editorBody: {
      version: 2,
      blocks: [
        { type: 'paragraph', content: [] },
        {
          type: 'list',
          kind: 'bullet',
          items: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '仅用于离线测试。', marks: [] }],
            },
          ],
        },
        { type: 'image', imageId: 'image' },
      ],
    },
  };
  task.state = 'running';
  task.stage = 'body';
  task.possibleRemoteEffect = true;
  task.evidence.images = [
    { bodyIndex: 2, imageId: 'image', assetKey, resourceKey: 'b'.repeat(64) },
  ];
  expect(DraftTaskSchema.safeParse(task).success).toBe(true);
  task.evidence.images[0].bodyIndex = 1;
  expect(DraftTaskSchema.safeParse(task).success).toBe(false);
});
