import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepository } from '../../src/db/index.js';
import { SqliteIssueRepository } from '../../src/db/sqlite/SqliteIssueRepository.js';
import { describeRepositoryContract } from './repositoryContract.js';

// 1. The shared contract, against an in-memory database.
describeRepositoryContract('SQLite (:memory:)', (now) =>
  SqliteIssueRepository.open(':memory:', { now }),
);

// 2. Behaviour specific to the SQLite implementation (files, migrations, FKs).
describe('SqliteIssueRepository specifics', () => {
  const tempDirs: string[] = [];
  const tempDbPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'issue-tracker-test-'));
    tempDirs.push(dir);
    return join(dir, 'nested', 'issues.db'); // "nested" checks the directory is created
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('persists data to disk and re-opens it without re-running migrations', async () => {
    const path = tempDbPath();
    const first = SqliteIssueRepository.open(path);
    const issue = await first.createIssue({ title: 't', description: 'd', priority: 'low' });
    await first.close();

    const second = SqliteIssueRepository.open(path);
    expect(await second.getIssue(issue.id)).toEqual(issue);
    await second.close();

    const raw = new Database(path, { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(1);
    raw.close();
  });

  it('enforces foreign keys (a comment cannot reference a missing issue)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    new SqliteIssueRepository(db); // runs migrations

    expect(() =>
      db
        .prepare(
          "INSERT INTO comments (id, issue_id, author, text, created_at) VALUES ('c', 'missing', 'a', 'b', 'now')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('rejects invalid status values at the database level (CHECK constraint)', () => {
    const db = new Database(':memory:');
    new SqliteIssueRepository(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO issues (id, title, description, status, priority, created_at, updated_at) VALUES ('i', 't', 'd', 'bogus', 'low', 'x', 'x')",
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });

  it('is created by the factory when STORAGE=sqlite', async () => {
    const repo = await createRepository({ storage: 'sqlite', sqlitePath: ':memory:' });
    expect(repo).toBeInstanceOf(SqliteIssueRepository);
    await repo.close();
  });
});
