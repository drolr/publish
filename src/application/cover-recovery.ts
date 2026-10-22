import { ImportFailure } from '../domain/import-error';
import type {
  ArticleCoverRepository,
  CoverAssetStore,
} from '../domain/ports/article-cover';
export function createCoverRecovery(
  repository: ArticleCoverRepository,
  assets: CoverAssetStore,
) {
  let ready = false;
  async function recoverCoverOperations(): Promise<boolean> {
    ready = false;
    let successful = true;
    try {
      for (const op of repository.listCoverOperations()) {
        try {
          if (op.committedCoverRevision !== null) {
            const config = repository.loadArchivedCoverVersion(
              op.articleKey,
              op.committedCoverRevision,
            );
            if (!config) throw Error('Missing cover version');
            try {
              await assets.verifyCoverVersion(config);
            } catch (error) {
              if (!(
                error instanceof ImportFailure &&
                error.code === 'IMAGE_UNAVAILABLE'
              ))
                throw error;
              // A trusted committed configuration with a definitely absent file is a per-cover failure.
              // Keep normal body workflows available; never redo the cover save or delete old assets.
            }
            repository.markCoverOperation(op.operationId, {
              status: 'committed',
              cleanupComplete: true,
            });
          } else if (!op.cleanupComplete) {
            await assets.cleanupOwnedUnreferenced(op);
            repository.markCoverOperation(op.operationId, {
              status: 'failed',
              cleanupComplete: true,
            });
          } else if (op.status !== 'failed') {
            throw Error('Unknown completed cover operation');
          }
        } catch {
          successful = false;
          try {
            repository.markCoverOperation(op.operationId, {
              status: 'needs_review',
            });
          } catch {
            /* Preserve previous immutable receipt and ownership evidence. */
          }
        }
      }
      ready = successful;
    } catch {
      ready = false;
    }
    return ready;
  }
  return {
    isReady: () => ready,
    recover: recoverCoverOperations,
    recoverCoverOperations,
  };
}
