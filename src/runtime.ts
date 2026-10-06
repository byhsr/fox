import { createRequire } from "node:module";
import { HashEmbedder, type Embedder } from "./embedder.js";
import { ValidationError } from "./errors.js";

export const DEFAULT_DATABASE_PATH = "./agent-memory.db";

/** Resolve the database path from an explicit value, the environment, or a default. */
export function resolveDatabasePath(explicit?: string): string {
  const value = explicit ?? process.env["AGENT_MEMORY_DB"] ?? DEFAULT_DATABASE_PATH;
  return value.length > 0 ? value : DEFAULT_DATABASE_PATH;
}

/**
 * Build an embedder from a spec string. Supported: `none`, `hash`,
 * `hash:<dimensions>`. Defaults to the environment variable
 * `AGENT_MEMORY_EMBEDDER`, then to no embedder.
 */
export function resolveEmbedder(spec?: string): Embedder | undefined {
  const value = spec ?? process.env["AGENT_MEMORY_EMBEDDER"];
  if (value === undefined || value === "" || value === "none") return undefined;
  if (value === "hash" || value.startsWith("hash:")) {
    const [, dims] = value.split(":");
    if (dims === undefined || dims === "") return new HashEmbedder();
    const dimensions = Number(dims);
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new ValidationError(`Invalid embedder dimensions in "${value}"`);
    }
    return new HashEmbedder({ dimensions });
  }
  throw new ValidationError(`Unknown embedder "${value}" (supported: none, hash, hash:<dimensions>)`);
}

const require = createRequire(import.meta.url);

/** Read the package version (used for CLI/MCP identity). */
export function readPackageVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
