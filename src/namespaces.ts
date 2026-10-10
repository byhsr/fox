import type { Db } from "./database.js";
import {
  EVENT_COLUMNS,
  MEMORY_COLUMNS,
  NAMESPACE_COLUMNS,
  SELF_MODEL_COLUMNS,
  rowToEvent,
  rowToMemory,
  rowToNamespace,
  rowToSelfModel,
  type EventRow,
  type MemoryRow,
  type NamespaceRow,
  type SelfModelRow,
} from "./schema.js";
import {
  createNamespaceSchema,
  getNamespaceSchema,
  listNamespacesSchema,
  normalizeScope,
  parseInput,
  type CreateNamespaceInput,
  type GetNamespaceInput,
  type ListNamespacesInput,
  type Namespace,
  type NamespaceDetail,
  type NamespaceSummary,
  type ScopeInput,
} from "./types.js";

interface NamespaceSummaryRow extends NamespaceRow {
  event_count: number;
  memory_count: number;
  self_model_count: number;
  last_activity: number | null;
}

const SUMMARY_SELECT = `SELECT ${NAMESPACE_COLUMNS.split(", ")
  .map((column) => `n.${column}`)
  .join(", ")},
  (SELECT COUNT(*) FROM events e WHERE e.scope = n.key) AS event_count,
  (SELECT COUNT(*) FROM memories m WHERE m.scope = n.key) AS memory_count,
  (SELECT COUNT(*) FROM self_model s WHERE s.scope = n.key) AS self_model_count,
  NULLIF(MAX(
    COALESCE((SELECT MAX(e.occurred_at) FROM events e WHERE e.scope = n.key), 0),
    COALESCE((SELECT MAX(m.updated_at) FROM memories m WHERE m.scope = n.key), 0),
    COALESCE((SELECT MAX(s.updated_at) FROM self_model s WHERE s.scope = n.key), 0)
  ), 0) AS last_activity
  FROM namespaces n`;

/**
 * A registry of namespaces: named scopes (typically projects) whose memory is
 * tracked together. The registry stores name/description metadata and derives
 * live counts and last-activity from the scoped events, memories, and
 * self-model entries, so "everything tracked there" is always current.
 */
export class NamespaceStore {
  constructor(private readonly db: Db) {}

  /** Create or update a namespace registration. */
  create(input: CreateNamespaceInput): Namespace {
    const params = parseInput(createNamespaceSchema, input);
    const resolved = normalizeScope(params.scope);
    const now = this.db.now();
    const existing = this.get(resolved.key);
    const namespace: Namespace = {
      key: resolved.key,
      type: resolved.type,
      id: resolved.id,
      name: params.name ?? existing?.name ?? resolved.id ?? resolved.type,
      description: params.description ?? existing?.description ?? null,
      metadata: params.metadata ?? existing?.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.db.run(
      `INSERT INTO namespaces (${NAMESPACE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         metadata = excluded.metadata,
         updated_at = excluded.updated_at`,
      namespace.key,
      namespace.type,
      namespace.id,
      namespace.name,
      namespace.description,
      JSON.stringify(namespace.metadata),
      namespace.createdAt,
      namespace.updatedAt,
    );
    return namespace;
  }

  get(scope: ScopeInput): Namespace | undefined {
    const key = normalizeScope(scope).key;
    const row = this.db.get<NamespaceRow>(`SELECT ${NAMESPACE_COLUMNS} FROM namespaces WHERE key = ?`, key);
    return row ? rowToNamespace(row) : undefined;
  }

  /** All registered namespaces with their counts and last activity. */
  list(input: ListNamespacesInput = {}): NamespaceSummary[] {
    const params = parseInput(listNamespacesSchema, input);
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.type !== undefined) {
      where.push("n.type = ?");
      args.push(params.type);
    }
    if (params.query !== undefined) {
      where.push("(n.name LIKE ? OR n.key LIKE ? OR n.description LIKE ?)");
      const like = `%${params.query}%`;
      args.push(like, like, like);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    args.push(params.limit ?? 100);
    const sql = `${SUMMARY_SELECT}${clause} ORDER BY last_activity IS NULL, last_activity DESC, n.updated_at DESC LIMIT ?`;
    return this.db.all<NamespaceSummaryRow>(sql, ...args).map(rowToSummary);
  }

  /** A namespace plus its counts and last activity. */
  summary(scope: ScopeInput): NamespaceSummary | undefined {
    const key = normalizeScope(scope).key;
    const row = this.db.get<NamespaceSummaryRow>(`${SUMMARY_SELECT} WHERE n.key = ?`, key);
    return row ? rowToSummary(row) : undefined;
  }

  /** Everything tracked in a namespace: summary plus recent entries. */
  detail(input: GetNamespaceInput): NamespaceDetail | undefined {
    const params = parseInput(getNamespaceSchema, input);
    const summary = this.summary(params.scope);
    if (summary === undefined) return undefined;
    const key = summary.namespace.key;

    const selfModel = this.db
      .all<SelfModelRow>(`SELECT ${SELF_MODEL_COLUMNS} FROM self_model WHERE scope = ? ORDER BY importance DESC, key ASC`, key)
      .map(rowToSelfModel);
    const memories = this.db
      .all<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM memories WHERE scope = ? ORDER BY importance DESC, updated_at DESC LIMIT ?`,
        key,
        params.memoryLimit ?? 20,
      )
      .map(rowToMemory);
    const events = this.db
      .all<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM events WHERE scope = ? ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
        key,
        params.eventLimit ?? 20,
      )
      .map(rowToEvent);

    return { ...summary, selfModel, memories, events };
  }

  /** Unregister a namespace. Tracked memory is left in place. */
  remove(scope: ScopeInput): boolean {
    const key = normalizeScope(scope).key;
    return this.db.run("DELETE FROM namespaces WHERE key = ?", key).changes > 0;
  }
}

function rowToSummary(row: NamespaceSummaryRow): NamespaceSummary {
  return {
    namespace: rowToNamespace(row),
    counts: {
      events: row.event_count,
      memories: row.memory_count,
      selfModelEntries: row.self_model_count,
    },
    lastActivityAt: row.last_activity,
  };
}
