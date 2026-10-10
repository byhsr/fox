# agent-memory

Local-first, portable **agent memory** in a single SQLite file.

`agent-memory` gives an agent a durable place to remember what happened (events),
what it knows (typed memories), who it is (a persistent self-model), and how to
pull the right slice of that into a token-budgeted context window — all offline,
with no API keys and no vector database.

It is a TypeScript package for **Node.js 22+** and **Bun**, with a
framework-independent, promise-based mutation API. It does not run a web server
and does not talk to the network.

## Philosophy

Most work in agentic memory is about *the user's* context: remembering what
someone said, preferred, or did, so the assistant can serve them better. `fox`
points the same machinery at a different subject — the agent itself.

Here, memory is what gives an agent a **self**. The self-model holds its
identity, values, goals, and current focus. Typed memories hold what it knows
(`semantic`), how it does things (`procedural`), the rules it operates under
(`policy`), its leanings (`preference`), and what it concluded (`reflection`).
Events are its experience: what actually happened, in order. Together they are
not a transcript of the conversation — they are a sense of self and a repertoire
of things the agent can do and how it does them.

None of it is static. Every interaction, and every user, leaves a trace, and the
agent is meant to change because of it. Set a self-model key and it upserts as
the agent's understanding of itself shifts. Reflect over recurring episodes and
last week's failures become this week's procedures. Memory compounds with use.

The goal is not a bigger context window. It is a small, durable sense of self
and capability that survives sessions, stays lean in the prompt, and can be
recalled on demand — so the agent carries *who it is and what it can do*, not
everything it has ever seen.

## Why this design

The hard problem is fast iteration on memory semantics, retrieval quality,
context compilation, and evaluation — not building a storage engine. So the
package leans on SQLite (via `better-sqlite3`) for durable, synchronous, local
storage, uses FTS5 for lexical retrieval, and treats embeddings as an optional
extra signal rather than a requirement.

## Features

- **Events** — append-only episodes (`tool_result`, `user_message`, …) with scoped, queryable history.
- **Typed memories** — `episodic`, `semantic`, `procedural`, `policy`, `preference`, `reflection`, `self_model`, with status, confidence, importance, tags, expiry, and provenance.
- **Persistent self-model** — keyed identity/values/goals entries that survive across sessions.
- **Hybrid retrieval** — SQLite FTS5 (BM25) + optional embedding cosine + importance/confidence/recency heuristics, all blended into one score.
- **Context compilation** — assembles self-model, policies, procedures, facts, and recent episodes into a token-budgeted markdown block.
- **Reflection** — a deterministic, offline reflector surfaces recurring failure patterns as candidate memories; inject your own LLM-backed reflector if you want.
- **Fully local** — one portable `.db` file, WAL mode, foreign keys on.

## Install

```bash
npm install agent-memory
```

Requires Node 22+ (or Bun). The native `better-sqlite3` binary is installed as a
dependency.

## Quick start

```ts
import { AgentMemory, MemoryKind, Scope } from "agent-memory";

const memory = new AgentMemory({
  path: "./forge.agentmem.db",
});

memory.recordEvent({
  agentId: "forge",
  scope: Scope.project("agent-memory"),
  type: "tool_result",
  content: "Deploy failed: DATABASE_URL missing",
});

memory.addMemory({
  agentId: "forge",
  scope: Scope.project("agent-memory"),
  kind: MemoryKind.Procedure,
  title: "Verify deployment configuration",
  content: "Before deploying this project, verify DATABASE_URL is configured.",
  confidence: 0.85,
  importance: 0.9,
  status: "active",
});

const context = memory.compileContext({
  agentId: "forge",
  scope: Scope.project("agent-memory"),
  task: "Deploy production",
  tokenBudget: 1200,
  includeSelf: true,
  includePolicies: true,
  includeProcedures: true,
  includeRecentEpisodes: true,
});

console.log(context.toMarkdown());
```

Everything works with no embeddings. Run the full tour with:

```bash
npm run example
```

## Concepts

### Scopes

A scope is a namespace for memory. `Scope` is a factory:

```ts
Scope.global();               // shared across everything
Scope.agent("forge");
Scope.project("agent-memory");
Scope.session("2026-10-03");
Scope.task("deploy-42");
```

