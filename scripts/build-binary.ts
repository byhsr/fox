#!/usr/bin/env bun
/**
 * Build a standalone, portable `agent-memory` executable.
 *
 * The current memory database is checkpointed (so it is a single file) and
 * embedded in the binary together with the migration SQL. Bun's own SQLite backs
 * the runtime, so the result is a genuine single-file executable with no native
 * addon to install or extract — copy it anywhere and the accumulated memory
 * comes with it.
 *
 * Usage:
 *   bun run scripts/build-binary.ts [options]
 *
 *   --db <path>      Source memory database (default: $AGENT_MEMORY_DB or ./agent-memory.db)
 *   --out <path>     Output executable (default: dist-binary/agent-memory[.exe])
 *   --target <t>     Bun compile target, e.g. bun-linux-x64, bun-darwin-arm64, bun-windows-x64
 *   --mode <m>       cli (default) or mcp
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const root = resolve(import.meta.dir, "..");

function readFlag(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === flag) return argv[i + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

const argv = process.argv.slice(2);
const mode = readFlag(argv, "--mode") ?? "cli";
if (mode !== "cli" && mode !== "mcp") {
  console.error(`Unknown --mode "${mode}" (expected cli or mcp)`);
  process.exit(1);
}

const migrationsDir = join(root, "migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
if (migrationFiles.length === 0) {
  console.error(`No migration files found in ${migrationsDir}`);
  process.exit(1);
}

const staging = join(root, ".binary-build");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const stagedDatabase = join(staging, "agent-memory.db");

const sourceDatabase = readFlag(argv, "--db") ?? process.env["AGENT_MEMORY_DB"] ?? "./agent-memory.db";
const sourceAbsolute = isAbsolute(sourceDatabase) ? sourceDatabase : resolve(process.cwd(), sourceDatabase);

if (existsSync(sourceAbsolute)) {
  checkpoint(sourceAbsolute);
  copyFileSync(sourceAbsolute, stagedDatabase);
  console.log(`Embedding memory from ${sourceAbsolute}`);
} else {
  createMigratedDatabase(stagedDatabase);
  console.log(`No database at ${sourceAbsolute}; embedding an empty migrated database`);
}

const migrations = migrationFiles
  .map((file) => `    ${JSON.stringify(file)}: ${JSON.stringify(readFileSync(join(migrationsDir, file), "utf8"))},`)
  .join("\n");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
const targetModule = mode === "mcp" ? "../src/mcp/server.js" : "../src/cli/index.js";

const entry = `import embeddedDatabase from "./agent-memory.db" with { type: "file" };
import { handleExtract, prepareRuntime, seedEmbeddedDatabase } from "../src/binary/bootstrap.js";

const runtime = {
  databasePath: embeddedDatabase,
  version: ${JSON.stringify(pkg.version ?? "0.0.0")},
  migrations: {
${migrations}
  },
};

prepareRuntime(runtime);

if (!handleExtract(runtime)) {
  seedEmbeddedDatabase(runtime);
  await import(${JSON.stringify(targetModule)});
}
`;
const entryPath = join(staging, "entry.ts");
writeFileSync(entryPath, entry);

const outFlag = readFlag(argv, "--out");
const outfile = outFlag
  ? isAbsolute(outFlag)
    ? outFlag
    : resolve(process.cwd(), outFlag)
  : join(root, "dist-binary", mode === "mcp" ? "agent-memory-mcp" : "agent-memory");

const command = ["bun", "build", "--compile", entryPath, "--outfile", outfile, "--external", "better-sqlite3"];
const target = readFlag(argv, "--target");
if (target !== undefined) command.push("--target", target);

const result = Bun.spawnSync({ cmd: command, cwd: root, stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) {
  process.exit(result.exitCode ?? 1);
}

const produced = existsSync(outfile) ? outfile : `${outfile}.exe`;
const bytes = existsSync(produced) ? statSync(produced).size : 0;
console.log(`\nBuilt ${produced} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log("Run it with --help; use `extract --out <path>` to pull the memory back out.");

function checkpoint(path: string): void {
  const db = new Database(path);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function createMigratedDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);");
    for (const file of migrationFiles) {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(file, Date.now());
    }
  } finally {
    db.close();
  }
}
