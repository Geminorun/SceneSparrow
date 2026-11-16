CREATE TABLE user_locks (
  block_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  action_id TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE approved_manifests (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  manifest_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE approved_manifest_history (
 history_entry_id TEXT NOT NULL,
 baseline_id TEXT NOT NULL REFERENCES approved_manifests(id),
 PRIMARY KEY(history_entry_id,baseline_id)
);
CREATE TABLE manuscript_baseline (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  baseline_id TEXT REFERENCES approved_manifests(id)
);
INSERT INTO manuscript_baseline VALUES(1,NULL);
-- Legacy provisional approval numbers do not prove any exact user-locked body.
UPDATE project SET approved_baseline=NULL;
CREATE TABLE review_candidate_bindings (
  candidate_id TEXT PRIMARY KEY REFERENCES review_candidates(id),
  request_version INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  tokens TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  history_entry_id TEXT NOT NULL
);
CREATE TABLE review_history_evidence (
 history_entry_id TEXT NOT NULL,
 thread_id TEXT NOT NULL,
 candidate_id TEXT NOT NULL REFERENCES review_candidates(id),
 PRIMARY KEY(history_entry_id,thread_id)
);
CREATE TABLE downstream_inputs (
  id TEXT PRIMARY KEY,
  baseline_id TEXT NOT NULL REFERENCES approved_manifests(id),
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('using','complete','cancelled')),
  fence TEXT NOT NULL,
  expires_ms INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  outdated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE downstream_dependencies (
  consumer_id TEXT NOT NULL REFERENCES downstream_inputs(id),
  block_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(consumer_id,block_id)
);
PRAGMA user_version=8;
