import {
  canonicalDraftArticle,
  createDraftSnapshotDigest,
} from '../../src/infrastructure/draft-snapshot-integrity';
import {
  upgradeEditorBody,
  richBodyEquals,
} from '../../src/domain/rich-text-body';
import { JudongcheCoverRequiredError } from '../../src/infrastructure/platforms/judongche/production-state';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { createDraftHarness } from '../fixtures/draft-harness';
import { coverDraftHarness, coverSession } from '../fixtures/cover-draft';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { createCoverAssetStore } from '../../src/infrastructure/assets/cover-asset-store';
import { createDraftSnapshotPort } from '../../src/infrastructure/assets/draft-snapshot';
import { createDraftPreparation } from '../../src/application/draft-preparation';
import {
  createDraftController,
  type DraftController,
} from '../../src/application/draft-controller';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(
  fault:
    | 'complete'
    | 'mismatch'
    | 'missing'
    | 'recoverable'
    | 'ambiguous'
    | 'reopen'
    | 'no-save'
    | 'unproved-rejection'
    | 'library-reopen'
    | 'upload-reopen'
    | 'confirmed-gap' = 'complete',
) {
  const h = await createDraftHarness(1);
  cleanups.push(h.close);
  const assets = createCoverAssetStore(dirname(h.path), h.articles);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
    'base64',
  );
  const intent = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    articleKey: h.articleKey,
    expectedArticleRevision: 1,
    expectedCoverRevision: 0,
    draftRevision: 0,
    mode: 'single' as const,
    payloadDigest: 'a'.repeat(64),
    startedAt: new Date().toISOString(),
  };
  expect(h.articles.beginCoverSave(intent).status).toBe('not_started');
  const files = await assets.prepareCoverFiles(
    intent,
    [{ bytes: png }],
    new AbortController().signal,
  );
  expect(h.articles.commitCoverVersion(intent, files).status).toBe('committed');
  if (fault === 'missing')
    unlinkSync(join(dirname(h.path), 'covers', files[0].relativePath));
  const snapshots = createDraftSnapshotPort(
    createAssetStore(join(dirname(h.path), 'assets')),
    { repository: h.articles, assets },
  );
  const p = coverDraftHarness();
  const generation = randomUUID();
  p.pages.probe = async () => ({
    status: 'ready',
    store: p.task.store,
    generation,
  });
  const session = {
    ...coverSession,
    generation: () => generation,
  };
  if (fault === 'recoverable')
    p.pages.uploadLocalCover = async () => ({
      status: 'recoverable_failure',
      reason: 'UPLOAD_REJECTED',
      items: [],
      safeEditorProof: {
        generation,
        contextKey: p.observed.contextKey!,
        storeKey: p.task.store.storeKey,
        editorUrl: p.observed.editorUrl!,
        modalClosed: true,
        uploadsSettled: true,
      },
    });
  if (fault === 'library-reopen' || fault === 'upload-reopen')
    p.pages.uploadLocalCover = async (input) => {
      const items = input.files.map(({ position, assetKey, sha256 }) => ({
        position,
        assetKey,
        sha256,
        resourceKey: sha256,
      }));
      p.observed.localCover = {
        known: true,
        mode: input.mode,
        items: items.map((i) => ({ ...i, loaded: true })),
        pendingUploads: false,
      };
      return {
        status: 'recoverable_failure',
        reason:
          fault === 'library-reopen'
            ? 'LIBRARY_OPTION_UNVERIFIED'
            : 'UPLOAD_REJECTED',
        items,
        safeEditorProof: {
          generation,
          contextKey: p.observed.contextKey!,
          storeKey: p.task.store.storeKey,
          editorUrl: p.observed.editorUrl!,
          modalClosed: true,
          uploadsSettled: true,
        },
      };
    };
  if (fault === 'ambiguous')
    p.pages.saveOnce = async () => {
      p.calls.push('save');
      throw Error('lost response');
    };
  if (fault === 'no-save' || fault === 'unproved-rejection')
    p.pages.saveOnce = async () => {
      p.calls.push('save');
      throw new JudongcheCoverRequiredError(
        fault === 'no-save'
          ? {
              explicitRejection: true,
              remoteRecordAbsent: true,
              noPendingSave: true,
              autosaveExcluded: true,
            }
          : undefined,
      );
    };
  const inspect = p.pages.inspectDraft;
  let first = true;
  p.pages.inspectDraft = async (remote) => {
    if (
      (fault === 'reopen' ||
        fault === 'library-reopen' ||
        fault === 'upload-reopen') &&
      first
    ) {
      first = false;
      throw Error('reopen interrupted');
    }
    const observed = (await inspect(remote))!;
    if (fault === 'mismatch')
      observed.localCover = {
        known: true,
        mode: 'single',
        items: [],
        pendingUploads: false,
      };
    return observed;
  };
  // These legacy cover/restart fixtures exercise immutable V1 history, not the closed V2 writer.
  snapshots.capture = async (editable) => {
    if (
      !richBodyEquals(
        upgradeEditorBody(editable.editorBody, editable.article.body),
        upgradeEditorBody(null, editable.article.body),
      )
    )
      throw Error('Legacy fixture must be lossless plain');
    const article = canonicalDraftArticle(editable.article);
    const snapshot = {
      version: 1 as const,
      article,
      digest: createDraftSnapshotDigest(article),
    };
    await snapshots.verify(snapshot);
    return snapshot;
  };
  const events: string[] = [];
  let interruptedAtConfirmed = false;
  let api: DraftController;
  const controller = () =>
    createDraftController({
      invalidateBrowserHealth: () => {},
      tasks: {
        ...h.tasks,
        apply: (...args) => {
          events.push(args[2].type);
          const committed = h.tasks.apply(...args);
          if (
            fault === 'confirmed-gap' &&
            !interruptedAtConfirmed &&
            args[2].type === 'cover_report' &&
            args[2].report.phase === 'confirmed'
          ) {
            interruptedAtConfirmed = true;
            throw Error(
              'Simulated exit after durable confirmed report, before body settlement',
            );
          }
          return committed;
        },
      },
      preparation: createDraftPreparation({
        contentCapabilities: () => ({
          revision: 'judongche-rich-unknown-v1',
          features: {},
        }),
        repository: h.articles,
        covers: h.articles,
        snapshots,
        tasks: h.tasks,
        newId: randomUUID,
      }),
      snapshots,
      platform: {
        ...createAdapterWithPages(session, p.pages),
        openSession: () => p.pages.probe(),
      },
      newId: randomUUID,
      now: () => new Date().toISOString(),
      gate: () => 'ready',
    });
  api = controller();
  cleanups.push(async () => {
    await api.stopAndWait();
  });
  async function start() {
    const open = await api.openDraftSession();
    const prepared = await api.prepareDraft(
      h.articleKey,
      open.view.session.bindingToken!,
    );
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') throw Error('not prepared');
    await api.startDraft(prepared.preparation.preparationId);
    await vi.waitFor(() => expect(api.isActive()).toBe(false));
    return prepared.preparation.preparationId;
  }
  async function restart() {
    await api.stopAndWait();
    await h.restart();
    api = controller();
    return api;
  }
  return {
    h,
    p,
    events,
    start,
    restart,
    get api() {
      return api;
    },
  };
}
it.each(['complete', 'mismatch', 'missing', 'recoverable'] as const)(
  'durable body/cover independent settlement and no restart replay: %s',
  async (fault) => {
    const s = await setup(fault);
    await s.start();
    expect(s.h.tasks.latest()).toMatchObject({
      state: 'draft_saved',
      reason: null,
      holdsPlatform: false,
      coverPlan: {
        report: {
          phase: fault === 'complete' ? 'confirmed' : 'failed',
          reason:
            fault === 'complete'
              ? null
              : fault === 'mismatch'
                ? 'COVER_MISMATCH'
                : fault === 'missing'
                  ? 'IMAGE_UNAVAILABLE'
                  : 'UPLOAD_REJECTED',
        },
      },
    });
    expect(s.p.calls.filter((c) => c === 'save')).toHaveLength(1);
    expect(s.events.lastIndexOf('cover_report')).toBeLessThan(
      s.events.lastIndexOf('settle'),
    );
    const id = s.h.tasks.latest()!.taskId;
    const before = s.h.tasks.latest()!.coverPlan!.report;
    const api = await s.restart();
    expect((await api.getDraftState()).task?.coverReport).toMatchObject({
      phase: before.phase,
      reason: before.reason,
    });
    expect(s.h.tasks.get(id)?.coverPlan?.report).toEqual(before);
    expect(s.p.calls.filter((c) => c === 'save')).toHaveLength(1);
  },
);
it('ambiguous save keeps durable pending association and cannot start or upload again after restart', async () => {
  const s = await setup('ambiguous');
  const preparationId = await s.start();
  expect(s.h.tasks.latest()).toMatchObject({
    state: 'needs_human',
    saveAttempted: true,
    reason: 'RESULT_AMBIGUOUS',
    coverPlan: { report: { phase: 'pending' } },
  });
  expect(s.h.tasks.latest()!.coverPlan!.report.confirmedItems).toHaveLength(1);
  const api = await s.restart();
  await api.startDraft(preparationId);
  expect((await api.reconcileDraft(s.h.tasks.latest()!.taskId)).status).toBe(
    'blocked',
  );
  expect(s.p.calls.filter((c) => c === 'save')).toHaveLength(1);
  expect(s.p.calls.filter((c) => c === 'upload-cover')).toHaveLength(1);
});
it('fresh read-only reopened proof settles persisted pending cover before terminal body after restart', async () => {
  const s = await setup('reopen');
  await s.start();
  const id = s.h.tasks.latest()!.taskId;
  expect(s.h.tasks.latest()).toMatchObject({
    state: 'needs_human',
    coverPlan: { report: { phase: 'needs_human', reason: 'PAGE_UNVERIFIED' } },
  });
  expect(s.h.tasks.latest()!.evidence.remote).not.toBeNull();
  const api = await s.restart();
  for (const method of [
    'enterNewEditor',
    'fillTitle',
    'appendParagraph',
    'appendImage',
    'chooseFirstCover',
    'saveOnce',
    'uploadLocalCover',
  ] as const)
    s.p.pages[method] = async () => {
      throw Error('reconciliation must be read-only');
    };
  expect((await api.reconcileDraft(id)).status).toBe('ok');
  expect(s.h.tasks.get(id)).toMatchObject({
    state: 'draft_saved',
    coverPlan: { report: { phase: 'confirmed' } },
  });
  expect(s.events.lastIndexOf('cover_report')).toBeLessThan(
    s.events.lastIndexOf('settle'),
  );
  expect(s.p.calls.filter((c) => c === 'save')).toHaveLength(1);
  expect(s.p.calls.filter((c) => c === 'upload-cover')).toHaveLength(1);
});

