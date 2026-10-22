-- Explicit user stop release; preserve task, cover, closure and batch evidence.
CREATE TEMP TABLE stopped_batch_items_backup AS SELECT * FROM draft_batch_items;
DROP TABLE draft_batch_items;
-- Derived from the complete schema after migrations 0001-0008.
-- migrate() executes this atomically; both child tables are preserved before parent replacement.
CREATE TEMP TABLE closure_history_backup AS SELECT * FROM judongche_task_closures;
CREATE TEMP TABLE task_cover_history_backup AS SELECT * FROM judongche_task_covers;
DROP TABLE judongche_task_covers;
DROP TABLE judongche_task_closures;
CREATE TABLE judongche_draft_tasks_next (
  task_id TEXT PRIMARY KEY NOT NULL,
  preparation_id TEXT NOT NULL UNIQUE,
  article_key TEXT NOT NULL REFERENCES articles(article_key) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform = 'judongche'),
  mode TEXT NOT NULL CHECK (mode = 'draft'),
  store_key TEXT NOT NULL,
  store_json TEXT NOT NULL CHECK (json_valid(store_json)),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  snapshot_digest TEXT NOT NULL,
  cover_policy TEXT NOT NULL CHECK (cover_policy IN ('store-material-first', 'manual-after-draft')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','draft_saved','failed','needs_human','stopped','interrupted','closed_without_save','closed_after_review','stopped_by_user')),
  stage TEXT NOT NULL CHECK (stage IN ('reserved','editor','body','cover','save','verify','settled')),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0),
  possible_remote_effect INTEGER NOT NULL CHECK (possible_remote_effect IN (0,1)),
  save_attempted INTEGER NOT NULL CHECK (save_attempted IN (0,1)),
  stop_requested INTEGER NOT NULL CHECK (stop_requested IN (0,1)),
  holds_platform INTEGER NOT NULL CHECK (holds_platform IN (0,1)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, cover_plan_version INTEGER NOT NULL DEFAULT 0 CHECK(cover_plan_version IN (0,1)),
  CHECK (save_attempted <= possible_remote_effect),
  CHECK (state NOT IN ('queued','running','needs_human','interrupted') OR holds_platform = 1),
  CHECK (state <> 'draft_saved' OR (holds_platform = 0 AND possible_remote_effect = 1)),
  CHECK (state NOT IN ('failed','stopped') OR (holds_platform = 0 AND possible_remote_effect = 0)),
  CHECK (state <> 'closed_without_save' OR (holds_platform = 0 AND save_attempted = 0 AND stage = 'settled')),
 CHECK (state <> 'stopped_by_user' OR (holds_platform=0 AND stop_requested=1 AND stage='settled')),
 CHECK (state <> 'closed_after_review' OR (holds_platform=0 AND save_attempted=1 AND possible_remote_effect=1 AND stage='settled'))
);
INSERT INTO judongche_draft_tasks_next ("task_id","preparation_id","article_key","platform","mode","store_key","store_json","snapshot_json","snapshot_digest","cover_policy","state","stage","revision","possible_remote_effect","save_attempted","stop_requested","holds_platform","evidence_json","reason","created_at","updated_at","cover_plan_version") SELECT "task_id","preparation_id","article_key","platform","mode","store_key","store_json","snapshot_json","snapshot_digest","cover_policy","state","stage","revision","possible_remote_effect","save_attempted","stop_requested","holds_platform","evidence_json","reason","created_at","updated_at","cover_plan_version" FROM judongche_draft_tasks;
DROP TABLE judongche_draft_tasks;
ALTER TABLE judongche_draft_tasks_next RENAME TO judongche_draft_tasks;
CREATE UNIQUE INDEX judongche_one_occupied_task
  ON judongche_draft_tasks(platform) WHERE holds_platform = 1;
CREATE UNIQUE INDEX judongche_one_unclosed_identity
  ON judongche_draft_tasks(article_key, platform, store_key, mode)
  WHERE state NOT IN ('closed_without_save','stopped_by_user');
CREATE TABLE judongche_task_closures (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES judongche_draft_tasks(task_id) ON DELETE RESTRICT,
  prior_revision INTEGER NOT NULL CHECK (prior_revision >= 0),
  prior_state TEXT NOT NULL CHECK (prior_state IN ('needs_human','interrupted')),
  prior_stage TEXT NOT NULL CHECK (prior_stage IN ('reserved','editor','body','cover','save','verify','settled')),
  prior_reason TEXT,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  closed_at TEXT NOT NULL,
  successor_task_id TEXT UNIQUE REFERENCES judongche_draft_tasks(task_id) ON DELETE RESTRICT
);
CREATE TABLE judongche_task_covers (
 task_id TEXT NOT NULL PRIMARY KEY REFERENCES judongche_draft_tasks(task_id) ON DELETE RESTRICT,
 policy TEXT NOT NULL CHECK(policy='local-upload-v1'),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 snapshot_digest TEXT NOT NULL,
 report_json TEXT NOT NULL CHECK(json_valid(report_json))
);
INSERT INTO judongche_task_closures SELECT * FROM closure_history_backup;
INSERT INTO judongche_task_covers SELECT * FROM task_cover_history_backup;
DROP TABLE closure_history_backup;
DROP TABLE task_cover_history_backup;

CREATE TABLE draft_batch_items (
  batch_id TEXT NOT NULL REFERENCES draft_batches(id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  article_key TEXT NOT NULL REFERENCES articles(article_key),
  view_json TEXT NOT NULL CHECK(json_valid(view_json)),
  reservation_json TEXT CHECK(reservation_json IS NULL OR json_valid(reservation_json)),
  task_id TEXT UNIQUE REFERENCES judongche_draft_tasks(task_id),
  state TEXT NOT NULL CHECK(state IN ('queued','running','draft_saved','failed','needs_human','stopped','skipped')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(batch_id,ordinal),
  UNIQUE(batch_id,article_key),
  CHECK(state <> 'running' OR task_id IS NOT NULL)
);

INSERT INTO draft_batch_items SELECT * FROM stopped_batch_items_backup;
DROP TABLE stopped_batch_items_backup;
