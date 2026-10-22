import {
  RevisionSaveInputSchema,
  type RevisionSaveInput,
  type RevisionSaveResult,
  type SaveLookup,
  type RevisionOperation,
  type SaveReceipt,
} from '../contracts/article-revision';
import { StoredArticleSchema } from '../contracts/stored-article';
import { deriveEditorBody, projectEditorBody } from '../domain/article-edit';
import type { ArticleRevisionRepository } from '../domain/ports/article-revision';
import type {
  CreateEditedArticle,
  RevisionAssetStore,
} from '../domain/ports/revision-assets';
export function createArticleRevisionService(
  repository: ArticleRevisionRepository,
  assets: RevisionAssetStore,
  createArticle: CreateEditedArticle,
) {
  let ready = false;
  const active = new Map<
    string,
    { payloadDigest: string; sessionId: string; documentRevision: number }
  >();
  async function getSaveResult(operationId: string): Promise<SaveLookup> {
    try {
      const receipt = repository.readSaveReceipt(operationId);
      if (receipt) return { status: 'committed', receipt };
      const op = repository.readRevisionOperation(operationId);
      if (!op)
        return {
          status: active.has(operationId) ? 'pending' : 'not_started',
          operationId,
        };
      if (op.status === 'failed' && op.cleanupComplete)
        return { status: 'failed', operationId };
      const writer = active.get(operationId);
      return {
        status:
          op.status === 'preparing' &&
          writer?.payloadDigest === op.payloadDigest &&
          writer.sessionId === op.sessionId &&
          writer.documentRevision === op.documentRevision
            ? 'pending'
            : 'needs_review',
        operationId,
      };
    } catch {
      return { status: 'unavailable', operationId };
    }
  }
  async function settle(op: RevisionOperation): Promise<boolean> {
    try {
      await assets.cleanupOwnedUnreferenced(op);
      repository.markRevisionOperation(op.operationId, {
        status: op.committedRevision !== null ? 'committed' : 'failed',
        cleanupComplete: true,
      });
      return true;
    } catch {
      ready = false;
      try {
        repository.markRevisionOperation(op.operationId, {
          status: 'cleanup_required',
          cleanupComplete: false,
        });
      } catch {
        /* Keep original audit. */
      }
      return false;
    }
  }
  async function committed(receipt: SaveReceipt): Promise<RevisionSaveResult> {
    try {
      await assets.verify(receipt);
      const op = repository.readRevisionOperation(receipt.operationId);
      if (!op) throw Error('Missing audit');
      await settle(op);
    } catch {
      ready = false;
      try {
        repository.markRevisionOperation(receipt.operationId, {
          status: 'needs_review',
        });
      } catch {
        /* Immutable receipt is retained. */
      }
    }
    return { status: 'committed', receipt };
  }
  return {
    isReady: () => ready,
    getSaveResult,
    async recover(): Promise<boolean> {
      if (active.size) return false;
      ready = false;
      try {
        for (const op of repository.listRevisionOperations()) {
          if (op.committedRevision !== null) {
            const receipt = repository.readSaveReceipt(op.operationId);
            if (!receipt) return false;
            await assets.verify(receipt);
          }
          if (!(await settle(op))) return false;
        }
        ready = true;
        return true;
      } catch {
        return false;
      }
    },
    async saveRevision(
      raw: RevisionSaveInput,
      signal: AbortSignal,
    ): Promise<RevisionSaveResult> {
      const operationId =
        raw.kind === 'created'
          ? raw.command.operationId
          : raw.intent.operationId;
      const checked = RevisionSaveInputSchema.safeParse(raw);
      if (!checked.success) return { status: 'failed', operationId };
      const input = checked.data;
      const command = input.kind === 'created' ? input.command : input.intent;
      let ownsWriter = false;
      try {
        const op = repository.readRevisionOperation(operationId);
        if (
          op &&
          (op.payloadDigest !== command.payloadDigest ||
            op.sessionId !== command.sessionId ||
            op.documentRevision !== command.documentRevision)
        )
          return { status: 'needs_review', operationId };
        const previous = repository.readSaveReceipt(operationId);
        if (previous) return { status: 'committed', receipt: previous };
        const writer = active.get(operationId);
        if (writer) {
          if (
            writer.payloadDigest !== command.payloadDigest ||
            writer.sessionId !== command.sessionId ||
            writer.documentRevision !== command.documentRevision
          )
            return { status: 'needs_review', operationId };
          return getSaveResult(operationId);
        }
        if (!ready || active.size)
          return { status: 'unavailable', operationId };
        if (
          input.kind === 'updated' &&
          input.compatibilityLease &&
          !repository.isEditorCompatibilityLease(
            input.compatibilityLease,
            input.intent.articleKey,
            input.intent.sessionId,
            input.intent.baseRevision,
          )
        )
          return { status: 'needs_review', operationId };
        if (op && !(op.status === 'failed' && op.cleanupComplete))
          return { status: 'needs_review', operationId };
        signal.throwIfAborted();
        active.set(operationId, command);
        ownsWriter = true;
        if (input.kind === 'updated') {
          const current = repository.loadEditableArticle(
            input.identity.articleKey,
          );
          if (
            !current ||
            current.articleRevision !== input.intent.baseRevision ||
            input.intent.articleKey !== input.identity.articleKey ||
            input.intent.externalId !== input.identity.externalId ||
            ['articleKey', 'externalId', 'importId', 'createdAt'].some(
              (k) =>
                current.article[k as keyof typeof input.identity] !==
                input.identity[k as keyof typeof input.identity],
            )
          )
            return { status: 'needs_review', operationId };
          const sameContent =
            current.article.title === input.title &&
            current.article.contentDeclaration === input.contentDeclaration &&
            JSON.stringify(
              current.editorBody ?? deriveEditorBody(current.article.body),
            ) === JSON.stringify(input.editorBody);
          if (sameContent && input.images.every((i) => i.kind === 'stored')) {
            const prepared = await assets.prepare(
              input.intent,
              input.images,
              signal,
            );
            const verifiedCurrent = repository.loadEditableArticle(
              input.identity.articleKey,
            );
            if (
              !verifiedCurrent ||
              verifiedCurrent.articleRevision !== input.intent.baseRevision
            )
              return { status: 'needs_review', operationId };
            const sorted = (values: typeof prepared.assets) =>
              JSON.stringify(
                [...values].sort((a, b) =>
                  a.assetKey.localeCompare(b.assetKey),
                ),
              );
            if (
              verifiedCurrent.article.title === input.title &&
              verifiedCurrent.article.contentDeclaration ===
                input.contentDeclaration &&
              JSON.stringify(
                verifiedCurrent.editorBody ??
                  deriveEditorBody(verifiedCurrent.article.body),
              ) === JSON.stringify(input.editorBody) &&
              sorted(prepared.assets) === sorted(verifiedCurrent.article.assets)
            )
              return {
                status: 'unchanged',
                articleKey: verifiedCurrent.article.articleKey,
                articleRevision: verifiedCurrent.articleRevision,
              };
          }
        }
        if (input.kind === 'created') {
          const result = await createArticle(input, signal);
          if (result.status === 'committed') return committed(result.receipt);
          if (
            result.status === 'needs_review' ||
            result.status === 'unavailable'
          )
            ready = false;
          return result;
        }
        const begun = repository.beginRevision(input.intent);
        if (begun.status !== 'not_started') return begun;
        try {
          const prepared = await assets.prepare(
            input.intent,
            input.images,
            signal,
          );
          const nextArticle = StoredArticleSchema.parse({
            ...input.identity,
            title: input.title,
            body: projectEditorBody(input.editorBody),
            contentDeclaration: input.contentDeclaration,
            assets: prepared.assets,
          });
          await assets.finalizeNewFiles(input.intent, signal);
          signal.throwIfAborted();
          const receipt: SaveReceipt = {
            ...command,
            articleKey: input.identity.articleKey,
            externalId: input.identity.externalId,
            kind: 'updated',
            articleRevision: input.intent.baseRevision + 1,
            committedAt: new Date().toISOString(),
          };
          // The intent's startedAt/baseRevision are audit fields, not public receipt fields.
          const publicReceipt: SaveReceipt = {
            operationId: receipt.operationId,
            sessionId: receipt.sessionId,
            documentRevision: receipt.documentRevision,
            payloadDigest: receipt.payloadDigest,
            articleKey: receipt.articleKey,
            externalId: receipt.externalId,
            kind: receipt.kind,
            articleRevision: receipt.articleRevision,
            committedAt: receipt.committedAt,
          };
          const result = repository.commitRevision(
            input.intent.baseRevision,
            {
              intent: input.intent,
              nextArticle,
              editorBody: input.editorBody,
              ...(input.compatibilityLease
                ? { compatibilityLease: input.compatibilityLease }
                : {}),
            },
            publicReceipt,
          );
          if (
            result.status === 'committed' ||
            result.status === 'already_committed'
          )
            return committed(result.receipt);
          if (result.status === 'unavailable') throw Error('Unknown commit');
          const op = repository.readRevisionOperation(operationId);
          if (!op || !(await settle(op)))
            return { status: 'needs_review', operationId };
          return {
            status: result.status === 'conflict' ? 'needs_review' : 'failed',
            operationId,
          };
        } catch {
          const saved = repository.readSaveReceipt(operationId);
          if (saved) return committed(saved);
          const op = repository.readRevisionOperation(operationId);
          if (!op || !(await settle(op)))
            return { status: 'needs_review', operationId };
          return { status: 'failed', operationId };
        }
      } catch {
        ready = false;
        return { status: 'unavailable', operationId };
      } finally {
        if (ownsWriter) active.delete(operationId);
      }
    },
  };
}
