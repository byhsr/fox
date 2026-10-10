import { z } from "zod";
import type { AgentMemory } from "./index.js";
import { ValidationError } from "./errors.js";
import {
  addMemorySchema,
  compileContextSchema,
  createNamespaceSchema,
  getNamespaceSchema,
  listMemoriesSchema,
  listNamespacesSchema,
  namespaceRefSchema,
  parseInput,
  recordEventSchema,
  reflectSchema,
  retrieveSchema,
  saveReflectionSchema,
  setSelfModelSchema,
  updateMemorySchema,
  zScopeInput,
  zScopeMode,
} from "./types.js";

/**
 * A single, framework-independent operation over an `AgentMemory` instance.
 *
 * The same definitions back both the CLI (`agent-memory <name>`) and the MCP
 * server (`tools/list` + `tools/call`), so the two surfaces never drift.
 */
export interface CommandDefinition {
  name: string;
  description: string;
  /** Zod schema used for discovery (JSON Schema) and input validation. */
  schema: z.ZodTypeAny;
  run(memory: AgentMemory, input: unknown): Promise<unknown>;
}

/** Register a command with a strongly-typed handler. */
export function defineCommand<S extends z.ZodTypeAny>(definition: {
  name: string;
  description: string;
  schema: S;
  run(memory: AgentMemory, input: z.output<S>): Promise<unknown> | unknown;
}): CommandDefinition {
  return {
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    async run(memory, input) {
      return definition.run(memory, input as z.output<S>);
    },
  };
}

const byIdSchema = z.object({ id: z.string().min(1) }).strict();

export const commands: CommandDefinition[] = [
  defineCommand({
    name: "record_event",
    description: "Append a raw episode (event) to memory: what happened, with optional structured data.",
    schema: recordEventSchema,
    run: (memory, input) => memory.recordEvent(input),
  }),
  defineCommand({
    name: "add_memory",
    description:
      "Add a durable typed memory. kind is one of episodic, semantic, procedural, policy, preference, reflection, self_model.",
    schema: addMemorySchema,
    run: (memory, input) => memory.addMemory(input),
  }),
  defineCommand({
    name: "get_memory",
    description: "Fetch a single memory by id. Returns null if it does not exist.",
    schema: byIdSchema,
    run: (memory, input) => memory.getMemory(input.id) ?? null,
  }),
  defineCommand({
    name: "list_memories",
    description: "List memories, optionally filtered by scope, kind, status, or tags.",
    schema: listMemoriesSchema,
    run: (memory, input) => memory.listMemories(input),
  }),
  defineCommand({
    name: "update_memory",
    description: "Update fields of an existing memory. Re-embeds when the title or content changes.",
    schema: z.object({ id: z.string().min(1), patch: updateMemorySchema }).strict(),
    run: (memory, input) => memory.updateMemory(input.id, input.patch),
  }),
  defineCommand({
    name: "archive_memory",
    description: "Archive a memory (soft delete: status becomes archived).",
    schema: byIdSchema,
    run: (memory, input) => memory.archiveMemory(input.id),
  }),
  defineCommand({
    name: "forget_memory",
    description: "Permanently delete a memory.",
    schema: byIdSchema,
    run: async (memory, input) => {
      await memory.forgetMemory(input.id);
      return { forgotten: true, id: input.id };
    },
  }),
  defineCommand({
    name: "search",
    description:
      "Recall relevant memories for a query. Hybrid: SQLite FTS5 lexical + optional embeddings + importance/confidence/recency.",
    schema: retrieveSchema,
    run: (memory, input) => memory.retrieve(input),
  }),
  defineCommand({
    name: "compile_context",
    description:
      "Compile a token-budgeted context block (self-model, policies, procedures, facts, recent episodes). Returns structured sections plus ready-to-inject markdown.",
    schema: compileContextSchema,
    run: (memory, input) => {
      const context = memory.compileContext(input);
      return { ...context.toJSON(), markdown: context.toMarkdown() };
    },
  }),
  defineCommand({
    name: "set_self_model",
    description: "Set (upsert) a keyed self-model entry: identity, values, capabilities, goals, current focus.",
    schema: setSelfModelSchema,
    run: (memory, input) => memory.setSelfModel(input),
  }),
  defineCommand({
    name: "get_self_model",
    description: "Get self-model entries for an agent in a scope, or a single entry when key is provided.",
    schema: z
      .object({
        agentId: z.string().min(1),
        key: z.string().min(1).optional(),
        scope: zScopeInput.optional(),
        scopeMode: zScopeMode.optional(),
      })
      .strict(),
    run: (memory, input) =>
      input.key !== undefined
        ? (memory.getSelfModel(input.agentId, input.key, input.scope) ?? null)
        : memory.selfModelEntries(input.agentId, input.scope, input.scopeMode ?? "inherit"),
  }),
  defineCommand({
    name: "remove_self_model",
    description: "Remove a self-model entry by key (in a scope; defaults to global).",
    schema: z.object({ agentId: z.string().min(1), key: z.string().min(1), scope: zScopeInput.optional() }).strict(),
    run: (memory, input) => ({ removed: memory.removeSelfModel(input.agentId, input.key, input.scope) }),
  }),
  defineCommand({
    name: "reflect",
    description:
      "Analyze recent episodes for recurring failure patterns and return reflection candidates. Set persist=true to store them.",
    schema: reflectSchema,
    run: (memory, input) => memory.reflect(input),
  }),
  defineCommand({
    name: "save_reflection",
    description: "Persist a reflection as a memory.",
    schema: saveReflectionSchema,
    run: (memory, input) => memory.saveReflection(input),
  }),
  defineCommand({
    name: "create_namespace",
    description:
      "Register (or update) a namespace: a named scope (e.g. a project) whose memory is tracked together. Use the scope to record memory under it.",
    schema: createNamespaceSchema,
    run: (memory, input) => memory.createNamespace(input),
  }),
  defineCommand({
    name: "list_namespaces",
    description: "List registered namespaces with their counts of events, memories, self-model entries, and last activity.",
    schema: listNamespacesSchema,
    run: (memory, input) => memory.listNamespaces(input),
  }),
  defineCommand({
    name: "get_namespace",
    description:
      "Show everything tracked in a namespace: registration, counts, self-model entries, memories, and recent events.",
    schema: getNamespaceSchema,
    run: (memory, input) => memory.namespaceDetail(input) ?? null,
  }),
  defineCommand({
    name: "remove_namespace",
    description: "Unregister a namespace. Tracked memory is left in place.",
    schema: namespaceRefSchema,
    run: (memory, input) => ({ removed: memory.removeNamespace(input.scope) }),
  }),
  defineCommand({
    name: "stats",
    description: "Return counts of events, memories, and self-model entries.",
    schema: z.object({}).strict(),
    run: (memory) => memory.stats(),
  }),
];

export const commandMap: Map<string, CommandDefinition> = new Map(commands.map((command) => [command.name, command]));

/** Validate and run a command by name (used by the CLI). */
export async function executeCommand(memory: AgentMemory, name: string, input: unknown = {}): Promise<unknown> {
  const command = commandMap.get(name);
  if (command === undefined) {
    throw new ValidationError(`Unknown command "${name}". Available: ${commands.map((c) => c.name).join(", ")}`);
  }
  const parsed = parseInput(command.schema, input);
  return command.run(memory, parsed);
}

/** Names and descriptions, for discovery. */
export function listCommands(): Array<{ name: string; description: string }> {
  return commands.map((command) => ({ name: command.name, description: command.description }));
}
