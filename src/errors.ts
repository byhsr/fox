import type { ZodError } from "zod";

/** Base class for every error thrown by agent-memory. */
export class AgentMemoryError extends Error {
  readonly code: string;

  constructor(message: string, code = "AGENT_MEMORY_ERROR", options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Input failed validation against its schema. */
export class ValidationError extends AgentMemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "VALIDATION_ERROR", options);
  }
}

/** A requested row does not exist. */
export class NotFoundError extends AgentMemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "NOT_FOUND", options);
  }
}

/** The underlying SQLite handle reported a failure. */
export class DatabaseError extends AgentMemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "DATABASE_ERROR", options);
  }
}

/** A schema migration could not be loaded or applied. */
export class MigrationError extends AgentMemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "MIGRATION_ERROR", options);
  }
}

/** An embedder failed or produced an unusable vector. */
export class EmbeddingError extends AgentMemoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "EMBEDDING_ERROR", options);
  }
}

/** Render a ZodError as a compact, human-readable string. */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
