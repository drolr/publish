import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import {
  migrate,
  readMigrations,
} from '../../src/infrastructure/persistence/migrate';
import { seedLegacyStoredArticle } from '../../src/infrastructure/persistence/testing/article-fixtures';
import { makeDraftTask } from '../fixtures/draft-task';
import { revisionRuntime, png } from './revision-crash-child';
const migrations = resolve('src/infrastructure/persistence/migrations');
const roots: string[] = [];
const digest = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
function root() {
  const path = mkdtempSync(join(tmpdir(), 'editor-upgrade-'));
  roots.push(path);
  return path;
}
function integrity(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
}
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

// Private schema2 backup acceptance is intentionally excluded from publication.

it('representative schema5 upgrade preserves complete task JSON, stable identities, assets and durable hold without replay', async () => {
  const seeded = await revisionRuntime(root());
  const article = seeded.article;
  seeded.repository.close();
  const clone = root();
  const path = join(clone, 'app.sqlite');
  cpSync(join(seeded.root, 'assets'), join(clone, 'assets'), {
    recursive: true,
  });
  const db = new Database(path);
  migrate(db, readMigrations(migrations).slice(0, 5));
  db.close();
  seedLegacyStoredArticle(path, article);
  const second = {
    ...article,
    articleKey: randomUUID(),
    externalId: 'held-synthetic',
    importId: randomUUID(),
    assets: [],
    body: [{ type: 'paragraph' as const, text: 'Held body' }],
  };
  seedLegacyStoredArticle(path, second);
  const writer = new Database(path);
  const historical = makeDraftTask({
    articleKey: article.articleKey,
    state: 'draft_saved',
    stage: 'settled',
    possibleRemoteEffect: true,
    saveAttempted: true,
    holdsPlatform: false,
    evidence: {
      remote: {
        recordKey: 'synthetic-saved',
        editUrl: 'https://example.invalid/edit/synthetic-saved',
      },
      images: [
        {
          bodyIndex: 1,
          imageId: article.assets[0].imageId,
          assetKey: article.assets[0].assetKey,
          resourceKey: 'a'.repeat(64),
        },
      ],
      cover: null,
    },
  });
  const held = makeDraftTask({
    taskId: randomUUID(),
    preparationId: randomUUID(),
    articleKey: second.articleKey,
    state: 'running',
    stage: 'body',
    possibleRemoteEffect: true,
    holdsPlatform: true,
  });
  for (const [task, item] of [
    [historical, article],
    [held, second],
  ] as const) {
    const snapshot = {
      version: 1,
      article: item,
      digest: digest(JSON.stringify(item)),
    };
    writer
      .prepare(
        'INSERT INTO judongche_draft_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        task.taskId,
        task.preparationId,
        task.articleKey,
        task.platform,
        task.mode,
        task.store.storeKey,
        JSON.stringify(task.store),
        JSON.stringify(snapshot),
        snapshot.digest,
        task.coverPolicy,
        task.state,
        task.stage,
        task.revision,
        Number(task.possibleRemoteEffect),
        Number(task.saveAttempted),
        Number(task.stopRequested),
        Number(task.holdsPlatform),
        JSON.stringify(task.evidence),
        task.reason,
        task.createdAt,
        task.updatedAt,
      );
  }
  const before = writer
    .prepare('SELECT * FROM judongche_draft_tasks ORDER BY task_id')
    .all();
  writer.close();
  const upgraded = openArticleRepository(path, migrations);
  expect(upgraded.load(article.articleKey)).toEqual(article);
  expect(upgraded.load(second.articleKey)).toEqual(second);
  upgraded.close();
  const reader = new Database(path, { readonly: true });
  expect(
    reader
      .prepare('SELECT * FROM judongche_draft_tasks ORDER BY task_id')
      .all(),
  ).toEqual(
    before.map((row) => ({
      ...(row as Record<string, unknown>),
      cover_plan_version: 0,
      article_revision: null,
    })),
  );
  reader.close();
  const tasks = openDraftTaskRepository(path, migrations);
  try {
    expect(tasks.get(historical.taskId)).toMatchObject({
      state: 'draft_saved',
      saveAttempted: true,
      holdsPlatform: false,
    });
    tasks.recover('2026-10-08T00:00:00.000Z');
    expect(tasks.get(held.taskId)).toMatchObject({
      state: 'interrupted',
      stage: 'body',
      saveAttempted: false,
      possibleRemoteEffect: true,
      holdsPlatform: true,
    });
    expect(tasks.occupied()?.taskId).toBe(held.taskId);
    expect(
      tasks.findIdentity(article.articleKey, historical.store.storeKey)?.taskId,
    ).toBe(historical.taskId);
    const unchanged = tasks.get(historical.taskId)!;
    expect(
      tasks.reserve({
        taskId: randomUUID(),
        preparationId: randomUUID(),
        snapshot: unchanged.snapshot,
        store: unchanged.store,
        now: '2026-10-08T00:00:00.000Z',
        expectedArticleRevision: 1,
      }),
    ).toMatchObject({
      status: 'blocked',
      task: { taskId: held.taskId, saveAttempted: false },
    });
  } finally {
    tasks.close();
  }
  expect(
    readFileSync(join(clone, 'assets', article.assets[0].relativePath)),
  ).toEqual(png);
  integrity(path);
});

