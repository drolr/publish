import type { StoredArticle } from '../../contracts/stored-article';
import type {
  ReserveInput,
  ReserveResult,
  DraftTask,
  TaskEvent,
  DraftSnapshot,
  SessionProbe,
  AdapterOutcome,
  DraftEvidence,
  DraftAbsenceResult,
} from '../../contracts/draft-task';
import type {
  CoverReport,
  CoverTaskSnapshot,
} from '../../contracts/cover-task';
import type { StoredCoverConfiguration } from '../../contracts/article-cover';
export type {
  ReserveInput,
  ReserveResult,
  SessionProbe,
  AdapterOutcome,
} from '../../contracts/draft-task';
export interface DraftTaskRepository {
  reserve(input: ReserveInput): ReserveResult;
  get(taskId: string): DraftTask | undefined;
  findPreparation(preparationId: string): DraftTask | undefined;
  /** Historical information only; this never grants permission to execute. */
  findLatestIdentity(
    articleKey: string,
    storeKey: string,
  ): DraftTask | undefined;
  /** Compatibility query for legacy preparation callers; excluded closed/stopped identities. */
  findIdentity(articleKey: string, storeKey: string): DraftTask | undefined;
  latest(): DraftTask | undefined;
  occupied(): DraftTask | undefined;
  apply(
    taskId: string,
    expectedRevision: number,
    event: TaskEvent,
    now: string,
  ): DraftTask;
  recover(now: string): void;
  close(): void;
}
export interface SnapshotPort {
  capture(article: StoredArticle): Promise<DraftSnapshot>;
  captureCover(configuration: StoredCoverConfiguration): CoverTaskSnapshot;
  readCoverImage(
    snapshot: CoverTaskSnapshot,
    assetKey: string,
  ): Promise<Uint8Array>;
  verify(snapshot: DraftSnapshot): Promise<void>;
  readImage(snapshot: DraftSnapshot, assetKey: string): Promise<Uint8Array>;
}
export interface ExecutionHooks {
  batchSubmissionReview?: 'operator';
  coverReport(report: CoverReport): Promise<void>;
  readCoverImage(assetKey: string): Promise<Uint8Array>;
  checkpoint(stage: 'editor' | 'body' | 'cover' | 'save'): Promise<void>;
  verifying(): Promise<void>;
  evidence(value: DraftEvidence): Promise<void>;
  stopped(): boolean;
  readImage(assetKey: string): Promise<Uint8Array>;
}
export interface DraftPlatform {
  openSession(): Promise<SessionProbe>;
  /** Internal startup recheck may request context only; execution checks safety. */
  checkSession(contextOnly?: boolean): Promise<SessionProbe>;
  closeSession(): Promise<void>;
  execute(task: DraftTask, hooks: ExecutionHooks): Promise<AdapterOutcome>;
  reconcile(task: DraftTask): Promise<AdapterOutcome>;
  checkAbsence(task: DraftTask): Promise<DraftAbsenceResult>;
  openVerified(task: DraftTask): Promise<void>;
}