Queries default to `scopeMode: "inherit"`, which means they see their own scope
**plus** `global` (shared rules and facts). Use `scopeMode: "exact"` to match only
the given scope. You may also pass a raw string key (`"project:agent-memory"`).

### Namespaces

A namespace is a named scope — typically a project — whose memory is tracked
together. Register one to give it a name and description, then list or show it to
see everything tracked there.

```ts
memory.createNamespace({
  scope: Scope.project("checkout"),
  name: "Checkout Service",
  description: "Payment flow",
});

await memory.addMemory({
  agentId: "forge",
  scope: Scope.project("checkout"),
  kind: MemoryKind.Policy,
  title: "Validate card tokens",
  content: "Never charge without validating the card token first.",
});
memory.setSelfModel({ agentId: "forge", scope: Scope.project("checkout"), key: "identity", value: "Checkout agent." });

memory.listNamespaces();                                        // namespaces with counts + last activity
memory.namespaceDetail({ scope: Scope.project("checkout") });   // everything tracked there
```

To avoid repeating the agent and scope, bind a handle:

```ts
const project = memory.namespace({ agentId: "forge", scope: Scope.project("checkout") });

await project.addMemory({ kind: MemoryKind.Policy, title: "…", content: "…" });
project.setSelfModel({ key: "identity", value: "Checkout agent." });
project.stats();                    // counts for this namespace
project.detail();                   // self-model, memories, and recent events
project.compileContext({ task: "deploy" });
```

Counts and last-activity are derived live from the scoped events, memories, and
self-model entries. The same operations are available from the CLI (and a
portable binary):

```bash
agent-memory create_namespace --json '{"scope":"project:checkout","name":"Checkout Service"}'
agent-memory list_namespaces --pretty
agent-memory get_namespace --json '{"scope":"project:checkout"}' --pretty
```

### Events

Events are raw, mostly-immutable things that happened. They feed reflection and
the "recent episodes" section of compiled context.

```ts
await memory.recordEvent({
  agentId: "forge",
  scope: Scope.project("agent-memory"),
  type: "tool_result",
  content: "Deploy failed: DATABASE_URL missing",
  data: { tool: "deploy", success: false },
  importance: 0.8,
  occurredAt: new Date(),
});
```

### Memories

Memories are durable, typed, and retrievable. Each carries `confidence`,
`importance`, `tags`, `status`, and optional `sourceEventIds`.

```ts
const created = await memory.addMemory({
  agentId: "forge",
  scope: Scope.project("agent-memory"),
  kind: MemoryKind.Policy,
  title: "Never deploy without a config check",
  content: "Deployments must run the configuration preflight first.",
  importance: 0.95,
  tags: ["deploy", "guardrail"],
});
```

Only `active` memories are retrieved and compiled by default. Use
`updateMemory`, `archiveMemory`, and `forgetMemory` to evolve them.

### Self-model

The self-model is a small, canonical set of keyed entries, scoped like everything
else. Setting a key upserts it. Entries default to `global`; set a scope to give a
namespace its own identity/values/focus, and reads inherit `global` unless you ask
for `exact`.

```ts
memory.setSelfModel({ agentId: "forge", key: "identity", value: "A careful coding agent." });
memory.setSelfModel({ agentId: "forge", scope: Scope.project("checkout"), key: "current_focus", value: "Ship a reliable checkout." });

memory.selfModelEntries("forge");                                      // every scope
memory.selfModelEntries("forge", Scope.project("checkout"));           // checkout + global
memory.selfModelEntries("forge", Scope.project("checkout"), "exact");  // checkout only
```

### Retrieval

`retrieve` (async) and `search` (sync) rank memories by a weighted blend of
signals. A candidate is only returned when it has a genuine relevance signal
(a lexical match or a non-zero vector similarity) — unrelated queries return an
empty list rather than the most recent memories.

```ts
const hits = await memory.retrieve({
  agentId: "forge",
  scope: Scope.project("agent-memory"),
  query: "deploy production database url",
  limit: 5,
  tags: ["deploy"],           // optional
  halfLifeDays: 30,           // recency decay
  weights: { lexical: 0.6, vector: 0.2 }, // optional overrides
});

for (const hit of hits) {
  console.log(hit.score, hit.memory.title, hit.signals);
}
```

