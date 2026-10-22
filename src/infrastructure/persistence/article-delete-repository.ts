import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ArticleDeletionTimeSchema,
  DeleteArticleCommandSchema,
  DeleteArticleResultSchema,
  type DeleteArticleResult,
} from '../../contracts/article-delete';
import { StorageIdSchema } from '../../contracts/stored-article';
import { IdentifierSchema } from '../../contracts/article-package';
import { ArticleRevisionSchema } from '../../contracts/manual-edit';
import { MembershipRevisionSchema } from '../../contracts/article-library';
import type { ArticleDeletionRepository } from '../../domain/ports/article-delete';
import { ImportFailure } from '../../domain/import-error';
import { loadStoredArticle } from './stored-article-reader';
interface ReceiptRow {
  operation_id: string;
  article_key: string;
  expected_revision: number;
  payload_digest: string;
  outcome: 'deleted' | 'conflict' | 'blocked' | 'not_found';
  committed_revision: number | null;
}
function result(row: ReceiptRow): DeleteArticleResult {
  return DeleteArticleResultSchema.parse(
    row.outcome === 'deleted'
      ? {
          status: 'deleted',
          operationId: row.operation_id,
          articleKey: row.article_key,
          articleRevision: row.committed_revision,
        }
      : { status: row.outcome, operationId: row.operation_id },
  );
}
export function deletionRepository(
  db: Database.Database,
): ArticleDeletionRepository {
  const read = (operationId: string) =>
    db
      .prepare('SELECT * FROM article_delete_operations WHERE operation_id = ?')
      .get(operationId) as ReceiptRow | undefined;
  return {
    deleteArticle(raw, now) {
      const operationId = raw.operationId;
      try {
        const command = DeleteArticleCommandSchema.parse(raw);
        ArticleDeletionTimeSchema.parse(now);
        const digest = createHash('sha256')
          .update(
            JSON.stringify([
              command.articleKey,
              command.expectedArticleRevision,
            ]),
          )
          .digest('hex');
        return db
          .transaction((): DeleteArticleResult => {
            const prior = read(command.operationId);
            if (prior)
              return prior.payload_digest === digest &&
                prior.article_key === command.articleKey &&
                prior.expected_revision === command.expectedArticleRevision
                ? result(prior)
                : { status: 'blocked', operationId };
            const current = db
              .prepare(
                'SELECT deleted_at, content_revision FROM articles WHERE article_key = ?',
              )
              .get(command.articleKey) as
              | { deleted_at: string | null; content_revision: number }
              | undefined;
            // No article means no foreign-key target: do not invent a durable success receipt.
            if (!current) return { status: 'not_found', operationId };
            const revision = ArticleRevisionSchema.parse(
              current.content_revision,
            );
            const membership = MembershipRevisionSchema.parse(
              (
                db
                  .prepare(
                    'SELECT membership_revision FROM article_library_meta WHERE singleton = 1',
                  )
                  .get() as { membership_revision: number }
              ).membership_revision,
            );
            let outcome: ReceiptRow['outcome'];
            if (
              current.deleted_at !== null ||
              revision !== command.expectedArticleRevision
            )
              outcome = 'conflict';
            else if (
              revision === Number.MAX_SAFE_INTEGER ||
              membership === Number.MAX_SAFE_INTEGER ||
              db
                .prepare(
                  'SELECT task_id FROM judongche_draft_tasks WHERE holds_platform = 1 LIMIT 1',
                )
                .get()
            )
              outcome = 'blocked';
            else {
              const changed = db
                .prepare(
                  'UPDATE articles SET deleted_at = ?, content_revision = content_revision + 1 WHERE article_key = ? AND deleted_at IS NULL AND content_revision = ?',
                )
                .run(now, command.articleKey, command.expectedArticleRevision);
              const memberChanged = db
                .prepare(
                  'UPDATE article_library_meta SET membership_revision = membership_revision + 1 WHERE singleton = 1 AND membership_revision = ?',
                )
                .run(membership);
              if (changed.changes !== 1 || memberChanged.changes !== 1)
                throw new Error('Deletion transaction conflict');
              outcome = 'deleted';
            }
            const committed = outcome === 'deleted' ? revision + 1 : null;
            db.prepare(
              'INSERT INTO article_delete_operations (operation_id,article_key,expected_revision,payload_digest,outcome,committed_revision,completed_at) VALUES (?,?,?,?,?,?,?)',
            ).run(
              operationId,
              command.articleKey,
              command.expectedArticleRevision,
              digest,
              outcome,
              committed,
              now,
            );
            return result({
              operation_id: operationId,
              article_key: command.articleKey,
              expected_revision: command.expectedArticleRevision,
              payload_digest: digest,
              outcome,
              committed_revision: committed,
            });
          })
          .immediate();
      } catch {
        return { status: 'unavailable', operationId };
      }
    },
    readDeletionResult(operationId) {
      try {
        const prior = read(StorageIdSchema.parse(operationId));
        return prior ? result(prior) : { status: 'not_started', operationId };
      } catch {
        return { status: 'unavailable', operationId };
      }
    },
    isArticleDeleted(articleKey) {
      try {
        const row = db
          .prepare('SELECT deleted_at FROM articles WHERE article_key = ?')
          .get(StorageIdSchema.parse(articleKey)) as
          { deleted_at: string | null } | undefined;
        return row !== undefined && row.deleted_at !== null;
      } catch {
        throw new ImportFailure('STORAGE_UNAVAILABLE');
      }
    },
    findExternalState(externalId) {
      try {
        return db.transaction(() => {
          const article = loadStoredArticle(
            db,
            'external_id',
            IdentifierSchema.parse(externalId),
          );
          if (!article) return undefined;
          const row = db
            .prepare('SELECT deleted_at FROM articles WHERE article_key = ?')
            .get(article.articleKey) as { deleted_at: string | null };
          return {
            kind:
              row.deleted_at === null
                ? ('active' as const)
                : ('deleted' as const),
            article,
          };
        })();
      } catch {
        throw new ImportFailure('STORAGE_UNAVAILABLE');
      }
    },
  };
}
