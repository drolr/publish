ALTER TABLE articles ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(content_revision) = 'integer' AND content_revision BETWEEN 1 AND 9007199254740991);
ALTER TABLE articles ADD COLUMN editor_body_json TEXT CHECK (editor_body_json IS NULL OR json_valid(editor_body_json));
CREATE TABLE article_edit_operations (
 operation_id TEXT NOT NULL PRIMARY KEY,
 session_id TEXT NOT NULL,
 article_key TEXT NOT NULL,
 external_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('created', 'updated')),
 base_revision INTEGER NOT NULL CHECK (typeof(base_revision) = 'integer' AND base_revision BETWEEN 0 AND 9007199254740990 AND ((kind = 'created' AND base_revision = 0) OR (kind = 'updated' AND base_revision > 0))),
 payload_digest TEXT NOT NULL,
 next_digest TEXT,
 status TEXT NOT NULL CHECK (status IN ('preparing', 'committed', 'failed', 'cleanup_required', 'needs_review')),
 document_revision INTEGER NOT NULL CHECK (typeof(document_revision) = 'integer' AND document_revision BETWEEN 0 AND 9007199254740991),
 committed_revision INTEGER CHECK (committed_revision IS NULL OR (typeof(committed_revision) = 'integer' AND committed_revision = base_revision + 1)),
 started_at TEXT NOT NULL,
 committed_at TEXT,
 cleanup_complete INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_complete IN (0, 1)),
 owned_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(owned_files_json)),
 CHECK ((committed_revision IS NULL AND committed_at IS NULL) OR (committed_revision IS NOT NULL AND committed_at IS NOT NULL AND next_digest IS NOT NULL)),
 CHECK (status != 'committed' OR committed_revision IS NOT NULL)
);
CREATE INDEX article_edit_pending_cleanup ON article_edit_operations(cleanup_complete, status);
