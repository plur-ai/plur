-- Hand-written fixture mirroring Gentleman-Programming/engram's SQLite schema
-- (internal/store/store.go migrate() DDL, trimmed to the tables the importer
-- reads: sessions + observations). No network involved — tests build a .db
-- from this file with better-sqlite3 in beforeAll.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  directory  TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT,
  summary    TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id         TEXT,
  session_id      TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  tool_name       TEXT,
  project         TEXT,
  scope           TEXT    NOT NULL DEFAULT 'project',
  topic_key       TEXT,
  normalized_hash TEXT,
  revision_count  INTEGER NOT NULL DEFAULT 1,
  duplicate_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at    TEXT,
  review_after    TEXT,
  expires_at      TEXT,
  pinned          BOOLEAN NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

INSERT INTO sessions (id, project, directory, started_at, ended_at, summary) VALUES
  ('sess-1', 'acme-api', '/home/dev/acme-api', '2025-12-01 09:00:00', NULL, NULL);

INSERT INTO observations
  (id, sync_id, session_id, type, title, content, tool_name, project, scope, topic_key,
   normalized_hash, revision_count, duplicate_count, last_seen_at, review_after, expires_at, pinned,
   created_at, updated_at, deleted_at)
VALUES
  (1, NULL, 'sess-1', 'decision', 'Use SQLite for local persistence',
   'Chose SQLite over Postgres for zero-config local storage',
   NULL, 'acme-api', 'project', 'decision/storage',
   'h1', 1, 1, '2025-12-02 10:00:00', '2026-06-01 09:15:00', NULL, 0,
   '2025-12-01 09:15:00', '2025-12-01 09:15:00', NULL),
  (2, NULL, 'sess-1', 'pattern', 'Error wrapping convention',
   'Wrap errors with fmt.Errorf and %w so callers can unwrap',
   NULL, 'acme-api', 'project', 'pattern/errors',
   'h2', 1, 2, NULL, NULL, NULL, 1,
   '2025-12-01 10:00:00', '2025-12-01 10:00:00', NULL),
  (3, NULL, 'sess-1', 'config', 'CI runs on push to main',
   'GitHub Actions workflow triggers on every push to main',
   'Bash', NULL, 'global', 'config/ci',
   'h3', 1, 1, NULL, NULL, '2026-12-31 00:00:00', 0,
   '2025-12-01 11:00:00', '2025-12-01 11:00:00', NULL),
  (4, NULL, 'sess-1', 'bugfix', 'Deleted observation',
   'This observation is soft-deleted and must not be imported',
   NULL, 'acme-api', 'project', 'bug/deleted',
   'h4', 1, 1, NULL, NULL, NULL, 0,
   '2025-12-01 12:00:00', '2025-12-05 12:00:00', '2025-12-05 12:00:00');
