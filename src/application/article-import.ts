import { validateArticlePackage } from '../contracts/article-package';
import type {
  ArticleIssue,
  ArticleWarning,
} from '../contracts/article-package-errors';
import { StoredArticleSchema } from '../contracts/stored-article';
import {
  RevisionSaveInputSchema,
  type RevisionSaveInput,
  type RevisionSaveResult,
  type RevisionIntent,
  type SaveReceipt,
} from '../contracts/article-revision';
import type { ArticleRevisionRepository } from '../domain/ports/article-revision';
import { projectEditorBody } from '../domain/article-edit';
import type { ManualImageSource } from '../domain/ports/manual-images';
import { WebPasteFailure } from '../domain/web-paste-error';
import {
  ImportFailure,
  importMessages,
  type ImportErrorCode,
} from '../domain/import-error';
import type {
  ArticleRepository,
  AssetStore,
  ImageReader,
  ImportAttempt,
  ImageSourceCapability,
  StoredArticle,
} from '../domain/ports/article-import';

export type ImportResult =
  | { status: 'imported'; article: StoredArticle; warnings: ArticleWarning[] }
  | { status: 'already_exists' | 'already_deleted'; article: StoredArticle }
  | { status: 'invalid'; issues: ArticleIssue[] }
  | { status: 'cancelled' }
  | {
      status: 'failed';
      code: ImportErrorCode;
      message: string;
      imageIndex?: number;
    };
