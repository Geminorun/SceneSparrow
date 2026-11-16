CREATE TABLE export_jobs (
 id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, format TEXT NOT NULL,
 status TEXT NOT NULL, attempt INTEGER NOT NULL, snapshot_hash TEXT NOT NULL,
 body_hash TEXT NOT NULL, captured_revision INTEGER NOT NULL,
 filename TEXT NOT NULL, artifact_hash TEXT, size INTEGER NOT NULL DEFAULT 0,
 captured_baseline TEXT,
 retain_until INTEGER NOT NULL DEFAULT (unixepoch()*1000+600000),
 error TEXT, input_retained INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE export_controls (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, job_id TEXT NOT NULL);
CREATE TABLE export_deliveries (delivery_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, artifact_hash TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
PRAGMA user_version = 9;

CREATE TABLE copy_preparations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,snapshot_hash TEXT NOT NULL,body_hash TEXT NOT NULL,captured_revision INTEGER NOT NULL,payload_hash TEXT,expires_at INTEGER NOT NULL);
