/**
 * Shared test utilities.
 *
 * Tests never use the real clock: a controllable clock makes timestamps,
 * ordering and "this week" logic deterministic.
 */
import type { AppContext } from '../src/context.js';
import { SqliteIssueRepository } from '../src/db/sqlite/SqliteIssueRepository.js';

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

export interface TestContext extends AppContext {
  clock: TestClock;
  repo: SqliteIssueRepository;
}

/** Fresh in-memory SQLite repository + context sharing one controllable clock. */
export function createTestContext(clock: TestClock = createClock()): TestContext {
  const repo = SqliteIssueRepository.open(':memory:', { now: clock.now });
  return { repo, now: clock.now, clock };
}
