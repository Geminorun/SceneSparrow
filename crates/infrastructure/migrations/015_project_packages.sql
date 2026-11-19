-- Trusted local provenance is independent of archive-supplied descriptors.
CREATE TABLE package_exports (
 export_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, base_json TEXT NOT NULL,
 capture_state TEXT NOT NULL, inventory_hash TEXT, roots_hash TEXT, capture_store TEXT, capture_token TEXT, capture_owner TEXT, capture_failure TEXT, capture_expires_at INTEGER, materialized_token TEXT
);
-- A copied terminal outcome remains immutable; filesystem availability is separate.
CREATE TABLE work_copy_availability (item_id TEXT PRIMARY KEY, available INTEGER NOT NULL CHECK(available IN (0,1)));
CREATE TABLE work_package_candidates (candidate_id TEXT PRIMARY KEY);
CREATE TABLE work_package_returns (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, item_id TEXT NOT NULL);
PRAGMA user_version=15;
CREATE TABLE package_intake_leases (request_id TEXT PRIMARY KEY,intake_id TEXT NOT NULL,candidate_id TEXT NOT NULL,retain_until INTEGER);
CREATE TRIGGER package_intake_decision_retention AFTER UPDATE OF disposition ON work_candidates
WHEN NEW.disposition!='pending'
BEGIN UPDATE package_intake_leases SET retain_until=CAST(unixepoch('subsec')*1000 AS INTEGER)+604800000 WHERE candidate_id=NEW.id; END;

CREATE TABLE package_capture_pins (export_id TEXT NOT NULL,object_hash TEXT NOT NULL,PRIMARY KEY(export_id,object_hash));

CREATE INDEX package_capture_pending_state ON package_exports(capture_state);
CREATE INDEX package_capture_expiry ON package_exports(capture_owner,capture_expires_at) WHERE roots_hash IS NOT NULL;
