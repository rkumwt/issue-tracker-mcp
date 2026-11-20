/**
 * Dependencies shared by every tool, resource and prompt.
 *
 * Design decision: dependency injection by plain object. createServer() builds
 * this once and passes it down. Tests pass an in-memory repository, a fixed
 * clock and a capturing logger; production passes SQLite or DynamoDB, the real
 * clock and the JSON logger. No globals, no DI framework.
 */
import type { IssueRepository } from './db/IssueRepository.js';
import type { Logger } from './lib/logger.js';

export interface AppContext {
  repo: IssueRepository;
  /** Injectable clock (tests use a fixed date, e.g. for the weekly report). */
  now: () => Date;
  /** Structured logger (stderr JSON lines). */
  logger: Logger;
}
