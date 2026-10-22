import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  coverAssetMetadata,
  StoredCoverAssetSchema,
  CoverTaskSnapshotSchema,
  CoverConfigurationSchema,
  CoverOperationSchema,
  CoverOperationPatchSchema,
  CoverSaveIntentSchema,
  type CoverMode,
  type StoredCoverAsset,
  type StoredCoverConfiguration,
  type CoverOperation,
  type CoverSaveIntent,
  type CoverSaveResult,
} from '../../contracts/article-cover';
import { StorageIdSchema } from '../../contracts/stored-article';
import { RevisionSchema } from '../../contracts/web-paste';
import type { ArticleCoverRepository } from '../../domain/ports/article-cover';
import { ImportFailure } from '../../domain/import-error';
export function coverConfigurationDigest(
  articleKey: string,
  coverRevision: number,
  mode: CoverMode,
  assets: readonly StoredCoverAsset[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        articleKey: StorageIdSchema.parse(articleKey),
        coverRevision: RevisionSchema.parse(coverRevision),
        mode,
        assets: assets.map((a) => StoredCoverAssetSchema.parse(a)),
      }),
    )
    .digest('hex');
}
const columns =
  'operation_id AS operationId,article_key AS articleKey,session_id AS sessionId,expected_article_revision AS expectedArticleRevision,expected_cover_revision AS expectedCoverRevision,draft_revision AS draftRevision,requested_mode AS mode,payload_digest AS payloadDigest,status,owned_files_json AS ownedFilesJson,committed_cover_revision AS committedCoverRevision,started_at AS startedAt,committed_at AS committedAt,cleanup_complete AS cleanupComplete';
interface OperationRow {
  ownedFilesJson: string;
  cleanupComplete: number;
}
function operation(row: OperationRow): CoverOperation {
  const { ownedFilesJson, cleanupComplete, ...rest } = row;
  return CoverOperationSchema.parse({
    ...rest,
    ownedFiles: JSON.parse(ownedFilesJson) as unknown,
    cleanupComplete: cleanupComplete === 1,
  });
}
const sameIntent = (a: CoverSaveIntent, b: CoverSaveIntent) =>
  Object.keys(CoverSaveIntentSchema.shape).every(
    (k) => a[k as keyof CoverSaveIntent] === b[k as keyof CoverSaveIntent],
  );
