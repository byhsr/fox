import type { Db } from "./database.js";
import { SELF_MODEL_COLUMNS, ensureAgent, newId, rowToSelfModel, type SelfModelRow } from "./schema.js";
import { parseInput, setSelfModelSchema, type SelfModelEntry, type SetSelfModelInput } from "./types.js";

/**
 * The persistent self-model: a small, canonical set of keyed entries that
 * describe who the agent is (identity, values, capabilities, current focus).
 * Keys are unique per agent; setting a key upserts it.
 */
export class SelfModelStore {
  constructor(private readonly db: Db) {}

  set(input: SetSelfModelInput): SelfModelEntry {
    const params = parseInput(setSelfModelSchema, input);
    const now = this.db.now();
    const existing = this.get(params.agentId, params.key);
    const entry: SelfModelEntry = {
      id: existing?.id ?? newId("slf"),
      agentId: params.agentId,
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
        `INSERT INTO self_model (${SELF_MODEL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET
           value = excluded.value,
           confidence = excluded.confidence,
           importance = excluded.importance,
           source = excluded.source,
           updated_at = excluded.updated_at`,
        entry.id,
        entry.agentId,
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

  get(agentId: string, key: string): SelfModelEntry | undefined {
    const row = this.db.get<SelfModelRow>(
      `SELECT ${SELF_MODEL_COLUMNS} FROM self_model WHERE agent_id = ? AND key = ?`,
      agentId,
      key,
    );
    return row ? rowToSelfModel(row) : undefined;
  }

  all(agentId: string): SelfModelEntry[] {
    return this.db
      .all<SelfModelRow>(`SELECT ${SELF_MODEL_COLUMNS} FROM self_model WHERE agent_id = ? ORDER BY importance DESC, key ASC`, agentId)
      .map(rowToSelfModel);
  }

  remove(agentId: string, key: string): boolean {
    const result = this.db.run("DELETE FROM self_model WHERE agent_id = ? AND key = ?", agentId, key);
    return result.changes > 0;
  }

  count(agentId: string): number {
    const row = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM self_model WHERE agent_id = ?", agentId);
    return row?.count ?? 0;
  }
}
