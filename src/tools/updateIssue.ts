import { ValidationError } from '../lib/errors.js';
import {
  assigneeField,
  descriptionField,
  issueIdField,
  labelsField,
  priorityField,
  titleField,
} from './schemas.js';
import { defineTool } from './types.js';

const UPDATABLE_FIELDS = ['title', 'description', 'priority', 'assignee', 'labels'] as const;

export const updateIssueTool = defineTool({
  name: 'update_issue',
  title: 'Update issue',
  description:
    'Change one or more fields of an existing issue: title, description, priority, assignee or ' +
    'labels. Only the fields you pass are changed. ' +
    'Use this to re-prioritise, (re)assign, unassign (assignee: null), retitle or relabel. ' +
    'Status can NOT be changed here: use change_status, which enforces the workflow rules. ' +
    'To add discussion or progress notes, use add_comment instead of editing the description.',
  inputSchema: {
    id: issueIdField,
    title: titleField.optional(),
    description: descriptionField.optional().describe('Replaces the whole description.'),
    priority: priorityField.optional(),
    assignee: assigneeField
      .nullable()
      .optional()
      .describe('New assignee username, or null to unassign.'),
    labels: labelsField.optional().describe('Replaces ALL labels with this list ([] removes all).'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },

  async handler({ id, ...changes }, { repo }) {
    const updatedFields = UPDATABLE_FIELDS.filter((field) => changes[field] !== undefined);

    if (updatedFields.length === 0) {
      throw new ValidationError(
        'No fields to update. Pass at least one of: title, description, priority, assignee, labels.',
      );
    }

    const issue = await repo.updateIssue(id, changes);
    return { issue, updatedFields };
  },
});