The default weights are lexical `0.5`, vector `0.3`, importance `0.1`,
confidence `0.05`, recency `0.05`. Signals that are unavailable (for example
vector, when no embedder is configured) are dropped and the rest are
renormalized, so retrieval always works offline.

### Context compilation

```ts
const context = memory.compileContext({
  agentId: "forge",
  scope: Scope.project("agent-memory"),
  task: "Deploy production",
  tokenBudget: 1200,
  includeSelf: true,
  includePolicies: true,
  includeProcedures: true,
  includeSemantic: true,
  includeRecentEpisodes: true,
  includePreferences: false,  // opt-in
  includeReflections: false,  // opt-in
});

context.sections;   // structured sections and items
context.tokenCount; // tokens used
context.truncated;  // true if items were dropped to fit
context.toMarkdown();
```

Sections are filled under a hard token budget. Mandatory sections (task and
self-model) are reserved first; the rest receive proportional shares and any
leftover budget is redistributed in priority order. Token counts use a default
estimate of ~4 characters per token — pass `tokenEstimator` to override.

### Reflection

Reflection turns recent episodes into candidate memories. The default
`HeuristicReflector` finds recurring failure patterns offline. Provide your own
`reflector` to use an LLM.

```ts
const drafts = await memory.reflect({
  agentId: "forge",
  scope: Scope.project("agent-memory"),
  threshold: 2,     // min repeats to surface a pattern
  persist: true,    // write the drafts as memories
});

await memory.saveReflection({
  agentId: "forge",
  scope: Scope.project("agent-memory"),
  title: "Prefer explicit config validation",
  content: "Validate configuration before any deploy step.",
  kind: MemoryKind.Policy,
});
```

## Optional embeddings

Embeddings are an **additional** retrieval signal, never the only mechanism. The
core package makes no network calls; you inject an `Embedder`.

```ts
import { AgentMemory, HashEmbedder } from "agent-memory";

const memory = new AgentMemory({
  path: "./forge.agentmem.db",
  embedder: new HashEmbedder({ dimensions: 256 }), // deterministic, offline stand-in
});
```

`HashEmbedder` is a dependency-free local placeholder for demos and tests — not a
semantic model. For production, implement the interface with a real model:

```ts
import type { Embedder } from "agent-memory";

const embedder: Embedder = {
  id: "my-model-v1",
  dimensions: 768,
  async embed(texts) {
    return texts.map(() => new Array(768).fill(0)); // call your local model here
  },
};
```

When an embedder is configured, `addMemory`/`updateMemory` compute and store
vectors, `retrieve` adds a cosine signal, and `compileContextAsync` uses the
embedding-enhanced path. `compileContext` (sync) stays lexical + heuristic.

## API reference

### `new AgentMemory(options)`

| Option | Type | Description |
| --- | --- | --- |
| `path` | `string` | SQLite file path, or `":memory:"`. Required. |
| `embedder` | `Embedder` | Optional embedding provider. |
| `reflector` | `Reflector` | Optional reflection provider (defaults to heuristic). |
| `tokenEstimator` | `(text: string) => number` | Override token estimation. |
| `now` | `() => number` | Clock injection (epoch ms). |
| `readOnly` | `boolean` | Open the database read-only. |
| `autoMigrate` | `boolean` | Run migrations on open (default `true`). |

### Methods

