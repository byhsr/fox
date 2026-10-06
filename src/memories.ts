import type { Db } from "./database.js";
import {
  MEMORY_COLUMNS,
  deserializeEmbedding,
  ensureAgent,
  newId,
  rowToMemory,
  serializeEmbedding,
  type CountRow,
  type MemoryRow,
} from "./schema.js";
import {
  MemoryStatus,
  addMemorySchema,
  listMemoriesSchema,
  normalizeScope,
  parseInput,
  scopeKeys,
  toEpochMs,
  updateMemorySchema,
  type AddMemoryInput,
  type ListMemoriesInput,
  type Memory,
  type MemoryKind,
  type ScopeLike,
  type UpdateMemoryInput,
} from "./types.js";
import { NotFoundError } from "./errors.js";

/** Durable, typed, retrievable memories. */
export class MemoryStore {
  constructor(private readonly db: Db) {}

  add(input: AddMemoryInput): Memory {
    const params = parseInput(addMemorySchema, input);
    const scope = normalizeScope(params.scope);
    const now = this.db.now();
    const embedding = params.embedding;
    const memory: Memory = {
      id: params.id ?? newId("mem"),
      agentId: params.agentId,
      scope: scope.key,
      scopeType: scope.type,
      kind: params.kind,
      status: params.status ?? MemoryStatus.Active,
      title: params.title,
      content: params.content,
      summary: params.summary ?? null,
      tags: params.tags ?? [],
      confidence: params.confidence ?? 0.5,
      importance: params.importance ?? 0.5,
      sourceEventIds: params.sourceEventIds ?? [],
      metadata: params.metadata ?? {},
      hasEmbedding: embedding !== undefined,
      embeddingModel: embedding !== undefined ? params.embeddingModel ?? null : null,
      embeddingDim: embedding !== undefined ? embedding.length : null,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      accessCount: 0,
      expiresAt: toNullableTime(params.expiresAt),
    };

    const insert = this.db.transaction(() => {
      ensureAgent(this.db, memory.agentId, now);
      this.db.run(
        `INSERT INTO memories (${MEMORY_COLUMNS}) VALUES (${placeholders(22)})`,
        memory.id,
        memory.agentId,
        memory.scope,
        memory.scopeType,
        memory.kind,
        memory.status,
        memory.title,
        memory.content,
        memory.summary,
        JSON.stringify(memory.tags),
        memory.confidence,
        memory.importance,
        JSON.stringify(memory.sourceEventIds),
        JSON.stringify(memory.metadata),
        embedding !== undefined ? serializeEmbedding(embedding) : null,
        memory.embeddingModel,
        memory.embeddingDim,
        memory.createdAt,
        memory.updatedAt,
        memory.lastAccessedAt,
        memory.accessCount,
        memory.expiresAt,
      );
    });
    insert();
    return memory;
  }

