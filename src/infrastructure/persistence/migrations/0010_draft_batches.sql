CREATE TABLE draft_batches (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK(platform = 'judongche'),
  store_key TEXT NOT NULL,
  store_name TEXT NOT NULL,
  seed_json TEXT NOT NULL CHECK(json_valid(seed_json)),
  state TEXT NOT NULL CHECK(state IN ('prepared','running','paused','stopped','completed','interrupted')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  stop_requested INTEGER NOT NULL CHECK(stop_requested IN (0,1)),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_draft_batch ON draft_batches(platform)
  WHERE state IN ('prepared','running','paused','interrupted');
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
