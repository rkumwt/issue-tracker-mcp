/**
 * Minimal structured (JSON) logger.
 *
 * Design decisions:
 *  - One JSON object per line, so CloudWatch Logs Insights (phase 5), `jq` and
 *    log shippers can filter on fields like `tool`, `outcome` or `durationMs`
 *    instead of grepping free text.
 *  - Writes to STDERR. With the stdio transport, stdout carries the MCP
 *    protocol and must never be polluted. On Lambda, stderr goes to CloudWatch
 *    just like stdout.
 *  - Secrets are redacted by key name (authorization, apiKey, token, ...) at
 *    any depth, as a safety net. The primary rule is still "don't log secrets
 *    or tool arguments in the first place".
 *  - No dependency: ~80 lines are enough here and easy to explain. A larger
 *    service would use pino, which has the same JSON-lines model.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every entry (e.g. a requestId). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Minimum level to emit. Default "info". */
  level?: LogLevel;
  /** Fields added to every entry. */
  base?: LogFields;
  /** Where lines go. Default: stderr. Tests inject an in-memory sink. */
  write?: (line: string) => void;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

const REDACTED = '[REDACTED]';
const SECRET_KEY = /authorization|api[-_]?key|token|secret|password|cookie/i;
const MAX_DEPTH = 6;

/** Deep-copy `value`, replacing secret-looking keys and serialising Errors. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (value instanceof Error) {
    const withCode = value as Error & { code?: unknown };
    return {
      name: value.name,
      message: value.message,
      ...(withCode.code !== undefined && { code: withCode.code }),
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = LOG_LEVELS.indexOf(options.level ?? 'info');
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const log = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LOG_LEVELS.indexOf(level) < minLevel) return;
    const entry = redact({ ...base, ...fields }) as LogFields;
    // time/level/msg go first and can't be overwritten by caller fields.
    delete entry.time;
    delete entry.level;
    delete entry.msg;
    write(JSON.stringify({ time: now().toISOString(), level, msg, ...entry }));
  };

  return {
    debug: (msg, fields) => {
      log('debug', msg, fields);
    },
    info: (msg, fields) => {
      log('info', msg, fields);
    },
    warn: (msg, fields) => {
      log('warn', msg, fields);
    },
    error: (msg, fields) => {
      log('error', msg, fields);
    },
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/** A logger that discards everything (handy default for library code and tests). */
export const silentLogger: Logger = createLogger({ write: () => undefined });
