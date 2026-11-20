/**
 * SQLite schema + a tiny migration runner.
 *
 * Design decision: instead of a migration framework, we keep an ordered list of
 * SQL scripts and store the number applied so far in SQLite's built-in
 * `PRAGMA user_version`. On startup we run only the scripts that are newer.
 * That is enough for a single-file local database and shows the idea without
 * pulling in a dependency.
 *
 * Rules: never edit a migration that has shipped; append a new one instead.
 */
import type { Database } from 'better-sqlite3';

const MIGRATIONS: readonly string[] = [
  // v1: initial schema
  `
  CREATE TABLE issues (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    priority    TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    assignee    TEXT,
    -- Labels are stored as a JSON array (e.g. '["bug","ui"]') and queried with
    -- SQLite's built-in json_each(). A separate join table would be more
    -- "normalised", but a JSON column mirrors how DynamoDB stores the same data
    -- and is plenty fast at this scale.
    labels      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels)),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX idx_issues_status     ON issues (status);
  CREATE INDEX idx_issues_priority   ON issues (priority);
  CREATE INDEX idx_issues_assignee   ON issues (assignee COLLATE NOCASE);
  CREATE INDEX idx_issues_created_at ON issues (created_at);

  CREATE TABLE comments (
    id          TEXT PRIMARY KEY,
    -- ON DELETE CASCADE: deleting an issue removes its comments atomically.
    issue_id    TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    author      TEXT NOT NULL,
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX idx_comments_issue_id ON comments (issue_id, created_at);
  `,
];

/** Apply any pending migrations inside a single transaction. */
export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.slice(current);
  if (pending.length === 0) return;

  db.transaction(() => {
    for (const sql of pending) db.exec(sql);
    // PRAGMA does not accept bound parameters; the value is our own integer.
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
}
