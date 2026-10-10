-- agent-memory: namespaces + namespaced self-model
--
-- A namespace is a named scope (typically a project) whose memory is tracked
-- together. The registry below records names/descriptions and lets namespaces be
-- listed and shown; the scope keys themselves already live on events/memories.

CREATE TABLE IF NOT EXISTS namespaces (
  key         TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  id          TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  metadata    TEXT
);

CREATE INDEX IF NOT EXISTS idx_namespaces_type ON namespaces(type);
CREATE INDEX IF NOT EXISTS idx_namespaces_updated ON namespaces(updated_at DESC);

-- Scope the self-model so each namespace has its own identity/values/focus.
-- SQLite cannot alter a UNIQUE constraint in place, so rebuild the table and
-- carry existing (previously agent-global) entries over as `global` scope.

DROP INDEX IF EXISTS idx_self_model_agent;
ALTER TABLE self_model RENAME TO self_model_legacy;

CREATE TABLE self_model (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL DEFAULT 'global',
  scope_type TEXT NOT NULL DEFAULT 'global',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  importance REAL NOT NULL DEFAULT 0.7,
  source     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(agent_id, scope, key)
);

INSERT INTO self_model (id, agent_id, scope, scope_type, key, value, confidence, importance, source, created_at, updated_at)
  SELECT id, agent_id, 'global', 'global', key, value, confidence, importance, source, created_at, updated_at
  FROM self_model_legacy;

DROP TABLE self_model_legacy;

CREATE INDEX IF NOT EXISTS idx_self_model_agent ON self_model(agent_id);
CREATE INDEX IF NOT EXISTS idx_self_model_agent_scope ON self_model(agent_id, scope);
