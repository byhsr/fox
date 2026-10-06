import type { Db } from "./database.js";
import { cosineSimilarity, type Embedder } from "./embedder.js";
import { EmbeddingError } from "./errors.js";
import type { MemoryStore } from "./memories.js";
import { MEMORY_COLUMNS, rowToMemory, type MemoryRow } from "./schema.js";
import {
  MemoryStatus,
  normalizeScope,
  parseInput,
  retrieveSchema,
  scopeKeys,
  type Memory,
  type MemoryKind,
  type RetrievalHit,
  type RetrievalSignals,
  type RetrievalWeights,
  type RetrieveInput,
  type RetrieveParams,
} from "./types.js";

export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = {
  lexical: 0.5,
  vector: 0.3,
  importance: 0.1,
  confidence: 0.05,
  recency: 0.05,
};

const DEFAULT_HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were",
  "be", "been", "being", "with", "as", "at", "by", "it", "its", "this", "that", "these",
  "those", "from", "into", "about", "we", "you", "your", "our", "i", "me", "my", "do", "does",
]);

export interface LexicalSearchOptions {
  agentId: string;
  scopes: readonly string[];
  query: string;
  limit: number;
  kinds?: readonly MemoryKind[];
  statuses?: readonly MemoryStatus[];
}

/**
 * Hybrid retriever.
 *
 * Always runs SQLite FTS5 lexical search. Additionally uses cosine similarity
 * over stored embeddings when an `Embedder` is configured. Metadata signals
 * (importance, confidence, recency) are always blended in, so retrieval keeps
 * working with no embeddings and no network access.
 */
export class Retriever {
  readonly weights: RetrievalWeights;

  constructor(
    private readonly db: Db,
    private readonly memories: MemoryStore,
    private readonly embedder: Embedder | null = null,
    weights?: Partial<RetrievalWeights>,
  ) {
    this.weights = mergeWeights(DEFAULT_RETRIEVAL_WEIGHTS, weights);
  }

  get hasEmbedder(): boolean {
    return this.embedder !== null;
  }

  /** Synchronous lexical + heuristic retrieval (never uses embeddings). */
  retrieveSync(input: RetrieveInput): RetrievalHit[] {
    const params = parseInput(retrieveSchema, input);
    return this.run(params, null);
  }

  /** Async retrieval that adds an embedding signal when an embedder is set. */
  async retrieve(input: RetrieveInput): Promise<RetrievalHit[]> {
    const params = parseInput(retrieveSchema, input);
    if (this.embedder === null) return this.run(params, null);
    const vector = await this.embedQuery(params.query);
    return this.run(params, vector);
  }

  /** Normalized (`0..1`, best = 1) lexical scores for a set of filters. */
  lexicalScores(options: LexicalSearchOptions): Map<string, number> {
    const expressions = buildMatchExpressions(options.query);
    if (expressions === null) return new Map();

    let rows = this.queryLexical(options, expressions.and);
    if (rows.length === 0 && expressions.or !== expressions.and) {
      rows = this.queryLexical(options, expressions.or);
    }
    if (rows.length === 0) return new Map();

    const max = rows.reduce((acc, row) => Math.max(acc, row.raw), 1e-9);
    const scores = new Map<string, number>();
    for (const row of rows) scores.set(row.id, clamp01(row.raw / max));
    return scores;
  }

  /** Build the individual retrieval signals for a memory. */
  signalsFor(
    memory: Memory,
    lexical: number | null,
    vector: number | null,
    now: number,
    halfLifeDays: number,
  ): RetrievalSignals {
    const reference = memory.lastAccessedAt ?? memory.updatedAt;
    const ageDays = Math.max(0, (now - reference) / DAY_MS);
    const recency = Math.exp(-ageDays / halfLifeDays);
    return {
      lexical,
      vector,
      importance: clamp01(memory.importance),
      confidence: clamp01(memory.confidence),
      recency: clamp01(recency),
    };
  }

  /** Weighted blend of signals, renormalized over the signals that are present. */
  score(signals: RetrievalSignals, weights: RetrievalWeights = this.weights): number {
    let sum = 0;
    let weightSum = 0;
    const add = (value: number | null, weight: number): void => {
      if (value === null || weight <= 0) return;
      sum += value * weight;
      weightSum += weight;
    };
    add(signals.lexical, weights.lexical);
    add(signals.vector, weights.vector);
    add(signals.importance, weights.importance);
    add(signals.confidence, weights.confidence);
    add(signals.recency, weights.recency);
    if (weightSum === 0) return 0;
    return clamp01(sum / weightSum);
  }

  private run(params: RetrieveParams, queryVector: Float32Array | null): RetrievalHit[] {
    const scope = normalizeScope(params.scope);
    const scopes = scopeKeys(scope, params.scopeMode ?? "inherit");
    const statuses = params.status ?? [MemoryStatus.Active];
    const limit = params.limit ?? 10;
    const poolSize = params.poolSize ?? Math.max(limit * 8, 60);
    const now = this.db.now();
    const halfLife = params.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    const weights = mergeWeights(this.weights, params.weights);

    const lexical = this.lexicalScores({
      agentId: params.agentId,
      scopes,
      kinds: params.kinds,
      statuses,
      query: params.query,
      limit: Math.max(limit * 5, 25),
    });

    const candidates = this.pool({
      agentId: params.agentId,
      scopes,
      kinds: params.kinds,
      statuses,
      lexicalIds: new Set(lexical.keys()),
      size: poolSize,
      now,
    });

    const embeddings =
      queryVector !== null
        ? this.memories.getEmbeddings(candidates.filter((memory) => memory.hasEmbedding).map((memory) => memory.id))
        : new Map<string, Float32Array>();

    const hits: RetrievalHit[] = [];
    for (const memory of candidates) {
      const stored = embeddings.get(memory.id);
      const vector = queryVector !== null && stored !== undefined ? clamp01(cosineSimilarity(queryVector, stored)) : null;
      const signals = this.signalsFor(memory, lexical.get(memory.id) ?? null, vector, now, halfLife);
      hits.push({ memory, score: this.score(signals, weights), signals });
    }

    const filtered = filterHits(
      hits.filter((hit) => isRelevant(hit.signals)),
      params.minScore ?? 0,
      params.tags,
    );
    filtered.sort(compareHits);
    const limited = filtered.slice(0, limit);
    if (params.trackAccess === true) {
      this.memories.markAccessed(limited.map((hit) => hit.memory.id), now);
    }
    return limited;
  }

