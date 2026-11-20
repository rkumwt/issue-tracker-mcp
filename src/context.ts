/**
 * Dependencies shared by every tool, resource and prompt.
 *
 * Design decision: dependency injection by plain object. createServer() builds
 * this once and passes it down. Tests pass an in-memory repository and a fixed
 * clock; production passes SQLite or DynamoDB and the real clock. No globals,
 * no DI framework.
 */
import type { IssueRepository } from './db/IssueRepository.js';

export interface AppContext {
  repo: IssueRepository;
  /** Injectable clock (tests use a fixed date, e.g. for the weekly report). */
  now: () => Date;
}
