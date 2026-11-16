CREATE TABLE sources (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE intakes (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, object_hash TEXT, status TEXT NOT NULL CHECK(status IN ('uploading','complete','cancelled')));
CREATE TABLE document_attempts (id TEXT PRIMARY KEY, attempt INTEGER NOT NULL, status TEXT NOT NULL, purpose TEXT NOT NULL, input_hash TEXT NOT NULL, display_name TEXT NOT NULL, base_revision INTEGER NOT NULL, source_id TEXT, result_hash TEXT, candidate_hash TEXT, error TEXT);
CREATE TABLE import_provenance (block_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, result_hash TEXT NOT NULL, parser TEXT NOT NULL);
CREATE TABLE external_object_pins (owner_id TEXT NOT NULL, object_hash TEXT NOT NULL, PRIMARY KEY(owner_id,object_hash));
PRAGMA user_version = 4;
