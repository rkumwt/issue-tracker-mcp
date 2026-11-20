/**
 * SQLite implementation of IssueRepository, used for local development.
 *
 * Why better-sqlite3?
 *  - Zero setup: the database is one file (or ":memory:" for tests).
 *  - Synchronous API and prepared statements make it fast and simple. Methods
 *    are still declared `async` to satisfy the interface; a bonus is that any
 *    thrown error (e.g. NotFoundError) becomes a rejected Promise, exactly
 *    like the DynamoDB implementation, instead of a synchronous throw.
 *
 * Security note: every value reaches SQL through bound parameters (`?`), never
 * string concatenation, so user / LLM input cannot inject SQL. The only dynamic
 * SQL is the list of WHERE clauses in listIssues(), and those clause strings are
 * fixed literals chosen by our code, not by the caller.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import { NotFoundError } from '../../lib/errors.js';
import { newCommentId, newIssueId } from '../../lib/ids.js';
import {
  clampLimit,
  emptySummary,
  normalizeLabels,
  type AddCommentInput,
  type Comment,
  type CreateIssueInput,
  type Issue,
  type IssueFilter,
  type IssuePriority,
  type IssueStatus,
  type IssueSummary,
  type UpdateIssueInput,
} from '../../models/issue.js';
import type { IssueRepository } from '../IssueRepository.js';
import { migrate } from './schema.js';

/** Row shapes exactly as SQLite returns them (snake_case, labels as JSON text). */
interface IssueRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string | null;
  labels: string;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: string;
  issue_id: string;
  author: string;
  text: string;
  created_at: string;
}

export interface SqliteRepositoryOptions {
  /** Injectable clock so tests can control timestamps (e.g. for the weekly report). */
  now?: () => Date;
}

// The CHECK constraints in schema.ts guarantee status/priority are valid enum
// values, so the casts below are safe.
function rowToIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as IssueStatus,
    priority: row.priority as IssuePriority,
    assignee: row.assignee,
    labels: JSON.parse(row.labels) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToComment(row: CommentRow): Comment {
  return {
    id: row.id,
    issueId: row.issue_id,
    author: row.author,
    text: row.text,
    createdAt: row.created_at,
  };
}

