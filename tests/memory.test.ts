import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentMemory,
  AgentMemoryError,
  HashEmbedder,
  MemoryKind,
  MemoryStatus,
  NotFoundError,
  Scope,
  ValidationError,
} from "../src/index.js";
import type { AgentMemoryOptions } from "../src/index.js";

const dirs: string[] = [];
const open: AgentMemory[] = [];

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmem-"));
  dirs.push(dir);
  return join(dir, "memory.db");
}

function make(options: Partial<AgentMemoryOptions> = {}): AgentMemory {
  const memory = new AgentMemory({ path: dbPath(), ...options });
  open.push(memory);
  return memory;
}

afterEach(() => {
  for (const memory of open.splice(0)) {
    try {
      memory.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("schema & pragmas", () => {
  it("applies the required pragmas and runs migrations", () => {
    const memory = make();
    expect(memory.db.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(memory.db.raw.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(memory.db.raw.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(memory.db.raw.pragma("synchronous", { simple: true })).toBe(1);
    const tables = memory.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .map((row) => row.name);
    for (const table of ["events", "memories", "self_model", "memories_fts", "events_fts", "schema_migrations"]) {
      expect(tables).toContain(table);
    }
  });

  it("persists across reopen", async () => {
    const path = dbPath();
    const first = new AgentMemory({ path });
    await first.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Semantic,
      title: "Fact",
      content: "The sky is blue.",
    });
    first.close();

    const second = new AgentMemory({ path });
    open.push(second);
    const list = second.listMemories({ agentId: "forge", scope: Scope.project("p") });
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Fact");
  });
});

describe("events", () => {
  it("records and lists events within a scope", async () => {
    const memory = make();
    await memory.recordEvent({
      agentId: "forge",
      scope: Scope.project("p"),
      type: "tool_result",
      content: "Deploy failed: DATABASE_URL missing",
      data: { tool: "deploy", success: false },
    });
    await memory.recordEvent({ agentId: "forge", scope: Scope.project("other"), type: "note", content: "elsewhere" });

    const events = memory.listEvents({ agentId: "forge", scope: Scope.project("p") });
    expect(events).toHaveLength(1);
    expect(events[0]?.data["tool"]).toBe("deploy");
    expect(memory.events.count("forge", Scope.project("p"))).toBe(1);
  });

  it("supports scope inheritance from global", async () => {
    const memory = make();
    await memory.recordEvent({ agentId: "forge", scope: Scope.global(), type: "note", content: "global note" });
    const events = memory.listEvents({ agentId: "forge", scope: Scope.project("p") });
    expect(events.map((event) => event.content)).toContain("global note");
  });

  it("filters by type and validates input", async () => {
    const memory = make();
    await memory.recordEvent({ agentId: "forge", scope: Scope.project("p"), type: "error", content: "boom" });
    await memory.recordEvent({ agentId: "forge", scope: Scope.project("p"), type: "note", content: "ok" });
    expect(memory.listEvents({ agentId: "forge", scope: Scope.project("p"), types: ["error"] })).toHaveLength(1);
    expect(() => memory.recordEvent({ agentId: "forge", scope: Scope.project("p"), type: "note", content: "" })).toThrow(
      ValidationError,
    );
  });
});

describe("memories", () => {
  it("adds, reads, updates, archives and forgets", async () => {
    const memory = make();
    const created = await memory.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Procedure,
      title: "Verify deployment configuration",
      content: "Before deploying, verify DATABASE_URL is configured.",
      confidence: 0.85,
      importance: 0.9,
    });
    expect(created.status).toBe(MemoryStatus.Active);
    expect(created.id).toMatch(/^mem_/);

    const updated = await memory.updateMemory(created.id, { importance: 0.5, tags: ["deploy"] });
    expect(updated.importance).toBe(0.5);
    expect(updated.tags).toEqual(["deploy"]);

    await memory.archiveMemory(created.id);
    expect(memory.getMemory(created.id)?.status).toBe(MemoryStatus.Archived);

    await memory.forgetMemory(created.id);
    expect(memory.getMemory(created.id)).toBeUndefined();
  });

  it("rejects unknown fields and missing required fields", () => {
    const memory = make();
    expect(() => memory.addMemory({ agentId: "forge", scope: Scope.project("p"), title: "x", content: "y" } as never)).toThrow(
      ValidationError,
    );
    expect(() =>
      memory.addMemory({
        agentId: "forge",
        scope: Scope.project("p"),
        kind: MemoryKind.Semantic,
        title: "x",
        content: "y",
        bogus: true,
      } as never),
    ).toThrow(ValidationError);
  });

  it("throws NotFoundError when updating a missing memory", () => {
    const memory = make();
    expect(() => memory.updateMemory("mem_missing", { importance: 0.5 })).toThrow(NotFoundError);
  });

  it("filters by kind, status and tags and excludes expired memories", async () => {
    const memory = make();
    await memory.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Policy,
      title: "Policy",
      content: "never do x",
      tags: ["guardrail"],
    });
    await memory.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Semantic,
      title: "Expired",
      content: "stale",
      expiresAt: Date.now() - 1000,
    });

    expect(memory.listMemories({ agentId: "forge", scope: Scope.project("p"), kinds: [MemoryKind.Policy] })).toHaveLength(1);
    expect(memory.listMemories({ agentId: "forge", scope: Scope.project("p"), tags: ["guardrail"] })).toHaveLength(1);
    expect(memory.listMemories({ agentId: "forge", scope: Scope.project("p") })).toHaveLength(1);
    expect(memory.listMemories({ agentId: "forge", scope: Scope.project("p"), includeExpired: true })).toHaveLength(2);
  });

  it("keeps the lexical index in sync on update and delete", async () => {
    const memory = make();
    const created = await memory.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Semantic,
      title: "Alpha",
      content: "The quick brown fox",
    });
    expect(memory.search({ agentId: "forge", scope: Scope.project("p"), query: "brown fox" })).toHaveLength(1);
    await memory.updateMemory(created.id, { content: "A completely different sentence about llamas" });
    expect(memory.search({ agentId: "forge", scope: Scope.project("p"), query: "brown fox" })).toHaveLength(0);
    expect(memory.search({ agentId: "forge", scope: Scope.project("p"), query: "llamas" })).toHaveLength(1);
  });
});

