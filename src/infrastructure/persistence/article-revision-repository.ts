import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  RevisionIntentSchema,
  RevisionOperationSchema,
  RevisionOperationPatchSchema,
  RevisionProposalSchema,
  SaveReceiptSchema,
  type RevisionIntent,
  type RevisionOperation,
  type SaveReceipt,
  type EditorCompatibilityLease,
} from '../../contracts/article-revision';
import { ArticleRevisionSchema } from '../../contracts/manual-edit';
import {
  StorageIdSchema,
  StoredArticleSchema,
} from '../../contracts/stored-article';
import { PersistedEditorBodySchema } from '../../contracts/rich-text-body';
import type { ArticleRevisionRepository } from '../../domain/ports/article-revision';
import {
  editorProjectionMatches,
  deriveEditorBody,
} from '../../domain/article-edit';
import { ImportFailure } from '../../domain/import-error';
import {
  loadEditableArticle,
  loadActiveEditableArticle,
} from './stored-article-reader';
const columns =
  'operation_id AS operationId, session_id AS sessionId, article_key AS articleKey, external_id AS externalId, kind, document_revision AS documentRevision, base_revision AS baseRevision, payload_digest AS payloadDigest, next_digest AS nextDigest, status, committed_revision AS committedRevision, started_at AS startedAt, committed_at AS committedAt, cleanup_complete AS cleanupComplete, owned_files_json AS ownedFilesJson';