export function createArticleImportService(
  repository: ArticleRepository,
  assets: AssetStore,
  reader: ImageReader,
  revisionImages?: Pick<ManualImageSource, 'capability'>,
) {
  let ready = false;
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation);
    tail = next.catch(() => undefined);
    return next;
  }
  function failed(code: ImportErrorCode, imageIndex?: number): ImportResult {
    return {
      status: 'failed',
      code,
      message: importMessages[code],
      ...(imageIndex === undefined ? {} : { imageIndex }),
    };
  }
  function retain(
    attempt: ImportAttempt,
    status: 'cleanup_required' | 'needs_review',
  ) {
    ready = false;
    try {
      repository.markAttempt(attempt.importId, status);
    } catch {
      /* Durable original attempt remains. */
    }
  }
  async function clean(attempt: ImportAttempt): Promise<boolean> {
    try {
      if (
        repository.findImport(attempt.importId) ||
        repository.load(attempt.articleKey)
      ) {
        retain(attempt, 'needs_review');
        return false;
      }
      await assets.cleanup(attempt);
      repository.forgetAttempt(attempt.importId);
      return true;
    } catch {
      retain(attempt, 'cleanup_required');
      return false;
    }
  }
  return {
    importEditedArticle: (
      raw: Extract<RevisionSaveInput, { kind: 'created' }>,
      signal: AbortSignal,
    ): Promise<RevisionSaveResult> =>
      serial(async () => {
        const operationId = raw.command.operationId;
        const revisionRepository = repository as ArticleRepository &
          Partial<ArticleRevisionRepository>;
        const checked = RevisionSaveInputSchema.safeParse(raw);
        if (!checked.success || checked.data.kind !== 'created')
          return { status: 'failed', operationId };
        const input = checked.data;
        if (
          !ready ||
          !revisionRepository.beginRevision ||
          !revisionRepository.readSaveReceipt ||
          !revisionRepository.readRevisionOperation ||
          !revisionRepository.markRevisionOperation
        )
          return { status: 'unavailable', operationId };
        const command = input.command;
        let attempt: ImportAttempt | undefined;
        let intent: RevisionIntent | undefined;
        try {
          const existingReceipt =
            revisionRepository.readSaveReceipt(operationId);
          if (existingReceipt)
            return existingReceipt.payloadDigest === command.payloadDigest &&
              existingReceipt.sessionId === command.sessionId &&
              existingReceipt.documentRevision === command.documentRevision
              ? { status: 'committed', receipt: existingReceipt }
              : { status: 'needs_review', operationId };
          const previous =
            revisionRepository.readRevisionOperation(operationId);
          if (
            previous &&
            (previous.kind !== 'created' ||
              previous.externalId !== input.externalId ||
              previous.sessionId !== command.sessionId ||
              previous.documentRevision !== command.documentRevision ||
              previous.payloadDigest !== command.payloadDigest ||
              previous.status !== 'failed' ||
              !previous.cleanupComplete ||
              previous.committedRevision !== null)
          )
            return { status: 'needs_review', operationId };
          if (
            repository.findExternal(input.externalId) ||
            repository.attempts().length
          )
            return { status: 'needs_review', operationId };
          if (
            input.images.some(
              (i) =>
                i.kind !== 'temporary' || i.sessionId !== command.sessionId,
            )
          )
            return { status: 'failed', operationId };
          const body = projectEditorBody(input.editorBody);
          const articleCheck = validateArticlePackage({
            schema_version: 1,
            article_id: input.externalId,
            title: input.title,
            body,
            content_declaration: input.contentDeclaration,
            images: input.images.map((i) => ({
              image_id: i.imageId,
              source: { type: 'local', path: 'authorized.image' },
            })),
          });
          if (!articleCheck.ok) return { status: 'failed', operationId };
          signal.throwIfAborted();
          // This is the sole reservation for a first save, shared with ordinary import identity.
          attempt = repository.reserve(
            input.externalId,
            previous ? { revisionOperationId: operationId } : undefined,
          );
          intent = previous
            ? {
                operationId: previous.operationId,
                sessionId: previous.sessionId,
                articleKey: previous.articleKey,
                externalId: previous.externalId,
                kind: previous.kind,
                documentRevision: previous.documentRevision,
                baseRevision: previous.baseRevision,
                payloadDigest: previous.payloadDigest,
                startedAt: previous.startedAt,
              }
            : {
                ...command,
                articleKey: attempt.articleKey,
                externalId: attempt.externalId,
                kind: 'created',
                baseRevision: 0,
                startedAt: attempt.startedAt,
              };
          const begun = revisionRepository.beginRevision(intent);
          if (begun.status !== 'not_started') {
            if (!(await clean(attempt)))
              return { status: 'needs_review', operationId };
            return begun;
          }
          await assets.prepare(attempt, signal);
          const article: StoredArticle = {
            articleKey: attempt.articleKey,
            importId: attempt.importId,
            externalId: attempt.externalId,
            title: input.title,
            body,
            contentDeclaration: input.contentDeclaration,
            createdAt: attempt.startedAt,
            assets: [],
          };
          let total = 0;
          for (const image of input.images) {
            if (image.kind !== 'temporary')
              throw new ImportFailure('SOURCE_NOT_ALLOWED');
            const bytes = await reader.read(
              { type: 'local', path: `${image.imageToken}.image` },
              revisionImages?.capability(command.sessionId),
              signal,
            );
            total += bytes.byteLength;
            if (
              total > 200 * 1024 * 1024 ||
              bytes.byteLength > 20 * 1024 * 1024
            )
              throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
            article.assets.push(
              await assets.put(attempt, image.imageId, bytes, signal),
            );
          }
          const normalized = StoredArticleSchema.parse(article);
          await assets.finalize(attempt, signal);
          signal.throwIfAborted();
          const receipt: SaveReceipt = {
            ...command,
            articleKey: attempt.articleKey,
            externalId: attempt.externalId,
            kind: 'created',
            articleRevision: 1,
            committedAt: new Date().toISOString(),
          };
          repository.commit(attempt, normalized, {
            receipt,
            editorBody: input.editorBody,
          });
          return { status: 'committed', receipt };
        } catch {
          try {
            const saved = revisionRepository.readSaveReceipt(operationId);
            if (saved) return { status: 'committed', receipt: saved };
            if (attempt && !(await clean(attempt)))
              return { status: 'needs_review', operationId };
            if (intent)
              revisionRepository.markRevisionOperation(operationId, {
                status: 'failed',
                cleanupComplete: true,
              });
            return { status: 'failed', operationId };
          } catch {
            ready = false;
            return { status: 'unavailable', operationId };
          }
        }
      }),
    recover: () =>
      serial(async () => {
        ready = false;
        try {
          for (const attempt of repository.attempts()) {
            if (!(await clean(attempt))) return false;
          }
          ready = true;
          return true;
        } catch {
          return false;
        }
      }),
    importArticle: (
      input: unknown,
      options: {
        capability?: ImageSourceCapability;
        signal?: AbortSignal;
      } = {},
    ): Promise<ImportResult> =>
      serial(async () => {
        if (!ready) return failed('RECOVERY_REQUIRED');
        if (options.signal?.aborted) return { status: 'cancelled' };
        const checked = validateArticlePackage(input);
        if (!checked.ok) return { status: 'invalid', issues: checked.issues };
        const { article, warnings } = checked;
        let attempt: ImportAttempt;
        try {
          const existing = repository.findExternalState(article.article_id);
          if (existing)
            return {
              status:
                existing.kind === 'deleted'
                  ? 'already_deleted'
                  : 'already_exists',
              article: existing.article,
            };
          if (repository.attempts().length) {
            ready = false;
            return failed('RECOVERY_REQUIRED');
          }
          attempt = repository.reserve(article.article_id);
        } catch {
          ready = false;
          return failed('RECOVERY_REQUIRED');
        }
        const deadline = AbortSignal.timeout(10 * 60 * 1000);
        const signal = options.signal
          ? AbortSignal.any([options.signal, deadline])
          : deadline;
        let imageIndex: number | undefined;
        let committed: StoredArticle | undefined;
        try {
          signal.throwIfAborted();
          await assets.prepare(attempt, signal);
          const stored: StoredArticle = {
            articleKey: attempt.articleKey,
            importId: attempt.importId,
            externalId: article.article_id,
            title: article.title,
            body: article.body,
            contentDeclaration: article.content_declaration,
            createdAt: attempt.startedAt,
            assets: [],
          };
          let total = 0;
          for (const [index, image] of article.images.entries()) {
            imageIndex = index;
            signal.throwIfAborted();
            const bytes = await reader.read(
              image.source,
              options.capability,
              signal,
            );
            total += bytes.byteLength;
            if (
              bytes.byteLength > 20 * 1024 * 1024 ||
              total > 200 * 1024 * 1024
            )
              throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
            stored.assets.push(
              await assets.put(attempt, image.image_id, bytes, signal),
            );
          }
          imageIndex = undefined;
          const normalized = StoredArticleSchema.parse(stored);
          await assets.finalize(attempt, signal);
          signal.throwIfAborted();
          try {
            repository.commit(attempt, normalized);
            committed = normalized;
          } catch {
            try {
              const found = repository.findImport(attempt.importId);
              if (
                found &&
                found.articleKey === attempt.articleKey &&
                found.externalId === attempt.externalId
              )
                committed = found;
              else if (found || repository.load(attempt.articleKey)) {
                retain(attempt, 'needs_review');
                return failed('RECOVERY_REQUIRED');
              }
            } catch {
              retain(attempt, 'needs_review');
              return failed('RECOVERY_REQUIRED');
            }
            if (!committed) throw new ImportFailure('STORAGE_UNAVAILABLE');
          }
          return { status: 'imported', article: committed, warnings };
        } catch (error) {
          if (!(await clean(attempt))) return failed('RECOVERY_REQUIRED');
          // Temporary byte ownership uncertainty survives successful formal
          // staging cleanup and must dominate a simultaneous stop request.
          if (
            (error instanceof WebPasteFailure ||
              error instanceof ImportFailure) &&
            error.code === 'RECOVERY_REQUIRED'
          ) {
            ready = false;
            return failed('RECOVERY_REQUIRED', imageIndex);
          }
          if (options.signal?.aborted) return { status: 'cancelled' };
          return failed(
            error instanceof ImportFailure
              ? error.code
              : imageIndex === undefined
                ? 'STORAGE_UNAVAILABLE'
                : 'IMAGE_UNAVAILABLE',
            imageIndex,
          );
        }
      }),
    load: (articleKey: string) =>
      serial(async () => {
        if (!ready) throw new ImportFailure('RECOVERY_REQUIRED');
        try {
          const article = repository.load(articleKey);
          if (article) await assets.verify(article);
          return article;
        } catch {
          throw new ImportFailure('STORAGE_UNAVAILABLE');
        }
      }),
  };
}
