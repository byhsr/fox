/**
 * Runnable tour of agent-memory.
 *
 *   npm run example
 */
import { rmSync } from "node:fs";
import { AgentMemory, HashEmbedder, MemoryKind, Scope } from "../src/index.js";

const dbPath = "./forge.agentmem.db";
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

// --- 1. The public API, exactly as documented -------------------------------

const memory = new AgentMemory({ path: dbPath });

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

// --- 2. A little more state so retrieval and reflection have something to do -

const scope = Scope.project("agent-memory");
memory.setSelfModel({ agentId: "forge", key: "identity", value: "A careful coding agent for the agent-memory project." });
memory.setSelfModel({ agentId: "forge", key: "current_focus", value: "Ship a reliable deployment path." });

await memory.recordEvent({
  agentId: "forge",
  scope,
  type: "tool_result",
  content: "Deploy failed: DATABASE_URL missing",
  data: { tool: "deploy", success: false },
  occurredAt: new Date(Date.now() - 60_000),
});
await memory.recordEvent({
  agentId: "forge",
  scope,
  type: "tool_result",
  content: "Deploy failed: DATABASE_URL missing",
  data: { tool: "deploy", success: false },
});
await memory.addMemory({
  agentId: "forge",
  scope,
  kind: MemoryKind.Policy,
  title: "Never deploy without a config check",
  content: "Deployments must run the configuration preflight before touching production.",
  importance: 0.95,
  confidence: 0.9,
});
await memory.addMemory({
  agentId: "forge",
  scope,
  kind: MemoryKind.Semantic,
  title: "Production database",
  content: "Production uses a managed Postgres instance; DATABASE_URL is injected by the platform.",
  importance: 0.7,
});

// --- 3. Hybrid retrieval ----------------------------------------------------

const hits = await memory.retrieve({ agentId: "forge", scope, query: "deploy production database url", limit: 3 });
console.log("Top retrieval hits:");
for (const hit of hits) {
  console.log(`  ${hit.score.toFixed(3)}  ${hit.memory.title}`);
}

// --- 4. Reflection over the recurring failures ------------------------------

const drafts = await memory.reflect({ agentId: "forge", scope, threshold: 2, persist: true });
console.log(`\nReflection drafts (${drafts.length}):`);
for (const draft of drafts) {
  console.log(`  [${draft.kind}] ${draft.title} (importance ${draft.importance.toFixed(2)})`);
}

// --- 5. Embeddings are optional ---------------------------------------------

const embedded = new AgentMemory({ path: ":memory:", embedder: new HashEmbedder({ dimensions: 256 }) });
await embedded.addMemory({
  agentId: "forge",
  scope: "project:agent-memory",
  kind: MemoryKind.Semantic,
  title: "Deploy runbook",
  content: "The deploy runbook lives in docs/deploy.md and lists every required environment variable.",
});
const embeddedHits = await embedded.retrieve({ agentId: "forge", scope: "project:agent-memory", query: "which env vars are required", limit: 1 });
console.log(`\nEmbedding-assisted hit: ${embeddedHits[0]?.memory.title} (${embeddedHits[0]?.score.toFixed(3)})`);

console.log(`\nStats: ${JSON.stringify(memory.stats())}`);

memory.close();
embedded.close();
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
