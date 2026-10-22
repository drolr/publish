import type { ArticleCoverRepository } from '../../domain/ports/article-cover';
import { coverRepository } from './article-cover-repository';
import type { ArticleDeletionRepository } from '../../domain/ports/article-delete';
import { deletionRepository } from './article-delete-repository';
import { SaveReceiptSchema } from '../../contracts/article-revision';
import { PersistedEditorBodyV1Schema } from '../../contracts/manual-edit';
import type { ArticleRevisionRepository } from '../../domain/ports/article-revision';
import { editorProjectionMatches } from '../../domain/article-edit';
import {
  revisionRepository,
  revisionDigest,
  commitReceipt,
  receiptMatches,
} from './article-revision-repository';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  DeclarationKeysSchema,
  DeclarationChangeSchema,
  DeclarationItemSchema,
  type DeclarationItem,
  type DeclarationReadResult,
  type DeclarationWriteResult,
} from '../../contracts/article-declaration';
import {
  ArticleCursorSchema,
  ArticlePageSchema,
  ArticleSummarySchema,
  MembershipRevisionSchema,
} from '../../contracts/article-library';
import {
  ImportAttemptSchema,
  StoredArticleSchema,
} from '../../contracts/stored-article';
import { ImportFailure } from '../../domain/import-error';
import type {
  ArticleRepository,
  ImportAttempt,
} from '../../domain/ports/article-import';
import { migrate, readMigrations } from './migrate';
import { loadStoredArticle } from './stored-article-reader';

function safely<T>(action: () => T): T {
  try {
    return action();
  } catch {
    throw new ImportFailure('STORAGE_UNAVAILABLE');
  }
}

