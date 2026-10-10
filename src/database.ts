import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import { DatabaseError, MigrationError } from "./errors.js";
import { runMigrations } from "./schema.js";
import { openRawDatabase } from "./sqlite.js";

export type SqliteDatabase = Database.Database;
export type SqliteStatement<Row = unknown, Params extends unknown[] = unknown[]> = Database.Statement<Params, Row>;
export type RunResult = Database.RunResult;

export interface OpenDatabaseOptions {
  path: string;
  readOnly?: boolean;
  autoMigrate?: boolean;
  now?: () => number;
}

/**
 * A thin, synchronous wrapper over a single better-sqlite3 connection.
 * Applies the required pragmas and runs pending migrations on open.
 */
export class Db {
  readonly raw: SqliteDatabase;
  readonly path: string;
  readonly readOnly: boolean;
  readonly now: () => number;
  private readonly statements = new Map<string, SqliteStatement>();

  constructor(options: OpenDatabaseOptions) {
    this.path = normalizeDbPath(options.path);
    this.readOnly = options.readOnly === true;
    this.now = options.now ?? Date.now;

    if (this.path !== ":memory:") {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
      } catch {
        // Best effort; better-sqlite3 will surface a meaningful error on open.
      }
    }

    try {
      this.raw = openRawDatabase(this.path, { readOnly: this.readOnly });
    } catch (cause) {
      throw new DatabaseError(`Failed to open SQLite database at "${options.path}"`, { cause });
    }

    this.applyPragmas();

    if (options.autoMigrate !== false) {
      try {
        runMigrations(this);
      } catch (cause) {
        if (cause instanceof MigrationError) throw cause;
        throw new MigrationError("Failed to run database migrations", { cause });
      }
    }
  }

  get inTransaction(): boolean {
    return this.raw.inTransaction;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare<Row = unknown, Params extends unknown[] = unknown[]>(sql: string): SqliteStatement<Row, Params> {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached as SqliteStatement<Row, Params>;
    const statement = this.raw.prepare<Params, Row>(sql);
    this.statements.set(sql, statement as unknown as SqliteStatement);
    return statement;
  }

  run(sql: string, ...params: unknown[]): RunResult {
    return this.prepare(sql).run(...params);
  }

  get<Row = unknown>(sql: string, ...params: unknown[]): Row | undefined {
    return this.prepare<Row>(sql).get(...params);
  }

  all<Row = unknown>(sql: string, ...params: unknown[]): Row[] {
    return this.prepare<Row>(sql).all(...params);
  }

  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    const wrapped = this.raw.transaction(fn as (...args: never[]) => unknown);
    return wrapped as unknown as (...args: Args) => R;
  }

  close(): void {
    if (this.raw.open) {
      this.statements.clear();
      this.raw.close();
    }
  }

  private applyPragmas(): void {
    try {
      if (!this.readOnly) this.raw.pragma("journal_mode = WAL");
      this.raw.pragma("busy_timeout = 5000");
      this.raw.pragma("foreign_keys = ON");
      if (!this.readOnly) this.raw.pragma("synchronous = NORMAL");
    } catch (cause) {
      throw new DatabaseError("Failed to configure SQLite pragmas", { cause });
    }
  }
}

function normalizeDbPath(path: string): string {
  if (path === ":memory:" || path.startsWith("file:")) return path;
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}
