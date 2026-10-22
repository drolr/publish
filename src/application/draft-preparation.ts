import type {
  AttemptIntent,
  DraftSnapshot,
  DraftTask,
  PrepareResult,
  ReasonCode,
  SessionProbe,
  SessionView,
  StoreBinding,
  TaskView,
} from '../contracts/draft-task';
import { StorageIdSchema } from '../contracts/stored-article';
import type { ArticleRevisionRepository } from '../domain/ports/article-revision';
import type {
  DraftTaskRepository,
  SnapshotPort,
} from '../domain/ports/draft-task';

import {
  coverSummary,
  coverReportView,
  type CoverTaskSnapshot,
} from '../contracts/cover-task';
import type { ArticleCoverRepository } from '../domain/ports/article-cover';

const inputReasons = new Set<ReasonCode>([
  'INPUT_UNSUPPORTED',
  'TITLE_UNSUPPORTED',
  'IMAGE_FORMAT_UNSUPPORTED',
  'IMAGE_SIZE_UNSUPPORTED',
  'ASSET_UNAVAILABLE',
]);

function taskView(task: DraftTask): TaskView {
  return {
    ...(task.evidence.submission
      ? { submission: task.evidence.submission }
      : {}),
    ...(task.coverPlan
      ? {
          coverSummary: coverSummary(task.coverPlan.snapshot),
          coverReport: coverReportView(task.coverPlan.report),
        }
      : {}),
    taskId: task.taskId,
    articleKey: task.articleKey,
    title: task.snapshot.article.title,
    storeName: task.store.displayName,
    state: task.state,
    stage: task.stage,
    revision: task.revision,
    possibleRemoteEffect: task.possibleRemoteEffect,
    stopRequested: task.stopRequested,
    platformPaused:
      task.state === 'needs_human' || task.state === 'interrupted',
    reason: task.reason,
    canOpenDraft: task.state === 'draft_saved',
  };
}

function mappedReason(error: unknown): ReasonCode {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    inputReasons.has(error.code as ReasonCode)
  )
    return error.code as ReasonCode;
  return 'ASSET_UNAVAILABLE';
}

export interface DraftPreparation {
  offer(probe: SessionProbe): SessionView;
  prepare(
    articleKey: string,
    bindingToken: string,
    intent?: AttemptIntent,
  ): Promise<PrepareResult>;
  take(preparationId: string):
    | {
        snapshot: DraftSnapshot;
        store: StoreBinding;
        generation: string;
        articleRevision: number;
        coverSnapshot: CoverTaskSnapshot;
      }
    | undefined;
  invalidate(): void;
}