| Method | Returns | Notes |
| --- | --- | --- |
| `recordEvent(input)` | `Promise<Event>` | Append an episode. |
| `listEvents(input)` / `getEvent(id)` / `recentEvents(...)` | `Event[]` / `Event` | Query history. |
| `addMemory(input)` | `Promise<Memory>` | Embed first if configured. |
| `updateMemory(id, patch)` | `Promise<Memory>` | Re-embeds when text changes. |
| `archiveMemory(id)` / `forgetMemory(id)` | `Promise<Memory>` / `Promise<void>` | Soft / hard delete. |
| `getMemory(id)` / `listMemories(input)` | `Memory` / `Memory[]` | Reads. |
| `setSelfModel(input)` / `getSelfModel(...)` / `selfModelEntries(...)` / `removeSelfModel(...)` | | Scoped self-model (defaults to `global`). |
| `retrieve(input)` | `Promise<RetrievalHit[]>` | Embedding-aware. |
| `search(input)` | `RetrievalHit[]` | Synchronous lexical + heuristic. |
| `compileContext(input)` | `CompiledContext` | Synchronous. |
| `compileContextAsync(input)` | `Promise<CompiledContext>` | Embedding-aware. |
| `reflect(input)` | `Promise<ReflectionDraft[]>` | Optionally persists. |
| `saveReflection(input)` | `Promise<Memory>` | Persist a reflection. |
| `createNamespace(input)` / `getNamespace(scope)` / `listNamespaces(input)` | | Namespace registry. |
| `namespaceSummary(scope)` / `namespaceDetail(input)` / `removeNamespace(scope)` | | Counts and everything tracked in a namespace. |
| `namespace(options)` | `NamespaceHandle` | Bound, pre-scoped namespace operations. |
| `stats()` / `close()` | | Lifecycle. |

The lower-level stores (`memory.events`, `memory.memories`, `memory.selfModel`,
`memory.namespaces`, `memory.retriever`) are also exported and usable directly.

### Errors

All errors extend `AgentMemoryError` with a `code`: `ValidationError`
(`VALIDATION_ERROR`), `NotFoundError` (`NOT_FOUND`), `DatabaseError`
(`DATABASE_ERROR`), `MigrationError` (`MIGRATION_ERROR`), `EmbeddingError`
(`EMBEDDING_ERROR`). Every public input is validated with `zod`; unknown fields
are rejected.

## Database

A single SQLite file with these settings applied on open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

Schema migrations live in `migrations/` and are applied inside a transaction,
tracked in `schema_migrations`. Two FTS5 tables (`memories_fts`, `events_fts`)
are kept in sync by triggers. Embeddings are stored as compact `BLOB`s
(`Float32Array`), tagged with their model id and dimension. Namespaces are
recorded in a `namespaces` registry, and `self_model` rows are scoped
(`unique(agent_id, scope, key)`; rows from older databases are migrated as
`global`).

## Design notes

- **Mutations are promise-based; reads and compilation are synchronous.** SQLite
  access is local and synchronous, so `compileContext` and the getters return
  directly; async variants exist where embeddings (`async` embedders) are
  involved. This keeps the documented usage — including `compileContext(...)`
  followed by `context.toMarkdown()` — working as-is.
- **Embeddings are additive.** Retrieval and compilation never depend on them.
- **No hidden I/O.** The core package performs no network calls and needs no keys.

## Portable binary

You can bake the current memory into a single self-contained executable and move
it anywhere — the accumulated memory comes with it, with no Node install, no
`node_modules`, and no native addon to build.

```bash
# Build from the default database ($AGENT_MEMORY_DB or ./agent-memory.db)
npm run binary

# Or choose the source database and output
bun run scripts/build-binary.ts --db ./forge.agentmem.db --out ./forge-memory

# Cross-compile (Bun downloads the target runtime on first use)
bun run scripts/build-binary.ts --target bun-linux-x64 --out ./forge-memory-linux

# Build an MCP server binary instead of the CLI
npm run binary:mcp
```

The build checkpoints the source database (folding any WAL into a single file),
bakes it plus the migration SQL into the executable, and compiles with
`bun build --compile`. At runtime the binary uses Bun's built-in SQLite rather
than `better-sqlite3`, which cannot load under Bun (oven-sh/bun#4290).

On first launch the binary seeds a working database from the embedded copy:

- If the target database (from `--db`, `$AGENT_MEMORY_DB`, or `./agent-memory.db`)
  does not exist, it is created from the baked-in memory.
- If it already exists, it is left untouched, so memory accumulates across runs.

To pull memory back out of a binary — to inspect it, move it on, or re-bake it
into a new binary — use `extract`:

```bash
./agent-memory extract --out memory.db        # current (working) memory
./agent-memory extract --embedded --out baked.db  # the memory baked at build time
```

Both produce an ordinary SQLite file, readable by this package, the CLI, or any
SQLite tool.

## Development

```bash
npm install --include=dev
npm run build        # tsc -> dist/
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run example      # run examples/basic.ts
```

## License

MIT