  get(id: string): Memory | undefined {
    const row = this.db.get<MemoryRow>(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`, id);
    return row ? rowToMemory(row) : undefined;
  }

  require(id: string): Memory {
    const memory = this.get(id);
    if (memory === undefined) throw new NotFoundError(`Memory not found: ${id}`);
    return memory;
  }

  update(id: string, patch: UpdateMemoryInput): Memory {
    const params = parseInput(updateMemorySchema, patch);
    const existing = this.require(id);
    const now = this.db.now();
    const sets: string[] = [];
    const args: unknown[] = [];

    if (params.title !== undefined) {
      sets.push("title = ?");
      args.push(params.title);
    }
    if (params.content !== undefined) {
      sets.push("content = ?");
      args.push(params.content);
    }
    if (params.summary !== undefined) {
      sets.push("summary = ?");
      args.push(params.summary);
    }
    if (params.kind !== undefined) {
      sets.push("kind = ?");
      args.push(params.kind);
    }
    if (params.status !== undefined) {
      sets.push("status = ?");
      args.push(params.status);
    }
    if (params.tags !== undefined) {
      sets.push("tags = ?");
      args.push(JSON.stringify(params.tags));
    }
    if (params.confidence !== undefined) {
      sets.push("confidence = ?");
      args.push(params.confidence);
    }
    if (params.importance !== undefined) {
      sets.push("importance = ?");
      args.push(params.importance);
    }
    if (params.sourceEventIds !== undefined) {
      sets.push("source_event_ids = ?");
      args.push(JSON.stringify(params.sourceEventIds));
    }
    if (params.metadata !== undefined) {
      sets.push("metadata = ?");
      args.push(JSON.stringify(params.metadata));
    }
    if (params.embedding !== undefined) {
      if (params.embedding === null) {
        sets.push("embedding = ?", "embedding_model = ?", "embedding_dim = ?");
        args.push(null, null, null);
      } else {
        sets.push("embedding = ?", "embedding_model = ?", "embedding_dim = ?");
        args.push(serializeEmbedding(params.embedding), params.embeddingModel ?? existing.embeddingModel, params.embedding.length);
      }
    } else if (params.embeddingModel !== undefined) {
      sets.push("embedding_model = ?");
      args.push(params.embeddingModel);
    }
    if (params.expiresAt !== undefined) {
      sets.push("expires_at = ?");
      args.push(toNullableTime(params.expiresAt));
    }

    sets.push("updated_at = ?");
    args.push(now);
    args.push(id);

    this.db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, ...args);
    return this.require(id);
  }

  archive(id: string): Memory {
    return this.update(id, { status: MemoryStatus.Archived });
  }

  forget(id: string): void {
    this.require(id);
    this.db.run("DELETE FROM memories WHERE id = ?", id);
  }

  list(input: ListMemoriesInput): Memory[] {
    const params = parseInput(listMemoriesSchema, input);
    const where: string[] = ["agent_id = ?"];
    const args: unknown[] = [params.agentId];

    if (params.scope !== undefined) {
      const keys = scopeKeys(params.scope, params.scopeMode ?? "inherit");
      where.push(`scope IN (${placeholders(keys.length)})`);
      args.push(...keys);
    }
    if (params.kinds !== undefined && params.kinds.length > 0) {
      where.push(`kind IN (${placeholders(params.kinds.length)})`);
      args.push(...params.kinds);
    }
    if (params.status !== undefined && params.status.length > 0) {
      where.push(`status IN (${placeholders(params.status.length)})`);
      args.push(...params.status);
    }
    if (params.tags !== undefined && params.tags.length > 0) {
      where.push(`EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE json_each.value IN (${placeholders(params.tags.length)}))`);
      args.push(...params.tags);
    }
    if (params.includeExpired !== true) {
      where.push("(expires_at IS NULL OR expires_at > ?)");
      args.push(this.db.now());
    }

    args.push(params.limit ?? 50, params.offset ?? 0);
    const sql = `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${where.join(" AND ")} ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?`;
    return this.db.all<MemoryRow>(sql, ...args).map(rowToMemory);
  }

  byKind(
    agentId: string,
    scope: ScopeLike,
    kinds: readonly MemoryKind[],
    limit: number,
    scopeMode: "exact" | "inherit" = "inherit",
  ): Memory[] {
    return this.list({ agentId, scope, kinds: [...kinds], limit, scopeMode, status: [MemoryStatus.Active] });
  }

  count(agentId: string, scope?: ScopeLike, scopeMode: "exact" | "inherit" = "inherit"): number {
    const where: string[] = ["agent_id = ?"];
    const args: unknown[] = [agentId];
    if (scope !== undefined) {
      const keys = scopeKeys(scope, scopeMode);
      where.push(`scope IN (${placeholders(keys.length)})`);
      args.push(...keys);
    }
    const row = this.db.get<CountRow>(`SELECT COUNT(*) AS count FROM memories WHERE ${where.join(" AND ")}`, ...args);
    return row?.count ?? 0;
  }

  getEmbeddings(ids: readonly string[]): Map<string, Float32Array> {
    const result = new Map<string, Float32Array>();
    if (ids.length === 0) return result;
    const rows = this.db.all<{ id: string; embedding: Buffer | null }>(
      `SELECT id, embedding FROM memories WHERE id IN (${placeholders(ids.length)})`,
      ...ids,
    );
    for (const row of rows) {
      const vector = deserializeEmbedding(row.embedding);
      if (vector !== null) result.set(row.id, vector);
    }
    return result;
  }

  markAccessed(ids: readonly string[], at: number): void {
    if (ids.length === 0) return;
    this.db.run(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders(ids.length)})`,
      at,
      ...ids,
    );
  }
}

function toNullableTime(value: Date | number | string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  return toEpochMs(value);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