it.each(['prepare', 'finalize', 'before', 'after', 'cleanup'])(
  'owned process kill at %s restores old or complete new version without replay',
  async (phase) => {
    const path = root();
    const initial = await revisionRuntime(path);
    const article = initial.article;
    initial.repository.close();
    const id = randomUUID();
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('tests/integration/revision-crash-child.ts'),
        'revision-crash',
        path,
        phase,
        id,
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(
          () => reject(Error('owned checkpoint timeout')),
          20000,
        );
        child.once('message', () => {
          clearTimeout(timer);
          done();
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(Error(`owned early exit ${code}: ${stderr}`));
        });
      });
      await new Promise<void>((done) => {
        child.once('exit', () => done());
        child.kill();
      });
    } finally {
      if (child.exitCode === null) child.kill();
    }
    const recovered = await revisionRuntime(path);
    try {
      // The cleanup journal is gone before its DB completion marker. Preserve the
      // committed receipt and complete assets, but keep writes closed for review.
      expect(await recovered.service.recover()).toBe(phase !== 'cleanup');
      expect(recovered.service.isReady()).toBe(phase !== 'cleanup');
      const committed = phase === 'after' || phase === 'cleanup';
      const loaded = recovered.repository.loadEditableArticle(
        article.articleKey,
      )!;
      expect(loaded.articleRevision).toBe(committed ? 2 : 1);
      expect(loaded.article.title).toBe(committed ? 'Updated' : 'Original');
      expect(loaded.article.contentDeclaration).toBe(
        committed ? 'original' : 'repost',
      );
      expect(loaded.article.body).toEqual(
        committed
          ? [
              { type: 'paragraph', text: ' 原文😀\n ' },
              { type: 'image', image_id: 'i' },
              { type: 'image', image_id: 'new' },
            ]
          : [
              { type: 'paragraph', text: ' 原文😀\n ' },
              { type: 'image', image_id: 'i' },
            ],
      );
      expect(loaded.editorBody).toEqual(
        committed
          ? {
              version: 1,
              blocks: [
                { type: 'paragraph', text: '' },
                { type: 'paragraph', text: ' 原文😀\n ' },
                { type: 'image', imageId: 'i' },
                { type: 'image', imageId: 'new' },
              ],
            }
          : null,
      );
      expect(loaded.article.articleKey).toBe(article.articleKey);
      expect(loaded.article.externalId).toBe(article.externalId);
      expect(loaded.article.importId).toBe(article.importId);
      expect((await recovered.service.getSaveResult(id)).status).toBe(
        committed ? 'committed' : 'failed',
      );
      expect(loaded.article.assets).toHaveLength(committed ? 2 : 1);
      for (const asset of loaded.article.assets) {
        const bytes = readFileSync(join(path, 'assets', asset.relativePath));
        expect(bytes).toEqual(png);
        expect(digest(bytes)).toBe(asset.sha256);
      }
      const before = loaded;
      expect(await recovered.service.recover()).toBe(phase !== 'cleanup');
      expect(
        recovered.repository.loadEditableArticle(article.articleKey),
      ).toEqual(before);
      const listed = recovered.repository.list!();
      if (listed.status !== 'ok') throw new Error('Library unavailable');
      expect(listed.page.items).toHaveLength(1);
    } finally {
      recovered.repository.close();
    }
    integrity(join(path, 'app.sqlite'));
  },
  30000,
);
