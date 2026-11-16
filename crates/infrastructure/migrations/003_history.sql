-- Applied drafts start at their current acknowledged state; no past actions are invented.
CREATE TABLE history_cursor (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 history_revision INTEGER NOT NULL CHECK(history_revision>=0),
 cursor INTEGER NOT NULL CHECK(cursor BETWEEN 0 AND 5)
);
INSERT INTO history_cursor VALUES(1,0,0);
CREATE TABLE history_entries (
 position INTEGER PRIMARY KEY CHECK(position BETWEEN 1 AND 5),
 before_hash TEXT NOT NULL,
 after_hash TEXT NOT NULL,
 affected_json TEXT NOT NULL,
 label TEXT NOT NULL,
 group_id TEXT
);
ALTER TABLE edit_groups ADD COLUMN scope_block_id TEXT;
ALTER TABLE edit_groups ADD COLUMN last_commit_ms INTEGER NOT NULL DEFAULT 0;
UPDATE edit_groups SET closed=1,before_hash=NULL,after_hash='';
PRAGMA user_version = 3;
