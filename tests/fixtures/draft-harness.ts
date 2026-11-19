import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDraftController } from '../../src/application/draft-controller';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
import { createArticleImportService } from '../../src/application/article-import';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { createCoverAssetStore } from '../../src/infrastructure/assets/cover-asset-store';
import { createDraftSnapshotPort } from '../../src/infrastructure/assets/draft-snapshot';
import type {
  DraftPlatform,
  SnapshotPort,
} from '../../src/domain/ports/draft-task';
import type {
  AdapterOutcome,
  DraftEvidence,
  SessionProbe,
} from '../../src/contracts/draft-task';
import { makeDraftTask } from './draft-task';

export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export async function createDraftHarness(
  bodyImageCount = 1,
  article = {
    title: 'Offline title',
    contentDeclaration: 'repost' as 'original' | 'repost',
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'controller-draft-'));
  const path = join(root, 'app.sqlite');
  const migrations = resolve('src/infrastructure/persistence/migrations');
  const articles = openArticleRepository(path, migrations);
  const assetStore = createAssetStore(join(root, 'assets'));
  const coverAssets = createCoverAssetStore(root, articles);
  const importer = createArticleImportService(articles, assetStore, {
    read: async () =>
      new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
          'base64',
        ),
      ),
  });
  await importer.recover();
  const imported = await importer.importArticle({
    schema_version: 1,
    article_id: randomUUID(),
    title: article.title,
    content_declaration: article.contentDeclaration,
    body: [
      { type: 'paragraph', text: 'Offline body' },
      ...Array.from({ length: bodyImageCount }, () => ({
        type: 'image' as const,
        image_id: 'image',
      })),
    ],
    images: bodyImageCount
      ? [{ image_id: 'image', source: { type: 'local', path: 'image.png' } }]
      : [],
  });
  if (imported.status !== 'imported') throw new Error('Fixture import failed');
  const articleKey = imported.article.articleKey;
  const calls: string[] = [];
  const pause = deferred();
  const store = makeDraftTask().store;
  const evidence: DraftEvidence = {
    remote: {
      recordKey: 'offline-record',
      editUrl: 'https://example.test/edit/offline-record',
    },
    images: Array.from({ length: bodyImageCount }, (_, index) => ({
      bodyIndex: index + 1,
      imageId: 'image',
      assetKey: imported.article.assets[0].assetKey,
      resourceKey: 'b'.repeat(64),
    })),
    cover: { resourceKey: 'a'.repeat(64), source: 'store-material-first' },
  };
  const control = {
    healthInvalidations: 0,
    controlledPilot: undefined as
      | {
          reviewedTitle?: string;
          reviewedTaskId?: string;
          reviewedEmptyEditorTaskId?: string;
          reviewedUnsavedBodyTaskId?: string;
          reviewedUnsavedBodyImageCount?: number;
          reviewedAmbiguousSave?: {
            taskId: string;
            revision: number;
            snapshotDigest: string;
            title: string;
            storeKey: string;
          };
          storeIdentity: string;
        }
      | undefined,
    capabilities: {
      revision: 'fixture-v1',
      features: {},
    } as import('../../src/contracts/draft-content').DraftContentCapabilities,
    now: '2026-09-23T00:00:00.000Z',
    gate: 'ready' as 'ready' | 'busy' | 'unavailable',
    probe: { status: 'ready', store, generation: randomUUID() } as SessionProbe,
    pauseAt: 'before-editor',
    outcome: { status: 'verified', evidence } as AdapterOutcome,
    reconcile: { status: 'verified', evidence } as AdapterOutcome,
    check: async () => {},
    verify: async () => {},
    afterCheckpoint: async (stage: string) => {
      void stage;
    },
  };
  const realSnapshots = createDraftSnapshotPort(assetStore, {
    repository: articles,
    assets: coverAssets,
  });
  const snapshots: SnapshotPort = {
    ...realSnapshots,
    verify: async (snapshot) => {
      await control.verify();
      await realSnapshots.verify(snapshot);
    },
  };
  const platform: DraftPlatform = {
    contentCapabilities: () => structuredClone(control.capabilities),
    checkAbsence: async () => ({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    }),
    openSession: async () => {
      calls.push('open');
      return control.probe;
    },
    checkSession: async () => {
      calls.push('check');
      await control.check();
      return control.probe;
    },
    closeSession: async () => {
      calls.push('close');
    },
    returnHomeAfterHandledTask: async (_task, cancelled) => {
      calls.push('handoff');
      return cancelled()
        ? { status: 'blocked', reason: 'STOP_REQUESTED' }
        : control.probe;
    },
    openVerified: async () => {
      calls.push('open-verified');
    },
    reconcile: async () => {
      calls.push('reconcile');
      return control.reconcile;
    },
    execute: async (_task, hooks) => {
      calls.push('execute');
      try {
        for (const stage of ['editor', 'body', 'cover', 'save'] as const) {
          if (control.pauseAt === `before-${stage}`) await pause.promise;
          if (hooks.stopped())
            return { status: 'blocked', reason: 'STOP_REQUESTED' };
          await hooks.checkpoint(stage);
          await control.afterCheckpoint(stage);
          if (control.pauseAt === `checkpoint-${stage}`) await pause.promise;
          if (hooks.stopped())
            return { status: 'blocked', reason: 'STOP_REQUESTED' };
          calls.push(
            stage === 'editor' ? 'enter' : stage === 'body' ? 'fill' : stage,
          );
          if (control.pauseAt === `after-${stage}`) await pause.promise;
        }
        await hooks.verifying();
        calls.push('verify-result');
        return control.outcome;
      } catch {
        return { status: 'blocked', reason: 'PAGE_CHANGED' };
      }
    },
  };
  let tasks = openDraftTaskRepository(path, migrations);
  let preparation: ReturnType<typeof createDraftPreparation>;
  function controller() {
    preparation = createDraftPreparation({
      repository: articles,
      contentCapabilities: () => platform.contentCapabilities(),
      covers: articles,
      snapshots,
      tasks,
      newId: randomUUID,
    });
    return createDraftController({
      invalidateBrowserHealth: () => {
        control.healthInvalidations++;
      },
      tasks,
      preparation,
      snapshots,
      platform,
      newId: randomUUID,
      now: () => control.now,
      gate: () => control.gate,
      controlledPilot: control.controlledPilot,
    });
  }
  let api = controller();
  const opened = await api.openDraftSession();
  const prepared = await api.prepareDraft(
    articleKey,
    opened.view.session.bindingToken!,
  );
  if (prepared.status !== 'ready')
    throw new Error('Fixture preparation failed');
  return {
    api,
    preparationId: prepared.preparation.preparationId,
    articleKey,
    articles,
    path,
    calls,
    control,
    platform,
    snapshots,
    setSingleCover: async (key: string) => {
      const config = articles.loadCover(key)!;
      const intent = {
        operationId: randomUUID(),
        sessionId: randomUUID(),
        articleKey: key,
        expectedArticleRevision:
          articles.loadEditableArticle(key)!.articleRevision,
        expectedCoverRevision: config.coverRevision,
        draftRevision: 0,
        mode: 'single' as const,
        payloadDigest: 'a'.repeat(64),
        startedAt: control.now,
      };
      if (articles.beginCoverSave(intent).status !== 'not_started')
        throw Error('Fixture cover reservation failed');
      const files = await coverAssets.prepareCoverFiles(
        intent,
        [
          {
            bytes: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
              'base64',
            ),
          },
        ],
        new AbortController().signal,
      );
      if (articles.commitCoverVersion(intent, files).status !== 'committed')
        throw Error('Fixture cover commit failed');
      return articles.loadCover(key)!;
    },
    get preparation() {
      return preparation;
    },
    get tasks() {
      return tasks;
    },
    releaseExecute: pause.release,
    addArticle: async (title = 'Another article', imageCount = 0) => {
      const value = await importer.importArticle({
        schema_version: 1,
        article_id: randomUUID(),
        title,
        body: [
          { type: 'paragraph', text: 'Other body' },
          ...Array.from({ length: imageCount }, (_, index) => [
            { type: 'image' as const, image_id: 'image' },
            { type: 'paragraph' as const, text: `After image ${index + 1}` },
          ]).flat(),
        ],
        images: imageCount
          ? [
              {
                image_id: 'image',
                source: { type: 'local', path: 'image.png' },
              },
            ]
          : [],
      });
      if (value.status !== 'imported') throw new Error('Fixture import failed');
      return value.article.articleKey;
    },
    restart: async () => {
      tasks.close();
      tasks = openDraftTaskRepository(path, migrations);
      api = controller();
      return api;
    },
    close: async () => {
      pause.release();
      await api.stopAndWait();
      tasks.close();
      articles.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type DraftHarness = Awaited<ReturnType<typeof createDraftHarness>>;
