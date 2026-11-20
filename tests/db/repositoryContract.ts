/**
 * Repository CONTRACT tests.
 *
 * These tests describe the behaviour every IssueRepository implementation must
 * have, independent of the storage engine. Each implementation's test file calls
 * `describeRepositoryContract()` with a factory:
 *
 *   describeRepositoryContract('SQLite', (now) => SqliteIssueRepository.open(':memory:', { now }));
 *
 * In phase 5 the DynamoDB repository runs the exact same suite, which is the
 * proof that STORAGE=sqlite and STORAGE=dynamodb are interchangeable.
 *
 * Note: the clock advances between writes, so tests never depend on how an
 * engine breaks ties between identical timestamps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IssueRepository } from '../../src/db/IssueRepository.js';
import { NotFoundError } from '../../src/lib/errors.js';
import type { CreateIssueInput, Issue } from '../../src/models/issue.js';
import { createClock, type TestClock } from '../helpers.js';

export type RepositoryFactory = (now: () => Date) => IssueRepository | Promise<IssueRepository>;

export function describeRepositoryContract(name: string, factory: RepositoryFactory): void {
  describe(`IssueRepository contract: ${name}`, () => {
    let repo: IssueRepository;
    let clock: TestClock;

    /** Create an issue, then advance the clock so the next write is strictly later. */
    async function create(overrides: Partial<CreateIssueInput> = {}): Promise<Issue> {
      const issue = await repo.createIssue({
        title: 'Login fails',
        description: 'OAuth redirect loops',
        priority: 'medium',
        ...overrides,
      });
      clock.advance();
      return issue;
    }

    beforeEach(async () => {
      clock = createClock();
      repo = await factory(clock.now);
    });

    afterEach(async () => {
      await repo.close();
    });

    describe('createIssue / getIssue', () => {
      it('creates an open issue with defaults and a prefixed id', async () => {
        const issue = await create({ priority: 'high' });

        expect(issue).toMatchObject({
          title: 'Login fails',
          description: 'OAuth redirect loops',
          status: 'open',
          priority: 'high',
          assignee: null,
          labels: [],
        });
        expect(issue.id).toMatch(/^iss_[0-9a-f]{12}$/);
        expect(issue.createdAt).toBe('2026-11-18T10:00:00.000Z');
        expect(issue.updatedAt).toBe(issue.createdAt);
      });

      it('normalises labels (trim, lower-case, de-duplicate, drop empty)', async () => {
        const issue = await create({ labels: ['Bug', ' bug ', 'UI', '', 'ui'] });
        expect(issue.labels).toEqual(['bug', 'ui']);
      });

      it('generates unique ids', async () => {
        const a = await create();
        const b = await create();
        expect(a.id).not.toBe(b.id);
      });

      it('round-trips through getIssue', async () => {
        const created = await create({ assignee: 'alice', labels: ['bug'] });
        expect(await repo.getIssue(created.id)).toEqual(created);
      });

      it('returns null for an unknown id', async () => {
        expect(await repo.getIssue('iss_000000000000')).toBeNull();
      });
    });

    describe('listIssues', () => {
      it('returns newest first', async () => {
        const first = await create({ title: 'first' });
        const second = await create({ title: 'second' });
        const ids = (await repo.listIssues()).map((i) => i.id);
        expect(ids).toEqual([second.id, first.id]);
      });

      it('filters by status, priority, assignee and label (AND semantics)', async () => {
        const critical = await create({ priority: 'critical', assignee: 'Alice', labels: ['bug'] });
        await create({ priority: 'critical', assignee: 'bob', labels: ['bug'] });
        await create({ priority: 'low', assignee: 'alice', labels: ['ui'] });
        await repo.updateIssue(critical.id, { status: 'in_progress' });

        const ids = async (filter: Parameters<IssueRepository['listIssues']>[0]) =>
          (await repo.listIssues(filter)).map((i) => i.id);

        expect(await ids({ status: 'in_progress' })).toEqual([critical.id]);
        expect(await ids({ priority: 'critical' })).toHaveLength(2);
        expect(await ids({ priority: 'critical', assignee: 'alice' })).toEqual([critical.id]);
        expect(await ids({ label: 'BUG' })).toHaveLength(2);
        expect(await ids({ label: 'ui', status: 'in_progress' })).toEqual([]);
      });

      it('matches assignee case-insensitively', async () => {
        const issue = await create({ assignee: 'Alice' });
        expect((await repo.listIssues({ assignee: 'ALICE' })).map((i) => i.id)).toEqual([issue.id]);
      });

      it('filters by createdAfter and updatedAfter', async () => {
        const old = await create({ title: 'old' });
        const recent = await create({ title: 'recent' });
        clock.advance(60 * 60_000);
        const cutoff = clock.now().toISOString();
        await repo.updateIssue(old.id, { priority: 'high' }); // updated after cutoff

        expect(
          (await repo.listIssues({ createdAfter: recent.createdAt })).map((i) => i.id),
        ).toEqual([recent.id]);
        expect((await repo.listIssues({ updatedAfter: cutoff })).map((i) => i.id)).toEqual([
          old.id,
        ]);
      });

      it('applies the limit, clamping invalid values', async () => {
        for (let i = 0; i < 3; i++) await create({ title: `issue ${i}` });
        expect(await repo.listIssues({ limit: 2 })).toHaveLength(2);
        expect(await repo.listIssues({ limit: 0 })).toHaveLength(1);
        expect(await repo.listIssues({ limit: -10 })).toHaveLength(1);
        expect(await repo.listIssues({ limit: 10_000 })).toHaveLength(3);
      });

      it('returns an empty list when nothing matches', async () => {
        expect(await repo.listIssues({ status: 'closed' })).toEqual([]);
      });
    });

    describe('updateIssue', () => {
      it('changes only the given fields and bumps updatedAt', async () => {
        const issue = await create({ assignee: 'alice', labels: ['bug'] });
        const updated = await repo.updateIssue(issue.id, { priority: 'critical', title: 'New' });

        expect(updated).toMatchObject({
          title: 'New',
          priority: 'critical',
          description: issue.description,
          assignee: 'alice',
          labels: ['bug'],
          createdAt: issue.createdAt,
        });
        expect(updated.updatedAt > issue.updatedAt).toBe(true);
        expect(await repo.getIssue(issue.id)).toEqual(updated);
      });

      it('unassigns with assignee: null but keeps it when assignee is omitted', async () => {
        const issue = await create({ assignee: 'alice' });
        expect((await repo.updateIssue(issue.id, { priority: 'low' })).assignee).toBe('alice');
        expect((await repo.updateIssue(issue.id, { assignee: null })).assignee).toBeNull();
      });

      it('replaces labels and normalises them', async () => {
        const issue = await create({ labels: ['bug', 'ui'] });
        expect((await repo.updateIssue(issue.id, { labels: ['Backend'] })).labels).toEqual([
          'backend',
        ]);
        expect((await repo.updateIssue(issue.id, { labels: [] })).labels).toEqual([]);
      });

      it('does not bump updatedAt when there is nothing to change', async () => {
        const issue = await create();
        const same = await repo.updateIssue(issue.id, {});
        expect(same).toEqual(issue);
      });

      it('rejects with NotFoundError for an unknown id', async () => {
        await expect(repo.updateIssue('iss_000000000000', { title: 'x' })).rejects.toBeInstanceOf(
          NotFoundError,
        );
      });
    });

    describe('deleteIssue', () => {
      it('deletes the issue and its comments', async () => {
        const issue = await create();
        await repo.addComment({ issueId: issue.id, author: 'alice', text: 'hi' });

        await repo.deleteIssue(issue.id);

        expect(await repo.getIssue(issue.id)).toBeNull();
        expect(await repo.listComments(issue.id)).toEqual([]);
      });

      it('leaves other issues alone', async () => {
        const keep = await create({ title: 'keep' });
        const remove = await create({ title: 'remove' });
        await repo.deleteIssue(remove.id);
        expect((await repo.listIssues()).map((i) => i.id)).toEqual([keep.id]);
      });

      it('rejects with NotFoundError for an unknown id', async () => {
        await expect(repo.deleteIssue('iss_000000000000')).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      });
    });

    describe('comments', () => {
      it('adds a comment and bumps the issue updatedAt', async () => {
        const issue = await create();
        const comment = await repo.addComment({ issueId: issue.id, author: 'bob', text: 'On it' });

        expect(comment).toMatchObject({ issueId: issue.id, author: 'bob', text: 'On it' });
        expect(comment.id).toMatch(/^cmt_[0-9a-f]{12}$/);
        expect((await repo.getIssue(issue.id))?.updatedAt).toBe(comment.createdAt);
      });

      it('lists comments oldest first', async () => {
        const issue = await create();
        await repo.addComment({ issueId: issue.id, author: 'a', text: 'first' });
        clock.advance();
        await repo.addComment({ issueId: issue.id, author: 'b', text: 'second' });

        expect((await repo.listComments(issue.id)).map((c) => c.text)).toEqual(['first', 'second']);
      });

      it('returns an empty list for an issue without comments or an unknown issue', async () => {
        const issue = await create();
        expect(await repo.listComments(issue.id)).toEqual([]);
        expect(await repo.listComments('iss_000000000000')).toEqual([]);
      });

      it('rejects with NotFoundError when the issue does not exist', async () => {
        await expect(
          repo.addComment({ issueId: 'iss_000000000000', author: 'a', text: 'b' }),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe('searchIssues', () => {
      it('matches title or description, case-insensitively, newest first', async () => {
        const inTitle = await create({ title: 'Payment timeout', description: 'x' });
        const inDescription = await create({ title: 'Checkout', description: 'PAYMENT fails' });
        await create({ title: 'Unrelated', description: 'nothing here' });

        expect((await repo.searchIssues('payment')).map((i) => i.id)).toEqual([
          inDescription.id,
          inTitle.id,
        ]);
      });

      it('treats % and _ literally, not as wildcards', async () => {
        const percent = await create({ title: 'CPU at 100% usage' });
        await create({ title: 'CPU at 1000 usage' });
        const underscore = await create({ title: 'Crash in user_id parsing' });

        expect((await repo.searchIssues('100%')).map((i) => i.id)).toEqual([percent.id]);
        expect((await repo.searchIssues('user_id')).map((i) => i.id)).toEqual([underscore.id]);
        expect(await repo.searchIssues('10_')).toEqual([]);
      });

      it('returns nothing for a blank keyword and respects the limit', async () => {
        await create({ title: 'bug one' });
        await create({ title: 'bug two' });
        expect(await repo.searchIssues('   ')).toEqual([]);
        expect(await repo.searchIssues('bug', 1)).toHaveLength(1);
      });
    });

    describe('getSummary', () => {
      it('returns zero-filled counts for an empty tracker', async () => {
        expect(await repo.getSummary()).toEqual({
          total: 0,
          byStatus: { open: 0, in_progress: 0, resolved: 0, closed: 0 },
          byPriority: { low: 0, medium: 0, high: 0, critical: 0 },
        });
      });

      it('counts issues by status and priority', async () => {
        const a = await create({ priority: 'critical' });
        await create({ priority: 'critical' });
        await create({ priority: 'low' });
        await repo.updateIssue(a.id, { status: 'resolved' });

        expect(await repo.getSummary()).toEqual({
          total: 3,
          byStatus: { open: 2, in_progress: 0, resolved: 1, closed: 0 },
          byPriority: { low: 1, medium: 0, high: 0, critical: 2 },
        });
      });
    });

    it('close() can be called more than once', async () => {
      await repo.close();
      await expect(repo.close()).resolves.toBeUndefined();
    });
  });
}
