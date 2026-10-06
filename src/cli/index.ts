#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { AgentMemory } from "../index.js";
import { commandMap, executeCommand, listCommands } from "../commands.js";
import { AgentMemoryError, ValidationError } from "../errors.js";
import { readPackageVersion, resolveDatabasePath, resolveEmbedder } from "../runtime.js";

interface ParsedArgs {
  command?: string;
  positionals: string[];
  db?: string;
  json?: string;
  file?: string;
  embedder?: string;
  pretty: boolean;
  markdown: boolean;
  help: boolean;
  version: boolean;
}

const VALUE_FLAGS = new Set(["--db", "--json", "--file", "--embedder"]);

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], pretty: false, markdown: false, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === "-h" || token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "-v" || token === "--version") {
      parsed.version = true;
      continue;
    }
    if (token === "--pretty") {
      parsed.pretty = true;
      continue;
    }
    if (token === "--markdown") {
      parsed.markdown = true;
      continue;
    }

    const separator = token.indexOf("=");
    const flag = separator === -1 ? token : token.slice(0, separator);
    if (VALUE_FLAGS.has(flag)) {
      let value = separator === -1 ? undefined : token.slice(separator + 1);
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined) throw new ValidationError(`Missing value for ${flag}`);
        i += 1;
      }
      if (flag === "--db") parsed.db = value;
      else if (flag === "--json") parsed.json = value;
      else if (flag === "--file") parsed.file = value;
      else parsed.embedder = value;
      continue;
    }

    if (token.startsWith("-") && token !== "-") throw new ValidationError(`Unknown option "${token}"`);
    parsed.positionals.push(token);
  }
  parsed.command = parsed.positionals[0];
  return parsed;
}

function readInputSource(source: string): string {
  return source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
}

function resolveInput(args: ParsedArgs): unknown {
  let raw: string | undefined;
  if (args.json !== undefined) raw = args.json === "-" ? readFileSync(0, "utf8") : args.json;
  else if (args.file !== undefined) raw = readInputSource(args.file);
  if (raw === undefined || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ValidationError(`Input is not valid JSON: ${(cause as Error).message}`, { cause });
  }
}

function hasMarkdown(value: unknown): value is { markdown: string } {
  return (
    typeof value === "object" && value !== null && typeof (value as { markdown?: unknown }).markdown === "string"
  );
}

function helpText(): string {
  const lines = [
    "agent-memory — local-first agent memory (CLI)",
    "",
    "Usage:",
    "  agent-memory <command> [--db <path>] [--json <json> | --file <path>] [--embedder <spec>] [--pretty] [--markdown]",
    "",
    "Options:",
    "  --db <path>        SQLite file (default: $AGENT_MEMORY_DB or ./agent-memory.db)",
    '  --json <json>      Command input as JSON ("-" reads stdin)',
    '  --file <path>      Command input from a JSON file ("-" reads stdin)',
    "  --embedder <spec>  none | hash | hash:<dimensions> (default: none)",
    "  --pretty           Pretty-print JSON output",
    "  --markdown         Print only markdown when available (compile_context)",
    "  -h, --help         Show this help",
    "  -v, --version      Show the version",
    "",
    "Utility:",
    "  agent-memory commands          List available commands (JSON)",
    "  agent-memory schema <command>  Print a command's JSON Schema",
    "",
    "Commands:",
  ];
  for (const command of listCommands()) {
    lines.push(`  ${command.name.padEnd(18)} ${command.description}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }
  if (args.help || args.command === undefined || args.command === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (args.command === "commands") {
    process.stdout.write(`${JSON.stringify(listCommands(), null, args.pretty ? 2 : 0)}\n`);
    return;
  }
  if (args.command === "schema") {
    const target = args.positionals[1];
    if (target === undefined) throw new ValidationError("Usage: agent-memory schema <command>");
    const command = commandMap.get(target);
    if (command === undefined) throw new ValidationError(`Unknown command "${target}"`);
    const { zodToJsonSchema } = await import("zod-to-json-schema");
    process.stdout.write(`${JSON.stringify(zodToJsonSchema(command.schema, { target: "jsonSchema7" }), null, 2)}\n`);
    return;
  }

  const input = resolveInput(args);
  const memory = new AgentMemory({ path: resolveDatabasePath(args.db), embedder: resolveEmbedder(args.embedder) });
  try {
    const result = await executeCommand(memory, args.command, input);
    if (args.markdown && hasMarkdown(result)) {
      process.stdout.write(result.markdown.endsWith("\n") ? result.markdown : `${result.markdown}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
    }
  } finally {
    memory.close();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof AgentMemoryError ? error.code : "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
  process.exitCode = 1;
});