export function createDraftPreparation(deps: {
  repository: Pick<ArticleRevisionRepository, 'loadEditableArticle'>;
  covers: Pick<ArticleCoverRepository, 'loadCover'>;
  snapshots: SnapshotPort;
  tasks: DraftTaskRepository;
  newId: () => string;
}): DraftPreparation {
  let session:
    { token: string; store: StoreBinding; generation: string } | undefined;
  const preparations = new Map<
    string,
    {
      snapshot: DraftSnapshot;
      store: StoreBinding;
      generation: string;
      articleRevision: number;
      coverSnapshot: CoverTaskSnapshot;
    }
  >();

  function invalidate() {
    session = undefined;
    preparations.clear();
  }

  return {
    offer(probe) {
      if (probe.status === 'blocked') {
        invalidate();
        return {
          status: 'blocked',
          bindingToken: null,
          storeName: null,
          reason: probe.reason,
        };
      }
      const unchanged =
        session?.generation === probe.generation &&
        session.store.storeKey === probe.store.storeKey &&
        JSON.stringify(session.store.identity) ===
          JSON.stringify(probe.store.identity);
      if (!unchanged) {
        invalidate();
        session = {
          token: StorageIdSchema.parse(deps.newId()),
          store: structuredClone(probe.store),
          generation: probe.generation,
        };
      }
      return {
        status: 'ready',
        bindingToken: session!.token,
        storeName: session!.store.displayName,
        reason: null,
      };
    },
    async prepare(articleKey, bindingToken, intent = 'default') {
      if (intent !== 'default' && intent !== 'new_attempt')
        return { status: 'blocked', reason: 'INPUT_UNSUPPORTED' };
      const offered = session;
      if (!offered || bindingToken !== offered.token)
        return { status: 'blocked', reason: 'STALE_PREPARATION' };
      const parsedKey = StorageIdSchema.safeParse(articleKey);
      if (!parsedKey.success)
        return { status: 'blocked', reason: 'INPUT_UNSUPPORTED' };
      let editable;
      try {
        editable = deps.repository.loadEditableArticle(parsedKey.data);
      } catch {
        return { status: 'blocked', reason: 'STORAGE_UNAVAILABLE' };
      }
      if (!editable) return { status: 'blocked', reason: 'INPUT_UNSUPPORTED' };
      const { article, articleRevision } = editable;
      const existing = deps.tasks.findLatestIdentity(
        article.articleKey,
        offered.store.storeKey,
      );
      if (existing?.holdsPlatform)
        return { status: 'existing', task: taskView(existing) };
      if (/^\p{Script=Han}+$/u.test(article.title)) {
        const length = [...article.title].length;
        if (length < 5 || length > 30)
          return { status: 'blocked', reason: 'TITLE_UNSUPPORTED' };
      }
      let coverSnapshot: CoverTaskSnapshot;
      try {
        const config = deps.covers.loadCover(articleKey);
        if (!config) return { status: 'blocked', reason: 'STALE_PREPARATION' };
        coverSnapshot = deps.snapshots.captureCover(config);
      } catch {
        return { status: 'blocked', reason: 'STORAGE_UNAVAILABLE' };
      }
      let snapshot: DraftSnapshot;
      try {
        snapshot = await deps.snapshots.capture(article);
      } catch (error) {
        return { status: 'blocked', reason: mappedReason(error) };
      }
      let currentCover;
      try {
        currentCover = deps.covers.loadCover(articleKey);
      } catch {
        return { status: 'blocked', reason: 'STORAGE_UNAVAILABLE' };
      }
      if (
        !currentCover ||
        currentCover.coverRevision !== coverSnapshot.coverRevision ||
        currentCover.configurationDigest !== coverSnapshot.digest ||
        deps.repository.loadEditableArticle(articleKey)?.articleRevision !==
          articleRevision ||
        session !== offered ||
        session.generation !== offered.generation ||
        session.token !== bindingToken
      )
        return { status: 'blocked', reason: 'STALE_PREPARATION' };
      const submitted =
        existing &&
        ['draft_saved', 'submission_recorded'].includes(existing.state);
      if (submitted && intent === 'default') {
        if (existing.articleRevision == null || !existing.coverPlan)
          return { status: 'blocked', reason: 'NEW_ATTEMPT_REQUIRED' };
        if (
          existing.snapshot.digest === snapshot.digest &&
          existing.articleRevision === articleRevision &&
          existing.coverPlan.snapshot.digest === coverSnapshot.digest &&
          existing.coverPlan.snapshot.coverRevision ===
            coverSnapshot.coverRevision &&
          existing.store.storeKey === offered.store.storeKey
        )
          return { status: 'existing', task: taskView(existing) };
      }
      const preparationId = StorageIdSchema.parse(deps.newId());
      preparations.set(preparationId, {
        articleRevision,
        coverSnapshot: structuredClone(coverSnapshot),
        snapshot: structuredClone(snapshot),
        store: structuredClone(offered.store),
        generation: offered.generation,
      });
      return {
        status: 'ready',
        preparation: {
          preparationId,
          ...(submitted ? { previouslySubmitted: true } : {}),
          coverSummary: coverSummary(coverSnapshot),
          articleKey: snapshot.article.articleKey,
          title: snapshot.article.title,
          storeName: offered.store.displayName,
          bodyImageCount: snapshot.article.body.filter(
            (block) => block.type === 'image',
          ).length,
          contentDeclaration: snapshot.article.contentDeclaration,
          mode: 'draft',
          coverPolicy: 'local-upload-v1',
        },
      };
    },
    take(preparationId) {
      const value = preparations.get(preparationId);
      return value === undefined ? undefined : structuredClone(value);
    },
    invalidate,
  };
}
