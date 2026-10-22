CREATE TABLE article_cover_versions (
 article_key TEXT NOT NULL REFERENCES articles(article_key) ON DELETE RESTRICT,
 cover_revision INTEGER NOT NULL CHECK (typeof(cover_revision)='integer' AND cover_revision BETWEEN 1 AND 9007199254740991),
 mode TEXT NOT NULL CHECK (mode IN ('none','single','triple')),
 assets_json TEXT NOT NULL CHECK (json_valid(assets_json)),
 configuration_digest TEXT NOT NULL,
 save_operation_id TEXT NOT NULL UNIQUE,
 committed_at TEXT NOT NULL,
 PRIMARY KEY(article_key,cover_revision)
);
CREATE TABLE article_cover_heads (
 article_key TEXT NOT NULL PRIMARY KEY REFERENCES articles(article_key) ON DELETE RESTRICT,
 cover_revision INTEGER NOT NULL,
 FOREIGN KEY(article_key,cover_revision) REFERENCES article_cover_versions(article_key,cover_revision) ON DELETE RESTRICT
);
CREATE TABLE article_cover_operations (
 operation_id TEXT NOT NULL PRIMARY KEY,
 article_key TEXT NOT NULL REFERENCES articles(article_key) ON DELETE RESTRICT,
 session_id TEXT NOT NULL,
 expected_article_revision INTEGER NOT NULL CHECK (typeof(expected_article_revision)='integer' AND expected_article_revision BETWEEN 1 AND 9007199254740991),
 expected_cover_revision INTEGER NOT NULL CHECK (typeof(expected_cover_revision)='integer' AND expected_cover_revision BETWEEN 0 AND 9007199254740990),
 draft_revision INTEGER NOT NULL CHECK (typeof(draft_revision)='integer' AND draft_revision BETWEEN 0 AND 9007199254740991),
 requested_mode TEXT NOT NULL CHECK (requested_mode IN ('none','single','triple')),
 payload_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('preparing','committed','failed','cleanup_required','needs_review')),
 owned_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(owned_files_json)),
 committed_cover_revision INTEGER,
 started_at TEXT NOT NULL,
 committed_at TEXT,
 cleanup_complete INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_complete IN (0,1)),
 CHECK ((committed_cover_revision IS NULL AND committed_at IS NULL) OR (typeof(committed_cover_revision)='integer' AND committed_cover_revision=expected_cover_revision+1 AND committed_at IS NOT NULL)),
 CHECK(status!='committed' OR committed_cover_revision IS NOT NULL)
);
ALTER TABLE judongche_draft_tasks ADD COLUMN cover_plan_version INTEGER NOT NULL DEFAULT 0 CHECK(cover_plan_version IN (0,1));
CREATE TABLE judongche_task_covers (
 task_id TEXT NOT NULL PRIMARY KEY REFERENCES judongche_draft_tasks(task_id) ON DELETE RESTRICT,
 policy TEXT NOT NULL CHECK(policy='local-upload-v1'),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 snapshot_digest TEXT NOT NULL,
 report_json TEXT NOT NULL CHECK(json_valid(report_json))
);
CREATE INDEX article_cover_pending_cleanup ON article_cover_operations(cleanup_complete,status);
