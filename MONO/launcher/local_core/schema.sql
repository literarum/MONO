PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,trashed INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_created ON records(created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS segments(record_id TEXT NOT NULL REFERENCES records(id),track TEXT NOT NULL,idx INTEGER NOT NULL,frames INTEGER NOT NULL,sha256 TEXT NOT NULL,relative_path TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(record_id,track,idx));
PRAGMA user_version=1;
