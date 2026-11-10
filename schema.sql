CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'gotcha', 'convention', 'decision')),
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  hits INTEGER NOT NULL DEFAULT 0,
  provenance TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_hit_at TEXT,
  retired_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS notes_unique ON notes (scope, IFNULL(project_id, 0), kind, fingerprint);
CREATE INDEX IF NOT EXISTS notes_live ON notes (scope, project_id, retired_at);

CREATE TABLE IF NOT EXISTS note_hits (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  hit_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS note_hits_note ON note_hits (note_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  diary TEXT,
  distilled_at TEXT
);

CREATE TABLE IF NOT EXISTS dream_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  rejected_at TEXT,
  inserted INTEGER NOT NULL DEFAULT 0,
  merged INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0,
  promoted INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  source_fork TEXT,
  source_path TEXT
);

CREATE TABLE IF NOT EXISTS staged (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES dream_runs(id) ON DELETE CASCADE,
  op TEXT NOT NULL CHECK (op IN ('insert', 'merge', 'update', 'retire', 'promote')),
  project_slug TEXT,
  scope TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('project', 'global')),
  kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact', 'gotcha', 'convention', 'decision')),
  body TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  provenance TEXT NOT NULL DEFAULT '',
  target_id INTEGER,
  target_version INTEGER,
  reason TEXT,
  examples TEXT,
  prevalence TEXT,
  session_id TEXT,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS staged_run ON staged (run_id, applied_at);

CREATE TABLE IF NOT EXISTS run_sessions (
  run_id INTEGER NOT NULL REFERENCES dream_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  PRIMARY KEY (run_id, session_id)
);

CREATE TABLE IF NOT EXISTS note_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'gotcha', 'convention', 'decision')),
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  confidence REAL NOT NULL,
  provenance TEXT NOT NULL,
  retired_at TEXT,
  run_id INTEGER REFERENCES dream_runs(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  cause TEXT NOT NULL CHECK (cause IN ('update', 'promote', 'revert')),
  updated_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS note_revisions_note ON note_revisions (note_id, id DESC);
CREATE INDEX IF NOT EXISTS note_revisions_run ON note_revisions (run_id);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(body, content = 'notes', content_rowid = 'id');

CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE OF body ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO notes_fts (rowid, body) VALUES (new.id, new.body);
END;
