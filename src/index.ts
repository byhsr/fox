import { CompiledContext, ContextCompiler, defaultTokenEstimator } from "./context.js";
import { Db } from "./database.js";
import { AgentMemoryError, EmbeddingError } from "./errors.js";
import type { Embedder } from "./embedder.js";
import { EventStore } from "./events.js";
import { MemoryStore } from "./memories.js";
import { HeuristicReflector, type ReflectionContext, type ReflectionDraft, type Reflector } from "./reflection.js";
import { Retriever } from "./retrieval.js";
import type { CountRow } from "./schema.js";
import { SelfModelStore } from "./self-model.js";
import {
  MemoryKind,
  MemoryStatus,
  addMemorySchema,
  agentMemoryOptionsSchema,
  normalizeScope,
  parseInput,
  reflectSchema,
  saveReflectionSchema,
  toEpochMs,
  updateMemorySchema,
} from "./types.js";
import type {
  AddMemoryInput,
  AddMemoryParams,
  AgentMemoryOptions,
  CompileContextInput,
  Event,
  ListEventsInput,
  ListMemoriesInput,
  Memory,
  RecordEventInput,
  ReflectInput,
  RetrieveInput,
  RetrievalHit,
  SaveReflectionInput,
  SelfModelEntry,
  SetSelfModelInput,
  UpdateMemoryInput,
  UpdateMemoryParams,
} from "./types.js";

export interface MemoryStats {
  events: number;
  memories: number;
  selfModelEntries: number;
}

/**
 * Local-first agent memory over a single SQLite file.
 *
 * Mutations are promise-based. Reads and context compilation are synchronous,
 * because SQLite access is local and synchronous; an embedding-aware variant is
 * provided where vectors can improve the result.
 */
export class AgentMemory {
  readonly db: Db;
  readonly events: EventStore;
  readonly memories: MemoryStore;
  readonly selfModel: SelfModelStore;
  readonly retriever: Retriever;
  readonly embedder: Embedder | null;
  readonly reflector: Reflector;
  private readonly compiler: ContextCompiler;
  private closed = false;

  constructor(options: AgentMemoryOptions) {
    const settings = parseInput(agentMemoryOptionsSchema, options);
    this.embedder = settings.embedder ?? null;
    this.reflector = settings.reflector ?? new HeuristicReflector();
    this.db = new Db({
      path: settings.path,
      readOnly: settings.readOnly,
      autoMigrate: settings.autoMigrate,
      now: settings.now,
    });
    this.events = new EventStore(this.db);
    this.memories = new MemoryStore(this.db);
    this.selfModel = new SelfModelStore(this.db);
    this.retriever = new Retriever(this.db, this.memories, this.embedder);
    this.compiler = new ContextCompiler(
      this.db,
      this.memories,
      this.events,
      this.selfModel,
      this.retriever,
      settings.tokenEstimator ?? defaultTokenEstimator,
    );
  }

  // --- events ---------------------------------------------------------------

  /** Append a raw episode. */
  recordEvent(input: RecordEventInput): Promise<Event> {
    this.assertOpen();
    return Promise.resolve(this.events.record(input));
  }

  getEvent(id: string): Event | undefined {
    this.assertOpen();
    return this.events.get(id);
  }

  listEvents(input: ListEventsInput): Event[] {
    this.assertOpen();
    return this.events.list(input);
  }

  recentEvents(agentId: string, scope: string | ReturnType<typeof normalizeScope>, limit = 20): Event[] {
    this.assertOpen();
    return this.events.recent(agentId, scope, limit);
  }

  // --- memories -------------------------------------------------------------

  /** Add a durable memory. Embeds it first when an embedder is configured. */
  addMemory(input: AddMemoryInput): Promise<Memory> {
    this.assertOpen();
    if (this.embedder === null) return Promise.resolve(this.memories.add(input));
    const params = parseInput(addMemorySchema, input);
    if (params.embedding !== undefined) return Promise.resolve(this.memories.add(params));
    return this.addEmbedded(params);
  }

  /** Update an existing memory. Re-embeds when title/content change. */
  updateMemory(id: string, patch: UpdateMemoryInput): Promise<Memory> {
    this.assertOpen();
    if (this.embedder === null) return Promise.resolve(this.memories.update(id, patch));
    const params = parseInput(updateMemorySchema, patch);
    const touchesText = params.title !== undefined || params.content !== undefined;
    if (params.embedding !== undefined || !touchesText) return Promise.resolve(this.memories.update(id, params));
    return this.updateEmbedded(id, params);
  }

  archiveMemory(id: string): Promise<Memory> {
    this.assertOpen();
    return Promise.resolve(this.memories.archive(id));
  }

  forgetMemory(id: string): Promise<void> {
    this.assertOpen();
    this.memories.forget(id);
    return Promise.resolve();
  }

  getMemory(id: string): Memory | undefined {
    this.assertOpen();
    return this.memories.get(id);
  }

  listMemories(input: ListMemoriesInput): Memory[] {
    this.assertOpen();
    return this.memories.list(input);
  }

  // --- self model -----------------------------------------------------------

  setSelfModel(input: SetSelfModelInput): SelfModelEntry {
    this.assertOpen();
    return this.selfModel.set(input);
  }

  getSelfModel(agentId: string, key: string): SelfModelEntry | undefined {
    this.assertOpen();
    return this.selfModel.get(agentId, key);
  }

