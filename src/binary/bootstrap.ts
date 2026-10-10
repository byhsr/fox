import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { resolveDatabasePath } from "../runtime.js";
import { setEmbeddedMigrations } from "../schema.js";
import { openRawDatabase } from "../sqlite.js";

/**
 * Runtime support for a compiled, portable `agent-memory` binary.
 *
 * A binary bakes in a memory database (and the migration SQL) at build time. On
 * launch we seed a working database from it the first time, so the accumulated
 * memory travels with the executable and then keeps growing locally. The
 * `extract` command copies the current memory back out so it can be moved on or
 * re-baked into a new binary.
 */
export interface EmbeddedRuntime {
  /** Path to the memory database embedded in the binary. */
  databasePath: string;
  /** Migration SQL keyed by filename. */
  migrations: Readonly<Record<string, string>>;
  /** Package version to report. */
  version: string;
}

function readFlag(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === flag) return argv[i + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

function isFileDatabase(path: string): boolean {
  return path !== ":memory:" && !path.startsWith("file:");
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * Copy a file by reading and writing its bytes. Bun's embedded (`~BUN`) files
 * are virtual and unreadable to the OS-level copy syscall that `copyFileSync`
 * uses, but they read fine through `readFileSync`.
 */
function copyBytes(from: string, to: string): void {
  writeFileSync(to, readFileSync(from));
}

/** The database path the CLI/MCP layer will open, given the process arguments. */
export function effectiveDatabasePath(argv: readonly string[] = process.argv.slice(2)): string {
  return resolveDatabasePath(readFlag(argv, "--db"));
}

/** Install the embedded migrations and reported version before the app boots. */
export function prepareRuntime(runtime: EmbeddedRuntime): void {
  process.env["AGENT_MEMORY_VERSION"] = runtime.version;
  setEmbeddedMigrations(runtime.migrations);
}

/** Seed the working database from the embedded one, once, if it does not exist. */
export function seedEmbeddedDatabase(
  runtime: EmbeddedRuntime,
  argv: readonly string[] = process.argv.slice(2),
): void {
  const target = effectiveDatabasePath(argv);
  if (!isFileDatabase(target)) return;
  const destination = absolute(target);
  if (existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  copyBytes(runtime.databasePath, destination);
}

function checkpoint(path: string): void {
  const raw = openRawDatabase(absolute(path), { readOnly: false });
  try {
    raw.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    raw.close();
  }
}

/**
 * Handle the `extract` command: copy the current memory (the working database if
 * present, otherwise the embedded one) to a standalone file. Returns true when
 * the command ran and the caller should not start the CLI/MCP server.
 */
export function handleExtract(
  runtime: EmbeddedRuntime,
  argv: readonly string[] = process.argv.slice(2),
): boolean {
  if (argv[0] !== "extract") return false;

  const rest = argv.slice(1);
  const useEmbedded = rest.includes("--embedded");
  const target = readFlag(rest, "--out") ?? rest.find((token) => !token.startsWith("-")) ?? "./agent-memory.extracted.db";
  const working = effectiveDatabasePath(argv);

  const useWorking = !useEmbedded && isFileDatabase(working) && existsSync(absolute(working));
  const source = useWorking ? absolute(working) : runtime.databasePath;
  if (useWorking) checkpoint(source);

  const destination = absolute(target);
  mkdirSync(dirname(destination), { recursive: true });
  copyBytes(source, destination);

  process.stdout.write(
    `${JSON.stringify({ extracted: destination, source: useWorking ? "working" : "embedded", bytes: statSync(destination).size }, null, 2)}\n`,
  );
  return true;
}
