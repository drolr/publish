-- Attempts retain their own identity; article/store is searchable history only.
-- No business rows are rebuilt or rewritten, including previous save evidence.
DROP INDEX judongche_one_unclosed_identity;
CREATE INDEX judongche_draft_attempt_history
  ON judongche_draft_tasks(article_key, store_key, platform, mode, created_at DESC);
-- NULL means the historical content revision cannot be recovered safely.
ALTER TABLE judongche_draft_tasks ADD COLUMN article_revision INTEGER
  CHECK(article_revision IS NULL OR (typeof(article_revision) = 'integer' AND article_revision BETWEEN 1 AND 9007199254740991));