/** Escape LIKE wildcards so a search for "100%" matches the literal text. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class SqliteIssueRepository implements IssueRepository {
  private readonly now: () => Date;

  // Statements are prepared once and reused: faster, and they document every
  // query this class runs in one place.
  private readonly stmts: {
    insertIssue: Statement;
    getIssue: Statement<[string], IssueRow>;
    updateIssue: Statement;
    touchIssue: Statement;
    deleteIssue: Statement;
    insertComment: Statement;
    listComments: Statement<[string], CommentRow>;
    searchIssues: Statement<[string, string, number], IssueRow>;
    countByStatus: Statement<[], { key: string; n: number }>;
    countByPriority: Statement<[], { key: string; n: number }>;
  };

  constructor(
    private readonly db: DatabaseType,
    options: SqliteRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    migrate(db);

    this.stmts = {
      insertIssue: db.prepare(`
        INSERT INTO issues (id, title, description, status, priority, assignee, labels, created_at, updated_at)
        VALUES (@id, @title, @description, @status, @priority, @assignee, @labels, @createdAt, @updatedAt)
      `),
      getIssue: db.prepare('SELECT * FROM issues WHERE id = ?'),
      updateIssue: db.prepare(`
        UPDATE issues
           SET title = @title, description = @description, status = @status, priority = @priority,
               assignee = @assignee, labels = @labels, updated_at = @updatedAt
         WHERE id = @id
      `),
      touchIssue: db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?'),
      deleteIssue: db.prepare('DELETE FROM issues WHERE id = ?'),
      insertComment: db.prepare(`
        INSERT INTO comments (id, issue_id, author, text, created_at)
        VALUES (@id, @issueId, @author, @text, @createdAt)
      `),
      listComments: db.prepare(
        'SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC, rowid ASC',
      ),
      searchIssues: db.prepare(`
        SELECT * FROM issues
         WHERE title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?
      `),
      countByStatus: db.prepare('SELECT status AS key, COUNT(*) AS n FROM issues GROUP BY status'),
      countByPriority: db.prepare(
        'SELECT priority AS key, COUNT(*) AS n FROM issues GROUP BY priority',
      ),
    };
  }

  /**
   * Open (creating if needed) a database file and return a ready repository.
   * Pass ":memory:" for an in-memory database (used by tests).
   */
  static open(path: string, options?: SqliteRepositoryOptions): SqliteIssueRepository {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL'); // readers don't block the writer
    db.pragma('foreign_keys = ON'); // SQLite has FK enforcement OFF by default!
    db.pragma('busy_timeout = 5000'); // wait instead of failing if the file is locked
    return new SqliteIssueRepository(db, options);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const ts = this.timestamp();
    const issue: Issue = {
      id: newIssueId(),
      title: input.title,
      description: input.description,
      status: 'open',
      priority: input.priority,
      assignee: input.assignee ?? null,
      labels: normalizeLabels(input.labels),
      createdAt: ts,
      updatedAt: ts,
    };
    this.stmts.insertIssue.run({ ...issue, labels: JSON.stringify(issue.labels) });
    return issue;
  }

  async getIssue(id: string): Promise<Issue | null> {
    const row = this.stmts.getIssue.get(id);
    return row ? rowToIssue(row) : null;
  }

  async listIssues(filter: IssueFilter = {}): Promise<Issue[]> {
    // Each supplied filter adds one fixed clause + one bound parameter.
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.priority) {
      where.push('priority = ?');
      params.push(filter.priority);
    }
    if (filter.assignee) {
      where.push('assignee = ? COLLATE NOCASE');
      params.push(filter.assignee.trim());
    }
    if (filter.label) {
      where.push('EXISTS (SELECT 1 FROM json_each(issues.labels) WHERE json_each.value = ?)');
      params.push(filter.label.trim().toLowerCase());
    }
    if (filter.createdAfter) {
      where.push('created_at >= ?');
      params.push(filter.createdAfter);
    }
    if (filter.updatedAfter) {
      where.push('updated_at >= ?');
      params.push(filter.updatedAfter);
    }

    const sql = `
      SELECT * FROM issues
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `;
    params.push(clampLimit(filter.limit));

    const rows = this.db.prepare<(string | number)[], IssueRow>(sql).all(...params);
    return rows.map(rowToIssue);
  }

  async updateIssue(id: string, changes: UpdateIssueInput): Promise<Issue> {
    // Read-modify-write inside a transaction so the merge is atomic.
    const run = this.db.transaction((): Issue => {
      const row = this.stmts.getIssue.get(id);
      if (!row) throw new NotFoundError('Issue', id);
      const current = rowToIssue(row);

      // Nothing to change: return as-is rather than bumping updatedAt.
      const hasChanges = Object.values(changes).some((v) => v !== undefined);
      if (!hasChanges) return current;

      const updated: Issue = {
        ...current,
        title: changes.title ?? current.title,
        description: changes.description ?? current.description,
        status: changes.status ?? current.status,
        priority: changes.priority ?? current.priority,
        // `null` means "unassign", `undefined` means "leave unchanged".
        assignee: changes.assignee === undefined ? current.assignee : changes.assignee,
        labels: changes.labels === undefined ? current.labels : normalizeLabels(changes.labels),
        updatedAt: this.timestamp(),
      };
      this.stmts.updateIssue.run({ ...updated, labels: JSON.stringify(updated.labels) });
      return updated;
    });
    return run();
  }

  async deleteIssue(id: string): Promise<void> {
    // Comments are removed by ON DELETE CASCADE in the same statement.
    const result = this.stmts.deleteIssue.run(id);
    if (result.changes === 0) throw new NotFoundError('Issue', id);
  }

  async searchIssues(keyword: string, limit?: number): Promise<Issue[]> {
    const term = keyword.trim();
    if (term.length === 0) return [];
    // Note: SQLite's LIKE is case-insensitive for ASCII letters only.
    const pattern = `%${escapeLike(term)}%`;
    const rows = this.stmts.searchIssues.all(pattern, pattern, clampLimit(limit));
    return rows.map(rowToIssue);
  }

  async getSummary(): Promise<IssueSummary> {
    const summary = emptySummary();
    for (const { key, n } of this.stmts.countByStatus.all()) {
      summary.byStatus[key as IssueStatus] = n;
      summary.total += n;
    }
    for (const { key, n } of this.stmts.countByPriority.all()) {
      summary.byPriority[key as IssuePriority] = n;
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  async addComment(input: AddCommentInput): Promise<Comment> {
    const run = this.db.transaction((): Comment => {
      const ts = this.timestamp();
      // Touching updated_at doubles as the existence check.
      const touched = this.stmts.touchIssue.run(ts, input.issueId);
      if (touched.changes === 0) throw new NotFoundError('Issue', input.issueId);

      const comment: Comment = {
        id: newCommentId(),
        issueId: input.issueId,
        author: input.author,
        text: input.text,
        createdAt: ts,
      };
      this.stmts.insertComment.run(comment);
      return comment;
    });
    return run();
  }

  async listComments(issueId: string): Promise<Comment[]> {
    return this.stmts.listComments.all(issueId).map(rowToComment);
  }

  async close(): Promise<void> {
    if (this.db.open) this.db.close();
  }
}
