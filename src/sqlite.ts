import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import type { SqliteDatabase, SqliteStatement, RunResult } from "./database.js";

/**
 * Storage driver selection.
 *
 * `better-sqlite3` is a Node.js native addon and cannot load under Bun
 * (oven-sh/bun#4290), so a compiled Bun binary would fail the moment it opens a
 * database. Under Bun we instead use the built-in `bun:sqlite`, wrapped in a
 * thin adapter that exposes the small slice of the `better-sqlite3` surface the
 * `Db` class relies on. Node keeps using `better-sqlite3` unchanged.
 *
 * Both modules are required lazily so each runtime only ever loads its own
 * driver, and so bundlers never pull the native addon into a Bun build.
 */

interface BunStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): RunResult;
}

interface BunDatabase {
  query(sql: string): BunStatement;
  exec(sql: string): void;
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
  close(): void;
  readonly inTransaction: boolean;
}

type BunDatabaseConstructor = new (path: string, options?: Record<string, unknown>) => BunDatabase;

class BunDatabaseAdapter {
  private readonly db: BunDatabase;
  private isOpen = true;

  constructor(constructor: BunDatabaseConstructor, path: string, readOnly: boolean) {
    this.db = readOnly ? new constructor(path, { readonly: true }) : new constructor(path);
  }

  get open(): boolean {
    return this.isOpen;
  }

  get inTransaction(): boolean {
    return this.db.inTransaction;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const statement = this.db.query(sql);
    const adapter = {
      all: (...params: unknown[]) => statement.all(...params),
      // better-sqlite3 returns undefined for an empty result; bun:sqlite returns null.
      get: (...params: unknown[]) => {
        const row = statement.get(...params);
        return row === null ? undefined : row;
      },
      run: (...params: unknown[]) => statement.run(...params),
    };
    return adapter as unknown as SqliteStatement;
  }

  pragma(source: string): void {
    try {
      this.db.query(`PRAGMA ${source}`).all();
    } catch {
      this.db.exec(`PRAGMA ${source}`);
    }
  }

  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return this.db.transaction(fn);
  }

  close(): void {
    if (!this.isOpen) return;
    this.db.close();
    this.isOpen = false;
  }
}

const require = createRequire(import.meta.url);

let bunDatabaseConstructor: BunDatabaseConstructor | undefined;

/** True when running inside the Bun runtime. */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** Open a raw SQLite connection using the driver native to the current runtime. */
export function openRawDatabase(path: string, options: { readOnly: boolean }): SqliteDatabase {
  if (isBunRuntime()) {
    bunDatabaseConstructor ??= (require("bun:sqlite") as { Database: BunDatabaseConstructor }).Database;
    return new BunDatabaseAdapter(bunDatabaseConstructor, path, options.readOnly) as unknown as SqliteDatabase;
  }

  const loaded = require("better-sqlite3") as typeof BetterSqlite3 | { default: typeof BetterSqlite3 };
  const Constructor = (typeof loaded === "function" ? loaded : loaded.default) as typeof BetterSqlite3;
  const database = options.readOnly ? new Constructor(path, { readonly: true }) : new Constructor(path);
  return database as SqliteDatabase;
}
