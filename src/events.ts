import type { Db } from "./database.js";
import { EVENT_COLUMNS, ensureAgent, newId, rowToEvent, type CountRow, type EventRow } from "./schema.js";
import {
  listEventsSchema,
  normalizeScope,
  parseInput,
  recordEventSchema,
  scopeKeys,
  toEpochMs,
  type Event,
  type ListEventsInput,
  type RecordEventInput,
  type ScopeLike,
} from "./types.js";

/** Append-only store for raw episodes. */
export class EventStore {
  constructor(private readonly db: Db) {}

  record(input: RecordEventInput): Event {
    const params = parseInput(recordEventSchema, input);
    const scope = normalizeScope(params.scope);
    const now = this.db.now();
    const event: Event = {
      id: params.id ?? newId("evt"),
      agentId: params.agentId,
      scope: scope.key,
      scopeType: scope.type,
      type: params.type,
      role: params.role ?? null,
      content: params.content,
      data: params.data ?? {},
      importance: params.importance ?? 0.5,
      occurredAt: params.occurredAt !== undefined ? toEpochMs(params.occurredAt) : now,
      createdAt: now,
    };

    const insert = this.db.transaction(() => {
      ensureAgent(this.db, event.agentId, now);
      this.db.run(
        `INSERT INTO events (${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.agentId,
        event.scope,
        event.scopeType,
        event.type,
        event.role,
        event.content,
        JSON.stringify(event.data),
        event.importance,
        event.occurredAt,
        event.createdAt,
      );
    });
    insert();
    return event;
  }

  get(id: string): Event | undefined {
    const row = this.db.get<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`, id);
    return row ? rowToEvent(row) : undefined;
  }

  list(input: ListEventsInput): Event[] {
    const params = parseInput(listEventsSchema, input);
    const where: string[] = ["agent_id = ?"];
    const args: unknown[] = [params.agentId];

    if (params.scope !== undefined) {
      const keys = scopeKeys(params.scope, params.scopeMode ?? "inherit");
      where.push(`scope IN (${placeholders(keys.length)})`);
      args.push(...keys);
    }
    if (params.types !== undefined && params.types.length > 0) {
      where.push(`type IN (${placeholders(params.types.length)})`);
      args.push(...params.types);
    }
    if (params.since !== undefined) {
      where.push("occurred_at >= ?");
      args.push(toEpochMs(params.since));
    }
    if (params.until !== undefined) {
      where.push("occurred_at <= ?");
      args.push(toEpochMs(params.until));
    }

    args.push(params.limit ?? 50, params.offset ?? 0);
    const sql = `SELECT ${EVENT_COLUMNS} FROM events WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    return this.db.all<EventRow>(sql, ...args).map(rowToEvent);
  }

  /** Most recent events within a scope, used to build episodic context. */
  recent(agentId: string, scope: ScopeLike, limit: number, scopeMode: "exact" | "inherit" = "inherit"): Event[] {
    return this.list({ agentId, scope, limit, scopeMode });
  }

  count(agentId: string, scope?: ScopeLike, scopeMode: "exact" | "inherit" = "inherit"): number {
    const where: string[] = ["agent_id = ?"];
    const args: unknown[] = [agentId];
    if (scope !== undefined) {
      const keys = scopeKeys(scope, scopeMode);
      where.push(`scope IN (${placeholders(keys.length)})`);
      args.push(...keys);
    }
    const row = this.db.get<CountRow>(`SELECT COUNT(*) AS count FROM events WHERE ${where.join(" AND ")}`, ...args);
    return row?.count ?? 0;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
