import type { Db } from "./database.js";
import { SELF_MODEL_COLUMNS, ensureAgent, newId, rowToSelfModel, type CountRow, type SelfModelRow } from "./schema.js";
import {
  normalizeScope,
  parseInput,
  scopeKeys,
  setSelfModelSchema,
  type ScopeInput,
  type SelfModelEntry,
  type SetSelfModelInput,
} from "./types.js";

const GLOBAL_SCOPE = { type: "global" as const, id: null };

/**
 * The persistent self-model: a small, canonical set of keyed entries that
 * describe who the agent is (identity, values, capabilities, current focus).
 *
 * Entries are scoped. Keys are unique per (agent, scope); setting a key upserts
 * it. Reads default to `inherit`, so a namespaced read also sees `global`
 * entries (shared identity) unless `exact` is requested.
 */
export class SelfModelStore {
  constructor(private readonly db: Db) {}

  set(input: SetSelfModelInput): SelfModelEntry {
    const params = parseInput(setSelfModelSchema, input);
    const scope = normalizeScope(params.scope ?? GLOBAL_SCOPE);
    const now = this.db.now();
    const existing = this.get(params.agentId, params.key, scope.key);
    const entry: SelfModelEntry = {
      id: existing?.id ?? newId("slf"),
      agentId: params.agentId,
      scope: scope.key,
      scopeType: scope.type,
      key: params.key,
      value: params.value,
      confidence: params.confidence ?? existing?.confidence ?? 0.8,
      importance: params.importance ?? existing?.importance ?? 0.7,
      source: params.source ?? existing?.source ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const upsert = this.db.transaction(() => {
      ensureAgent(this.db, entry.agentId, now);
      this.db.run(
        `INSERT INTO self_model (${SELF_MODEL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, scope, key) DO UPDATE SET
           value = excluded.value,
           confidence = excluded.confidence,
           importance = excluded.importance,
           source = excluded.source,
           updated_at = excluded.updated_at`,
        entry.id,
        entry.agentId,
        entry.scope,
        entry.scopeType,
        entry.key,
        entry.value,
        entry.confidence,
        entry.importance,
        entry.source,
        entry.createdAt,
        entry.updatedAt,
      );
    });
    upsert();
    return entry;
  }

  /** Get a single entry. Without a scope, reads the `global` entry. */
  get(agentId: string, key: string, scope?: ScopeInput): SelfModelEntry | undefined {
    const scopeKey = scope === undefined ? "global" : normalizeScope(scope).key;
    const row = this.db.get<SelfModelRow>(
      `SELECT ${SELF_MODEL_COLUMNS} FROM self_model WHERE agent_id = ? AND scope = ? AND key = ?`,
      agentId,
      scopeKey,
      key,
    );
    return row ? rowToSelfModel(row) : undefined;
  }

  /**
   * All entries for an agent. With no scope it returns every scope; with a scope
   * it returns that scope plus `global` (or only the scope when `exact`).
   */
  all(agentId: string, scope?: ScopeInput, scopeMode: "exact" | "inherit" = "inherit"): SelfModelEntry[] {
    if (scope === undefined) {
      return this.db
        .all<SelfModelRow>(
          `SELECT ${SELF_MODEL_COLUMNS} FROM self_model WHERE agent_id = ? ORDER BY importance DESC, key ASC`,
          agentId,
        )
        .map(rowToSelfModel);
    }
    const keys = scopeKeys(scope, scopeMode);
    return this.db
      .all<SelfModelRow>(
        `SELECT ${SELF_MODEL_COLUMNS} FROM self_model WHERE agent_id = ? AND scope IN (${placeholders(keys.length)}) ORDER BY importance DESC, key ASC`,
        agentId,
        ...keys,
      )
      .map(rowToSelfModel);
  }

  /** Remove an entry. Without a scope, removes the `global` entry. */
  remove(agentId: string, key: string, scope?: ScopeInput): boolean {
    const scopeKey = scope === undefined ? "global" : normalizeScope(scope).key;
    const result = this.db.run("DELETE FROM self_model WHERE agent_id = ? AND scope = ? AND key = ?", agentId, scopeKey, key);
    return result.changes > 0;
  }

  count(agentId: string, scope?: ScopeInput, scopeMode: "exact" | "inherit" = "inherit"): number {
    const where: string[] = ["agent_id = ?"];
    const args: unknown[] = [agentId];
    if (scope !== undefined) {
      const keys = scopeKeys(scope, scopeMode);
      where.push(`scope IN (${placeholders(keys.length)})`);
      args.push(...keys);
    }
    const row = this.db.get<CountRow>(`SELECT COUNT(*) AS count FROM self_model WHERE ${where.join(" AND ")}`, ...args);
    return row?.count ?? 0;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
