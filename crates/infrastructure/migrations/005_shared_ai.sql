CREATE TABLE ai_execution_origin (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), origin_id TEXT NOT NULL, watermark INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ai_preparations (owner_id TEXT PRIMARY KEY);
CREATE TABLE ai_input_snapshots (input_hash TEXT PRIMARY KEY, object_hash TEXT NOT NULL, payload_retained INTEGER NOT NULL DEFAULT 1);
CREATE TABLE ai_runs (
 run_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
 input_hash TEXT NOT NULL REFERENCES ai_input_snapshots(input_hash), config_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
 attempt INTEGER NOT NULL DEFAULT 0, fence TEXT, error TEXT, result_json TEXT,
 receipt_digest TEXT, completion_json TEXT, retry_of_run_id TEXT REFERENCES ai_runs(run_id),
 consumer TEXT NOT NULL, binding_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE ai_attempts (run_id TEXT NOT NULL REFERENCES ai_runs(run_id), attempt INTEGER NOT NULL, fence TEXT NOT NULL UNIQUE, status TEXT NOT NULL, PRIMARY KEY(run_id,attempt));
CREATE TABLE ai_dispatches (run_id TEXT PRIMARY KEY REFERENCES ai_runs(run_id), attempt INTEGER NOT NULL, fence TEXT NOT NULL, input_hash TEXT NOT NULL, marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE ai_artifacts (run_id TEXT NOT NULL REFERENCES ai_runs(run_id), artifact_id TEXT NOT NULL, object_hash TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(run_id,artifact_id));
CREATE TABLE ai_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES ai_runs(run_id), status TEXT NOT NULL, error TEXT);
-- Opaque module records are staged by the owning transaction participant. The AI
-- runtime never interprets payloads or application decisions.
CREATE TABLE application_execution_bindings (owner TEXT NOT NULL,binding_id TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE REFERENCES ai_runs(run_id),payload TEXT NOT NULL, applicability TEXT NOT NULL CHECK(applicability IN ('pending','cancelled','applied')),PRIMARY KEY(owner,binding_id));
CREATE TABLE ai_consumer_cleanup (run_id TEXT PRIMARY KEY REFERENCES ai_runs(run_id), owner TEXT NOT NULL);
PRAGMA user_version = 5;
