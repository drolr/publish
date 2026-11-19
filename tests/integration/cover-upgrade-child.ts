// External local process driver; no production test switches or platform sessions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import {
  captureSchema6Tables,
  createSchema6Fixture,
} from '../fixtures/library-schema6-fixture';
import {
  logicalSnapshot,
  treeHashes,
} from '../fixtures/library-historical-data';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import { createArticleCoverController } from '../../src/application/article-cover';
import { createCoverAssetStore } from '../../src/infrastructure/assets/cover-asset-store';
import { createCoverFilePicker } from '../../src/desktop/main/article-cover-picker';
import { createDraftSnapshotDigest } from '../../src/infrastructure/draft-snapshot-integrity';
import { makeDraftTask } from '../fixtures/draft-task';
import {
  migrate,
  readMigrations,
} from '../../src/infrastructure/persistence/migrate';
const [phase, root, versionText] = process.argv.slice(2);
const version = Number(versionText),
  migrations = resolve('src/infrastructure/persistence/migrations');
const path = join(root, 'app.sqlite'),
  now = '2026-10-09T00:00:00.000Z';
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const emit = (v: unknown) => process.stdout.write(JSON.stringify(v));
function originalRows(expected: ReturnType<typeof logicalSnapshot>) {
  const rows = logicalSnapshot(path, expected);
  rows.schema_migrations.rows = rows.schema_migrations.rows.filter(
    (r) => (r as { version: number }).version <= version,
  );
  // logicalSnapshot is an inherited schema6 helper. Restore schema7's migration row explicitly.
  if (version === 7) {
    const db = new Database(path, { readonly: true });
    try {
      rows.schema_migrations.rows = db
        .prepare(
          'SELECT * FROM schema_migrations WHERE version<=7 ORDER BY version',
        )
        .all();
    } finally {
      db.close();
    }
  }
  return rows;
}
async function main() {
  if (phase === 'seed') {
    const source = join(root, 'synthetic-source');
    mkdirSync(source);
    const seeded = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('tests/integration/library-recovery-child.ts'),
        'seed',
        source,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    assert.equal(seeded.status, 0, seeded.stderr);
    const repository = openArticleRepository(
      join(source, 'app.sqlite'),
      migrations,
    );
    const tasks = openDraftTaskRepository(
      join(source, 'app.sqlite'),
      migrations,
    );
    const article = repository.findExternal('recovery-0')!;
    const taskId = randomUUID();
    try {
      assert.equal(
        tasks.reserve({
          taskId,
          preparationId: randomUUID(),
          expectedArticleRevision: 1,
          snapshot: {
            version: 1,
            article,
            digest: createDraftSnapshotDigest(article),
          },
          store: makeDraftTask().store,
          now,
        }).status,
        'created',
      );
      let task = tasks.apply(taskId, 0, { type: 'begin' }, now);
      task = tasks.apply(
        taskId,
        task.revision,
        { type: 'before-effect', stage: 'editor' },
        now,
      );
      task = tasks.apply(
        taskId,
        task.revision,
        { type: 'settle', state: 'needs_human', reason: 'PAGE_CHANGED' },
        now,
      );
      tasks.apply(
        taskId,
        task.revision,
        {
          type: 'close-without-save',
          proof: {
            taskId,
            revision: task.revision,
            snapshotDigest: task.snapshot.digest,
            storeKey: task.store.storeKey,
            generation: 'synthetic-only',
            checkedAt: now,
          },
          confirmedAt: now,
        },
        now,
      );
    } finally {
      tasks.close();
      repository.close();
    }
    const tables = captureSchema6Tables(join(source, 'app.sqlite'));
    createSchema6Fixture(path, tables);
    cpSync(join(source, 'assets'), join(root, 'assets'), { recursive: true });
    if (version === 7) {
      const db = new Database(path);
      try {
        migrate(db, readMigrations(migrations).slice(0, 7));
      } finally {
        db.close();
      }
    }
    const original = logicalSnapshot(path);
    // Exclude only future tombstone column from exact old projection; deletion is tested separately.
    if (version === 7)
      original.articles.columns = original.articles.columns.filter(
        (c) => c !== 'deleted_at',
      );
    const exact =
      version === 7
        ? (() => {
            const db = new Database(path, { readonly: true });
            try {
              original.articles.rows = db
                .prepare(
                  'SELECT ' +
                    original.articles.columns.join(',') +
                    ' FROM articles',
                )
                .all()
                .sort((a, b) =>
                  JSON.stringify(a).localeCompare(JSON.stringify(b)),
                );
              return original;
            } finally {
              db.close();
            }
          })()
        : original;
    assert.ok(exact.judongche_draft_tasks.rows.length >= 2);
    assert.ok(exact.judongche_task_closures.rows.length);
    assert.ok(exact.article_edit_operations.rows.length);
    writeFileSync(
      join(root, 'upgrade-expected.json'),
      JSON.stringify({
        original: exact,
        assets: treeHashes(join(root, 'assets')),
      }),
    );
    emit({
      sourceSchema: version,
      nonemptyTask: true,
      nonemptyClosure: true,
      nonemptySave: true,
    });
    return;
  }
  const expected = JSON.parse(
    readFileSync(join(root, 'upgrade-expected.json'), 'utf8'),
  );
  const repository = openArticleRepository(path, migrations);
  const assets = createCoverAssetStore(root, repository);
  let selection: string[] | undefined;
  const controller = createArticleCoverController({
    repository,
    assets,
    picker: createCoverFilePicker(async () => selection),
    gate: () => 'ready',
    newId: randomUUID,
    now: () => now,
    digest: (v) => hash(Buffer.from(JSON.stringify(v))),
  });
  try {
    assert.equal(await controller.recover(), true);
    assert.deepEqual(originalRows(expected.original), expected.original);
    assert.deepEqual(treeHashes(join(root, 'assets')), expected.assets);
    if (phase === 'upgrade') {
      const input = join(root, 'input');
      mkdirSync(input);
      const colors = ['red', 'green', 'blue', 'yellow'];
      const paths: string[] = [];
      const hashes: string[] = [];
      for (const [i, color] of colors.entries()) {
        const bytes = await sharp({
          create: {
            width: 16 + i,
            height: 12 + i,
            channels: 3,
            background: color,
          },
        })
          .png()
          .toBuffer();
        const p = join(input, `${i}.png`);
        writeFileSync(p, bytes);
        paths.push(p);
        hashes.push(hash(bytes));
      }
      const covers = [];
      for (const [index, mode] of (['single', 'triple'] as const).entries()) {
        const article = repository.findExternal(`recovery-${index + 1}`)!;
        const before = repository.loadEditableArticle(article.articleKey)!;
        let s = await controller.beginCoverEdit(article.articleKey);
        if (!('sessionId' in s)) throw Error('begin');
        s = await controller.setCoverDraft(
          { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
          { mode, imageTokens: [] },
        );
        if (!('sessionId' in s)) throw Error('mode');
        selection = index === 0 ? [paths[0]] : paths.slice(1);
        s = await controller.pickCoverImages(
          { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
          index === 0 ? [0] : [0, 1, 2],
        );
        if (!('sessionId' in s)) throw Error('pick');
        if (index === 1) {
          s = await controller.setCoverDraft(
            { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
            {
              mode,
              imageTokens: [
                s.draft.imageTokens[2],
                s.draft.imageTokens[0],
                s.draft.imageTokens[1],
              ],
            },
          );
          if (!('sessionId' in s)) throw Error('order');
        }
        const receipt = await controller.saveCoverEdit({
          sessionId: s.sessionId,
          expectedDraftRevision: s.draftRevision,
          operationId: randomUUID(),
        });
        assert.equal(receipt.status, 'committed');
        await controller.closeCoverEdit(s.sessionId);
        assert.deepEqual(
          repository.loadEditableArticle(article.articleKey),
          before,
        );
        covers.push({
          key: article.articleKey,
          configuration: repository.loadCover(article.articleKey),
          receipt,
          hashes: index === 0 ? [hashes[0]] : [hashes[3], hashes[1], hashes[2]],
          before,
        });
      }
      renameSync(input, join(root, 'source-removed'));
      // Record actual persisted versions/bytes before tombstone; no platform task is created.
      assert.equal(await controller.recover(), true);
      expected.covers = covers;
      expected.coverTree = treeHashes(join(root, 'covers'));
      const all = logicalSnapshot(path);
      expected.coverTables = Object.fromEntries(
        Object.entries(all).filter(([n]) => n.startsWith('article_cover_')),
      );
      writeFileSync(
        join(root, 'upgrade-expected.json'),
        JSON.stringify(expected),
      );
      emit({
        schemaVersion: repository.getSchemaVersion(),
        oldRowsExact: true,
        oldAssetsExact: true,
        coverModes: covers.map((c) => c.configuration?.mode),
        originalBodiesExact: true,
        originalRevisionsExact: true,
        originalSourceRemoved: true,
      });
    } else if (phase === 'reopen') {
      for (const c of expected.covers) {
        assert.deepEqual(repository.loadCover(c.key), c.configuration);
        assert.deepEqual(repository.loadEditableArticle(c.key), c.before);
        assert.deepEqual(
          await controller.getCoverSaveResult(c.receipt.receipt.operationId),
          c.receipt,
        );
        for (const [i, a] of c.configuration.assets.entries()) {
          const result = await controller.getCoverImage({
            kind: 'stored',
            articleKey: c.key,
            coverRevision: c.configuration.coverRevision,
            assetKey: a.assetKey,
          });
          assert.equal(result.status, 'ok');
          if (result.status === 'ok')
            assert.equal(hash(result.bytes), c.hashes[i]);
        }
      }
      const key = expected.covers[1].key;
      assert.equal(
        repository.deleteArticle(
          {
            articleKey: key,
            expectedArticleRevision: 1,
            operationId: randomUUID(),
          },
          now,
        ).status,
        'deleted',
      );
      assert.equal(repository.loadCover(key), undefined);
      assert.deepEqual(treeHashes(join(root, 'covers')), expected.coverTree);
      const changed = expected.original.articles.rows.find(
        (r: { article_key: string }) => r.article_key === key,
      );
      changed.content_revision++;
      if (version === 7) {
        const post = logicalSnapshot(path);
        expected.original.article_library_meta.rows =
          post.article_library_meta.rows;
        expected.original.article_delete_operations.rows =
          post.article_delete_operations.rows;
        assert.equal(
          expected.original.article_library_meta.rows[0].membership_revision,
          1,
        );
        assert.equal(
          expected.original.article_delete_operations.rows.length,
          1,
        );
      }
      assert.deepEqual(originalRows(expected.original), expected.original);
      writeFileSync(
        join(root, 'upgrade-expected.json'),
        JSON.stringify(expected),
      );
      const tasks = openDraftTaskRepository(path, migrations);
      try {
        for (const row of expected.original.judongche_draft_tasks.rows) {
          const task = tasks.get(row.task_id);
          assert.ok(task);
          assert.equal(task.coverPlan, undefined);
          assert.equal(task.state, row.state);
          assert.equal(task.snapshot.digest, row.snapshot_digest);
        }
      } finally {
        tasks.close();
      }
      emit({
        schemaVersion: 15,
        orderedCoverBytesExact: true,
        coverReceiptsExact: true,
        oldRowsExact: true,
        deletedCoverHistoryExact: true,
        taskHistoryExact: true,
        originalBodiesExact: true,
      });
    } else if (phase === 'archive') {
      assert.deepEqual(
        logicalSnapshot(path, expected.coverTables),
        expected.coverTables,
      );
      assert.deepEqual(treeHashes(join(root, 'covers')), expected.coverTree);
      assert.equal(repository.loadCover(expected.covers[1].key), undefined);
      for (const c of expected.covers)
        assert.deepEqual(
          await controller.getCoverSaveResult(c.receipt.receipt.operationId),
          c.receipt,
        );
      emit({
        deletedCoverHistoryExact: true,
        coverReceiptsExact: true,
        oldRowsExact: true,
      });
    } else throw Error('unknown phase');
  } finally {
    repository.close();
  }
}
void main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
