import {
  EditableArticleSchema,
  type EditableArticle,
} from '../../contracts/article-revision';
import { editorProjectionMatches } from '../../domain/article-edit';
import type Database from 'better-sqlite3';
import {
  StoredArticleSchema,
  type StoredArticle,
} from '../../contracts/stored-article';
function readStoredArticle(
  db: Database.Database,
  column: 'article_key' | 'external_id' | 'import_id',
  value: string,
): StoredArticle | undefined {
  // Column is an internal allow-list; values are always bound parameters.
  const row = db
    .prepare(
      `SELECT article_key AS articleKey, external_id AS externalId, import_id AS importId, title, body_json AS bodyJson, content_declaration AS contentDeclaration, created_at AS createdAt FROM articles WHERE ${column} = ?`,
    )
    .get(value) as { articleKey: string; bodyJson: string } | undefined;
  if (!row) return undefined;
  const { bodyJson, ...article } = row;
  const assets = db
    .prepare(
      'SELECT asset_key AS assetKey, image_id AS imageId, relative_path AS relativePath, mime, byte_size AS byteSize, width, height, sha256 FROM article_assets WHERE article_key = ? ORDER BY rowid',
    )
    .all(row.articleKey);
  return StoredArticleSchema.parse({
    ...article,
    body: JSON.parse(bodyJson) as unknown,
    assets,
  });
}

function readEditableArticle(
  db: Database.Database,
  articleKey: string,
): EditableArticle | undefined {
  const row = db
    .prepare(
      'SELECT content_revision AS articleRevision, editor_body_json AS editorBodyJson FROM articles WHERE article_key = ?',
    )
    .get(articleKey) as
    { articleRevision: number; editorBodyJson: string | null } | undefined;
  if (!row) return undefined;
  const article = loadStoredArticle(db, 'article_key', articleKey);
  const editable = EditableArticleSchema.parse({
    article,
    articleRevision: row.articleRevision,
    editorBody:
      row.editorBodyJson === null
        ? null
        : (JSON.parse(row.editorBodyJson) as unknown),
  });
  if (
    editable.editorBody &&
    !editorProjectionMatches(editable.article, editable.editorBody)
  )
    throw new Error('Invalid editor projection');
  return editable;
}

export function loadStoredArticle(
  db: Database.Database,
  column: 'article_key' | 'external_id' | 'import_id',
  value: string,
): StoredArticle | undefined {
  return db.transaction(() => readStoredArticle(db, column, value))();
}
export function loadEditableArticle(
  db: Database.Database,
  articleKey: string,
): EditableArticle | undefined {
  return db.transaction(() => readEditableArticle(db, articleKey))();
}

// Ordinary editor/library access excludes tombstones. Archive readers above remain unfiltered.
export function loadActiveEditableArticle(
  db: Database.Database,
  articleKey: string,
): EditableArticle | undefined {
  return db.transaction(() => {
    if (
      !db
        .prepare(
          'SELECT article_key FROM articles WHERE article_key = ? AND deleted_at IS NULL',
        )
        .get(articleKey)
    )
      return undefined;
    return readEditableArticle(db, articleKey);
  })();
}