interface OperationRow {
  operationId: string;
  documentRevision: number;
  nextDigest: string | null;
  ownedFilesJson: string;
  cleanupComplete: number;
}
function operation(row: OperationRow): RevisionOperation {
  const { nextDigest, ownedFilesJson, cleanupComplete, ...rest } = row;
  return RevisionOperationSchema.parse({
    ...rest,
    nextDigest,
    cleanupComplete: cleanupComplete === 1,
    ownedFiles: JSON.parse(ownedFilesJson) as unknown,
  });
}
function receiptFor(op: RevisionOperation): SaveReceipt | undefined {
  if (op.committedRevision === null) return undefined;
  return SaveReceiptSchema.parse({
    operationId: op.operationId,
    sessionId: op.sessionId,
    articleKey: op.articleKey,
    externalId: op.externalId,
    documentRevision: op.documentRevision,
    articleRevision: op.committedRevision,
    kind: op.kind,
    payloadDigest: op.payloadDigest,
    committedAt: op.committedAt,
  });
}
function sameIntent(a: RevisionIntent, b: RevisionIntent): boolean {
  return [
    'operationId',
    'sessionId',
    'articleKey',
    'externalId',
    'kind',
    'documentRevision',
    'baseRevision',
    'payloadDigest',
    'startedAt',
  ].every(
    (key) => a[key as keyof RevisionIntent] === b[key as keyof RevisionIntent],
  );
}
export function revisionDigest(article: unknown, editorBody: unknown): string {
  const normalizedArticle = StoredArticleSchema.parse(article);
  normalizedArticle.assets.sort((a, b) => a.assetKey.localeCompare(b.assetKey));
  const normalizedBody =
    editorBody === null ? null : PersistedEditorBodySchema.parse(editorBody);
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...(normalizedBody?.version === 2
          ? { domain: 'article-revision-v2' }
          : {}),
        article: normalizedArticle,
        editorBody: normalizedBody,
      }),
    )
    .digest('hex');
}
export function revisionRepository(
  db: Database.Database,
): ArticleRevisionRepository {
  const compatibilityLeases = new WeakMap<
    EditorCompatibilityLease,
    {
      articleKey: string;
      sessionId: string;
      baseRevision: number;
      ceiling: number;
    }
  >();
  const compatibilityFor = (
    lease: EditorCompatibilityLease,
    articleKey: string,
    sessionId: string,
    baseRevision: number,
  ) => {
    const proof = compatibilityLeases.get(lease);
    return db.open &&
      proof?.articleKey === articleKey &&
      proof.sessionId === sessionId &&
      proof.baseRevision <= baseRevision
      ? proof
      : undefined;
  };
  const rowFor = (id: string) =>
    db
      .prepare(
        `SELECT ${columns} FROM article_edit_operations WHERE operation_id = ?`,
      )
      .get(StorageIdSchema.parse(id)) as OperationRow | undefined;
  const readReceipt = (id: string) => {
    const row = rowFor(id);
    return row ? receiptFor(operation(row)) : undefined;
  };
  return {
    createEditorCompatibilityLease(articleKey, sessionId, baseRevision) {
      StorageIdSchema.parse(sessionId);
      ArticleRevisionSchema.parse(baseRevision);
      return db.transaction(() => {
        const loaded = loadActiveEditableArticle(
          db,
          StorageIdSchema.parse(articleKey),
        );
        if (!loaded || loaded.articleRevision !== baseRevision)
          return undefined;
        const layout =
          loaded.editorBody ?? deriveEditorBody(loaded.article.body);
        const lease = Object.freeze({}) as EditorCompatibilityLease;
        compatibilityLeases.set(lease, {
          articleKey,
          sessionId,
          baseRevision,
          ceiling: Math.max(
            200,
            layout.blocks.filter((b) => b.type === 'image').length,
          ),
        });
        return lease;
      })();
    },
    isEditorCompatibilityLease: (lease, articleKey, sessionId, baseRevision) =>
      !!compatibilityFor(lease, articleKey, sessionId, baseRevision),
    releaseEditorCompatibilityLease: (lease) => {
      compatibilityLeases.delete(lease);
    },
    loadEditableArticle(articleKey) {
      try {
        return db.transaction(() =>
          loadActiveEditableArticle(db, StorageIdSchema.parse(articleKey)),
        )();
      } catch {
        throw new ImportFailure('STORAGE_UNAVAILABLE');
      }
    },
    loadArchivedEditableArticle(articleKey) {
      try {
        return loadEditableArticle(db, StorageIdSchema.parse(articleKey));
      } catch {
        throw new ImportFailure('STORAGE_UNAVAILABLE');
      }
    },
    readSaveReceipt(id) {
      try {
        return readReceipt(id);
      } catch {
        throw new ImportFailure('STORAGE_UNAVAILABLE');
      }
    },
    readRevisionOperation(id) {
      try {
        const row = rowFor(id);
        return row ? operation(row) : undefined;
      } catch {
        throw new ImportFailure('STORAGE_UNAVAILABLE');
      }
    },
    beginRevision(input) {
      const operationId = input.operationId;
      try {
        const intent = RevisionIntentSchema.parse(input);
        return db
          .transaction(() => {
            const existing = rowFor(operationId);
            if (existing) {
              const op = operation(existing);
              if (!sameIntent(op, intent))
                return { status: 'needs_review' as const, operationId };
              const receipt = receiptFor(op);
              if (receipt) return { status: 'committed' as const, receipt };
              if (op.status === 'failed' && op.cleanupComplete) {
                if (
                  intent.kind === 'updated' &&
                  !loadActiveEditableArticle(db, intent.articleKey)
                )
                  return { status: 'needs_review' as const, operationId };
                db.prepare(
                  "UPDATE article_edit_operations SET status = 'preparing', cleanup_complete = 0, owned_files_json = '[]' WHERE operation_id = ?",
                ).run(operationId);
                return { status: 'not_started' as const, operationId };
              }
              return { status: 'needs_review' as const, operationId };
            }
            if (intent.kind === 'created') {
              const reserved = db
                .prepare(
                  'SELECT article_key, external_id FROM article_import_attempts WHERE article_key = ? AND external_id = ? AND status = ?',
                )
                .get(intent.articleKey, intent.externalId, 'preparing');
              if (!reserved)
                return { status: 'needs_review' as const, operationId };
            } else {
              const article = loadActiveEditableArticle(db, intent.articleKey);
              if (!article || article.article.externalId !== intent.externalId)
                return { status: 'needs_review' as const, operationId };
            }
            db.prepare(
              'INSERT INTO article_edit_operations (operation_id,session_id,article_key,external_id,kind,document_revision,base_revision,payload_digest,status,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            ).run(
              intent.operationId,
              intent.sessionId,
              intent.articleKey,
              intent.externalId,
              intent.kind,
              intent.documentRevision,
              intent.baseRevision,
              intent.payloadDigest,
              'preparing',
              intent.startedAt,
            );
            return { status: 'not_started' as const, operationId };
          })
          .immediate();
      } catch {
        return { status: 'unavailable', operationId };
      }
    },
    commitRevision(expectedRevision, input, inputReceipt) {
      const parsed = RevisionProposalSchema.safeParse(input);
      const checkedReceipt = SaveReceiptSchema.safeParse(inputReceipt);
      if (!parsed.success || !checkedReceipt.success)
        return { status: 'invalid' };
      const proposal = parsed.data;
      const receipt = checkedReceipt.data;
      const { intent, nextArticle, editorBody } = proposal;
      const compatibility = proposal.compatibilityLease
        ? compatibilityFor(
            proposal.compatibilityLease,
            intent.articleKey,
            intent.sessionId,
            intent.baseRevision,
          )
        : undefined;
      if (
        intent.kind !== 'updated' ||
        !ArticleRevisionSchema.safeParse(expectedRevision).success ||
        expectedRevision !== intent.baseRevision ||
        !editorProjectionMatches(nextArticle, editorBody) ||
        !receiptMatches(intent, receipt) ||
        nextArticle.articleKey !== intent.articleKey ||
        nextArticle.externalId !== intent.externalId
      )
        return { status: 'invalid' };
      try {
        return db
          .transaction(() => {
            const row = rowFor(intent.operationId);
            if (!row) return { status: 'invalid' as const };
            const op = operation(row);
            if (!sameIntent(op, intent)) return { status: 'invalid' as const };
            const digest = revisionDigest(nextArticle, editorBody);
            const existing = receiptFor(op);
            if (existing)
              return row.nextDigest === digest
                ? { status: 'already_committed' as const, receipt: existing }
                : { status: 'invalid' as const };
            if (proposal.compatibilityLease && !compatibility)
              return { status: 'invalid' as const };
            if (op.status !== 'preparing')
              return { status: 'invalid' as const };
            const current = loadActiveEditableArticle(db, intent.articleKey);
            if (
              !current ||
              current.articleRevision !== expectedRevision ||
              expectedRevision === Number.MAX_SAFE_INTEGER
            )
              return { status: 'conflict' as const };
            if (
              current.article.importId !== nextArticle.importId ||
              current.article.createdAt !== nextArticle.createdAt ||
              current.article.externalId !== nextArticle.externalId
            )
              return { status: 'invalid' as const };
            const oldLayout =
              current.editorBody ?? deriveEditorBody(current.article.body);
            if (revisionDigest(current.article, oldLayout) === digest)
              return { status: 'invalid' as const };
            const oldPositions = oldLayout.blocks.filter(
              (b) => b.type === 'image',
            ).length;
            const newPositions = editorBody.blocks.filter(
              (b) => b.type === 'image',
            ).length;
            if (
              newPositions > 200 &&
              newPositions > oldPositions &&
              (!compatibility || newPositions > compatibility.ceiling)
            )
              return { status: 'invalid' as const };
            // Asset keys identify immutable bytes. Existing keys cannot be repurposed.
            for (const asset of nextArticle.assets) {
              const old = current.article.assets.find(
                (a) => a.assetKey === asset.assetKey,
              );
              if (old && JSON.stringify(old) !== JSON.stringify(asset))
                return { status: 'invalid' as const };
              const collision = db
                .prepare(
                  'SELECT asset_key FROM article_assets WHERE asset_key = ? AND article_key != ?',
                )
                .get(asset.assetKey, nextArticle.articleKey);
              if (collision) return { status: 'invalid' as const };
            }
            const updated = db
              .prepare(
                'UPDATE articles SET title = ?, body_json = ?, content_declaration = ?, editor_body_json = ?, content_revision = content_revision + 1 WHERE article_key = ? AND content_revision = ? AND deleted_at IS NULL',
              )
              .run(
                nextArticle.title,
                JSON.stringify(nextArticle.body),
                nextArticle.contentDeclaration,
                JSON.stringify(editorBody),
                nextArticle.articleKey,
                expectedRevision,
              );
            if (updated.changes !== 1)
              throw new ImportFailure('STORAGE_UNAVAILABLE');
            // Remove metadata references only; historical files remain outside repository cleanup authority.
            db.prepare('DELETE FROM article_assets WHERE article_key = ?').run(
              nextArticle.articleKey,
            );
            insertAssets(db, nextArticle);
            commitReceipt(db, intent, receipt, digest);
            return { status: 'committed' as const, receipt };
          })
          .immediate();
      } catch {
        return { status: 'unavailable' };
      }
    },
    listRevisionOperations() {
      try {
        return db
          .prepare(
            `SELECT ${columns} FROM article_edit_operations WHERE cleanup_complete = 0 OR status = 'needs_review' ORDER BY started_at, operation_id`,
          )
          .all()
          .map((row) => operation(row as OperationRow));
      } catch {
        throw new ImportFailure('STORAGE_UNAVAILABLE');
      }
    },
    markRevisionOperation(id, input) {
      try {
        const patch = RevisionOperationPatchSchema.parse(input);
        db.transaction(() => {
          const row = rowFor(id);
          if (!row) throw new ImportFailure('STORAGE_UNAVAILABLE');
          const op = operation(row);
          if (
            op.committedRevision !== null &&
            patch.status !== undefined &&
            !['committed', 'cleanup_required', 'needs_review'].includes(
              patch.status,
            )
          )
            throw new ImportFailure('STORAGE_UNAVAILABLE');
          const next = RevisionOperationSchema.parse({ ...op, ...patch });
          if (next.status === 'committed' && next.committedRevision === null)
            throw new ImportFailure('STORAGE_UNAVAILABLE');
          db.prepare(
            'UPDATE article_edit_operations SET status = ?, cleanup_complete = ?, owned_files_json = ? WHERE operation_id = ?',
          ).run(
            next.status,
            next.cleanupComplete ? 1 : 0,
            JSON.stringify(next.ownedFiles),
            id,
          );
        }).immediate();
      } catch {
        throw new ImportFailure('STORAGE_UNAVAILABLE');
      }
    },
  };
}
export function receiptMatches(
  intent: RevisionIntent,
  receipt: SaveReceipt,
): boolean {
  return (
    intent.operationId === receipt.operationId &&
    intent.sessionId === receipt.sessionId &&
    intent.articleKey === receipt.articleKey &&
    intent.externalId === receipt.externalId &&
    intent.documentRevision === receipt.documentRevision &&
    intent.kind === receipt.kind &&
    intent.payloadDigest === receipt.payloadDigest &&
    receipt.articleRevision === intent.baseRevision + 1
  );
}
export function insertAssets(
  db: Database.Database,
  article: import('../../contracts/stored-article').StoredArticle,
): void {
  const insert = db.prepare(
    'INSERT INTO article_assets (asset_key,article_key,image_id,relative_path,mime,byte_size,width,height,sha256) VALUES (?,?,?,?,?,?,?,?,?)',
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
}
export function commitReceipt(
  db: Database.Database,
  intent: RevisionIntent,
  receipt: SaveReceipt,
  digest: string,
): void {
  if (!receiptMatches(intent, receipt))
    throw new ImportFailure('STORAGE_UNAVAILABLE');
  const updated = db
    .prepare(
      "UPDATE article_edit_operations SET status = 'committed', next_digest = ?, committed_revision = ?, committed_at = ? WHERE operation_id = ? AND status = 'preparing' AND committed_revision IS NULL",
    )
    .run(
      digest,
      receipt.articleRevision,
      receipt.committedAt,
      intent.operationId,
    );
  if (updated.changes !== 1) throw new ImportFailure('STORAGE_UNAVAILABLE');
}
