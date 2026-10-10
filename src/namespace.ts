import type { CompiledContext } from "./context.js";
import type { AgentMemory } from "./index.js";
import type { ReflectionDraft } from "./reflection.js";
import {
  normalizeScope,
  type AddMemoryInput,
  type CompileContextInput,
  type Event,
  type GetNamespaceInput,
  type ListEventsInput,
  type ListMemoriesInput,
  type Memory,
  type NamespaceCounts,
  type NamespaceDetail,
  type NamespaceSummary,
  type RecordEventInput,
  type ReflectInput,
  type RetrievalHit,
  type RetrieveInput,
  type ScopeInput,
  type ScopeRef,
  type SelfModelEntry,
  type SetSelfModelInput,
} from "./types.js";

/** Options for binding a handle to a namespace. */
export interface NamespaceOptions {
  agentId: string;
  scope: ScopeInput;
  /** Defaults to `inherit` (namespace + global) for reads. */
  scopeMode?: "exact" | "inherit";
}

/**
 * A namespace bound to an agent and scope. Every operation is pre-filled with
 * the agent id and scope, so a project's memory can be written and read without
 * repeating them:
 *
 * ```ts
 * const project = memory.namespace({ agentId: "forge", scope: "project:checkout" });
 * await project.addMemory({ kind: MemoryKind.Policy, title: "…", content: "…" });
 * project.detail(); // everything tracked in the project
 * ```
 */
export class NamespaceHandle {
  readonly agentId: string;
  readonly scope: ScopeRef;
  readonly scopeMode: "exact" | "inherit";
  private readonly memory: AgentMemory;

  constructor(memory: AgentMemory, options: NamespaceOptions) {
    this.memory = memory;
    this.agentId = options.agentId;
    this.scope = normalizeScope(options.scope);
    this.scopeMode = options.scopeMode ?? "inherit";
  }

  /** Canonical scope key, e.g. `project:checkout`. */
  get key(): string {
    return this.scope.key;
  }

  addMemory(input: Omit<AddMemoryInput, "agentId" | "scope">): Promise<Memory> {
    return this.memory.addMemory({ ...input, agentId: this.agentId, scope: this.scope } as AddMemoryInput);
  }

  recordEvent(input: Omit<RecordEventInput, "agentId" | "scope">): Promise<Event> {
    return this.memory.recordEvent({ ...input, agentId: this.agentId, scope: this.scope } as RecordEventInput);
  }

  listMemories(input: Omit<ListMemoriesInput, "agentId" | "scope" | "scopeMode"> = {}): Memory[] {
    return this.memory.listMemories({ ...input, agentId: this.agentId, scope: this.scope, scopeMode: this.scopeMode });
  }

  listEvents(input: Omit<ListEventsInput, "agentId" | "scope" | "scopeMode"> = {}): Event[] {
    return this.memory.listEvents({ ...input, agentId: this.agentId, scope: this.scope, scopeMode: this.scopeMode });
  }

  retrieve(input: Omit<RetrieveInput, "agentId" | "scope" | "scopeMode">): Promise<RetrievalHit[]> {
    return this.memory.retrieve({ ...input, agentId: this.agentId, scope: this.scope, scopeMode: this.scopeMode });
  }

  search(input: Omit<RetrieveInput, "agentId" | "scope" | "scopeMode">): RetrievalHit[] {
    return this.memory.search({ ...input, agentId: this.agentId, scope: this.scope, scopeMode: this.scopeMode });
  }

  compileContext(input: Omit<CompileContextInput, "agentId" | "scope" | "scopeMode"> = {}): CompiledContext {
    return this.memory.compileContext({ ...input, agentId: this.agentId, scope: this.scope, scopeMode: this.scopeMode });
  }

  reflect(input: Omit<ReflectInput, "agentId" | "scope"> = {}): Promise<ReflectionDraft[]> {
    return this.memory.reflect({ ...input, agentId: this.agentId, scope: this.scope });
  }

  setSelfModel(input: Omit<SetSelfModelInput, "agentId" | "scope">): SelfModelEntry {
    return this.memory.setSelfModel({ ...input, agentId: this.agentId, scope: this.scope });
  }

  getSelfModel(key: string): SelfModelEntry | undefined {
    return this.memory.getSelfModel(this.agentId, key, this.scope.key);
  }

  selfModelEntries(): SelfModelEntry[] {
    return this.memory.selfModelEntries(this.agentId, this.scope.key, this.scopeMode);
  }

  /** Counts of what is tracked in this namespace (its own scope, not global). */
  stats(): NamespaceCounts {
    return {
      events: this.memory.events.count(this.agentId, this.scope.key, "exact"),
      memories: this.memory.memories.count(this.agentId, this.scope.key, "exact"),
      selfModelEntries: this.memory.selfModel.count(this.agentId, this.scope.key, "exact"),
    };
  }

  /** The namespace registration with counts and last activity. */
  summary(): NamespaceSummary | undefined {
    return this.memory.namespaces.summary(this.scope.key);
  }

  /** Everything tracked in this namespace (self-model, memories, events). */
  detail(options: Omit<GetNamespaceInput, "scope"> = {}): NamespaceDetail | undefined {
    return this.memory.namespaces.detail({ ...options, scope: this.scope.key });
  }
}
