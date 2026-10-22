import type { BatchSeed, BatchView } from '../../contracts/draft-batch';
import type { DraftTask, ReasonCode } from '../../contracts/draft-task';
export interface DraftBatchRepository {
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
