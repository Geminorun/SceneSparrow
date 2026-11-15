CREATE TABLE manuscripts (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 id TEXT NOT NULL UNIQUE,
 workspace_stage TEXT NOT NULL CHECK(workspace_stage IN ('outline','draft')),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 working_revision INTEGER NOT NULL,
 snapshot_hash TEXT
);
CREATE TABLE object_identities (id TEXT PRIMARY KEY, object_type TEXT NOT NULL, high_water INTEGER NOT NULL, tombstoned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE content_revisions (object_id TEXT NOT NULL REFERENCES object_identities(id), revision INTEGER NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY(object_id, revision));
CREATE TABLE blocks (id TEXT PRIMARY KEY REFERENCES object_identities(id), manuscript_id TEXT NOT NULL REFERENCES manuscripts(id), position INTEGER NOT NULL UNIQUE, revision INTEGER NOT NULL, payload_hash TEXT NOT NULL);
CREATE TABLE command_receipts (request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, outcome_json TEXT NOT NULL);
CREATE TABLE project_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE edit_groups (group_id TEXT PRIMARY KEY, client_session_id TEXT NOT NULL, group_sequence INTEGER NOT NULL, kind TEXT NOT NULL, before_hash TEXT, after_hash TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
PRAGMA user_version = 2;
