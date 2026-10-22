import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import type { StoredArticle } from '../../src/contracts/stored-article';
import type {
  DraftTaskRepository,
  SnapshotPort,
} from '../../src/domain/ports/draft-task';
import type { ArticleRevisionRepository } from '../../src/domain/ports/article-revision';
import { createDraftSnapshotPort } from '../../src/infrastructure/assets/draft-snapshot';
import { coverConfigurationDigest } from '../../src/infrastructure/persistence/article-cover-repository';
import { makeDraftTask } from '../fixtures/draft-task';

const article: StoredArticle = {
  articleKey: '11111111-1111-4111-8111-111111111111',
  importId: '22222222-2222-4222-8222-222222222222',
  externalId: 'article',
  title: '这是合格标题',
  body: [
    { type: 'paragraph', text: 'body' },
    { type: 'image', image_id: 'image' },
    { type: 'image', image_id: 'image' },
  ],
  contentDeclaration: 'original',
  createdAt: '2026-09-23T00:00:00.000Z',
  assets: [
    {
      assetKey: '33333333-3333-4333-8333-333333333333',
      imageId: 'image',
      relativePath:
        '11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.png',
      mime: 'image/png',
      byteSize: 1,
      width: 1,
      height: 1,
      sha256: 'a'.repeat(64),
    },
  ],
};
const store = {
  storeKey: 'b'.repeat(64),
  displayName: '测试门店',
  identity: { source: 'visible-shop-link' as const, value: 'store-1' },
};
function setup() {
  let next = 0;
  const repository = {
    loadEditableArticle: vi.fn(() => ({
      article: structuredClone(article),
      articleRevision: 1,
      editorBody: null,
    })),
  } as unknown as ArticleRevisionRepository;
  const snapshots = {
    captureCover: createDraftSnapshotPort({} as never).captureCover,
    readCoverImage: async () => {
      throw Error('no cover image');
    },
    capture: vi.fn(async (value: StoredArticle) => ({
      version: 1 as const,
      article: structuredClone(value),
      digest: 'c'.repeat(64),
    })),
  } as unknown as SnapshotPort;
  const tasks = {
    findIdentity: vi.fn(() => undefined),
    findLatestIdentity: vi.fn(() => undefined),
    reserve: vi.fn(),
    apply: vi.fn(),
  } as unknown as DraftTaskRepository;
  const service = createDraftPreparation({
    repository,
    covers: {
      loadCover: (articleKey: string) => ({
        articleKey,
        coverRevision: 0,
        mode: 'none',
        assets: [],
        configurationDigest: coverConfigurationDigest(
          articleKey,
          0,
          'none',
          [],
        ),
        saveOperationId: null,
        committedAt: null,
      }),
    },
    snapshots,
    tasks,
    newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
  });
  return { service, repository, snapshots, tasks };
}

it('keeps a binding token only for the same generation and store and invalidates preparations on change', async () => {
  const { service } = setup();
  const first = service.offer({
    status: 'ready',
    store,
    generation: randomUUID(),
  });
  const generation = randomUUID();
  const changed = service.offer({ status: 'ready', store, generation });
  expect(
    service.offer({ status: 'ready', store, generation }).bindingToken,
  ).toBe(changed.bindingToken);
  const ready = await service.prepare(
    article.articleKey,
    changed.bindingToken!,
  );
  expect(ready.status).toBe('ready');
  const id = ready.status === 'ready' ? ready.preparation.preparationId : '';
  expect(service.take(id)).toBeDefined();
  expect(service.take(id)).toBeDefined();
  expect(first.bindingToken).not.toBe(changed.bindingToken);
  service.offer({ status: 'blocked', reason: 'LOGIN_REQUIRED' });
  expect(service.take(id)).toBeUndefined();
});

it('rejects stale tokens before reading and rejects a generation change during capture', async () => {
  const { service, repository, snapshots } = setup();
  const view = service.offer({
    status: 'ready',
    store,
    generation: randomUUID(),
  });
  expect(await service.prepare(article.articleKey, randomUUID())).toEqual({
    status: 'blocked',
    reason: 'STALE_PREPARATION',
  });
  expect(repository.loadEditableArticle).not.toHaveBeenCalled();
  let release!: () => void;
  vi.mocked(snapshots.capture).mockImplementationOnce(async (value) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { version: 1, article: value, digest: 'c'.repeat(64) };
  });
  const pending = service.prepare(article.articleKey, view.bindingToken!);
  await vi.waitFor(() => expect(snapshots.capture).toHaveBeenCalled());
  service.offer({ status: 'ready', store, generation: randomUUID() });
  release();
  expect(await pending).toEqual({
    status: 'blocked',
    reason: 'STALE_PREPARATION',
  });
});