describe("scopes", () => {
  it("inherits global memories but isolates projects", async () => {
    const memory = make();
    await memory.addMemory({ agentId: "forge", scope: Scope.global(), kind: MemoryKind.Policy, title: "Global rule", content: "applies everywhere" });
    await memory.addMemory({ agentId: "forge", scope: Scope.project("a"), kind: MemoryKind.Semantic, title: "Only A", content: "secret to a" });

    const inA = memory.search({ agentId: "forge", scope: Scope.project("a"), query: "applies secret" });
    expect(inA.map((hit) => hit.memory.title).sort()).toEqual(["Global rule", "Only A"]);

    const inB = memory.search({ agentId: "forge", scope: Scope.project("b"), query: "applies secret" });
    expect(inB.map((hit) => hit.memory.title)).toEqual(["Global rule"]);

    const exact = memory.search({ agentId: "forge", scope: Scope.project("b"), query: "applies", scopeMode: "exact" });
    expect(exact).toHaveLength(0);
  });
});

describe("self model", () => {
  it("upserts keyed entries and preserves createdAt", () => {
    const memory = make();
    const first = memory.setSelfModel({ agentId: "forge", key: "identity", value: "v1" });
    const second = memory.setSelfModel({ agentId: "forge", key: "identity", value: "v2", confidence: 0.9 });
    expect(second.id).toBe(first.id);
    expect(second.value).toBe("v2");
    expect(second.createdAt).toBe(first.createdAt);
    expect(memory.getSelfModel("forge", "identity")?.value).toBe("v2");
    expect(memory.selfModelEntries("forge")).toHaveLength(1);
    expect(memory.removeSelfModel("forge", "identity")).toBe(true);
    expect(memory.selfModelEntries("forge")).toHaveLength(0);
  });
});

describe("retrieval", () => {
  it("works with no embedder and reports a null vector signal", async () => {
    const memory = make();
    await memory.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Procedure,
      title: "Deploy checklist",
      content: "Verify DATABASE_URL before deploying.",
    });
    const hits = await memory.retrieve({ agentId: "forge", scope: Scope.project("p"), query: "database url deploy" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.memory.title).toBe("Deploy checklist");
    expect(hits[0]?.signals.vector).toBeNull();
    expect(hits[0]?.signals.lexical).not.toBeNull();
  });

  it("adds a vector signal when an embedder is configured", async () => {
    const memory = make({ embedder: new HashEmbedder({ dimensions: 128 }) });
    const created = await memory.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Semantic,
      title: "Environment variables",
      content: "Required environment variables are documented in docs/deploy.md.",
    });
    expect(created.hasEmbedding).toBe(true);
    expect(created.embeddingModel).toContain("hash-embedder");
    expect(created.embeddingDim).toBe(128);

    const hits = await memory.retrieve({ agentId: "forge", scope: Scope.project("p"), query: "environment variables deploy" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.signals.vector).not.toBeNull();
  });

  it("respects minScore, limit and tag filters", async () => {
    const memory = make();
    for (let i = 0; i < 5; i += 1) {
      await memory.addMemory({
        agentId: "forge",
        scope: Scope.project("p"),
        kind: MemoryKind.Semantic,
        title: `Note ${i}`,
        content: `shared keyword payload number ${i}`,
        tags: i % 2 === 0 ? ["even"] : ["odd"],
      });
    }
    const limited = memory.search({ agentId: "forge", scope: Scope.project("p"), query: "shared keyword payload", limit: 2 });
    expect(limited).toHaveLength(2);
    const tagged = memory.search({ agentId: "forge", scope: Scope.project("p"), query: "shared keyword payload", tags: ["even"] });
    expect(tagged).toHaveLength(3);
    expect(memory.search({ agentId: "forge", scope: Scope.project("p"), query: "shared keyword payload", minScore: 1 })).toHaveLength(0);
    expect(memory.search({ agentId: "forge", scope: Scope.project("p"), query: "unrelated zzzz nonsense" })).toHaveLength(0);
  });
});

