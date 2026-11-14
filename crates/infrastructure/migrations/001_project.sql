CREATE TABLE IF NOT EXISTS project (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    working_revision INTEGER NOT NULL CHECK (working_revision >= 0),
    approved_baseline INTEGER
);
PRAGMA user_version = 1;
