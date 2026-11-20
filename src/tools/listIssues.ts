import { z } from 'zod';
import { clampLimit, LIMITS } from '../models/issue.js';
import { listResult } from './format.js';
import { limitField, priorityField, statusField } from './schemas.js';
import { defineTool } from './types.js';

export const listIssuesTool = defineTool({
  name: 'list_issues',
  title: 'List issues',
  description:
    'List issues filtered by status, priority, assignee and/or label (all filters are optional ' +
    'and combined with AND), newest first. Use this to browse or answer questions like ' +
    '"what critical bugs are open?" or "what is alice working on?". ' +
    'To find issues by words in their text, use search_issues instead. ' +
    'Descriptions are shortened; call get_issue for full details.',
  inputSchema: {
    status: statusField.optional().describe('Only issues in this status.'),
    priority: priorityField.optional().describe('Only issues with this priority.'),
    assignee: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.assigneeMax)
      .optional()
      .describe('Only issues assigned to this username (case-insensitive).'),
    label: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.labelMax)
      .optional()
      .describe('Only issues carrying this label, e.g. "bug".'),
    limit: limitField.optional(),
  },
  annotations: { readOnlyHint: true },

  async handler(args, { repo }) {
    const limit = clampLimit(args.limit);
    const issues = await repo.listIssues({ ...args, limit });
    return listResult(issues, limit);
  },
});
