/**
 * Storage abstraction (Repository pattern).
 *
 * Every MCP tool, resource and prompt talks to storage ONLY through this
 * interface. That buys us three things:
 *  1. Swappable backends: SQLite locally, DynamoDB on AWS, chosen by STORAGE=...
 *  2. Testability: tool handlers can be unit-tested against SQLite ":memory:"
 *     (or a fake) without touching AWS.
 *  3. A clear contract: both implementations must behave identically, so the
 *     same test suite can run against both.
 *
 * Every method is async even though better-sqlite3 is synchronous, because the
 * DynamoDB implementation is inherently async and the interface must fit both.
 *
 * Error contract:
 *  - "Not found" for reads returns `null` (a normal outcome, not an exception).
 *  - "Not found" for writes (update / delete / comment) throws NotFoundError,
 *    because the caller asked us to change something that does not exist.
 */
import type {
  AddCommentInput,
  Comment,
  CreateIssueInput,
  Issue,
  IssueFilter,
  IssueSummary,
  UpdateIssueInput,
} from '../models/issue.js';

export interface IssueRepository {
  /** Create a new issue. New issues always start in status "open". */
  createIssue(input: CreateIssueInput): Promise<Issue>;

  /** Fetch one issue, or `null` if it does not exist. */
  getIssue(id: string): Promise<Issue | null>;

  /**
   * List issues matching ALL supplied filters (AND semantics), newest first.
   * The result is capped by `filter.limit` (see LIMITS in models/issue.ts).
   */
  listIssues(filter?: IssueFilter): Promise<Issue[]>;

  /**
   * Apply a partial update and bump `updatedAt`.
   * @throws NotFoundError if the issue does not exist.
   */
  updateIssue(id: string, changes: UpdateIssueInput): Promise<Issue>;

  /**
   * Permanently delete an issue and all of its comments.
   * @throws NotFoundError if the issue does not exist.
   */
  deleteIssue(id: string): Promise<void>;

  /**
   * Add a comment to an issue. Also bumps the issue's `updatedAt`, so
   * "recently active" queries see comment activity.
   * @throws NotFoundError if the issue does not exist.
   */
  addComment(input: AddCommentInput): Promise<Comment>;

  /** All comments on an issue, oldest first. Empty array if none / no such issue. */
  listComments(issueId: string): Promise<Comment[]>;

  /**
   * Case-insensitive substring search over title and description, newest first.
   * (Deliberately simple; see README for why we don't use full-text search.)
   */
  searchIssues(keyword: string, limit?: number): Promise<Issue[]>;

  /** Counts by status and by priority (every key present, zero-filled). */
  getSummary(): Promise<IssueSummary>;

  /** Release resources (close DB handles). Safe to call more than once. */
  close(): Promise<void>;
}
