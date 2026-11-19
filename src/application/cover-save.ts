import type {
  CoverImageSource,
  CoverSaveIntent,
  CoverSaveResult,
} from '../contracts/article-cover';
import { CoverSaveResultSchema } from '../contracts/article-cover';
import type {
  ArticleCoverRepository,
  CoverAssetStore,
} from '../domain/ports/article-cover';
import { ImportFailure } from '../domain/import-error';

/** Shared journal/file transaction. Each caller retains its own session/receipt checks. */
export function createCoverSaveService(
  repository: ArticleCoverRepository,
  assets: CoverAssetStore,
) {
  async function cleanup(intent: CoverSaveIntent) {
    const operation = repository.readCoverOperation(intent.operationId);
    if (!operation) throw Error('Missing intent');
    await assets.cleanupOwnedUnreferenced(operation);
    repository.markCoverOperation(intent.operationId, {
      status: 'failed',
      cleanupComplete: true,
    });
  }
  function matchesIntent(operation: CoverSaveIntent, intent: CoverSaveIntent) {
    return Object.keys(intent).every(
      (key) =>
        operation[key as keyof CoverSaveIntent] ===
        intent[key as keyof CoverSaveIntent],
    );
  }
  return {
    async save(
      intent: CoverSaveIntent,
      sources: () => Promise<readonly CoverImageSource[]>,
      signal: AbortSignal,
      beforeCommit: () => boolean,
      settle: (result: CoverSaveResult) => Promise<void> = async () => {},
    ): Promise<CoverSaveResult> {
      let begun = false;
      const result = (
        status: Exclude<CoverSaveResult['status'], 'committed'>,
      ): CoverSaveResult => ({
        status,
        operationId: intent.operationId,
      });
      try {
        const admission = repository.beginCoverSave(intent);
        // Only a fresh persisted intent authorizes file creation. Pending/unknown
        // admission remains owned by the original operation and must be queried.
        if (admission.status !== 'not_started') return admission;
        const persisted = repository.readCoverOperation(intent.operationId);
        if (
          !persisted ||
          persisted.status !== 'preparing' ||
          persisted.ownedFiles.length !== 0 ||
          persisted.cleanupComplete ||
          persisted.committedCoverRevision !== null ||
          !matchesIntent(persisted, intent)
        ) {
          throw Error('Intent mismatch');
        }
        begun = true;
        const files = await assets.prepareCoverFiles(
          intent,
          await sources(),
          signal,
        );
        signal.throwIfAborted();
        if (!beforeCommit()) {
          await cleanup(intent);
          return result('conflict');
        }
        const committed = repository.commitCoverVersion(intent, files);
        if (committed.status === 'committed') {
          await settle(committed);
        } else if (
          committed.status === 'conflict' ||
          committed.status === 'blocked'
        ) {
          await cleanup(intent);
        }
        return committed;
      } catch (error) {
        try {
          const known = repository.readCoverSaveResult(intent.operationId);
          if (known.status === 'committed') {
            await settle(known);
            return known;
          }
          if (
            begun &&
            (signal.aborted ||
              (error instanceof ImportFailure &&
                error.code === 'IMAGE_UNAVAILABLE'))
          ) {
            await cleanup(intent);
            return result('failed');
          }
        } catch {
          // Do not clean up or replay without ownership/receipt proof.
        }
        return result('needs_review');
      }
    },
    async getSaveResult(
      operationId: string,
      intent?: CoverSaveIntent,
    ): Promise<CoverSaveResult> {
      const result = CoverSaveResultSchema.parse(
        repository.readCoverSaveResult(operationId),
      );
      const returnedId =
        result.status === 'committed'
          ? result.receipt.operationId
          : result.operationId;
      if (returnedId !== operationId) throw Error('Cover operation mismatch');
      if (intent) {
        const operation = repository.readCoverOperation(operationId);
        if (
          !operation ||
          !matchesIntent(operation, intent) ||
          (result.status === 'failed' &&
            (operation.status !== 'failed' ||
              !operation.cleanupComplete ||
              operation.committedCoverRevision !== null))
        ) {
          throw Error('Cover operation proof mismatch');
        }
      }
      return result;
    },
  };
}
export type CoverSaveService = ReturnType<typeof createCoverSaveService>;
