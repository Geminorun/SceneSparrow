-- Keep compact receipts for the project lifetime: pruning request identities would
-- allow an ambiguous old retry to overwrite a later rename after an ABA title cycle.
-- These are metadata receipts, not manuscript history or retained content objects.
CREATE TABLE project_rename_receipts (
    sequence INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES project(id),
    previous_title TEXT NOT NULL,
    title TEXT NOT NULL
);
PRAGMA user_version = 10;
