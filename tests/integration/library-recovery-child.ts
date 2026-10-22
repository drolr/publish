import {
  captureSchema6Tables,
  createSchema6Fixture,
} from '../fixtures/library-schema6-fixture';
import { logicalSnapshot } from '../fixtures/library-historical-data';
// Test-only process driver: real repositories, services and local assets; no platform adapter.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { revisionRuntime, updateInput } from './revision-crash-child';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import { createDraftSnapshotDigest } from '../../src/infrastructure/draft-snapshot-integrity';
import { createArticleImportService } from '../../src/application/article-import';
import { makeDraftTask } from '../fixtures/draft-task';

function hashes(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath, e.name);
      return [
        path.slice(root.length + 1),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
}
async function main() {
  const [phase, root] = process.argv.slice(2);
  const schema6 =
    phase === 'upgrade-schema6'
      ? JSON.parse(
          readFileSync(join(process.argv[4], 'schema6-fixture.json'), 'utf8'),
        )
      : undefined;
  if (schema6) {
    cpSync(join(process.argv[4], 'assets'), join(root, 'assets'), {
      recursive: true,
    });
    createSchema6Fixture(join(root, 'app.sqlite'), schema6.tables);
  }
  const r = await revisionRuntime(root);
  const tasks = openDraftTaskRepository(
    join(root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  const now = '2026-10-09T00:00:00.000Z';
  const count = () => {
    const list = r.repository.list!();
    if (list.status !== 'ok') throw Error('list failed');
    return list.page.totalCount;
  };
  try {
    if (phase === 'seed') {
      for (let i = 0; i < 10; i++) {
        const result = await r.importer.importArticle({
          schema_version: 1,
          article_id: `recovery-${i}`,
          title: `Recovery ${i}`,
          body: [{ type: 'paragraph', text: 'Synthetic local process test' }],
          images: [],
        });
        if (result.status !== 'imported') throw Error('seed failed');
      }
      const input = await updateInput(r);
      const saved = await r.service.saveRevision(
        input,
        new AbortController().signal,
      );
      if (saved.status !== 'committed') throw Error('save failed');
      const article = r.repository.load(r.article.articleKey)!;
      const fixture = makeDraftTask();
      const taskInput = {
        taskId: randomUUID(),
        preparationId: randomUUID(),
        snapshot: {
          version: 1 as const,
          article,
          digest: createDraftSnapshotDigest(article),
        },
        store: fixture.store,
        expectedArticleRevision: 2,
        now,
      };
      if (tasks.reserve(taskInput).status !== 'created')
        throw Error('reserve failed');
      tasks.apply(taskInput.taskId, 0, { type: 'begin' }, now);
      tasks.apply(taskInput.taskId, 1, { type: 'before-save' }, now);
      tasks.apply(
        taskInput.taskId,
        2,
        {
          type: 'evidence',
          evidence: {
            remote: {
              recordKey: 'synthetic-only',
              editUrl: 'https://example.test/draft/1',
            },
            cover: null,
            images: [
              {
                bodyIndex: article.body.findIndex(
                  (block) => block.type === 'image',
                ),
                imageId: 'i',
                assetKey: article.assets[0].assetKey,
                resourceKey: 'c'.repeat(64),
              },
            ],
          },
        },
        now,
      );
      tasks.apply(taskInput.taskId, 3, { type: 'verify' }, now);
      const task = tasks.apply(
        taskInput.taskId,
        4,
        { type: 'settle', state: 'draft_saved', reason: null },
        now,
      );
      writeFileSync(
        join(root, 'schema6-fixture.json'),
        JSON.stringify({
          tables: captureSchema6Tables(join(root, 'app.sqlite')),
          task,
          assets: hashes(join(root, 'assets')),
          saveId: input.intent.operationId,
        }),
      );
      const beforeCount = count();
      const command = {
        operationId: randomUUID(),
        articleKey: article.articleKey,
        expectedArticleRevision: 2,
      };
      const deleted = r.repository.deleteArticle(command, now);
      // Pending cleanup forces archived internal recovery to prove it retains the save receipt.
      r.repository.markRevisionOperation(input.intent.operationId, {
        cleanupComplete: false,
      });
      writeFileSync(
        join(root, 'expected.json'),
        JSON.stringify({
          task,
          taskInput,
          command,
          assets: hashes(join(root, 'assets')),
          saveId: input.intent.operationId,
        }),
      );
      process.stdout.write(
        JSON.stringify({
          beforeCount,
          count: count(),
          deleted: deleted.status,
          settled: task?.state,
        }),
      );
    } else if (phase === 'reopen') {
      const expected = JSON.parse(
        readFileSync(join(root, 'expected.json'), 'utf8'),
      );
      tasks.recover(now);
      let sourceReads = 0;
      const importer = createArticleImportService(r.repository, r.formal, {
        read: async () => {
          sourceReads++;
          throw Error('deleted identity must not read source');
        },
      });
      await importer.recover();
      const imported = await importer.importArticle({
        schema_version: 1,
        article_id: 'synthetic',
        title: 'Attempted reimport',
        body: [
          { type: 'paragraph', text: 'Must not resurrect' },
          { type: 'image', image_id: 'i' },
        ],
        images: [
          {
            image_id: 'i',
            source: {
              type: 'local',
              path: 'deleted-source-must-not-be-read.png',
            },
          },
        ],
      });
      const task = tasks.get(expected.task.taskId);
      const reserve = tasks.reserve({
        ...expected.taskInput,
        taskId: randomUUID(),
        preparationId: randomUUID(),
        expectedArticleRevision: 3,
      });
      const archiveRecovered =
        (await r.service.recover()) &&
        (await importer.recover()) &&
        r.repository.readSaveReceipt(expected.saveId)?.articleRevision === 2;
      process.stdout.write(
        JSON.stringify({
          count: count(),
          receipt: r.repository.readDeletionResult(expected.command.operationId)
            .status,
          settled: task?.state,
          sameTask: JSON.stringify(task) === JSON.stringify(expected.task),
          sameAssets:
            JSON.stringify(hashes(join(root, 'assets'))) ===
            JSON.stringify(expected.assets),
          importStatus: imported.status,
          sourceReads,
          reserve: reserve.status,
          archiveRecovered,
        }),
      );
    } else if (phase === 'upgrade-schema6') {
      tasks.recover(now);
      const task = tasks.get(schema6.task.taskId);
      // Schema6 has no article_revision. Compare every historical field exactly;
      // the newly added revision must independently remain unknown after upgrade.
      const historicalTask = { ...task };
      delete historicalTask.articleRevision;
      const expectedHistoricalTask = { ...schema6.task };
      delete expectedHistoricalTask.articleRevision;
      const recovered =
        (await r.service.recover()) && (await r.importer.recover());
      process.stdout.write(
        JSON.stringify({
          schemaVersion: r.repository.getSchemaVersion(),
          count: count(),
          sameTask: isDeepStrictEqual(historicalTask, expectedHistoricalTask),
          legacyArticleRevision: task?.articleRevision,
          sameAssets:
            JSON.stringify(hashes(join(root, 'assets'))) ===
            JSON.stringify(schema6.assets),
          sameOldRows:
            JSON.stringify(
              logicalSnapshot(join(root, 'app.sqlite'), schema6.tables),
            ) === JSON.stringify(schema6.tables),
          saveReceipt: r.repository.readSaveReceipt(schema6.saveId)
            ?.articleRevision,
          settled: task?.state,
          recovered,
        }),
      );
    } else throw Error('unknown phase');
  } finally {
    tasks.close();
    r.repository.close();
  }
}
void main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