describe("context compilation", () => {
  it("includes the requested sections and renders markdown", async () => {
    const memory = make();
    memory.setSelfModel({ agentId: "forge", key: "identity", value: "A careful agent." });
    await memory.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Policy,
      title: "Config check",
      content: "Always run the config preflight.",
    });
    await memory.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Procedure,
      title: "Deploy",
      content: "Verify DATABASE_URL then deploy.",
    });
    await memory.recordEvent({ agentId: "forge", scope: Scope.project("p"), type: "tool_result", content: "Deploy failed" });

    const context = memory.compileContext({
      agentId: "forge",
      scope: Scope.project("p"),
      task: "Deploy production",
      tokenBudget: 1200,
      includeSelf: true,
      includePolicies: true,
      includeProcedures: true,
      includeRecentEpisodes: true,
    });

    const ids = context.sections.map((section) => section.id);
    expect(ids).toEqual(expect.arrayContaining(["task", "self", "policies", "procedures", "episodes"]));
    const markdown = context.toMarkdown();
    expect(markdown).toContain("# Agent Context");
    expect(markdown).toContain("Deploy production");
    expect(markdown).toContain("Config check");
    expect(context.tokenCount).toBeLessThanOrEqual(context.tokenBudget);
  });

  it("keeps the compiled context within the token budget", async () => {
    const memory = make();
    for (let i = 0; i < 30; i += 1) {
      await memory.addMemory({
        agentId: "forge",
        scope: Scope.project("p"),
        kind: MemoryKind.Semantic,
        title: `Fact ${i}`,
        content: "lorem ipsum dolor sit amet ".repeat(20),
      });
    }
    const context = memory.compileContext({
      agentId: "forge",
      scope: Scope.project("p"),
      task: "answer a question",
      tokenBudget: 200,
      includeSemantic: true,
      includeTask: false,
    });
    expect(context.tokenCount).toBeLessThanOrEqual(200);
    expect(context.truncated).toBe(true);
    const semantic = context.sections.find((section) => section.id === "semantic");
    expect(semantic && semantic.items.length).toBeLessThan(30);
  });

  it("compiles asynchronously with an embedder", async () => {
    const memory = make({ embedder: new HashEmbedder({ dimensions: 64 }) });
    await memory.addMemory({
      agentId: "forge",
      scope: Scope.project("p"),
      kind: MemoryKind.Semantic,
      title: "Database URL",
      content: "DATABASE_URL is required for deploys.",
    });
    const context = await memory.compileContextAsync({
      agentId: "forge",
      scope: Scope.project("p"),
      task: "deploy the database",
      tokenBudget: 800,
    });
    expect(context.sections.some((section) => section.id === "semantic")).toBe(true);
  });
});

describe("reflection", () => {
  it("detects recurring failures and can persist them", async () => {
    const memory = make();
    for (let i = 0; i < 3; i += 1) {
      await memory.recordEvent({
        agentId: "forge",
        scope: Scope.project("p"),
        type: "tool_result",
        content: "Deploy failed: DATABASE_URL missing",
        data: { tool: "deploy", success: false },
      });
    }
    const drafts = await memory.reflect({ agentId: "forge", scope: Scope.project("p"), threshold: 2 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe(MemoryKind.Procedure);
    expect(drafts[0]?.supportingEventIds).toHaveLength(3);

    await memory.reflect({ agentId: "forge", scope: Scope.project("p"), threshold: 2, persist: true });
    const procedures = memory.listMemories({ agentId: "forge", scope: Scope.project("p"), kinds: [MemoryKind.Procedure] });
    expect(procedures).toHaveLength(1);
  });

  it("returns nothing when the threshold is not met", async () => {
    const memory = make();
    await memory.recordEvent({ agentId: "forge", scope: Scope.project("p"), type: "error", content: "one-off" });
    expect(await memory.reflect({ agentId: "forge", scope: Scope.project("p"), threshold: 2 })).toHaveLength(0);
  });

  it("accepts a host-provided reflector", async () => {
    const memory = make({
      reflector: {
        id: "test",
        async reflect() {
          return [
            {
              title: "Custom",
              content: "From the host.",
              kind: MemoryKind.Semantic,
              confidence: 0.5,
              importance: 0.5,
              tags: [],
              supportingEventIds: [],
              rationale: null,
            },
          ];
        },
      },
    });
    const drafts = await memory.reflect({ agentId: "forge", scope: Scope.project("p") });
    expect(drafts[0]?.title).toBe("Custom");
  });
});

describe("lifecycle", () => {
  it("reports stats and rejects use after close", async () => {
    const memory = make();
    await memory.addMemory({ agentId: "forge", scope: Scope.project("p"), kind: MemoryKind.Semantic, title: "x", content: "y" });
    memory.setSelfModel({ agentId: "forge", key: "identity", value: "z" });
    expect(memory.stats()).toEqual({ events: 0, memories: 1, selfModelEntries: 1 });
    memory.close();
    memory.close();
    expect(() => memory.listMemories({ agentId: "forge" })).toThrow(AgentMemoryError);
  });
});
