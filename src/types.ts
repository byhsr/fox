import { z } from "zod";
import type { Embedder } from "./embedder.js";
import type { Reflector } from "./reflection.js";
import { ValidationError, formatZodError } from "./errors.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** The kind of long-lived memory being stored. */
export enum MemoryKind {
  /** Raw episodes distilled into memory (what happened). */
  Episodic = "episodic",
  /** Facts and knowledge (what is true). */
  Semantic = "semantic",
  /** How to do things (step-by-step know-how). */
  Procedure = "procedural",
  /** Rules, constraints, and guardrails the agent must follow. */
  Policy = "policy",
  /** Preferences and style choices. */
  Preference = "preference",
  /** Self-generated reflections about the agent or its work. */
  Reflection = "reflection",
  /** Entries that belong to the persistent self-model. */
  SelfModel = "self_model",
}

/** Lifecycle state of a memory. Only `active` memories are retrieved by default. */
export enum MemoryStatus {
  Active = "active",
  Pending = "pending",
  Archived = "archived",
  Deprecated = "deprecated",
  Rejected = "rejected",
}

/** Common event types. Any non-empty string is accepted. */
export const EventType = {
  UserMessage: "user_message",
  AssistantMessage: "assistant_message",
  ToolCall: "tool_call",
  ToolResult: "tool_result",
  Observation: "observation",
  Decision: "decision",
  Error: "error",
  Outcome: "outcome",
  Note: "note",
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export const SCOPE_TYPES = ["global", "agent", "project", "session", "task"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/**
 * A resolved scope. `key` is the canonical string persisted in SQLite
 * (e.g. `project:agent-memory`, or just `global`).
 */
export interface ScopeRef {
  readonly type: ScopeType;
  readonly id: string | null;
  readonly key: string;
}

/** Anything accepted where a scope is expected: a `ScopeRef` or a scope key. */
export type ScopeLike = ScopeRef | string;

/** The loose object shape produced by the scope input schema. */
export interface ScopeInputObject {
  type: ScopeType;
  id?: string | null | undefined;
  key?: string | undefined;
}

/** Anything `normalizeScope` understands. */
export type ScopeInput = ScopeLike | ScopeInputObject;

function makeScope(type: ScopeType, id: string | null): ScopeRef {
  return { type, id, key: id === null ? type : `${type}:${id}` };
}

function isScopeType(value: string): value is ScopeType {
  return (SCOPE_TYPES as readonly string[]).includes(value);
}

/**
 * Factory for scopes.
 *
 * ```ts
 * Scope.project("agent-memory") // { type: "project", id: "agent-memory", key: "project:agent-memory" }
 * Scope.global()                // { type: "global", id: null, key: "global" }
 * ```
 */
export const Scope = {
  global(): ScopeRef {
    return makeScope("global", null);
  },
  agent(id: string): ScopeRef {
    return makeScope("agent", id);
  },
  project(id: string): ScopeRef {
    return makeScope("project", id);
  },
  session(id: string): ScopeRef {
    return makeScope("session", id);
  },
  task(id: string): ScopeRef {
    return makeScope("task", id);
  },
  /** Parse a canonical scope key. Unknown keys become `project` scopes. */
  parse(key: string): ScopeRef {
    const separator = key.indexOf(":");
    if (separator === -1) {
      return isScopeType(key) ? makeScope(key, null) : makeScope("project", key);
    }
    const type = key.slice(0, separator);
    const id = key.slice(separator + 1);
    return isScopeType(type) ? makeScope(type, id) : makeScope("project", key);
  },
} as const;

export function normalizeScope(input: ScopeInput): ScopeRef {
  if (typeof input === "string") return Scope.parse(input);
  const id = input.id ?? null;
  const key = input.key && input.key.length > 0 ? input.key : id === null ? input.type : `${input.type}:${id}`;
  return { type: input.type, id, key };
}

/**
 * The set of scopes a query should see. `exact` matches only the given scope;
 * `inherit` also includes `global` (shared, cross-project memory).
 */
export function scopeKeys(scope: ScopeInput, mode: "exact" | "inherit" = "inherit"): string[] {
  const resolved = normalizeScope(scope);
  if (mode === "exact") return [resolved.key];
  if (resolved.type === "global") return ["global"];
  return [resolved.key, "global"];
}

// ---------------------------------------------------------------------------
// Domain objects
// ---------------------------------------------------------------------------

export type EpochMs = number;
export type JsonObject = Record<string, unknown>;

/** A raw, mostly-immutable thing that happened. */
export interface Event {
  id: string;
  agentId: string;
  scope: string;
  scopeType: ScopeType;
  type: string;
  role: string | null;
  content: string;
  data: JsonObject;
  importance: number;
  occurredAt: EpochMs;
  createdAt: EpochMs;
}

/** A durable, retrievable unit of memory. */
export interface Memory {
  id: string;
  agentId: string;
  scope: string;
  scopeType: ScopeType;
  kind: MemoryKind;
  status: MemoryStatus;
  title: string;
  content: string;
  summary: string | null;
  tags: string[];
  confidence: number;
  importance: number;
  sourceEventIds: string[];
  metadata: JsonObject;
  hasEmbedding: boolean;
  embeddingModel: string | null;
  embeddingDim: number | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  lastAccessedAt: EpochMs | null;
  accessCount: number;
  expiresAt: EpochMs | null;
}

/** An entry in the persistent self-model. */
export interface SelfModelEntry {
  id: string;
  agentId: string;
  scope: string;
  scopeType: ScopeType;
  key: string;
  value: string;
  confidence: number;
  importance: number;
  source: string | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

/** A named scope (typically a project) whose memory is tracked together. */
export interface Namespace {
  /** Canonical scope key, e.g. `project:checkout-service`. */
  key: string;
  type: ScopeType;
  id: string | null;
  name: string;
  description: string | null;
  metadata: JsonObject;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface NamespaceCounts {
  events: number;
  memories: number;
  selfModelEntries: number;
}

/** A namespace plus a summary of what is tracked in it. */
export interface NamespaceSummary {
  namespace: Namespace;
  counts: NamespaceCounts;
  lastActivityAt: EpochMs | null;
}

/** Everything tracked in a namespace: summary plus the actual entries. */
export interface NamespaceDetail extends NamespaceSummary {
  selfModel: SelfModelEntry[];
  memories: Memory[];
  events: Event[];
}

export interface ContextItem {
  id: string | null;
  kind: MemoryKind | "event" | "self" | "task";
  title: string | null;
  text: string;
  score: number;
  tokens: number;
}

export interface ContextSection {
  id: string;
  title: string;
  items: ContextItem[];
  tokens: number;
}

export interface RetrievalSignals {
  lexical: number | null;
  vector: number | null;
  importance: number;
  confidence: number;
  recency: number;
}

export interface RetrievalHit {
  memory: Memory;
  score: number;
  signals: RetrievalSignals;
}

export interface RetrievalWeights {
  lexical: number;
  vector: number;
  importance: number;
  confidence: number;
  recency: number;
}

// ---------------------------------------------------------------------------
// Input schemas (every public input is validated with zod)
// ---------------------------------------------------------------------------

const zUnit = z.number().finite().min(0).max(1);
const zTime = z.union([
  z.date(),
  z.number().int(),
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "invalid date string" }),
]);
const zJsonObject = z.record(z.unknown());
export const zScopeInput = z.union([
  z
    .object({
      type: z.enum(SCOPE_TYPES),
      id: z.string().nullable().optional(),
      key: z.string().min(1).optional(),
    })
    .strict(),
  z.string().min(1),
]);
export const zScopeMode = z.enum(["exact", "inherit"]);
const zFn = <T extends (...args: never[]) => unknown>(label: string) =>
  z.custom<T>((value) => typeof value === "function", { message: `${label} must be a function` });

export function toEpochMs(value: Date | number | string): EpochMs {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

/** Validate a public API input, raising `ValidationError` on failure. */
export function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(formatZodError(result.error), { cause: result.error });
  }
  return result.data;
}

// --- events -----------------------------------------------------------------

export const recordEventSchema = z
  .object({
    id: z.string().min(1).optional(),
    agentId: z.string().min(1),
    scope: zScopeInput,
    type: z.string().min(1),
    role: z.string().min(1).optional(),
    content: z.string().min(1),
    data: zJsonObject.optional(),
    importance: zUnit.optional(),
    occurredAt: zTime.optional(),
  })
  .strict();

export type RecordEventInput = z.input<typeof recordEventSchema>;

export const listEventsSchema = z
  .object({
    agentId: z.string().min(1),
    scope: zScopeInput.optional(),
    scopeMode: zScopeMode.optional(),
    types: z.array(z.string().min(1)).optional(),
    since: zTime.optional(),
    until: zTime.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export type ListEventsInput = z.input<typeof listEventsSchema>;

// --- memories ---------------------------------------------------------------

export const addMemorySchema = z
  .object({
    id: z.string().min(1).optional(),
    agentId: z.string().min(1),
    scope: zScopeInput,
    kind: z.nativeEnum(MemoryKind),
    title: z.string().min(1),
    content: z.string().min(1),
    summary: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    confidence: zUnit.optional(),
    importance: zUnit.optional(),
    status: z.nativeEnum(MemoryStatus).optional(),
    sourceEventIds: z.array(z.string().min(1)).optional(),
    metadata: zJsonObject.optional(),
    embedding: z.array(z.number().finite()).optional(),
    embeddingModel: z.string().min(1).optional(),
    expiresAt: z.union([zTime, z.null()]).optional(),
  })
  .strict();

export type AddMemoryInput = z.input<typeof addMemorySchema>;

export const updateMemorySchema = z
  .object({
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    summary: z.string().nullable().optional(),
    kind: z.nativeEnum(MemoryKind).optional(),
    status: z.nativeEnum(MemoryStatus).optional(),
    tags: z.array(z.string().min(1)).optional(),
    confidence: zUnit.optional(),
    importance: zUnit.optional(),
    sourceEventIds: z.array(z.string().min(1)).optional(),
    metadata: zJsonObject.optional(),
    embedding: z.union([z.array(z.number().finite()), z.null()]).optional(),
    embeddingModel: z.string().min(1).optional(),
    expiresAt: z.union([zTime, z.null()]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field must be provided" });

export type UpdateMemoryInput = z.input<typeof updateMemorySchema>;

export const listMemoriesSchema = z
  .object({
    agentId: z.string().min(1),
    scope: zScopeInput.optional(),
    scopeMode: zScopeMode.optional(),
    kinds: z.array(z.nativeEnum(MemoryKind)).optional(),
    status: z.array(z.nativeEnum(MemoryStatus)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    includeExpired: z.boolean().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export type ListMemoriesInput = z.input<typeof listMemoriesSchema>;

// --- self model -------------------------------------------------------------

export const setSelfModelSchema = z
  .object({
    agentId: z.string().min(1),
    scope: zScopeInput.optional(),
    key: z.string().min(1),
    value: z.string().min(1),
    confidence: zUnit.optional(),
    importance: zUnit.optional(),
    source: z.string().min(1).optional(),
  })
  .strict();

export type SetSelfModelInput = z.input<typeof setSelfModelSchema>;

// --- namespaces -------------------------------------------------------------

export const createNamespaceSchema = z
  .object({
    scope: zScopeInput,
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    metadata: zJsonObject.optional(),
  })
  .strict();

export const namespaceRefSchema = z.object({ scope: zScopeInput }).strict();

export const listNamespacesSchema = z
  .object({
    type: z.enum(SCOPE_TYPES).optional(),
    query: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const getNamespaceSchema = z
  .object({
    scope: zScopeInput,
    memoryLimit: z.number().int().min(1).max(200).optional(),
    eventLimit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export type CreateNamespaceInput = z.input<typeof createNamespaceSchema>;
export type ListNamespacesInput = z.input<typeof listNamespacesSchema>;
export type GetNamespaceInput = z.input<typeof getNamespaceSchema>;
export type CreateNamespaceParams = z.output<typeof createNamespaceSchema>;
export type ListNamespacesParams = z.output<typeof listNamespacesSchema>;
export type GetNamespaceParams = z.output<typeof getNamespaceSchema>;

// --- retrieval --------------------------------------------------------------

export const retrievalWeightsSchema = z
  .object({
    lexical: z.number().finite().min(0).optional(),
    vector: z.number().finite().min(0).optional(),
    importance: z.number().finite().min(0).optional(),
    confidence: z.number().finite().min(0).optional(),
    recency: z.number().finite().min(0).optional(),
  })
  .strict();

export const retrieveSchema = z
  .object({
    agentId: z.string().min(1),
    scope: zScopeInput,
    query: z.string().min(1),
    kinds: z.array(z.nativeEnum(MemoryKind)).optional(),
    status: z.array(z.nativeEnum(MemoryStatus)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    scopeMode: zScopeMode.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    poolSize: z.number().int().min(1).max(2000).optional(),
    minScore: z.number().finite().min(0).max(1).optional(),
    halfLifeDays: z.number().finite().positive().optional(),
    weights: retrievalWeightsSchema.optional(),
    trackAccess: z.boolean().optional(),
  })
  .strict();

export type RetrieveInput = z.input<typeof retrieveSchema>;

// --- context compilation ----------------------------------------------------

export const compileContextSchema = z
  .object({
    agentId: z.string().min(1),
    scope: zScopeInput,
    task: z.string().optional(),
    query: z.string().optional(),
    tokenBudget: z.number().int().min(32).max(200_000).optional(),
    scopeMode: zScopeMode.optional(),
    includeSelf: z.boolean().optional(),
    includeTask: z.boolean().optional(),
    includePolicies: z.boolean().optional(),
    includeProcedures: z.boolean().optional(),
    includeSemantic: z.boolean().optional(),
    includePreferences: z.boolean().optional(),
    includeReflections: z.boolean().optional(),
    includeRecentEpisodes: z.boolean().optional(),
    maxItemsPerSection: z.number().int().min(1).max(50).optional(),
    recentEpisodeLimit: z.number().int().min(1).max(200).optional(),
    halfLifeDays: z.number().finite().positive().optional(),
    weights: retrievalWeightsSchema.optional(),
    tokenEstimator: zFn<(text: string) => number>("tokenEstimator").optional(),
  })
  .strict();

export type CompileContextInput = z.input<typeof compileContextSchema>;

// --- reflection -------------------------------------------------------------

export const reflectSchema = z
  .object({
    agentId: z.string().min(1),
    scope: zScopeInput,
    since: zTime.optional(),
    windowEvents: z.number().int().min(1).max(1000).optional(),
    threshold: z.number().int().min(2).max(20).optional(),
    persist: z.boolean().optional(),
  })
  .strict();

export type ReflectInput = z.input<typeof reflectSchema>;

export const saveReflectionSchema = z
  .object({
    agentId: z.string().min(1),
    scope: zScopeInput,
    title: z.string().min(1),
    content: z.string().min(1),
    kind: z.nativeEnum(MemoryKind).optional(),
    confidence: zUnit.optional(),
    importance: zUnit.optional(),
    tags: z.array(z.string().min(1)).optional(),
    supportingEventIds: z.array(z.string().min(1)).optional(),
    metadata: zJsonObject.optional(),
  })
  .strict();

export type SaveReflectionInput = z.input<typeof saveReflectionSchema>;

// --- constructor options ----------------------------------------------------

export const agentMemoryOptionsSchema = z
  .object({
    path: z.string().min(1),
    embedder: z
      .custom<Embedder>(
        (value) => typeof value === "object" && value !== null && typeof (value as Embedder).embed === "function",
        { message: "embedder must implement embed(texts)" },
      )
      .optional(),
    reflector: z
      .custom<Reflector>(
        (value) => typeof value === "object" && value !== null && typeof (value as Reflector).reflect === "function",
        { message: "reflector must implement reflect(context)" },
      )
      .optional(),
    tokenEstimator: zFn<(text: string) => number>("tokenEstimator").optional(),
    now: zFn<() => number>("now").optional(),
    readOnly: z.boolean().optional(),
    autoMigrate: z.boolean().optional(),
  })
  .strict();

export type AgentMemoryOptions = z.input<typeof agentMemoryOptionsSchema>;

// --- validated (post-parse) shapes used internally --------------------------

export type RecordEventParams = z.output<typeof recordEventSchema>;
export type ListEventsParams = z.output<typeof listEventsSchema>;
export type AddMemoryParams = z.output<typeof addMemorySchema>;
export type UpdateMemoryParams = z.output<typeof updateMemorySchema>;
export type ListMemoriesParams = z.output<typeof listMemoriesSchema>;
export type SetSelfModelParams = z.output<typeof setSelfModelSchema>;
export type RetrieveParams = z.output<typeof retrieveSchema>;
export type CompileContextParams = z.output<typeof compileContextSchema>;
export type ReflectParams = z.output<typeof reflectSchema>;
export type SaveReflectionParams = z.output<typeof saveReflectionSchema>;
export type AgentMemorySettings = z.output<typeof agentMemoryOptionsSchema>;