it('keeps overlapping preparations independent when captures resolve in reverse order and invalidates both together', async () => {
  const { service, snapshots } = setup();
  const releases: Array<
    (snapshot: { version: 1; article: StoredArticle; digest: string }) => void
  > = [];
  vi.mocked(snapshots.capture).mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  const generation = randomUUID();
  const view = service.offer({ status: 'ready', store, generation });
  const firstPending = service.prepare(article.articleKey, view.bindingToken!);
  const secondPending = service.prepare(article.articleKey, view.bindingToken!);
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  releases[1]({
    version: 1,
    article: { ...article, title: '第二份独立快照' },
    digest: 'd'.repeat(64),
  });
  const second = await secondPending;
  releases[0]({
    version: 1,
    article: { ...article, title: '第一份独立快照' },
    digest: 'c'.repeat(64),
  });
  const first = await firstPending;
  expect(first).toMatchObject({
    status: 'ready',
    preparation: { title: '第一份独立快照' },
  });
  expect(second).toMatchObject({
    status: 'ready',
    preparation: { title: '第二份独立快照' },
  });
  if (first.status !== 'ready' || second.status !== 'ready')
    throw new Error('Expected ready preparations');
  const firstId = first.preparation.preparationId;
  const secondId = second.preparation.preparationId;
  expect(service.take(firstId)?.snapshot.article.title).toBe('第一份独立快照');
  expect(service.take(secondId)?.snapshot.article.title).toBe('第二份独立快照');
  service.offer({ status: 'ready', store, generation: randomUUID() });
  expect(service.take(firstId)).toBeUndefined();
  expect(service.take(secondId)).toBeUndefined();
});

it('returns an existing logical task without capturing or creating a task', async () => {
  const { service, tasks, snapshots } = setup();
  const task = makeDraftTask({
    articleKey: article.articleKey,
    snapshot: { version: 1, article, digest: 'c'.repeat(64) },
    store,
  });
  vi.mocked(tasks.findLatestIdentity).mockReturnValue(task);
  const view = service.offer({
    status: 'ready',
    store,
    generation: randomUUID(),
  });
  expect(
    await service.prepare(article.articleKey, view.bindingToken!),
  ).toMatchObject({ status: 'existing', task: { taskId: task.taskId } });
  expect(snapshots.capture).not.toHaveBeenCalled();
});

it('reports image occurrences, preserves content, and performs no task write', async () => {
  const { service, repository, tasks } = setup();
  vi.mocked(repository.loadEditableArticle).mockReturnValue({
    article: { ...article, title: 'EV测试标题' },
    articleRevision: 1,
    editorBody: null,
  });
  const view = service.offer({
    status: 'ready',
    store,
    generation: randomUUID(),
  });
  const result = await service.prepare(article.articleKey, view.bindingToken!);
  expect(result).toMatchObject({
    status: 'ready',
    preparation: {
      title: 'EV测试标题',
      coverPolicy: 'local-upload-v1',
      bodyImageCount: 2,
      contentDeclaration: 'original',
    },
  });
  expect(tasks.reserve).not.toHaveBeenCalled();
  expect(tasks.apply).not.toHaveBeenCalled();
});

it.each([
  '短题',
  '这是一个超过三十个纯汉字限制用于确保不会自动截断并且明确拒绝的测试标题文本',
])('rejects unsupported pure-Han title %s', async (title) => {
  const { service, repository, snapshots } = setup();
  vi.mocked(repository.loadEditableArticle).mockReturnValue({
    article: { ...article, title },
    articleRevision: 1,
    editorBody: null,
  });
  const view = service.offer({
    status: 'ready',
    store,
    generation: randomUUID(),
  });
  expect(await service.prepare(article.articleKey, view.bindingToken!)).toEqual(
    { status: 'blocked', reason: 'TITLE_UNSUPPORTED' },
  );
  expect(snapshots.capture).not.toHaveBeenCalled();
});

it.each([
  'INPUT_UNSUPPORTED',
  'TITLE_UNSUPPORTED',
  'IMAGE_FORMAT_UNSUPPORTED',
  'IMAGE_SIZE_UNSUPPORTED',
  'ASSET_UNAVAILABLE',
] as const)(
  'maps fixed snapshot code %s without exposing the concrete error',
  async (code) => {
    const { service, snapshots } = setup();
    vi.mocked(snapshots.capture).mockRejectedValue({
      code,
      secret: 'private path',
    });
    const view = service.offer({
      status: 'ready',
      store,
      generation: randomUUID(),
    });
    expect(
      await service.prepare(article.articleKey, view.bindingToken!),
    ).toEqual({ status: 'blocked', reason: code });
  },
);

it('unknown initial storage read is not relabeled as operator input error', async () => {
  const { service, repository } = setup();
  const view = service.offer({
    status: 'ready',
    store,
    generation: randomUUID(),
  });
  vi.mocked(repository.loadEditableArticle).mockImplementationOnce(() => {
    throw Error('unknown database read');
  });
  expect(await service.prepare(article.articleKey, view.bindingToken!)).toEqual(
    { status: 'blocked', reason: 'STORAGE_UNAVAILABLE' },
  );
});

