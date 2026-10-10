import { cosineSimilarity } from "./embedder.js";
import type { Db } from "./database.js";
import type { EventStore } from "./events.js";
import type { MemoryStore } from "./memories.js";
import { clamp01, mergeWeights, type Retriever } from "./retrieval.js";
import type { SelfModelStore } from "./self-model.js";
import {
  MemoryKind,
  MemoryStatus,
  compileContextSchema,
  normalizeScope,
  parseInput,
  scopeKeys,
  type CompileContextInput,
  type CompileContextParams,
  type ContextItem,
  type ContextSection,
  type Memory,
  type RetrievalWeights,
} from "./types.js";

const DAY_MS = 86_400_000;

/** Default estimator: roughly 4 characters per token. Override for accuracy. */
export function defaultTokenEstimator(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface CompiledContextData {
  agentId: string;
  scope: string;
  task: string | null;
  sections: ContextSection[];
  tokenCount: number;
  tokenBudget: number;
  truncated: boolean;
  generatedAt: number;
}

/** The result of `compileContext`. Renders to markdown for direct injection. */
export class CompiledContext {
  readonly agentId: string;
  readonly scope: string;
  readonly task: string | null;
  readonly sections: ContextSection[];
  readonly tokenCount: number;
  readonly tokenBudget: number;
  readonly truncated: boolean;
  readonly generatedAt: number;

  constructor(data: CompiledContextData) {
    this.agentId = data.agentId;
    this.scope = data.scope;
    this.task = data.task;
    this.sections = data.sections;
    this.tokenCount = data.tokenCount;
    this.tokenBudget = data.tokenBudget;
    this.truncated = data.truncated;
    this.generatedAt = data.generatedAt;
  }

  /** Alias for `toMarkdown()`. */
  get text(): string {
    return this.toMarkdown();
  }

  toMarkdown(): string {
    const lines: string[] = ["# Agent Context", ""];
    const meta = [
      `scope: ${this.scope}`,
      `agent: ${this.agentId}`,
      `tokens: ~${this.tokenCount}/${this.tokenBudget}${this.truncated ? ", truncated" : ""}`,
    ];
    lines.push(`_${meta.join(" · ")}_`, "");

    for (const section of this.sections) {
      lines.push(`## ${section.title}`);
      for (const item of section.items) {
        lines.push(renderItem(item));
      }
      lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  toJSON(): CompiledContextData {
    return {
      agentId: this.agentId,
      scope: this.scope,
      task: this.task,
      sections: this.sections,
      tokenCount: this.tokenCount,
      tokenBudget: this.tokenBudget,
      truncated: this.truncated,
      generatedAt: this.generatedAt,
    };
  }

  toString(): string {
    return this.toMarkdown();
  }
}

interface SectionState {
  id: string;
  title: string;
  priority: number;
  weight: number;
  items: ContextItem[];
  chosen: ContextItem[];
  tokens: number;
}

interface MemorySectionPlan {
  id: string;
  title: string;
  kind: MemoryKind;
  priority: number;
  weight: number;
}

/** Builds a token-budgeted context from the self-model, memories, and episodes. */
export class ContextCompiler {
  constructor(
    private readonly db: Db,
    private readonly memories: MemoryStore,
    private readonly events: EventStore,
    private readonly selfModel: SelfModelStore,
    private readonly retriever: Retriever,
    private readonly estimator: (text: string) => number = defaultTokenEstimator,
  ) {}

  /** Synchronous compilation (lexical + heuristic signals only). */
  compile(input: CompileContextInput): CompiledContext {
    const params = parseInput(compileContextSchema, input);
    return this.build(params, null);
  }

  /** Async compilation; adds an embedding signal when an embedder is configured. */
  async compileAsync(input: CompileContextInput): Promise<CompiledContext> {
    const params = parseInput(compileContextSchema, input);
    if (!this.retriever.hasEmbedder) return this.build(params, null);
    const query = (params.query ?? params.task ?? "").trim();
    const vector = query.length > 0 ? await this.retriever.embedQuery(query) : null;
    return this.build(params, vector);
  }

  private build(params: CompileContextParams, queryVector: Float32Array | null): CompiledContext {
    const estimator = params.tokenEstimator ?? this.estimator;
    const scope = normalizeScope(params.scope);
    const scopeMode = params.scopeMode ?? "inherit";
    const now = this.db.now();
    const task = params.task?.trim() ?? "";
    const query = (params.query ?? params.task ?? "").trim();
    const halfLife = params.halfLifeDays ?? 30;
    const tokenBudget = params.tokenBudget ?? 1500;
    const maxItems = params.maxItemsPerSection ?? 8;
    const recentEpisodeLimit = params.recentEpisodeLimit ?? 12;
    const weights: RetrievalWeights = mergeWeights(this.retriever.weights, params.weights);

    const lexical =
      query.length > 0
        ? this.retriever.lexicalScores({
            agentId: params.agentId,
            scopes: scopeKeys(scope, scopeMode),
            statuses: [MemoryStatus.Active],
            query,
            limit: 80,
          })
        : new Map<string, number>();

    const memoryPlans: MemorySectionPlan[] = [];
    if (params.includePolicies !== false) {
      memoryPlans.push({ id: "policies", title: "Policies", kind: MemoryKind.Policy, priority: 1, weight: 0.9 });
    }
    if (params.includeProcedures !== false) {
      memoryPlans.push({ id: "procedures", title: "Procedures", kind: MemoryKind.Procedure, priority: 2, weight: 1.0 });
    }
    if (params.includeSemantic !== false) {
      memoryPlans.push({ id: "semantic", title: "Facts", kind: MemoryKind.Semantic, priority: 3, weight: 0.8 });
    }
    if (params.includePreferences === true) {
      memoryPlans.push({ id: "preferences", title: "Preferences", kind: MemoryKind.Preference, priority: 4, weight: 0.5 });
    }
    if (params.includeReflections === true) {
      memoryPlans.push({ id: "reflections", title: "Reflections", kind: MemoryKind.Reflection, priority: 4, weight: 0.6 });
    }

    const planMemories = new Map<string, Memory[]>();
    const allCandidates: Memory[] = [];
    for (const plan of memoryPlans) {
      const list = this.memories.byKind(params.agentId, scope.key, [plan.kind], 100, scopeMode);
      planMemories.set(plan.id, list);
      allCandidates.push(...list);
    }

    const embeddings =
      queryVector !== null
        ? this.memories.getEmbeddings(allCandidates.filter((memory) => memory.hasEmbedding).map((memory) => memory.id))
        : new Map<string, Float32Array>();

    const states: SectionState[] = [];

    if (params.includeTask !== false && task.length > 0) {
      const budgetChars = Math.max(80, Math.floor(tokenBudget * 0.25) * 4);
      const text = task.length <= budgetChars ? task : `${task.slice(0, budgetChars - 1)}…`;
      states.push({
        id: "task",
        title: "Task",
        priority: 0,
        weight: 1,
        items: [{ id: null, kind: "task", title: null, text, score: 1, tokens: estimator(text) }],
        chosen: [],
        tokens: 0,
      });
    }

    if (params.includeSelf !== false) {
      const items = this.selfModel.all(params.agentId, scope.key, scopeMode).map<ContextItem>((entry) => {
        const text = `${entry.key}: ${entry.value}`;
        return {
          id: entry.id,
          kind: "self",
          title: entry.key,
          text: entry.value,
          score: clamp01(0.5 * entry.importance + 0.5 * entry.confidence),
          tokens: estimator(text),
        };
      });
      items.sort((a, b) => b.score - a.score);
      states.push({ id: "self", title: "Self Model", priority: 0, weight: 1, items: items.slice(0, maxItems), chosen: [], tokens: 0 });
    }

    for (const plan of memoryPlans) {
      const items = (planMemories.get(plan.id) ?? []).map<ContextItem>((memory) => {
        const stored = embeddings.get(memory.id);
        const vector = queryVector !== null && stored !== undefined ? clamp01(cosineSimilarity(queryVector, stored)) : null;
        const signals = this.retriever.signalsFor(memory, lexical.get(memory.id) ?? null, vector, now, halfLife);
        const text = `${memory.title}\n${memory.content}`;
        return {
          id: memory.id,
          kind: memory.kind,
          title: memory.title,
          text: memory.content,
          score: this.retriever.score(signals, weights),
          tokens: estimator(text),
        };
      });
      items.sort((a, b) => b.score - a.score);
      states.push({
        id: plan.id,
        title: plan.title,
        priority: plan.priority,
        weight: plan.weight,
        items: items.slice(0, maxItems),
        chosen: [],
        tokens: 0,
      });
    }

    if (params.includeRecentEpisodes !== false) {
      const items = this.events.recent(params.agentId, scope.key, recentEpisodeLimit, scopeMode).map<ContextItem>((event) => {
        const ageDays = Math.max(0, (now - event.occurredAt) / DAY_MS);
        const recency = Math.exp(-ageDays / halfLife);
        const text = `[${event.type}] ${event.content}`;
        return {
          id: event.id,
          kind: "event",
          title: null,
          text,
          score: clamp01(0.65 * recency + 0.35 * clamp01(event.importance)),
          tokens: estimator(text),
        };
      });
      items.sort((a, b) => b.score - a.score);
      states.push({
        id: "episodes",
        title: "Recent Episodes",
        priority: 3,
        weight: 0.7,
        items: items.slice(0, maxItems),
        chosen: [],
        tokens: 0,
      });
    }

    this.allocate(states, tokenBudget, estimator);

    const sections: ContextSection[] = states
      .filter((state) => state.chosen.length > 0)
      .map((state) => ({ id: state.id, title: state.title, items: state.chosen, tokens: state.tokens }));
    const tokenCount = sections.reduce((total, section) => total + section.tokens, 0);
    const truncated = states.some((state) => state.chosen.length < state.items.length);

    return new CompiledContext({
      agentId: params.agentId,
      scope: scope.key,
      task: task.length > 0 ? task : null,
      sections,
      tokenCount,
      tokenBudget,
      truncated,
      generatedAt: now,
    });
  }

  private allocate(states: SectionState[], tokenBudget: number, estimator: (text: string) => number): void {
    let remaining = tokenBudget;
    const mandatoryCap = Math.max(32, Math.floor(tokenBudget * 0.3));

    for (const state of states.filter((s) => s.priority === 0)) {
      this.fill(state, Math.min(remaining, mandatoryCap), estimator);
      remaining -= state.tokens;
    }

    const rest = states
      .filter((state) => state.priority > 0 && state.items.length > 0)
      .sort((a, b) => a.priority - b.priority || b.weight - a.weight);

    let progress = true;
    while (remaining > 0 && progress) {
      progress = false;
      const active = rest.filter((state) => state.chosen.length < state.items.length);
      if (active.length === 0) break;
      const weightSum = active.reduce((total, state) => total + state.weight, 0) || 1;
      for (const state of active) {
        if (remaining <= 0) break;
        const share = Math.max(1, Math.floor((remaining * state.weight) / weightSum));
        const before = state.tokens;
        this.fill(state, share, estimator);
        if (state.tokens > before) progress = true;
        remaining -= state.tokens - before;
      }
    }
  }

  private fill(state: SectionState, cap: number, estimator: (text: string) => number): void {
    let budget = cap;
    if (state.chosen.length === 0) {
      const header = estimator(`## ${state.title}`);
      if (header > budget) return;
      state.tokens += header;
      budget -= header;
    }
    while (state.chosen.length < state.items.length) {
      const item = state.items[state.chosen.length];
      if (item === undefined) break;
      if (item.tokens > budget) break;
      state.chosen.push(item);
      state.tokens += item.tokens;
      budget -= item.tokens;
    }
  }
}

function renderItem(item: ContextItem): string {
  if (item.kind === "task") return item.text;
  if (item.title !== null) return `- **${item.title}** (score ${item.score.toFixed(2)}) — ${item.text}`;
  return `- ${item.text}`;
}
