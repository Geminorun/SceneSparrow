CREATE TABLE source_candidates (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 base_hash TEXT NOT NULL,
 base_generation INTEGER NOT NULL,
 live_hash TEXT,
 physical_identity TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 validation_error TEXT,
 disposition TEXT NOT NULL DEFAULT 'pending',
 explicitly_retained INTEGER NOT NULL DEFAULT 0 CHECK(explicitly_retained IN (0,1)),
 observed_sequence INTEGER NOT NULL DEFAULT 0,
 UNIQUE(project_id,base_hash,base_generation,live_hash,physical_identity)
);
CREATE TABLE source_candidate_observation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), current_candidate_id TEXT, sequence INTEGER NOT NULL DEFAULT 0);
INSERT INTO source_candidate_observation(singleton) VALUES(1);
ALTER TABLE export_jobs ADD COLUMN serializer_version TEXT NOT NULL DEFAULT 'canonical-1';
PRAGMA user_version=12;
CREATE TABLE source_recovery_decisions (
 intent_hash TEXT PRIMARY KEY,
 request_id TEXT NOT NULL,
 digest TEXT NOT NULL,
 recovery_digest TEXT NOT NULL,
 project_id TEXT NOT NULL,
 accepted_hash TEXT NOT NULL,
 generation INTEGER NOT NULL,
 committed INTEGER NOT NULL,
 observation_fingerprint TEXT NOT NULL
);
CREATE TABLE source_recovery_evidence (
 intent_hash TEXT NOT NULL REFERENCES source_recovery_decisions(intent_hash),
 source_hash TEXT NOT NULL,
 role TEXT NOT NULL,
 PRIMARY KEY(intent_hash,source_hash,role)
);