function safely<T>(action: () => T): T {
  try {
    return action();
  } catch {
    throw new ImportFailure('STORAGE_UNAVAILABLE');
  }
}
export function coverRepository(db: Database.Database): ArticleCoverRepository {
  const rowFor = (id: string) =>
    db
      .prepare(
        `SELECT ${columns} FROM article_cover_operations WHERE operation_id=?`,
      )
      .get(StorageIdSchema.parse(id)) as OperationRow | undefined;
  const articleFor = (key: string) =>
    db
      .prepare(
        'SELECT content_revision AS revision,deleted_at AS deletedAt FROM articles WHERE article_key=?',
      )
      .get(StorageIdSchema.parse(key)) as
      { revision: number; deletedAt: string | null } | undefined;
  function archived(
    key: string,
    revision: number,
  ): StoredCoverConfiguration | undefined {
    StorageIdSchema.parse(key);
    RevisionSchema.parse(revision);
    if (!articleFor(key)) return undefined;
    if (revision === 0)
      return {
        articleKey: key,
        coverRevision: 0,
        mode: 'none',
        assets: [],
        configurationDigest: coverConfigurationDigest(key, 0, 'none', []),
        saveOperationId: null,
        committedAt: null,
      };
    const row = db
      .prepare(
        'SELECT article_key AS articleKey,cover_revision AS coverRevision,mode,assets_json AS assetsJson,configuration_digest AS configurationDigest,save_operation_id AS saveOperationId,committed_at AS committedAt FROM article_cover_versions WHERE article_key=? AND cover_revision=?',
      )
      .get(key, revision) as { assetsJson: string } | undefined;
    if (!row) return undefined;
    const { assetsJson, ...rest } = row;
    const config = CoverConfigurationSchema.parse({
      ...rest,
      assets: JSON.parse(assetsJson) as unknown,
    });
    if (
      config.configurationDigest !==
      coverConfigurationDigest(key, revision, config.mode, config.assets)
    )
      throw Error('Cover digest mismatch');
    return config;
  }
  function current(key: string): StoredCoverConfiguration | undefined {
    const a = articleFor(key);
    if (!a || a.deletedAt !== null) return undefined;
    const head = db
      .prepare(
        'SELECT cover_revision AS revision FROM article_cover_heads WHERE article_key=?',
      )
      .get(key) as { revision: number } | undefined;
    const config = archived(key, head?.revision ?? 0);
    if (!config) throw Error('Missing cover version');
    return config;
  }
  function lookup(op: CoverOperation): CoverSaveResult {
    if (op.committedCoverRevision !== null) {
      const config = archived(op.articleKey, op.committedCoverRevision);
      if (
        !config ||
        config.saveOperationId !== op.operationId ||
        config.committedAt !== op.committedAt
      )
        throw Error('Receipt mismatch');
      return {
        status: 'committed',
        receipt: {
          operationId: op.operationId,
          articleKey: op.articleKey,
          coverRevision: config.coverRevision,
          configurationDigest: config.configurationDigest,
        },
      };
    }
    return {
      status:
        op.status === 'preparing'
          ? 'pending'
          : op.status === 'failed' && op.cleanupComplete
            ? 'failed'
            : 'needs_review',
      operationId: op.operationId,
    };
  }
  function admission(
    intent: CoverSaveIntent,
  ): 'ready' | 'conflict' | 'blocked' {
    const a = articleFor(intent.articleKey);
    if (
      !a ||
      a.deletedAt !== null ||
      a.revision !== intent.expectedArticleRevision ||
      current(intent.articleKey)?.coverRevision !== intent.expectedCoverRevision
    )
      return 'conflict';
    if (
      db
        .prepare(
          'SELECT 1 FROM judongche_draft_tasks WHERE article_key=? AND holds_platform=1',
        )
        .get(intent.articleKey)
    )
      return 'blocked';
    return 'ready';
  }
  return {
    loadCover: (key) => safely(() => db.transaction(() => current(key))()),
    loadArchivedCoverVersion: (key, revision) =>
      safely(() => archived(key, revision)),
    readCoverOperation: (id) =>
      safely(() => {
        const row = rowFor(id);
        return row ? operation(row) : undefined;
      }),
    listCoverOperations: () =>
      safely(() =>
        db
          .prepare(
            `SELECT ${columns} FROM article_cover_operations ORDER BY started_at,operation_id`,
          )
          .all()
          .map((row) => operation(row as OperationRow)),
      ),
    readCoverSaveResult: (id) =>
      safely(() => {
        const row = rowFor(id);
        return row
          ? lookup(operation(row))
          : { status: 'not_started', operationId: id };
      }),
    beginCoverSave(raw) {
      return safely(() =>
        db
          .transaction(() => {
            const intent = CoverSaveIntentSchema.parse(raw);
            const row = rowFor(intent.operationId);
            if (row) {
              const op = operation(row);
              if (!sameIntent(op, intent))
                return {
                  status: 'needs_review' as const,
                  operationId: intent.operationId,
                };
              return lookup(op);
            }
            const state = admission(intent);
            if (state !== 'ready')
              return { status: state, operationId: intent.operationId };
            db.prepare(
              'INSERT INTO article_cover_operations (operation_id,article_key,session_id,expected_article_revision,expected_cover_revision,draft_revision,requested_mode,payload_digest,status,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            ).run(
              intent.operationId,
              intent.articleKey,
              intent.sessionId,
              intent.expectedArticleRevision,
              intent.expectedCoverRevision,
              intent.draftRevision,
              intent.mode,
              intent.payloadDigest,
              'preparing',
              intent.startedAt,
            );
            return {
              status: 'not_started' as const,
              operationId: intent.operationId,
            };
          })
          .immediate(),
      );
    },
    commitCoverVersion(raw, assets) {
      return safely(() =>
        db
          .transaction(() => {
            const intent = CoverSaveIntentSchema.parse(raw);
            const row = rowFor(intent.operationId);
            if (!row)
              return {
                status: 'not_started' as const,
                operationId: intent.operationId,
              };
            const op = operation(row);
            if (!sameIntent(op, intent))
              return {
                status: 'needs_review' as const,
                operationId: intent.operationId,
              };
            if (op.committedCoverRevision !== null) {
              const config = archived(
                op.articleKey,
                op.committedCoverRevision,
              )!;
              if (JSON.stringify(config.assets) !== JSON.stringify(assets))
                return {
                  status: 'needs_review' as const,
                  operationId: intent.operationId,
                };
              return lookup(op);
            }
            if (op.status !== 'preparing' || op.cleanupComplete)
              return {
                status: 'needs_review' as const,
                operationId: intent.operationId,
              };
            const state = admission(intent);
            if (state !== 'ready')
              return { status: state, operationId: intent.operationId };
            const revision = intent.expectedCoverRevision + 1;
            const configurationDigest = coverConfigurationDigest(
              intent.articleKey,
              revision,
              intent.mode,
              assets,
            );
            const committedAt = new Date().toISOString();
            const config = CoverConfigurationSchema.parse({
              articleKey: intent.articleKey,
              coverRevision: revision,
              mode: intent.mode,
              assets,
              configurationDigest,
              saveOperationId: intent.operationId,
              committedAt,
            });
            const journalAssets = op.ownedFiles.map(coverAssetMetadata);
            if (
              op.ownedFiles.some((f) => !f.complete) ||
              JSON.stringify(config.assets) !== JSON.stringify(journalAssets)
            )
              throw Error('Incomplete cover ownership');
            db.prepare(
              'INSERT INTO article_cover_versions (article_key,cover_revision,mode,assets_json,configuration_digest,save_operation_id,committed_at) VALUES (?,?,?,?,?,?,?)',
            ).run(
              intent.articleKey,
              revision,
              intent.mode,
              JSON.stringify(config.assets),
              configurationDigest,
              intent.operationId,
              committedAt,
            );
            db.prepare(
              'INSERT INTO article_cover_heads (article_key,cover_revision) VALUES (?,?) ON CONFLICT(article_key) DO UPDATE SET cover_revision=excluded.cover_revision',
            ).run(intent.articleKey, revision);
            db.prepare(
              "UPDATE article_cover_operations SET status='committed',committed_cover_revision=?,committed_at=? WHERE operation_id=?",
            ).run(revision, committedAt, intent.operationId);
            return {
              status: 'committed' as const,
              receipt: {
                operationId: intent.operationId,
                articleKey: intent.articleKey,
                coverRevision: revision,
                configurationDigest,
              },
            };
          })
          .immediate(),
      );
    },
    markCoverOperation(id, raw) {
      safely(() =>
        db
          .transaction(() => {
            const row = rowFor(id);
            if (!row) throw Error('Missing operation');
            const previous = operation(row);
            const patch = CoverOperationPatchSchema.parse(raw);
            const next = CoverOperationSchema.parse({ ...previous, ...patch });
            if (
              previous.ownedFiles.some((file, index) => {
                const replacement = next.ownedFiles[index];
                return (
                  !replacement ||
                  JSON.stringify({ ...file, complete: false }) !==
                    JSON.stringify({ ...replacement, complete: false }) ||
                  (file.complete && !replacement.complete)
                );
              })
            )
              throw Error('Owned cover declaration immutable');
            if (
              previous.committedCoverRevision !== null &&
              ['preparing', 'failed'].includes(next.status)
            )
              throw Error('Committed operation immutable');
            if (
              previous.committedCoverRevision !== null &&
              patch.ownedFiles &&
              JSON.stringify(previous.ownedFiles) !==
                JSON.stringify(patch.ownedFiles)
            )
              throw Error('Committed journal immutable');
            db.prepare(
              'UPDATE article_cover_operations SET status=?,owned_files_json=?,cleanup_complete=? WHERE operation_id=?',
            ).run(
              next.status,
              JSON.stringify(next.ownedFiles),
              next.cleanupComplete ? 1 : 0,
              id,
            );
          })
          .immediate(),
      );
    },
    isCoverAssetReferenced(asset, excludingOperationId) {
      return safely(() =>
        db.transaction(() => {
          StorageIdSchema.parse(excludingOperationId);
          const matches = (a: StoredCoverAsset) =>
            a.assetKey === asset.assetKey ||
            a.relativePath === asset.relativePath;
          let referenced = false;
          const versions = db
            .prepare(
              'SELECT article_key AS articleKey,cover_revision AS revision FROM article_cover_versions',
            )
            .all() as { articleKey: string; revision: number }[];
          for (const v of versions) {
            const config = archived(v.articleKey, v.revision);
            if (!config) throw Error('Missing referenced cover');
            if (config.assets.some(matches)) referenced = true;
          }
          const tasks = db
            .prepare(
              'SELECT t.task_id AS taskId,t.article_key AS articleKey,t.cover_plan_version AS version,c.snapshot_json AS snapshotJson,c.snapshot_digest AS digest FROM judongche_draft_tasks t LEFT JOIN judongche_task_covers c ON c.task_id=t.task_id',
            )
            .all() as {
            taskId: string;
            articleKey: string;
            version: number;
            snapshotJson: string | null;
            digest: string | null;
          }[];
          for (const task of tasks) {
            if (task.version === 0) {
              if (task.snapshotJson !== null)
                throw Error('Unexpected legacy cover extension');
              continue;
            }
            if (task.version !== 1 || task.snapshotJson === null)
              throw Error('Missing task cover reference');
            const snapshot = CoverTaskSnapshotSchema.parse(
              JSON.parse(task.snapshotJson) as unknown,
            );
            if (
              snapshot.articleKey !== task.articleKey ||
              snapshot.digest !== task.digest ||
              snapshot.digest !==
                coverConfigurationDigest(
                  snapshot.articleKey,
                  snapshot.coverRevision,
                  snapshot.mode,
                  snapshot.assets,
                )
            )
              throw Error('Unknown task cover reference');
            const version = archived(
              snapshot.articleKey,
              snapshot.coverRevision,
            );
            if (
              !version ||
              version.configurationDigest !== snapshot.digest ||
              JSON.stringify(version.assets) !== JSON.stringify(snapshot.assets)
            )
              throw Error('Missing task cover version');
            if (snapshot.assets.some(matches)) referenced = true;
          }
          for (const row of db
            .prepare(`SELECT ${columns} FROM article_cover_operations`)
            .all()) {
            const op = operation(row as OperationRow);
            if (
              op.operationId !== excludingOperationId &&
              op.ownedFiles.some(matches)
            )
              referenced = true;
          }
          return referenced;
        })(),
      );
    },
  };
}
