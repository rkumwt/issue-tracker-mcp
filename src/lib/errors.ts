/**
 * Application error types.
 *
 * Design decision: errors carry a stable machine-readable `code` in addition to
 * a human-readable message. Tool handlers (phase 2) translate these into MCP
 * results with `isError: true`, so the LLM sees a clear message it can act on
 * ("Issue iss_123 not found") instead of a stack trace, and the logs can be
 * grouped by `code`.
 *
 * Anything that is NOT an AppError is treated as an unexpected internal error:
 * its details are logged but never echoed back to the client.
 */

export type ErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'CONFIG';

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The requested entity does not exist. */
export class NotFoundError extends AppError {
  constructor(entity: 'Issue' | 'Comment', id: string) {
    super('NOT_FOUND', `${entity} ${id} not found`);
  }
}

/** Input was syntactically valid but breaks a business rule. */
export class ValidationError extends AppError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

/** The operation conflicts with the current state (e.g. an illegal status transition). */
export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

/** Missing or invalid configuration / environment variables. */
export class ConfigError extends AppError {
  constructor(message: string) {
    super('CONFIG', message);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
