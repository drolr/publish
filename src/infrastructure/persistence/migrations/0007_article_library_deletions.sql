ALTER TABLE articles ADD COLUMN deleted_at TEXT;
CREATE TABLE article_library_meta (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  membership_revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(membership_revision) = 'integer' AND membership_revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO article_library_meta (singleton, membership_revision) VALUES (1, 0);
CREATE TABLE article_delete_operations (
  operation_id TEXT NOT NULL PRIMARY KEY,
  article_key TEXT NOT NULL REFERENCES articles(article_key) ON DELETE RESTRICT,
  expected_revision INTEGER NOT NULL CHECK (typeof(expected_revision) = 'integer' AND expected_revision BETWEEN 1 AND 9007199254740991),
  payload_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('deleted', 'conflict', 'blocked', 'not_found')),
  committed_revision INTEGER CHECK (committed_revision IS NULL OR (typeof(committed_revision) = 'integer' AND committed_revision BETWEEN 1 AND 9007199254740991)),
  completed_at TEXT NOT NULL,
  CHECK ((outcome = 'deleted' AND committed_revision = expected_revision + 1) OR (outcome != 'deleted' AND committed_revision IS NULL)),
  CHECK (outcome != 'deleted' OR committed_revision IS NOT NULL)
);
CREATE INDEX articles_live_order ON articles(created_at DESC, article_key DESC) WHERE deleted_at IS NULL;
