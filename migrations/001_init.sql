-- agent-memory: initial schema
-- All timestamps are stored as epoch milliseconds (INTEGER).
-- All structured payloads are stored as JSON TEXT.

CREATE TABLE IF NOT EXISTS agents (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata   TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  scope_type  TEXT NOT NULL,
  type        TEXT NOT NULL,
  role        TEXT,
  content     TEXT NOT NULL,
  data        TEXT,
  importance  REAL NOT NULL DEFAULT 0.5,
  occurred_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_agent_scope_time ON events(agent_id, scope, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_agent_type_time ON events(agent_id, type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope            TEXT NOT NULL,
  scope_type       TEXT NOT NULL,
  kind             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  summary          TEXT,
  tags             TEXT,
  confidence       REAL NOT NULL DEFAULT 0.5,
  importance       REAL NOT NULL DEFAULT 0.5,
  source_event_ids TEXT,
  metadata         TEXT,
  embedding        BLOB,
  embedding_model  TEXT,
  embedding_dim    INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_accessed_at INTEGER,
  access_count     INTEGER NOT NULL DEFAULT 0,
  expires_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memories_agent_scope_kind ON memories(agent_id, scope, kind, status);
CREATE INDEX IF NOT EXISTS idx_memories_agent_status ON memories(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(agent_id, kind, status);

CREATE TABLE IF NOT EXISTS memory_links (
  id             TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation       TEXT NOT NULL,
  weight         REAL NOT NULL DEFAULT 1.0,
  created_at     INTEGER NOT NULL,
  UNIQUE(from_memory_id, to_memory_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_memory_id);

CREATE TABLE IF NOT EXISTS self_model (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  importance REAL NOT NULL DEFAULT 0.7,
  source     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(agent_id, key)
);

CREATE INDEX IF NOT EXISTS idx_self_model_agent ON self_model(agent_id);

-- Lexical retrieval over memories (external-content FTS5).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  content,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Lexical retrieval over raw episodes (external-content FTS5).
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content,
  content='events',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, COALESCE(new.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags, ''));
  INSERT INTO memories_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, COALESCE(new.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO events_fts(rowid, content) VALUES (new.rowid, new.content);
END;
