-- Operational identities survive bulk payload disposition and interrupted workers.
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, origin TEXT NOT NULL,
 base_hash TEXT NOT NULL, base_generation INTEGER NOT NULL, creation_revision INTEGER NOT NULL,
 grant_json TEXT NOT NULL, reference_ids_json TEXT NOT NULL, context_json TEXT NOT NULL,
 revision INTEGER NOT NULL, state TEXT NOT NULL, operation_id TEXT NOT NULL,
 latest_candidate TEXT
);
CREATE TABLE work_operations (
 request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, payload_json TEXT NOT NULL,
 project_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
 failure_code TEXT, progress INTEGER NOT NULL DEFAULT 0, candidate_json TEXT
);
CREATE TABLE work_candidates (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL, digest TEXT NOT NULL, raw_hash TEXT NOT NULL,
 prepared_hash TEXT NOT NULL, preparation_json TEXT NOT NULL, observation_json TEXT,
 inspected_revision INTEGER NOT NULL, graph_generation INTEGER NOT NULL, view_json TEXT NOT NULL,
 changes_json TEXT NOT NULL, disposition TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE work_copy_locations (
 item_id TEXT PRIMARY KEY, identity_json TEXT NOT NULL,
 cleanup_state TEXT NOT NULL DEFAULT 'owned', cleanup_stage TEXT
);
CREATE TABLE work_preparations (
 item_id TEXT NOT NULL, raw_hash TEXT NOT NULL, preparation_json TEXT NOT NULL,
 PRIMARY KEY(item_id,raw_hash)
);
CREATE TABLE production_file_locks (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL);
-- Stable history identities, never mutable cursor positions.
CREATE TABLE history_production_locks (entry_id TEXT PRIMARY KEY, before_json TEXT NOT NULL, after_json TEXT NOT NULL);
PRAGMA user_version=14;