export function openArticleRepository(
  databasePath: string,
  migrationsDirectory: string,
): ArticleRepository &
  ArticleRevisionRepository &
  ArticleDeletionRepository &
  ArticleCoverRepository {
  return safely(() => {
    const db = new Database(databasePath);
    try {
      db.pragma('foreign_keys = ON');
      db.pragma('synchronous = FULL');
      db.pragma('busy_timeout = 1000');
      migrate(db, readMigrations(migrationsDirectory));
    } catch (error) {
      db.close();
      throw error;
    }

    function attemptRows(): ImportAttempt[] {
      return db
        .prepare(
          'SELECT import_id AS importId, article_key AS articleKey, external_id AS externalId, started_at AS startedAt, status FROM article_import_attempts ORDER BY started_at, import_id',
        )
        .all()
        .map((row) => ImportAttemptSchema.parse(row));
    }
    function readDeclarations(keys: string[]): DeclarationReadResult {
      // One statement gives a consistent snapshot without loading body or assets.
      const rows = db
        .prepare(
          `SELECT article_key AS articleKey, title, external_id AS externalId, content_declaration AS contentDeclaration FROM articles WHERE deleted_at IS NULL AND article_key IN (${keys.map(() => '?').join(',')})`,
        )
        .all(...keys)
        .map((row) => DeclarationItemSchema.parse(row));
      const byKey = new Map(rows.map((row) => [row.articleKey, row]));
      const missing = keys.filter((key) => !byKey.has(key));
      if (missing.length) return { status: 'not_found', articleKeys: missing };
      return {
        status: 'ok',
        items: keys.map((key) => byKey.get(key)!),
      };
    }
    const revisions = revisionRepository(db);
    return {
      ...revisions,
      ...coverRepository(db),
      ...deletionRepository(db),
      getArticleDeclarations(articleKeys) {
        try {
          return readDeclarations(DeclarationKeysSchema.parse(articleKeys));
        } catch {
          return {
            status: 'unavailable',
          };
        }
      },
      setArticleDeclarations(input) {
        try {
          const change = DeclarationChangeSchema.parse(input);
          return db
            .transaction((): DeclarationWriteResult => {
              const found = readDeclarations(
                change.targets.map((target) => target.articleKey),
              );
              if (found.status !== 'ok') return found;
              const expected = new Map(
                change.targets.map((target) => [
                  target.articleKey,
                  target.expectedDeclaration,
                ]),
              );
              const conflicts = found.items
                .filter(
                  (item) =>
                    item.contentDeclaration !== expected.get(item.articleKey),
                )
                .map((item) => item.articleKey);
              if (conflicts.length)
                return {
                  status: 'conflict',
                  articleKeys: conflicts,
                };
              const update = db.prepare(
                'UPDATE articles SET content_declaration = ?, content_revision = content_revision + 1 WHERE article_key = ? AND deleted_at IS NULL AND content_revision < 9007199254740991',
              );
              let changedCount = 0;
              const items: DeclarationItem[] = found.items.map((item) => {
                if (item.contentDeclaration === change.declaration) return item;
                if (
                  update.run(change.declaration, item.articleKey).changes !== 1
                )
                  throw new ImportFailure('STORAGE_UNAVAILABLE');
                changedCount++;
                return {
                  ...item,
                  contentDeclaration: change.declaration,
                };
              });
              return {
                status: 'updated',
                items,
                changedCount,
                unchangedCount: items.length - changedCount,
              };
            })
            .immediate();
        } catch {
          return {
            status: 'unavailable',
          };
        }
      },
      list(cursor) {
        return safely(() =>
          db.transaction(() => {
            const after =
              cursor === undefined
                ? undefined
                : ArticleCursorSchema.parse(cursor);
            // The first SELECT pins the same read snapshot for version, count and rows.
            const meta = db
              .prepare(
                'SELECT membership_revision AS membershipRevision FROM article_library_meta WHERE singleton = 1',
              )
              .get() as { membershipRevision: number } | undefined;
            const membershipRevision = MembershipRevisionSchema.parse(
              meta?.membershipRevision,
            );
            if (after && after.membershipRevision !== membershipRevision)
              return { status: 'stale_cursor' as const };
            const { totalCount } = db
              .prepare(
                'SELECT COUNT(*) AS totalCount FROM articles WHERE deleted_at IS NULL',
              )
              .get() as { totalCount: number };
            const query = `SELECT a.article_key AS articleKey, a.external_id AS externalId, a.title, a.content_declaration AS contentDeclaration, a.created_at AS createdAt, a.content_revision AS articleRevision, (SELECT COUNT(*) FROM article_assets s WHERE s.article_key = a.article_key) AS imageCount FROM articles a WHERE a.deleted_at IS NULL ${after ? 'AND (a.created_at < ? OR (a.created_at = ? AND a.article_key < ?))' : ''} ORDER BY a.created_at DESC, a.article_key DESC LIMIT 11`;
            const rows = (
              after
                ? db
                    .prepare(query)
                    .all(after.createdAt, after.createdAt, after.articleKey)
                : db.prepare(query).all()
            ).map((row) => ArticleSummarySchema.parse(row));
            const items = rows.slice(0, 10);
            const last = items.at(-1);
            const pageNumber = after?.pageNumber ?? 1;
            return {
              status: 'ok' as const,
              page: ArticlePageSchema.parse({
                items,
                totalCount,
                membershipRevision,
                pageNumber,
                totalPages: Math.max(1, Math.ceil(totalCount / 10)),
                ...(rows.length > 10 && last
                  ? {
                      nextCursor: {
                        createdAt: last.createdAt,
                        articleKey: last.articleKey,
                        membershipRevision,
                        pageNumber: pageNumber + 1,
                      },
                    }
                  : {}),
              }),
            };
          })(),
        );
      },
      reserve(externalId, retry) {
        return safely(() =>
          db
            .transaction(() => {
              if (
                attemptRows().length ||
                loadStoredArticle(db, 'external_id', externalId)
              )
                throw new ImportFailure('STORAGE_UNAVAILABLE');
              const operation = retry
                ? revisions.readRevisionOperation(retry.revisionOperationId)
                : undefined;
              if (
                retry &&
                (!operation ||
                  operation.kind !== 'created' ||
                  operation.baseRevision !== 0 ||
                  operation.externalId !== externalId ||
                  operation.status !== 'failed' ||
                  !operation.cleanupComplete ||
                  operation.committedRevision !== null ||
                  operation.committedAt !== null ||
                  loadStoredArticle(db, 'article_key', operation.articleKey))
              )
                throw new ImportFailure('STORAGE_UNAVAILABLE');
              const attempt = ImportAttemptSchema.parse({
                importId: randomUUID(),
                articleKey: operation?.articleKey ?? randomUUID(),
                externalId,
                startedAt: new Date().toISOString(),
                status: 'preparing',
              });
              db.prepare(
                'INSERT INTO article_import_attempts (import_id, article_key, external_id, started_at, status) VALUES (?, ?, ?, ?, ?)',
              ).run(
                attempt.importId,
                attempt.articleKey,
                attempt.externalId,
                attempt.startedAt,
                attempt.status,
              );
              return attempt;
            })
            .immediate(),
        );
      },
      findExternal: (value) =>
        safely(() => loadStoredArticle(db, 'external_id', value)),
      findImport: (value) =>
        safely(() => loadStoredArticle(db, 'import_id', value)),
      load: (value) =>
        safely(() => loadStoredArticle(db, 'article_key', value)),
      attempts: () => safely(attemptRows),
      commit(attempt, input, context) {
        safely(() =>
          db
            .transaction(() => {
              const parsedAttempt = ImportAttemptSchema.parse(attempt);
              const article = StoredArticleSchema.parse(input);
              const editorBody = context
                ? PersistedEditorBodyV1Schema.parse(context.editorBody)
                : null;
              const receipt = context
                ? SaveReceiptSchema.parse(context.receipt)
                : undefined;
              if (editorBody && !editorProjectionMatches(article, editorBody))
                throw new ImportFailure('STORAGE_UNAVAILABLE');
              if (receipt) {
                const duplicate = revisions.readSaveReceipt(
                  receipt.operationId,
                );
                if (duplicate) {
                  if (JSON.stringify(duplicate) !== JSON.stringify(receipt))
                    throw new ImportFailure('STORAGE_UNAVAILABLE');
                  const saved = db
                    .prepare(
                      'SELECT next_digest AS nextDigest FROM article_edit_operations WHERE operation_id = ?',
                    )
                    .get(receipt.operationId) as
                    { nextDigest: string } | undefined;
                  if (
                    !saved ||
                    saved.nextDigest !== revisionDigest(article, editorBody)
                  )
                    throw new ImportFailure('STORAGE_UNAVAILABLE');
                  return;
                }
              }
              const current = attemptRows().find(
                (row) => row.importId === parsedAttempt.importId,
              );
              if (
                !current ||
                current.status !== 'preparing' ||
                parsedAttempt.status !== 'preparing' ||
                current.articleKey !== parsedAttempt.articleKey ||
                current.externalId !== parsedAttempt.externalId ||
                current.startedAt !== parsedAttempt.startedAt ||
                article.articleKey !== current.articleKey ||
                article.externalId !== current.externalId ||
                article.importId !== current.importId
              )
                throw new ImportFailure('STORAGE_UNAVAILABLE');
              const createdIntent = receipt
                ? revisions
                    .listRevisionOperations()
                    .find((op) => op.operationId === receipt.operationId)
                : undefined;
              if (
                receipt &&
                (!createdIntent ||
                  createdIntent.kind !== 'created' ||
                  createdIntent.baseRevision !== 0 ||
                  createdIntent.articleKey !== current.articleKey ||
                  createdIntent.externalId !== current.externalId ||
                  receipt.articleKey !== article.articleKey ||
                  receipt.externalId !== article.externalId ||
                  !receiptMatches(createdIntent, receipt))
              )
                throw new ImportFailure('STORAGE_UNAVAILABLE');
              db.prepare(
                'INSERT INTO articles (article_key, external_id, import_id, title, body_json, content_declaration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              ).run(
                article.articleKey,
                article.externalId,
                article.importId,
                article.title,
                JSON.stringify(article.body),
                article.contentDeclaration,
                article.createdAt,
              );
              const insert = db.prepare(
                'INSERT INTO article_assets (asset_key, article_key, image_id, relative_path, mime, byte_size, width, height, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              );
              for (const asset of article.assets)
                insert.run(
                  asset.assetKey,
                  article.articleKey,
                  asset.imageId,
                  asset.relativePath,
                  asset.mime,
                  asset.byteSize,
                  asset.width,
                  asset.height,
                  asset.sha256,
                );
              const membership = db
                .prepare(
                  'UPDATE article_library_meta SET membership_revision = membership_revision + 1 WHERE singleton = 1 AND membership_revision < 9007199254740991',
                )
                .run();
              if (membership.changes !== 1)
                throw new ImportFailure('STORAGE_UNAVAILABLE');
              if (receipt) {
                db.prepare(
                  'UPDATE articles SET editor_body_json = ? WHERE article_key = ?',
                ).run(JSON.stringify(editorBody), article.articleKey);
                commitReceipt(
                  db,
                  createdIntent!,
                  receipt,
                  revisionDigest(article, editorBody),
                );
              }
              const deleted = db
                .prepare(
                  'DELETE FROM article_import_attempts WHERE import_id = ?',
                )
                .run(current.importId);
              if (deleted.changes !== 1)
                throw new ImportFailure('STORAGE_UNAVAILABLE');
            })
            .immediate(),
        );
      },
      markAttempt(importId, status) {
        safely(() => {
          const current = attemptRows().find(
            (row) => row.importId === importId,
          );
          if (!current) throw new ImportFailure('STORAGE_UNAVAILABLE');
          const updated = ImportAttemptSchema.parse({ ...current, status });
          if (
            db
              .prepare(
                'UPDATE article_import_attempts SET status = ? WHERE import_id = ?',
              )
              .run(updated.status, updated.importId).changes !== 1
          )
            throw new ImportFailure('STORAGE_UNAVAILABLE');
        });
      },
      forgetAttempt(importId) {
        safely(() =>
          db
            .transaction(() => {
              if (loadStoredArticle(db, 'import_id', importId))
                throw new ImportFailure('STORAGE_UNAVAILABLE');
              db.prepare(
                'DELETE FROM article_import_attempts WHERE import_id = ?',
              ).run(importId);
            })
            .immediate(),
        );
      },
      getSchemaVersion: () =>
        safely(
          () =>
            (
              db
                .prepare(
                  'SELECT MAX(version) AS version FROM schema_migrations',
                )
                .get() as { version: number }
            ).version,
        ),
      close() {
        if (db.open) safely(() => db.close());
      },
    };
  });
}
