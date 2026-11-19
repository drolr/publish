import type {
  BatchRecoveryInput,
  BatchSeed,
  BatchView,
} from '../../contracts/draft-batch';
import type {
  DraftTask,
  ReasonCode,
  ReserveInput,
} from '../../contracts/draft-task';
export interface DraftBatchRepository {
  recovery(input: BatchRecoveryInput): {
    store: ReserveInput['store'];
    queued: ReserveInput[];
  };
  skipCurrentAndContinue(input: BatchRecoveryInput, now: string): BatchView;
  create(seed: BatchSeed): BatchView;
  getCurrent(): BatchView | null;
  archiveFinished(id: string, revision: number, now: string): void;
  get(id: string): BatchView | null;
  findRequest(requestId: string, preparationId: string): BatchView | null;
  reserveNext(id: string, revision: number, now: string): DraftTask | null;
  settleItem(id: string, taskId: string, now: string): BatchView;
  requestStop(id: string, revision: number, now: string): BatchView;
  finish(id: string, revision: number, now: string): BatchView;
  pause(id: string, reason: ReasonCode, now: string): BatchView;
  recover(now: string): void;
  close(): void;
}
