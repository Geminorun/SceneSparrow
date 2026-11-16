CREATE TABLE review_threads(id TEXT PRIMARY KEY, high_water INTEGER NOT NULL, user_json TEXT NOT NULL, request_version INTEGER NOT NULL, request_hash TEXT NOT NULL, deleted INTEGER NOT NULL, handled INTEGER NOT NULL);
CREATE TABLE review_tasks(run_id TEXT PRIMARY KEY REFERENCES ai_runs(run_id), thread_id TEXT NOT NULL, request_version INTEGER NOT NULL, context_hash TEXT NOT NULL, application TEXT NOT NULL DEFAULT 'pending', error TEXT, answer TEXT, slot_heading TEXT, slot_after TEXT, operation TEXT NOT NULL);
CREATE INDEX review_tasks_thread ON review_tasks(thread_id);
CREATE TABLE review_candidates(id TEXT PRIMARY KEY, version INTEGER NOT NULL, thread_id TEXT NOT NULL, request_version INTEGER NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES review_tasks(run_id), payload_hash TEXT, status TEXT NOT NULL);
CREATE INDEX review_candidates_thread ON review_candidates(thread_id);
CREATE TABLE review_claims(block_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
CREATE TABLE review_reservations(block_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES review_tasks(run_id), PRIMARY KEY(block_id,run_id));
CREATE TABLE review_comparisons(block_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, candidate_id TEXT, payload_hash TEXT);
CREATE TABLE review_decisions(request_id TEXT PRIMARY KEY, candidate_ids_json TEXT NOT NULL, decision TEXT NOT NULL, history_entry_id TEXT NOT NULL);
PRAGMA user_version = 7;
CREATE TABLE review_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, request_version INTEGER NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, request_user_id TEXT NOT NULL);
CREATE INDEX review_messages_thread ON review_messages(thread_id,sequence);

CREATE TABLE history_entry_identities(position INTEGER PRIMARY KEY REFERENCES history_entries(position) ON DELETE CASCADE, entry_id TEXT NOT NULL UNIQUE);
INSERT INTO history_entry_identities SELECT position,lower(hex(randomblob(16))) FROM history_entries;
