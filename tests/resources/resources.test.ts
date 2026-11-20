import { describe, expect, it } from 'vitest';
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from '../../src/models/issue.js';
import { STATUS_TRANSITIONS } from '../../src/models/workflow.js';
import { buildSummary } from '../../src/resources/summary.js';
import { buildWorkflowMarkdown } from '../../src/resources/workflow.js';
import { createTestContext } from '../helpers.js';

describe('issues://workflow', () => {
  const markdown = buildWorkflowMarkdown();

  it('documents every status with exactly the transitions the code enforces', () => {
    for (const status of ISSUE_STATUSES) {
      const allowed = STATUS_TRANSITIONS[status].map((s) => `\`${s}\``).join(', ');
      expect(markdown).toMatch(new RegExp(`\\| \`${status}\` \\|.*\\| ${allowed} \\|`));
    }
  });

  it('defines every priority', () => {
    for (const priority of ISSUE_PRIORITIES) expect(markdown).toContain(`| \`${priority}\` |`);
  });
});

describe('issues://summary', () => {
  it('adds the active count and a generation timestamp', async () => {
    const ctx = createTestContext();
    const a = await ctx.repo.createIssue({ title: 'a', description: 'd', priority: 'low' });
    await ctx.repo.createIssue({ title: 'b', description: 'd', priority: 'low' });
    await ctx.repo.updateIssue(a.id, { status: 'closed' });

    expect(await buildSummary(ctx)).toMatchObject({
      total: 2,
      active: 1,
      generatedAt: '2026-11-18T10:00:00.000Z',
    });
  });
});
