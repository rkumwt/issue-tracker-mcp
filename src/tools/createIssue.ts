import {
  assigneeField,
  descriptionField,
  labelsField,
  priorityField,
  titleField,
} from './schemas.js';
import { defineTool } from './types.js';

export const createIssueTool = defineTool({
  name: 'create_issue',
  title: 'Create issue',
  description:
    'Create a new issue (bug, task or feature request) in the tracker. ' +
    'Use this when the user reports a problem or asks to track new work. ' +
    'To avoid duplicates, run search_issues first when the issue may already exist. ' +
    'New issues always start with status "open". Returns the created issue including its ID.',
  inputSchema: {
    title: titleField,
    description: descriptionField,
    priority: priorityField,
    assignee: assigneeField.optional().describe('Optional username to assign the issue to.'),
    labels: labelsField.optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },

  async handler(args, { repo }) {
    const issue = await repo.createIssue(args);
    return { issue };
  },
});
