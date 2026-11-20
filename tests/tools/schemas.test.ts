/**
 * Input validation: the Zod shapes are the guardrail between the LLM and the
 * database, so their limits are tested directly.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LIMITS } from '../../src/models/issue.js';
import { createIssueTool } from '../../src/tools/createIssue.js';
import { deleteIssueTool } from '../../src/tools/deleteIssue.js';
import { listIssuesTool } from '../../src/tools/listIssues.js';
import { updateIssueTool } from '../../src/tools/updateIssue.js';

const createSchema = z.object(createIssueTool.inputSchema);
const valid = { title: 'Crash', description: 'App crashes on start', priority: 'high' };

describe('tool input schemas', () => {
  it('accepts a valid create_issue payload and trims strings', () => {
    const parsed = createSchema.parse({ ...valid, title: '  Crash  ' });
    expect(parsed.title).toBe('Crash');
  });

  it.each([
    ['blank title', { ...valid, title: '   ' }],
    ['title over the limit', { ...valid, title: 'x'.repeat(LIMITS.titleMax + 1) }],
    [
      'description over the limit',
      { ...valid, description: 'x'.repeat(LIMITS.descriptionMax + 1) },
    ],
    ['unknown priority', { ...valid, priority: 'urgent' }],
    [
      'too many labels',
      { ...valid, labels: Array.from({ length: LIMITS.labelsMax + 1 }, (_, i) => `l${i}`) },
    ],
    ['label over the limit', { ...valid, labels: ['x'.repeat(LIMITS.labelMax + 1)] }],
    ['missing description', { title: 'Crash', priority: 'high' }],
  ])('rejects %s', (_name, payload) => {
    expect(createSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects list_issues limits outside 1-200 and non-integers', () => {
    const schema = z.object(listIssuesTool.inputSchema);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: LIMITS.listMax + 1 }).success).toBe(false);
    expect(schema.safeParse({ limit: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ limit: 10 }).success).toBe(true);
  });

  it('allows null assignee on update_issue (unassign) but has no status field', () => {
    const schema = z.object(updateIssueTool.inputSchema);
    expect(schema.parse({ id: 'iss_1', assignee: null }).assignee).toBeNull();
    expect(Object.keys(updateIssueTool.inputSchema)).not.toContain('status');
  });

  it('requires delete_issue.confirm to be a boolean', () => {
    const schema = z.object(deleteIssueTool.inputSchema);
    expect(schema.safeParse({ id: 'iss_1' }).success).toBe(false);
    expect(schema.safeParse({ id: 'iss_1', confirm: 'yes' }).success).toBe(false);
  });
});
