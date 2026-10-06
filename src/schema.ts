import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import type { Db } from "./database.js";
import { MigrationError } from "./errors.js";
import type { Event, Memory, MemoryKind, MemoryStatus, ScopeType, SelfModelEntry } from "./types.js";

/** Ordered list of migration files under `migrations/`. */
export const MIGRATIONS: readonly string[] = ["001_init.sql"];

export const MEMORY_COLUMNS = [
  "id",
  "agent_id",
  "scope",
  "scope_type",
  "kind",
  "status",
  "title",
  "content",
  "summary",
  "tags",
  "confidence",
  "importance",
  "source_event_ids",
  "metadata",
  "embedding",
  "embedding_model",
  "embedding_dim",
  "created_at",
  "updated_at",
  "last_accessed_at",
  "access_count",
  "expires_at",
].join(", ");

export const EVENT_COLUMNS = [
  "id",
  "agent_id",
  "scope",
  "scope_type",
  "type",
  "role",
  "content",
  "data",
  "importance",
  "occurred_at",
  "created_at",
].join(", ");

export const SELF_MODEL_COLUMNS = [
  "id",
  "agent_id",
  "key",
  "value",
  "confidence",
  "importance",
  "source",
  "created_at",
  "updated_at",
].join(", ");

// --- row shapes -------------------------------------------------------------

export interface EventRow {
  id: string;
  agent_id: string;
  scope: string;
  scope_type: string;
  type: string;
  role: string | null;
  content: string;
  data: string | null;
  importance: number;
  occurred_at: number;
  created_at: number;
}

export interface MemoryRow {
  id: string;
  agent_id: string;
  scope: string;
  scope_type: string;
  kind: string;
  status: string;
  title: string;
  content: string;
  summary: string | null;
  tags: string | null;
  confidence: number;
  importance: number;
  source_event_ids: string | null;
  metadata: string | null;
  embedding: Buffer | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
  access_count: number;
  expires_at: number | null;
}

export interface SelfModelRow {
  id: string;
  agent_id: string;
  key: string;
  value: string;
  confidence: number;
  importance: number;
  source: string | null;
  created_at: number;
  updated_at: number;
}

export interface IdRow {
  id: string;
}

export interface CountRow {
  count: number;
}

// --- mappers ----------------------------------------------------------------

export function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    agentId: row.agent_id,
    scope: row.scope,
    scopeType: row.scope_type as ScopeType,
    type: row.type,
    role: row.role,
    content: row.content,
    data: parseJson(row.data, {}),
    importance: row.importance,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

export function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    agentId: row.agent_id,
    scope: row.scope,
    scopeType: row.scope_type as ScopeType,
    kind: row.kind as MemoryKind,
    status: row.status as MemoryStatus,
    title: row.title,
    content: row.content,
    summary: row.summary,
    tags: parseJson<string[]>(row.tags, []),
    confidence: row.confidence,
    importance: row.importance,
    sourceEventIds: parseJson<string[]>(row.source_event_ids, []),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    hasEmbedding: row.embedding !== null && row.embedding !== undefined,
    embeddingModel: row.embedding_model,
    embeddingDim: row.embedding_dim,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    expiresAt: row.expires_at,
  };
}

export function rowToSelfModel(row: SelfModelRow): SelfModelEntry {
  return {
    id: row.id,
    agentId: row.agent_id,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    importance: row.importance,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- helpers ----------------------------------------------------------------

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function serializeEmbedding(values: readonly number[]): Buffer {
  const vector = new Float32Array(values);
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function deserializeEmbedding(value: Buffer | Uint8Array | null): Float32Array | null {
  if (value === null || value === undefined) return null;
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (source.byteLength === 0 || source.byteLength % 4 !== 0) return null;
  // Copy into a fresh, 4-byte-aligned buffer before viewing as Float32Array.
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return new Float32Array(copy.buffer, 0, source.byteLength / 4);
}

export function ensureAgent(db: Db, agentId: string, now: number): void {
  db.run("INSERT OR IGNORE INTO agents(id, created_at, updated_at) VALUES (?, ?, ?)", agentId, now, now);
}

// --- migrations -------------------------------------------------------------

export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

export function loadMigrationSql(version: string): string {
  const file = join(migrationsDir(), version);
  if (!existsSync(file)) {
    throw new MigrationError(`Migration file not found: ${file}`);
  }
  return readFileSync(file, "utf8");
}

export function runMigrations(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);");
  const appliedRows = db.all<{ version: string }>("SELECT version FROM schema_migrations");
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const version of MIGRATIONS) {
    if (applied.has(version)) continue;
    const sql = loadMigrationSql(version);
    const apply = db.transaction(() => {
      db.exec(sql);
      db.run("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", version, db.now());
    });
    try {
      apply();
    } catch (cause) {
      throw new MigrationError(`Failed to apply migration ${version}`, { cause });
    }
    applied.add(version);
  }
}
