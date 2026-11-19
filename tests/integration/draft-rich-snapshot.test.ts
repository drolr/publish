import { checkpointAttempt } from './draft-attempt-restart-child';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  createDraftHarness,
  type DraftHarness,
} from '../fixtures/draft-harness';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { createDraftSnapshotDigest } from '../../src/infrastructure/draft-snapshot-integrity';
import { upgradeEditorBody } from '../../src/domain/rich-text-body';
const cleanup: DraftHarness[] = [];
afterEach(async () => {
  for (const h of cleanup.splice(0)) await h.close();
});
async function setup() {
  const h = await createDraftHarness(0);
  cleanup.push(h);
  return h;
}
function writeBody(h: DraftHarness, body: unknown) {
  const db = new Database(h.path);
  try {
    db.prepare(
      'UPDATE articles SET editor_body_json=? WHERE article_key=?',
    ).run(JSON.stringify(body), h.articleKey);
  } finally {
    db.close();
  }
}
async function input(h: DraftHarness) {
  const a = h.articles.loadEditableArticle(h.articleKey)!;
  const c = h.snapshots.captureCover(h.articles.loadCover(h.articleKey)!);
  return {
    taskId: randomUUID(),
    preparationId: randomUUID(),
    expectedArticleRevision: a.articleRevision,
    expectedCoverRevision: c.coverRevision,
    coverSnapshot: c,
    snapshot: await h.snapshots.capture(a),
    store:
      h.control.probe.status === 'ready'
        ? h.control.probe.store
        : (() => {
            throw Error('no store');
          })(),
    now: h.control.now,
  };
}
it('reserve compares exact rich body inside its transaction even if a storage fault leaves revision and projection unchanged', async () => {
  const h = await setup(),
    frozen = await input(h);
  const body = upgradeEditorBody(null, frozen.snapshot.article.body);
  body.blocks[0] = {
    type: 'paragraph',
    content: [{ type: 'text', text: 'Offline body', marks: ['bold'] }],
  };
  writeBody(h, body);
  expect(h.tasks.reserve(frozen)).toEqual({ status: 'stale' });
  expect(h.tasks.latest()).toBeUndefined();
});
it('reserve freezes full V2 empty layout and container format; fresh connections cannot gain another execution permission', async () => {
  const h = await setup();
  writeBody(h, {
    version: 2,
    blocks: [
      { type: 'paragraph', content: [] },
      {
        type: 'list',
        kind: 'ordered',
        start: 7,
        items: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Offline body', marks: ['italic'] },
            ],
          },
        ],
      },
    ],
  });
  const frozen = await input(h),
    reserved = h.tasks.reserve(frozen);
  expect(reserved.status).toBe('created');
  expect(h.tasks.latest()?.snapshot).toEqual(frozen.snapshot);
  const restarted = await h.restart();
  expect(h.tasks.latest()).toMatchObject({
    state: 'interrupted',
    snapshot: frozen.snapshot,
  });
  expect(await restarted.startDraft(frozen.preparationId)).toMatchObject({
    status: 'ok',
  });
  expect(h.calls).not.toContain('execute');
  expect(
    h.tasks.reserve({
      ...frozen,
      taskId: randomUUID(),
      preparationId: randomUUID(),
    }).status,
  ).toBe('blocked');
});
it('V1 byte hash stays verifiable and plain V2 gets a different hash domain', async () => {
  const h = await setup(),
    next = (await input(h)).snapshot;
  const old = {
    version: 1 as const,
    article: next.article,
    digest: createDraftSnapshotDigest(next.article),
  };
  await expect(h.snapshots.verify(old)).resolves.toBeUndefined();
  expect(next.version).toBe(2);
  expect(next.digest).not.toBe(old.digest);
});
it('the internal adapter seam rejects every V2 without a declaration and capability mutation cannot enable it', async () => {
  const h = await setup(),
    snapshot = (await input(h)).snapshot;
  const adapter = createAdapterWithPages({} as never, {} as never);
  const capabilities = adapter.contentCapabilities();
  capabilities.features.bold = 'verified';
  capabilities.revision = 'fixture';
  expect(adapter.contentCapabilities()).toEqual({
    revision: 'judongche-rich-unknown-v1',
    features: {},
  });
  const task = {
    ...(await import('../fixtures/draft-task')).makeDraftTask(),
    articleKey: h.articleKey,
    snapshot,
  };
  expect(await adapter.execute(task, {} as never)).toEqual({
    status: 'blocked',
    reason: 'FORMAT_UNSUPPORTED',
  });
});

it('a format-only saved revision makes the old single summary stale before any writer', async () => {
  const h = await setup();
  writeBody(h, {
    version: 2,
    blocks: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Offline body', marks: ['bold'] }],
      },
    ],
  });
  const db = new Database(h.path);
  try {
    db.prepare(
      'UPDATE articles SET content_revision=content_revision+1 WHERE article_key=?',
    ).run(h.articleKey);
  } finally {
    db.close();
  }
  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'blocked',
    reason: 'STALE_PREPARATION',
  });
  expect(h.calls).not.toContain('execute');
  expect(h.tasks.latest()).toBeUndefined();
});

it('verified V1 submission and equivalent new V2 preparation remain the same attempt under revision/cover/store guards', async () => {
  const h = await setup(),
    next = await input(h);
  const old = {
    ...next,
    snapshot: {
      version: 1 as const,
      article: next.snapshot.article,
      digest: createDraftSnapshotDigest(next.snapshot.article),
    },
  };
  expect(h.tasks.reserve(old).status).toBe('created');
  checkpointAttempt(h.tasks, old.taskId, 'submission-recorded', h.control.now);
  const session = (await h.api.checkDraftSession()).view.session;
  expect(
    await h.api.prepareDraft(h.articleKey, session.bindingToken!),
  ).toMatchObject({
    status: 'existing',
    task: { taskId: old.taskId, state: 'submission_recorded' },
  });
  expect(h.tasks.latest()?.taskId).toBe(old.taskId);
  expect(h.calls).not.toContain('execute');
});
import { budgetSnapshot } from '../fixtures/rich-budget';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createDraftSnapshotV2Digest } from '../../src/infrastructure/draft-snapshot-integrity';
it('oversized full V2 snapshot blocks preparation with business feedback and cannot reserve a task', async () => {
  const h = await setup();
  const value = budgetSnapshot();
  const small = await input(h);
  value.article = {
    ...value.article,
    articleKey: h.articleKey,
    importId: small.snapshot.article.importId,
    externalId: small.snapshot.article.externalId,
  };
  value.digest = createDraftSnapshotV2Digest(value.article, value.editorBody);
  const preparation = createDraftPreparation({
    contentCapabilities: () => ({
      ...h.control.capabilities,
      features: { ...h.control.capabilities.features, bold: 'verified' },
    }),
    repository: {
      loadEditableArticle: () => ({
        article: value.article,
        articleRevision: 1,
        editorBody: value.editorBody,
      }),
    },
    covers: h.articles,
    snapshots: h.snapshots,
    tasks: h.tasks,
    newId: randomUUID,
  });
  const offered = preparation.offer(h.control.probe);
  expect(
    await preparation.prepare(h.articleKey, offered.bindingToken!),
  ).toEqual({ status: 'blocked', reason: 'INPUT_UNSUPPORTED' });
  expect(() => h.tasks.reserve({ ...small, snapshot: value })).toThrow();
  expect(h.tasks.latest()).toBeUndefined();
  expect(h.calls).not.toContain('execute');
});