  /** Embed a single string, raising `EmbeddingError` if the embedder fails. */
  async embedQuery(text: string): Promise<Float32Array | null> {
    const embedder = this.embedder;
    if (embedder === null) return null;
    try {
      const [vector] = await embedder.embed([text]);
      if (vector === undefined) return null;
      const array = Float32Array.from(vector);
      return array.length > 0 ? array : null;
    } catch (cause) {
      throw new EmbeddingError("Embedder failed to embed the query", { cause });
    }
  }

  private queryLexical(options: LexicalSearchOptions, match: string): Array<{ id: string; raw: number }> {
    const where: string[] = ["memories_fts MATCH ?", "m.agent_id = ?"];
    const args: unknown[] = [match, options.agentId];
    if (options.scopes.length > 0) {
      where.push(`m.scope IN (${placeholders(options.scopes.length)})`);
      args.push(...options.scopes);
    }
    if (options.statuses !== undefined && options.statuses.length > 0) {
      where.push(`m.status IN (${placeholders(options.statuses.length)})`);
      args.push(...options.statuses);
    }
    if (options.kinds !== undefined && options.kinds.length > 0) {
      where.push(`m.kind IN (${placeholders(options.kinds.length)})`);
      args.push(...options.kinds);
    }
    args.push(options.limit);

    const sql = `SELECT m.id AS id, bm25(memories_fts) AS bm
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY bm ASC
      LIMIT ?`;
    return this.db.all<{ id: string; bm: number }>(sql, ...args).map((row) => ({ id: row.id, raw: Math.max(0, -row.bm) }));
  }

  private pool(options: {
    agentId: string;
    scopes: readonly string[];
    kinds?: readonly MemoryKind[];
    statuses: readonly MemoryStatus[];
    lexicalIds: ReadonlySet<string>;
    size: number;
    now: number;
  }): Memory[] {
    const where: string[] = ["agent_id = ?", "(expires_at IS NULL OR expires_at > ?)"];
    const args: unknown[] = [options.agentId, options.now];
    if (options.scopes.length > 0) {
      where.push(`scope IN (${placeholders(options.scopes.length)})`);
      args.push(...options.scopes);
    }
    if (options.statuses.length > 0) {
      where.push(`status IN (${placeholders(options.statuses.length)})`);
      args.push(...options.statuses);
    }
    if (options.kinds !== undefined && options.kinds.length > 0) {
      where.push(`kind IN (${placeholders(options.kinds.length)})`);
      args.push(...options.kinds);
    }
    args.push(options.size);

    const rows = this.db
      .all<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${where.join(" AND ")} ORDER BY importance DESC, updated_at DESC LIMIT ?`,
        ...args,
      )
      .map(rowToMemory);

    const byId = new Map(rows.map((memory) => [memory.id, memory]));
    const missing = [...options.lexicalIds].filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const extra = this.db
        .all<MemoryRow>(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id IN (${placeholders(missing.length)})`, ...missing)
        .map(rowToMemory);
      for (const memory of extra) byId.set(memory.id, memory);
    }
    return [...byId.values()];
  }
}

/**
 * A candidate only counts as a hit when it has a genuine relevance signal:
 * a lexical match, or a non-zero vector similarity. Without this, a search for
 * unrelated terms would return whichever memories merely happen to be recent.
 */
function isRelevant(signals: RetrievalSignals): boolean {
  if (signals.lexical !== null) return true;
  return signals.vector !== null && signals.vector > 0;
}

function filterHits(hits: readonly RetrievalHit[], minScore: number, tags?: readonly string[]): RetrievalHit[] {
  return hits.filter((hit) => {
    if (hit.score < minScore) return false;
    if (tags !== undefined && tags.length > 0) {
      const memoryTags = hit.memory.tags;
      if (!tags.some((tag) => memoryTags.includes(tag))) return false;
    }
    return true;
  });
}

function compareHits(a: RetrievalHit, b: RetrievalHit): number {
  if (b.score !== a.score) return b.score - a.score;
  return b.memory.updatedAt - a.memory.updatedAt;
}

export function mergeWeights(base: RetrievalWeights, partial?: Partial<RetrievalWeights> | undefined): RetrievalWeights {
  const merged: RetrievalWeights = { ...base };
  if (partial !== undefined) {
    for (const key of Object.keys(partial) as Array<keyof RetrievalWeights>) {
      const value = partial[key];
      if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
    }
  }
  return merged;
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

interface MatchExpressions {
  and: string;
  or: string;
}

function buildMatchExpressions(query: string): MatchExpressions | null {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (raw.length < 2 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= 16) break;
  }
  if (terms.length === 0) return null;
  const prefixed = terms.map((term) => `${term}*`);
  return { and: prefixed.join(" AND "), or: prefixed.join(" OR ") };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
