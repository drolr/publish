import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createDraftHarness,
  type DraftHarness,
} from '../fixtures/draft-harness';
const harnesses: DraftHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
  const h = await createDraftHarness();
  harnesses.push(h);
  return h;
}
it('old_preparation_revision_rejected after declaration ABA even when content matches', async () => {
  const h = await setup();
  const item = h.articles.getArticleDeclarations!([h.articleKey]);
  if (item.status !== 'ok') throw Error('fixture');
  const original = item.items[0];
  h.articles.setArticleDeclarations!({
    targets: [
      {
        articleKey: original.articleKey,
        expectedDeclaration: original.contentDeclaration,
      },
    ],
    declaration: 'original',
  });
  const changed = h.articles.getArticleDeclarations!([h.articleKey]);
  if (changed.status !== 'ok') throw Error('fixture');
  h.articles.setArticleDeclarations!({
    targets: [
      {
        articleKey: original.articleKey,
        expectedDeclaration: changed.items[0].contentDeclaration,
      },
    ],
    declaration: original.contentDeclaration,
  });
  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'blocked',
    reason: 'STALE_PREPARATION',
  });
  expect(h.tasks.latest()).toBeUndefined();
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(0);
});
it('asset settlement rechecks atomic article revision before offering a summary', async () => {
  const h = await setup();
  const original = h.articles.loadEditableArticle(h.articleKey)!;
  const capture = h.snapshots.capture;
  h.snapshots.capture = async (article) => {
    const result = await capture(article);
    const read = h.articles.getArticleDeclarations!([h.articleKey]);
    if (read.status !== 'ok') throw Error('fixture');
    h.articles.setArticleDeclarations!({
      targets: [
        {
          articleKey: h.articleKey,
          expectedDeclaration: read.items[0].contentDeclaration,
        },
      ],
      declaration: 'original',
    });
    return result;
  };
  const opened = await h.api.checkDraftSession();
  expect(
    await h.api.prepareDraft(h.articleKey, opened.view.session.bindingToken!),
  ).toEqual({ status: 'blocked', reason: 'STALE_PREPARATION' });
  expect(h.articles.loadEditableArticle(h.articleKey)!.articleRevision).toBe(
    original.articleRevision + 1,
  );
});
it('edited saved content prepares a fresh attempt without replaying historical tasks or bypassing stale checks', async () => {
  const h = await setup();
  await h.api.startDraft(h.preparationId);
  h.releaseExecute();
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const task = h.tasks.latest()!;
  expect(task).toMatchObject({
    state: 'draft_saved',
    articleRevision: 1,
    saveAttempted: true,
    snapshot: { article: { contentDeclaration: 'repost' } },
  });
  const read = h.articles.getArticleDeclarations!([h.articleKey]);
  if (read.status !== 'ok') throw Error('fixture');
  h.articles.setArticleDeclarations!({
    targets: [
      {
        articleKey: h.articleKey,
        expectedDeclaration: read.items[0].contentDeclaration,
      },
    ],
    declaration: 'original',
  });
  const current = h.articles.loadEditableArticle(h.articleKey)!;
  expect(current.articleRevision).toBe(2);
  const opened = await h.api.checkDraftSession();
  const prepared = await h.api.prepareDraft(
    h.articleKey,
    opened.view.session.bindingToken!,
  );
  expect(prepared).toMatchObject({
    status: 'ready',
    preparation: {
      title: current.article.title,
      contentDeclaration: 'original',
      previouslySubmitted: true,
    },
  });
  if (prepared.status !== 'ready') throw Error('Expected fresh summary');
  const nextPreparationId = prepared.preparation.preparationId;
  expect(nextPreparationId).not.toBe(h.preparationId);
  expect(h.preparation.take(nextPreparationId)).toMatchObject({
    articleRevision: 2,
    snapshot: { article: current.article },
  });
  expect(h.tasks.latest()).toEqual(task);
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);

  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'ok',
    view: { task: { taskId: task.taskId, state: 'draft_saved' } },
  });
  for (const expectedArticleRevision of [1, 2]) {
    expect(
      h.tasks.reserve({
        taskId: randomUUID(),
        preparationId: randomUUID(),
        snapshot: task.snapshot,
        store: task.store,
        now: task.createdAt,
        expectedArticleRevision,
      }),
    ).toEqual({ status: 'stale' });
  }
  expect(h.tasks.latest()).toEqual(task);
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(1);
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);

  expect(await h.api.startDraft(nextPreparationId)).toMatchObject({
    status: 'ok',
  });
  await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
  const next = h.tasks.findPreparation(nextPreparationId)!;
  expect(next.taskId).not.toBe(task.taskId);
  expect(next).toMatchObject({
    state: 'draft_saved',
    articleRevision: 2,
    saveAttempted: true,
    snapshot: { article: current.article },
  });
  expect(h.tasks.get(task.taskId)).toEqual(task);
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(2);
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(2);

  expect(await h.api.startDraft(nextPreparationId)).toMatchObject({
    status: 'ok',
    view: { task: { taskId: next.taskId, state: 'draft_saved' } },
  });
  expect(h.tasks.get(task.taskId)).toEqual(task);
  expect(h.tasks.get(next.taskId)).toEqual(next);
  expect(h.calls.filter((c) => c === 'execute')).toHaveLength(2);
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(2);
});
it('layout-only revision invalidates the old preparation despite an identical v1 projection', async () => {
  const h = await setup();
  const before = h.articles.load(h.articleKey);
  const db = new Database(h.path);
  try {
    db.prepare(
      'UPDATE articles SET content_revision=content_revision+1, editor_body_json=? WHERE article_key=?',
    ).run(
      JSON.stringify({
        version: 1,
        blocks: [
          { type: 'paragraph', text: '' },
          ...before!.body.map((b) =>
            b.type === 'paragraph' ? b : { type: 'image', imageId: b.image_id },
          ),
        ],
      }),
      h.articleKey,
    );
  } finally {
    db.close();
  }
  expect(h.articles.load(h.articleKey)).toEqual(before);
  expect(await h.api.startDraft(h.preparationId)).toMatchObject({
    status: 'blocked',
    reason: 'STALE_PREPARATION',
  });
  expect(h.tasks.latest()).toBeUndefined();
  expect(h.calls).not.toContain('execute');
});
