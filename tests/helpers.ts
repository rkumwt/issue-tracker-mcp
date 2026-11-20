/**
 * Shared test utilities.
 *
 * Tests never use the real clock: a controllable clock makes timestamps,
 * ordering and "this week" logic deterministic.
 */
import type { AppContext } from '../src/context.js';
import { SqliteIssueRepository } from '../src/db/sqlite/SqliteIssueRepository.js';
import { createLogger, type Logger, type LogLevel } from '../src/lib/logger.js';

/** Wednesday 18 Nov 2026, 10:00 UTC (mid-week, handy for weekly-report tests). */
export const DEFAULT_NOW = '2026-11-18T10:00:00.000Z';

export interface TestClock {
  now: () => Date;
  /** Move time forward by `ms` (default 1 minute). */
  advance: (ms?: number) => void;
  set: (iso: string) => void;
}

export function createClock(startIso: string = DEFAULT_NOW): TestClock {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance: (ms = 60_000) => {
      current += ms;
    },
    set: (iso) => {
      current = Date.parse(iso);
    },
  };
}

/** A parsed log line as captured by createMemoryLogger(). */
export interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

export interface MemoryLogger {
  logger: Logger;
  entries: LogEntry[];
}

/** A real logger whose JSON lines are captured in memory for assertions. */
export function createMemoryLogger(level: LogLevel = 'debug'): MemoryLogger {
  const entries: LogEntry[] = [];
  const logger = createLogger({
    level,
    write: (line) => entries.push(JSON.parse(line) as LogEntry),
  });
  return { logger, entries };
}

export interface TestContext extends AppContext {
  clock: TestClock;
  repo: SqliteIssueRepository;
  logs: LogEntry[];
}

/** Fresh in-memory SQLite repository + context sharing one controllable clock. */
export function createTestContext(clock: TestClock = createClock()): TestContext {
  const repo = SqliteIssueRepository.open(':memory:', { now: clock.now });
  const { logger, entries } = createMemoryLogger();
  return { repo, now: clock.now, clock, logger, logs: entries };
}
