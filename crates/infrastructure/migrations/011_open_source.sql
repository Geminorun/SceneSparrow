-- Raw authored source belongs to the same receipt/history writer as metadata.
CREATE TABLE authored_source (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 project_id TEXT NOT NULL,
 relative_path TEXT NOT NULL,
 accepted_hash TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>=0)
);
CREATE TABLE source_operations (
 request_id TEXT PRIMARY KEY,
 digest TEXT NOT NULL,
 generation INTEGER NOT NULL,
 intent_hash TEXT NOT NULL
);
CREATE TABLE source_pins (owner_id TEXT PRIMARY KEY, source_hash TEXT NOT NULL);
PRAGMA user_version=11;