  selfModelEntries(agentId: string): SelfModelEntry[] {
    this.assertOpen();
    return this.selfModel.all(agentId);
  }

  removeSelfModel(agentId: string, key: string): boolean {
    this.assertOpen();
    return this.selfModel.remove(agentId, key);
  }

  // --- retrieval ------------------------------------------------------------

  /** Embedding-aware retrieval (falls back to lexical when no embedder). */
  retrieve(input: RetrieveInput): Promise<RetrievalHit[]> {
    this.assertOpen();
    return this.retriever.retrieve(input);
  }

  /** Synchronous lexical + heuristic retrieval. Never uses embeddings. */
  search(input: RetrieveInput): RetrievalHit[] {
    this.assertOpen();
    return this.retriever.retrieveSync(input);
  }

  // --- context compilation --------------------------------------------------

  /** Compile a token-budgeted context. Synchronous (lexical + heuristic). */
  compileContext(input: CompileContextInput): CompiledContext {
    this.assertOpen();
    return this.compiler.compile(input);
  }

  /** Compile a context using the configured embedder as an extra signal. */
  compileContextAsync(input: CompileContextInput): Promise<CompiledContext> {
    this.assertOpen();
    return this.compiler.compileAsync(input);
  }

  // --- reflection -----------------------------------------------------------

  /** Produce reflection candidates from recent episodes. */
  async reflect(input: ReflectInput): Promise<ReflectionDraft[]> {
    this.assertOpen();
    const params = parseInput(reflectSchema, input);
    const now = this.db.now();
    const context: ReflectionContext = {
      agentId: params.agentId,
      scope: normalizeScope(params.scope).key,
      events: this.events.list({
        agentId: params.agentId,
        scope: params.scope,
        scopeMode: "inherit",
        since: params.since !== undefined ? toEpochMs(params.since) : undefined,
        limit: params.windowEvents ?? 100,
      }),
      memories: this.memories.list({
        agentId: params.agentId,
        scope: params.scope,
        scopeMode: "inherit",
        status: [MemoryStatus.Active],
        limit: 100,
      }),
      threshold: params.threshold ?? 2,
      now,
    };

    const drafts = await this.reflector.reflect(context);
    if (params.persist === true) {
      for (const draft of drafts) {
        await this.addMemory({
          agentId: params.agentId,
          scope: params.scope,
          kind: draft.kind,
          title: draft.title,
          content: draft.content,
          confidence: draft.confidence,
          importance: draft.importance,
          tags: draft.tags,
          sourceEventIds: draft.supportingEventIds,
          metadata: draft.rationale !== null ? { rationale: draft.rationale } : {},
        });
      }
    }
    return drafts;
  }

  /** Persist a reflection as a memory. */
  saveReflection(input: SaveReflectionInput): Promise<Memory> {
    this.assertOpen();
    const params = parseInput(saveReflectionSchema, input);
    return this.addMemory({
      agentId: params.agentId,
      scope: params.scope,
      kind: params.kind ?? MemoryKind.Reflection,
      title: params.title,
      content: params.content,
      confidence: params.confidence,
      importance: params.importance,
      tags: params.tags,
      sourceEventIds: params.supportingEventIds,
      metadata: params.metadata,
    });
  }

  // --- misc -----------------------------------------------------------------

  stats(): MemoryStats {
    this.assertOpen();
    const events = this.db.get<CountRow>("SELECT COUNT(*) AS count FROM events")?.count ?? 0;
    const memories = this.db.get<CountRow>("SELECT COUNT(*) AS count FROM memories")?.count ?? 0;
    const selfModelEntries = this.db.get<CountRow>("SELECT COUNT(*) AS count FROM self_model")?.count ?? 0;
    return { events, memories, selfModelEntries };
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private async addEmbedded(params: AddMemoryParams): Promise<Memory> {
    const embedder = this.embedder;
    if (embedder === null) return this.memories.add(params);
    const vector = await this.embedMemory(embedder, `${params.title}\n${params.content}`);
    if (vector === null) return this.memories.add(params);
    return this.memories.add({ ...params, embedding: vector, embeddingModel: params.embeddingModel ?? embedder.id });
  }

  private async updateEmbedded(id: string, params: UpdateMemoryParams): Promise<Memory> {
    const embedder = this.embedder;
    if (embedder === null) return this.memories.update(id, params);
    const existing = this.memories.require(id);
    const title = params.title ?? existing.title;
    const content = params.content ?? existing.content;
    const vector = await this.embedMemory(embedder, `${title}\n${content}`);
    return this.memories.update(id, { ...params, embedding: vector, embeddingModel: embedder.id });
  }

  private async embedMemory(embedder: Embedder, text: string): Promise<number[] | null> {
    try {
      const [vector] = await embedder.embed([text]);
      return vector !== undefined ? [...vector] : null;
    } catch (cause) {
      throw new EmbeddingError("Embedder failed to embed memory content", { cause });
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentMemoryError("AgentMemory instance is closed");
  }
}

export * from "./types.js";
export * from "./errors.js";
export * from "./embedder.js";
export * from "./reflection.js";
export * from "./context.js";
export * from "./retrieval.js";
export * from "./events.js";
export * from "./memories.js";
export * from "./self-model.js";
export { Db } from "./database.js";
export type { SqliteDatabase, SqliteStatement, RunResult } from "./database.js";
