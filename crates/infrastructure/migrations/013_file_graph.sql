-- File graphs share the ordinary writer, receipt and five-transition history.
CREATE TABLE accepted_file_graph (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 graph_hash TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>=0)
);
CREATE TABLE history_file_graphs (
 entry_id TEXT PRIMARY KEY,
 before_hash TEXT NOT NULL,
 after_hash TEXT NOT NULL
);
CREATE TABLE approved_file_graphs (
 baseline_id TEXT PRIMARY KEY,
 graph_hash TEXT NOT NULL,
 capture_kind TEXT NOT NULL CHECK(capture_kind IN ('registration','approval'))
);
-- Deliberate graph roots also provide the extension for recorded work items.
CREATE TABLE file_graph_pins (
 owner_id TEXT PRIMARY KEY,
 graph_hash TEXT NOT NULL,
 capture_kind TEXT NOT NULL DEFAULT 'operation' CHECK(capture_kind IN ('operation','registration','downstream'))
);
CREATE TABLE graph_recovery_decisions (
 intent_hash TEXT PRIMARY KEY,
 request_id TEXT NOT NULL,
 digest TEXT NOT NULL,
 recovery_digest TEXT NOT NULL,
 graph_hash TEXT NOT NULL,
 generation INTEGER NOT NULL,
 committed INTEGER NOT NULL,
 observation_fingerprint TEXT NOT NULL
);
CREATE TABLE graph_recovery_members (
 intent_hash TEXT NOT NULL REFERENCES graph_recovery_decisions(intent_hash),
 relative_path TEXT NOT NULL,
 role TEXT NOT NULL,
 object_hash TEXT NOT NULL,
 byte_size INTEGER NOT NULL,
 PRIMARY KEY(intent_hash,relative_path,role,object_hash)
);
PRAGMA user_version=13;
