/**
 * Tool handler tests.
 *
 * Handlers are called directly with a real in-memory repository: no MCP
 * plumbing, no mocks of our own code. Protocol-level behaviour (Zod validation
 * by the SDK, JSON-RPC) is covered in tests/server.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../src/lib/errors.js';
import type { Issue } from '../../src/models/issue.js';
import { addCommentTool } from '../../src/tools/addComment.js';
import { changeStatusTool } from '../../src/tools/changeStatus.js';
import { createIssueTool } from '../../src/tools/createIssue.js';
import { deleteIssueTool } from '../../src/tools/deleteIssue.js';
import { getIssueTool } from '../../src/tools/getIssue.js';
import { listIssuesTool } from '../../src/tools/listIssues.js';
import { searchIssuesTool } from '../../src/tools/searchIssues.js';
import { updateIssueTool } from '../../src/tools/updateIssue.js';
import { createTestContext, type TestContext } from '../helpers.js';

const MISSING_ID = 'iss_000000000000';

let ctx: TestContext;

async function seedIssue(
  overrides: Partial<Parameters<TestContext['repo']['createIssue']>[0]> = {},
) {
  const issue = await ctx.repo.createIssue({
    title: 'Login loop',
    description: 'OAuth redirect loops forever',
    priority: 'high',
    ...overrides,
  });
  ctx.clock.advance();
  return issue;
}

beforeEach(() => {
  ctx = createTestContext();
});

describe('create_issue', () => {
  it('creates an open issue and returns it', async () => {
    const result = await createIssueTool.handler(
      { title: 'Crash', description: 'App crashes', priority: 'critical', labels: ['Bug'] },
      ctx,
    );
    expect(result).toEqual({
      issue: expect.objectContaining({ title: 'Crash', status: 'open', labels: ['bug'] }) as Issue,
    });
    expect(await ctx.repo.listIssues()).toHaveLength(1);
  });
});

describe('get_issue', () => {
  it('returns the full issue with comments', async () => {
    const issue = await seedIssue({ description: 'x'.repeat(500) });
    await ctx.repo.addComment({ issueId: issue.id, author: 'alice', text: 'Investigating' });

    const result = await getIssueTool.handler({ id: issue.id }, ctx);

    expect(result).toMatchObject({ id: issue.id, description: 'x'.repeat(500) });
    expect(result).toHaveProperty('comments', [
      expect.objectContaining({ author: 'alice', text: 'Investigating' }),
    ]);
  });

  it('throws NotFoundError for an unknown id', async () => {
    await expect(getIssueTool.handler({ id: MISSING_ID }, ctx)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('list_issues', () => {
  it('filters and truncates long descriptions to save tokens', async () => {
    await seedIssue({ priority: 'critical', description: 'y'.repeat(1_000) });
    await seedIssue({ priority: 'low' });

    const result = (await listIssuesTool.handler({ priority: 'critical' }, ctx)) as {
      count: number;
      issues: Issue[];
      note?: string;
    };

    expect(result.count).toBe(1);
    expect(result.issues[0]?.description).toHaveLength(201); // 200 chars + "…"
    expect(result.issues[0]?.description.endsWith('…')).toBe(true);
    expect(result.note).toBeUndefined();
  });

  it('adds a note when the limit was reached', async () => {
    await seedIssue();
    await seedIssue();
    const result = await listIssuesTool.handler({ limit: 1 }, ctx);
    expect(result).toMatchObject({
      count: 1,
      note: expect.stringMatching(/more may exist/) as string,
    });
  });
});

describe('update_issue', () => {
  it('updates the given fields and reports which ones changed', async () => {
    const issue = await seedIssue({ assignee: 'alice' });
    const result = await updateIssueTool.handler(
      { id: issue.id, priority: 'critical', assignee: null },
      ctx,
    );
    expect(result).toMatchObject({
      issue: { priority: 'critical', assignee: null },
      updatedFields: ['priority', 'assignee'],
    });
  });

  it('rejects an update with no fields', async () => {
    const issue = await seedIssue();
    await expect(updateIssueTool.handler({ id: issue.id }, ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('throws NotFoundError for an unknown id', async () => {
    await expect(
      updateIssueTool.handler({ id: MISSING_ID, title: 'x' }, ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('change_status', () => {
  it('moves an issue along an allowed transition', async () => {
    const issue = await seedIssue();
    const result = await changeStatusTool.handler({ id: issue.id, status: 'in_progress' }, ctx);
    expect(result).toMatchObject({
      issue: { status: 'in_progress' },
      previousStatus: 'open',
      changed: true,
    });
  });

  it('is idempotent when the issue already has that status', async () => {
    const issue = await seedIssue();
    const result = await changeStatusTool.handler({ id: issue.id, status: 'open' }, ctx);
    expect(result).toMatchObject({ changed: false, issue: { updatedAt: issue.updatedAt } });
  });

  it('rejects an illegal transition and lists the allowed ones', async () => {
    const issue = await seedIssue();
    await changeStatusTool.handler({ id: issue.id, status: 'closed' }, ctx);

    const attempt = changeStatusTool.handler({ id: issue.id, status: 'resolved' }, ctx);
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toThrow('Allowed from "closed": open');
    expect((await ctx.repo.getIssue(issue.id))?.status).toBe('closed');
  });

  it('throws NotFoundError for an unknown id', async () => {
    await expect(
      changeStatusTool.handler({ id: MISSING_ID, status: 'closed' }, ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('add_comment', () => {
  it('adds a comment to an existing issue', async () => {
    const issue = await seedIssue();
    const result = await addCommentTool.handler(
      { issueId: issue.id, author: 'bob', text: 'Fixed in v1.2' },
      ctx,
    );
    expect(result).toMatchObject({ comment: { issueId: issue.id, author: 'bob' } });
  });

  it('throws NotFoundError for an unknown issue', async () => {
    await expect(
      addCommentTool.handler({ issueId: MISSING_ID, author: 'a', text: 'b' }, ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('search_issues', () => {
  it('finds issues by keyword', async () => {
    const match = await seedIssue({ title: 'Payment timeout' });
    await seedIssue({ title: 'Dark mode' });
    const result = await searchIssuesTool.handler({ keyword: 'payment' }, ctx);
    expect(result).toMatchObject({ count: 1, issues: [{ id: match.id }] });
  });
});

describe('delete_issue', () => {
  it('refuses to delete without confirm: true and keeps the issue', async () => {
    const issue = await seedIssue();
    const attempt = deleteIssueTool.handler({ id: issue.id, confirm: false }, ctx);

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toThrow(/Refusing to delete/);
    expect(await ctx.repo.getIssue(issue.id)).not.toBeNull();
  });

  it('deletes with confirm: true and reports what was deleted', async () => {
    const issue = await seedIssue({ title: 'Spam' });
    const result = await deleteIssueTool.handler({ id: issue.id, confirm: true }, ctx);
    expect(result).toEqual({ deleted: true, id: issue.id, title: 'Spam' });
    expect(await ctx.repo.getIssue(issue.id)).toBeNull();
  });

  it('throws NotFoundError for an unknown id', async () => {
    await expect(
      deleteIssueTool.handler({ id: MISSING_ID, confirm: true }, ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
