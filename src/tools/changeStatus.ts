import { NotFoundError } from '../lib/errors.js';
import { assertTransition } from '../models/workflow.js';
import { issueIdField, statusField } from './schemas.js';
import { defineTool } from './types.js';

export const changeStatusTool = defineTool({
  name: 'change_status',
  title: 'Change issue status',
  description:
    'Move an issue through the workflow: open → in_progress → resolved → closed, or reopen it. ' +
    'Use this whenever work starts ("in_progress"), is fixed ("resolved"), is verified or ' +
    'abandoned ("closed"), or must be reopened ("open"). Illegal moves (e.g. closed → resolved) ' +
    'are rejected with the list of allowed statuses; read issues://workflow for the full rules. ' +
    'Tip: add a comment with add_comment explaining WHY the status changed.',
  inputSchema: {
    id: issueIdField,
    status: statusField.describe('The new status.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },

  async handler({ id, status }, { repo }) {
    const current = await repo.getIssue(id);
    if (!current) throw new NotFoundError('Issue', id);

    // Already there: succeed without changing anything (idempotent).
    if (current.status === status) {
      return { issue: current, previousStatus: current.status, changed: false };
    }

    assertTransition(current.status, status);
    const issue = await repo.updateIssue(id, { status });
    return { issue, previousStatus: current.status, changed: true };
  },
});