function submittedTask() {
  const coverSnapshot = createDraftSnapshotPort({} as never).captureCover({
    articleKey: article.articleKey,
    coverRevision: 0,
    mode: 'none',
    assets: [],
    configurationDigest: coverConfigurationDigest(
      article.articleKey,
      0,
      'none',
      [],
    ),
    saveOperationId: null,
    committedAt: null,
  });
  return makeDraftTask({
    articleKey: article.articleKey,
    articleRevision: 1,
    store,
    snapshot: { version: 1, article, digest: 'c'.repeat(64) },
    state: 'submission_recorded',
    stage: 'settled',
    holdsPlatform: false,
    saveAttempted: true,
    possibleRemoteEffect: true,
    evidence: {
      remote: null,
      images: [],
      cover: null,
      submission: {
        observation: 'unknown',
        attemptedAt: '2026-09-23T00:00:00.000Z',
      },
    },
    coverPlan: {
      policy: 'local-upload-v1',
      snapshot: coverSnapshot,
      report: {
        phase: 'not_configured',
        requestedMode: 'none',
        expectedCount: 0,
        confirmedItems: [],
        reason: null,
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
    },
  });
}
it('skips only a proven identical submitted snapshot, but explicit intent creates an independent preparation', async () => {
  const { service, tasks } = setup();
  vi.mocked(tasks.findLatestIdentity).mockReturnValue(submittedTask());
  const session = service.offer({
    status: 'ready',
    store,
    generation: randomUUID(),
  });
  expect(
    await service.prepare(article.articleKey, session.bindingToken!),
  ).toMatchObject({ status: 'existing' });
  const first = await service.prepare(
    article.articleKey,
    session.bindingToken!,
    'new_attempt',
  );
  const second = await service.prepare(
    article.articleKey,
    session.bindingToken!,
    'new_attempt',
  );
  expect(first.status).toBe('ready');
  expect(second.status).toBe('ready');
  if (first.status === 'ready' && second.status === 'ready')
    expect(first.preparation.preparationId).not.toBe(
      second.preparation.preparationId,
    );
});
it.each(['digest', 'articleRevision', 'coverRevision', 'coverDigest'] as const)(
  'prepares current snapshot when submitted %s differs',
  async (field) => {
    const { service, tasks } = setup();
    const old = submittedTask();
    if (field === 'digest') old.snapshot.digest = 'd'.repeat(64);
    if (field === 'articleRevision') old.articleRevision = 2;
    if (field === 'coverRevision') old.coverPlan!.snapshot.coverRevision = 1;
    if (field === 'coverDigest')
      old.coverPlan!.snapshot.digest = 'd'.repeat(64);
    vi.mocked(tasks.findLatestIdentity).mockReturnValue(old);
    const session = service.offer({
      status: 'ready',
      store,
      generation: randomUUID(),
    });
    expect(
      await service.prepare(article.articleKey, session.bindingToken!),
    ).toMatchObject({ status: 'ready', preparation: { title: article.title } });
  },
);
it('requires explicit confirmation for submitted history without recoverable versions', async () => {
  const { service, tasks } = setup();
  const old = submittedTask();
  old.articleRevision = null;
  vi.mocked(tasks.findLatestIdentity).mockReturnValue(old);
  const session = service.offer({
    status: 'ready',
    store,
    generation: randomUUID(),
  });
  expect(
    await service.prepare(article.articleKey, session.bindingToken!),
  ).toEqual({ status: 'blocked', reason: 'NEW_ATTEMPT_REQUIRED' });
  expect(
    await service.prepare(
      article.articleKey,
      session.bindingToken!,
      'new_attempt',
    ),
  ).toMatchObject({ status: 'ready' });
});
it('safe historical failures allow preparation while human-required ownership blocks explicit attempts', async () => {
  const { service, tasks } = setup();
  const old = makeDraftTask({
    articleKey: article.articleKey,
    state: 'failed',
    holdsPlatform: false,
  });
  vi.mocked(tasks.findLatestIdentity).mockReturnValue(old);
  const session = service.offer({
    status: 'ready',
    store,
    generation: randomUUID(),
  });
  expect(
    await service.prepare(article.articleKey, session.bindingToken!),
  ).toMatchObject({ status: 'ready' });
  vi.mocked(tasks.findLatestIdentity).mockReturnValue({
    ...old,
    state: 'needs_human',
    holdsPlatform: true,
  });
  expect(
    await service.prepare(
      article.articleKey,
      session.bindingToken!,
      'new_attempt',
    ),
  ).toMatchObject({ status: 'existing', task: { state: 'needs_human' } });
});