it.each(['no-save', 'unproved-rejection'] as const)(
  'cover required warning persists independently; no-save claim only with proof: %s',
  async (fault) => {
    const s = await setup(fault);
    await s.start();
    expect(s.h.tasks.latest()).toMatchObject({
      state: 'needs_human',
      reason: fault === 'no-save' ? 'COVER_REQUIRED' : 'RESULT_AMBIGUOUS',
      saveAttempted: true,
      holdsPlatform: true,
      coverPlan: { report: { phase: 'failed', reason: 'COVER_REQUIRED' } },
    });
    expect(s.h.tasks.latest()!.coverPlan!.report.confirmedItems).toHaveLength(
      1,
    );
    await s.restart();
    expect(s.h.tasks.latest()?.coverPlan?.report.reason).toBe('COVER_REQUIRED');
    expect(s.p.calls.filter((c) => c === 'save')).toHaveLength(1);
  },
);

it.each(['library-reopen', 'upload-reopen'] as const)(
  'a transient page warning never erases a definite failure or authorizes confirmation after restart: %s',
  async (fault) => {
    const s = await setup(fault);
    const reason =
      fault === 'library-reopen'
        ? 'LIBRARY_OPTION_UNVERIFIED'
        : 'UPLOAD_REJECTED';
    await s.start();
    const id = s.h.tasks.latest()!.taskId;
    expect(s.h.tasks.get(id)).toMatchObject({
      state: 'needs_human',
      coverPlan: {
        report: { phase: 'failed', reason },
      },
    });
    expect(s.h.tasks.get(id)!.coverPlan!.report.confirmedItems).toHaveLength(1);
    const api = await s.restart();
    expect((await api.reconcileDraft(id)).status).toBe('ok');
    expect(s.h.tasks.get(id)).toMatchObject({
      state: 'draft_saved',
      coverPlan: {
        report: { phase: 'failed', reason },
      },
    });
    expect(s.p.calls.filter((c) => c === 'save')).toHaveLength(1);
  },
);

