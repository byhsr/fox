#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { commands } from "../commands.js";
import { AgentMemoryError } from "../errors.js";
import { AgentMemory } from "../index.js";
import { readPackageVersion, resolveDatabasePath, resolveEmbedder } from "../runtime.js";

function formatError(error: unknown): string {
  if (error instanceof AgentMemoryError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

const memory = new AgentMemory({ path: resolveDatabasePath(), embedder: resolveEmbedder() });

const server = new McpServer(
  { name: "agent-memory", version: readPackageVersion() },
  {
    instructions:
      "Local-first agent memory in a single SQLite file. Use compile_context to assemble a token-budgeted context block, search to recall relevant memories, add_memory to persist durable knowledge, record_event to log episodes, and reflect to surface recurring patterns. Everything stays local.",
  },
);

for (const command of commands) {
  server.registerTool(
    command.name,
    { title: command.name, description: command.description, inputSchema: command.schema },
    async (args: unknown) => {
      try {
        const result = await command.run(memory, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatError(error) }], isError: true };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

function shutdown(): void {
  try {
    memory.close();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
