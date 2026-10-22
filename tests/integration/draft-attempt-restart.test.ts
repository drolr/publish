import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDraftController } from '../../src/application/draft-controller';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { createArticleImportService } from '../../src/application/article-import';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { createCoverAssetStore } from '../../src/infrastructure/assets/cover-asset-store';
import { createDraftSnapshotPort } from '../../src/infrastructure/assets/draft-snapshot';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import type { DraftPlatform } from '../../src/domain/ports/draft-task';
import { makeDraftTask } from '../fixtures/draft-task';
import { restartCheckpoints } from './draft-attempt-restart-child';

const migrations = resolve('src/infrastructure/persistence/migrations');
const now = '2026-10-18T01:00:00.000Z';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);

it.each(restartCheckpoints)(
  'real abnormal child exit at %s retains attempt, budget and snapshots, never replays, and requires fresh confirmation',
  async (checkpoint) => {
    const root = await mkdtemp(join(tmpdir(), 'draft-attempt-restart-'));
    const path = join(root, 'app.sqlite');
    let articles = openArticleRepository(path, migrations);
    let tasks = openDraftTaskRepository(path, migrations);
    let controller: ReturnType<typeof createDraftController> | undefined;
    try {
      const assets = createAssetStore(join(root, 'assets'));
      const importer = createArticleImportService(articles, assets, {
        read: async () => png,
      });
      await importer.recover();
      const imported = await importer.importArticle({
        schema_version: 1,
        article_id: randomUUID(),
        title: 'Restart attempt fixture',
        body: [
          { type: 'paragraph', text: 'Before image' },
          { type: 'image', image_id: 'body-image' },
          { type: 'paragraph', text: 'After image' },
        ],
        images: [
          {
            image_id: 'body-image',
            source: { type: 'local', path: 'fixture.png' },
          },
        ],
      });
      if (imported.status !== 'imported') throw Error('Fixture import failed');
      const articleKey = imported.article.articleKey;
      const covers = createCoverAssetStore(root, articles);
      const coverIntent = {
        operationId: randomUUID(),
        sessionId: randomUUID(),
        articleKey,
        expectedArticleRevision: 1,
        expectedCoverRevision: 0,
        draftRevision: 0,
        mode: 'single' as const,
        payloadDigest: 'a'.repeat(64),
        startedAt: now,
      };
      expect(articles.beginCoverSave(coverIntent).status).toBe('not_started');
      const coverFiles = await covers.prepareCoverFiles(
        coverIntent,
        [{ bytes: png }],
        new AbortController().signal,
      );
      expect(articles.commitCoverVersion(coverIntent, coverFiles).status).toBe(
        'committed',
      );
      const snapshots = createDraftSnapshotPort(assets, {
        repository: articles,
        assets: covers,
      });
      const snapshot = await snapshots.capture(imported.article);
      const coverSnapshot = snapshots.captureCover(
        articles.loadCover(articleKey)!,
      );
      const input = {
        taskId: randomUUID(),
        preparationId: randomUUID(),
        expectedArticleRevision: 1,
        expectedCoverRevision: coverSnapshot.coverRevision,
        snapshot,
        coverSnapshot,
        store: makeDraftTask().store,
        now,
      };
      expect(tasks.reserve(input).status).toBe('created');
      tasks.close();
      articles.close();
      const exited = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('tests/integration/draft-attempt-restart-child.ts'),
          'attempt-crash',
          path,
          migrations,
          input.taskId,
          checkpoint,
          now,
        ],
        { encoding: 'utf8', timeout: 15000, windowsHide: true },
      );
      expect(exited.error).toBeUndefined();
      expect(exited.status, exited.stderr).toBe(77);
      articles = openArticleRepository(path, migrations);
      tasks = openDraftTaskRepository(path, migrations);
      const persisted = tasks.get(input.taskId)!;
      const recorded = checkpoint === 'submission-recorded';
      expect(persisted).toMatchObject({
        taskId: input.taskId,
        preparationId: input.preparationId,
        articleRevision: 1,
        snapshot,
        coverPlan: { snapshot: coverSnapshot },
        saveAttempted: checkpoint !== 'before-save',
        possibleRemoteEffect: true,
        holdsPlatform: !recorded,
        state: recorded ? 'submission_recorded' : 'running',
        stage:
          checkpoint === 'before-save'
            ? 'body'
            : checkpoint === 'save-in-flight'
              ? 'save'
              : recorded
                ? 'settled'
                : 'verify',
      });
      const calls: string[] = [];
      const probe = {
        status: 'ready' as const,
        store: input.store,
        generation: randomUUID(),
      };
      const platform: DraftPlatform = {
        openSession: async () => {
          calls.push('open');
          return probe;
        },
        checkSession: async () => {
          calls.push('check');
          return probe;
        },
        closeSession: async () => {
          calls.push('close');
        },
        checkAbsence: async () => {
          calls.push('absence');
          return { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
        },
        reconcile: async () => {
          calls.push('reconcile');
          return { status: 'blocked', reason: 'RESULT_AMBIGUOUS' };
        },
        openVerified: async () => {
          calls.push('open-verified');
        },
        execute: async (task, hooks) => {
          calls.push(`execute:${task.taskId}`);
          await hooks.checkpoint('body');
          await hooks.readImage(task.snapshot.article.assets[0].assetKey);
          calls.push(`upload:${task.taskId}`);
          await hooks.checkpoint('save');
          calls.push(`save:${task.taskId}`);
          return {
            status: 'submission_recorded',
            submission: { observation: 'acknowledged', attemptedAt: now },
            evidence: { remote: null, images: [], cover: null },
          };
        },
      };
      const recoveredSnapshots = createDraftSnapshotPort(assets, {
        repository: articles,
        assets: createCoverAssetStore(root, articles),
      });
      const preparation = createDraftPreparation({
        repository: articles,
        covers: articles,
        tasks,
        snapshots: recoveredSnapshots,
        newId: randomUUID,
      });
      controller = createDraftController({
        tasks,
        preparation,
        snapshots: recoveredSnapshots,
        platform,
        newId: randomUUID,
        now: () => now,
        gate: () => 'ready',
      });
      expect((await controller.getDraftState()).task).toMatchObject({
        taskId: input.taskId,
        state: recorded ? 'submission_recorded' : 'interrupted',
        platformPaused: !recorded,
      });
      expect(calls).toEqual([]);
      const recovered = tasks.get(input.taskId)!;
      expect(recovered.snapshot).toEqual(persisted.snapshot);
      expect(recovered.coverPlan).toEqual(persisted.coverPlan);
      expect(recovered.evidence).toEqual(persisted.evidence);
      expect(recovered.saveAttempted).toBe(persisted.saveAttempted);
      expect(tasks.occupied()?.taskId).toBe(
        recorded ? undefined : input.taskId,
      );
      tasks.recover(now);
      expect(tasks.get(input.taskId)).toEqual(recovered);
      expect(await controller.startDraft(input.preparationId)).toMatchObject({
        status: 'ok',
        view: { task: { taskId: input.taskId } },
      });
      expect(calls).toEqual([]);
      if (!recorded) {
        expect(
          tasks.reserve({
            ...input,
            taskId: randomUUID(),
            preparationId: randomUUID(),
          }).status,
        ).toBe('blocked');
        await controller.stopForRestart();
        expect(calls).toEqual(['close']);
        expect(tasks.get(input.taskId)).toMatchObject({
          state: 'stopped_by_user',
          stopRequested: true,
          holdsPlatform: false,
        });
      }
      const old = tasks.get(input.taskId)!;
      expect(old.snapshot).toEqual(persisted.snapshot);
      expect(old.coverPlan).toEqual(persisted.coverPlan);
      expect(old.evidence).toEqual(persisted.evidence);
      expect(old.saveAttempted).toBe(persisted.saveAttempted);
      const opened = await controller.openDraftSession();
      const fresh = await controller.prepareDraft(
        articleKey,
        opened.view.session.bindingToken!,
        'new_attempt',
      );
      expect(fresh.status).toBe('ready');
      if (fresh.status !== 'ready')
        throw Error('No fresh confirmed preparation');
      expect(fresh.preparation.preparationId).not.toBe(input.preparationId);
      // Preparing a summary alone cannot execute or consume the new save budget.
      expect(
        calls.filter((call) => /^(execute|upload|save):/.test(call)),
      ).toEqual([]);
      expect(tasks.latest()?.taskId).toBe(input.taskId);
      await controller.startDraft(fresh.preparation.preparationId);
      await vi.waitFor(() => expect(controller!.isActive()).toBe(false));
      const next = tasks.latest()!;
      expect(next).toMatchObject({
        state: 'submission_recorded',
        saveAttempted: true,
        holdsPlatform: false,
        snapshot,
        coverPlan: { snapshot: coverSnapshot },
      });
      expect(next.taskId).not.toBe(input.taskId);
      expect(next.preparationId).toBe(fresh.preparation.preparationId);
      expect(
        calls.filter((call) => /^(execute|upload|save):/.test(call)),
      ).toEqual([
        `execute:${next.taskId}`,
        `upload:${next.taskId}`,
        `save:${next.taskId}`,
      ]);
      expect(tasks.get(input.taskId)).toEqual(old);
      await controller.startDraft(fresh.preparation.preparationId);
      expect(calls.filter((call) => call.startsWith('save:'))).toEqual([
        `save:${next.taskId}`,
      ]);
      expect(tasks.get(input.taskId)).toEqual(old);
      await controller.stopAndWait();
      controller = undefined;
      tasks.close();
      articles.close();
      tasks = openDraftTaskRepository(path, migrations);
      articles = openArticleRepository(path, migrations);
      expect(tasks.get(input.taskId)).toEqual(old);
      expect(tasks.get(next.taskId)).toEqual(next);
    } finally {
      await controller?.stopAndWait();
      tasks.close();
      articles.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