it.each(['missing', 'mismatch'] as const)(
  'persisted confirmed cover interrupted before body settlement reconciles with durable warning: %s',
  async (fault) => {
    const s = await setup('confirmed-gap');
    await s.start();
    const committed = s.h.tasks.latest()!;
    const id = committed.taskId;
    expect(committed).toMatchObject({
      state: 'running',
      stage: 'verify',
      saveAttempted: true,
      coverPlan: { report: { phase: 'confirmed' } },
    });
    expect(s.events).not.toContain('settle');
    const associations = structuredClone(
      committed.coverPlan!.report.confirmedItems,
    );
    const coverDigest = committed.coverPlan!.snapshot.digest;
    const api = await s.restart();
    expect(s.h.tasks.get(id)).toMatchObject({
      state: 'interrupted',
      stage: 'verify',
      coverPlan: { report: { phase: 'confirmed' } },
    });
    const inspect = s.p.pages.inspectDraft;
    s.p.pages.inspectDraft = async (remote) => {
      const observed = (await inspect(remote))!;
      if (fault === 'missing') delete observed.localCover;
      else
        observed.localCover = {
          known: true,
          mode: 'single',
          items: [],
          pendingUploads: false,
        };
      return observed;
    };
    for (const method of [
      'enterNewEditor',
      'fillTitle',
      'appendParagraph',
      'appendImage',
      'chooseFirstCover',
      'saveOnce',
      'uploadLocalCover',
    ] as const)
      s.p.pages[method] = async () => {
        throw Error('recovered reconciliation must never upload or save');
      };
    const response = await api.reconcileDraft(id);
    expect(response.status).toBe('ok');
    const settled = s.h.tasks.get(id)!;
    expect(settled).toMatchObject({
      state: 'draft_saved',
      reason: null,
      holdsPlatform: false,
      coverPlan: {
        report: {
          phase: fault === 'missing' ? 'needs_human' : 'failed',
          reason: fault === 'missing' ? 'PAGE_UNVERIFIED' : 'COVER_MISMATCH',
        },
      },
    });
    expect(settled.coverPlan!.report.confirmedItems).toEqual(associations);
    expect(settled.coverPlan!.snapshot.digest).toBe(coverDigest);
    expect(
      Date.parse(settled.coverPlan!.report.updatedAt),
    ).toBeGreaterThanOrEqual(Date.parse(committed.coverPlan!.report.updatedAt));
    expect(api.isBlocked()).toBe(false);
    expect((await api.getDraftState()).session.reason).not.toBe(
      'STORAGE_UNAVAILABLE',
    );
    expect(s.p.calls.filter((c) => c === 'save')).toHaveLength(1);
    expect(s.p.calls.filter((c) => c === 'upload-cover')).toHaveLength(1);
    await s.restart();
    expect(s.h.tasks.get(id)!.coverPlan!.report).toEqual(
      settled.coverPlan!.report,
    );
  },
);
