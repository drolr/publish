CREATE TABLE articles (
  article_key TEXT NOT NULL PRIMARY KEY,
  external_id TEXT NOT NULL COLLATE BINARY UNIQUE,
  import_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  content_declaration TEXT NOT NULL CHECK (content_declaration IN ('original', 'repost')),
  created_at TEXT NOT NULL
);

CREATE TABLE article_assets (
  asset_key TEXT NOT NULL PRIMARY KEY,
  article_key TEXT NOT NULL REFERENCES articles(article_key),
  image_id TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (typeof(byte_size) = 'integer' AND byte_size > 0),
  width INTEGER NOT NULL CHECK (typeof(width) = 'integer' AND width > 0),
  height INTEGER NOT NULL CHECK (typeof(height) = 'integer' AND height > 0),
  sha256 TEXT NOT NULL,
  UNIQUE (article_key, image_id)
);

CREATE TABLE article_import_attempts (
  import_id TEXT NOT NULL PRIMARY KEY,
  article_key TEXT NOT NULL UNIQUE,
  external_id TEXT NOT NULL COLLATE BINARY UNIQUE,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'cleanup_required', 'needs_review'))
);
