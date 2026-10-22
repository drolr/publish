import Database from 'better-sqlite3';
// Test-only interleaving: a second real connection commits after the first
// SELECT pins a snapshot, before the library reads its count and rows.
export function duringLibrarySnapshot<T>(commit: () => void, read: () => T): T {
  const prepare = Database.prototype.prepare;
  let fired = false;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql) as Database.Statement;
    if (!fired && /SELECT.*FROM article_library_meta/i.test(sql)) {
      const get = statement.get;
      statement.get = function (...args: unknown[]) {
        const row = get.apply(this, args);
        if (!fired) {
          fired = true;
          commit();
        }
        return row;
      };
    }
    return statement;
  } as typeof prepare;
  try {
    return read();
  } finally {
    Database.prototype.prepare = prepare;
  }
}
export function executeImportSql(path: string, sql: string): void {
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(sql);
  } finally {
    db.close();
  }
}
export function inspectImportDb(path: string) {
  const db = new Database(path);
  try {
    return {
      history: db
        .prepare('SELECT * FROM schema_migrations ORDER BY version')
        .all(),
      assets: db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'article_assets'")
        .get()
        ? (
            db
              .prepare('SELECT COUNT(*) AS count FROM article_assets')
              .get() as { count: number }
          ).count
        : 0,
    };
  } finally {
    db.close();
  }
}

export function inspectLibraryMigrationState(path: string) {
  const db = new Database(path);
  try {
    return {
      articles: db
        .prepare(
          'SELECT article_key, external_id, import_id, title, body_json, content_declaration, created_at FROM articles ORDER BY article_key',
        )
        .all(),
      assets: db
        .prepare('SELECT * FROM article_assets ORDER BY asset_key')
        .all(),
      closures: db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='judongche_task_closures'",
        )
        .get()
        ? db
            .prepare('SELECT * FROM judongche_task_closures ORDER BY task_id')
            .all()
        : [],
      tasks: db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'judongche_draft_tasks'",
        )
        .get()
        ? db
            .prepare('SELECT * FROM judongche_draft_tasks ORDER BY task_id')
            .all()
        : [],
    };
  } finally {
    db.close();
  }
}

// Synthetic public legacy fixture only: bound values and explicit pre-schema6 columns.
export function seedLegacyStoredArticle(
  path: string,
  article: import('../../../contracts/stored-article').StoredArticle,
): void {
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    db.transaction(() => {
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
      db.prepare('DELETE FROM article_import_attempts WHERE import_id = ?').run(
        article.importId,
      );
    }).immediate();
  } finally {
    db.close();
  }
}

export function inspectDeletionState(path: string) {
  const db = new Database(path);
  try {
    return {
      membershipRevision: (
        db
          .prepare('SELECT membership_revision FROM article_library_meta')
          .get() as { membership_revision: number }
      ).membership_revision,
      articles: db
        .prepare(
          'SELECT article_key, deleted_at, content_revision FROM articles ORDER BY article_key',
        )
        .all(),
      operations: db
        .prepare(
          'SELECT * FROM article_delete_operations ORDER BY operation_id',
        )
        .all(),
      assets: db
        .prepare('SELECT * FROM article_assets ORDER BY asset_key')
        .all(),
    };
  } finally {
    db.close();
  }
}
