import { authorField, commentTextField, issueIdField } from './schemas.js';
import { defineTool } from './types.js';

export const addCommentTool = defineTool({
  name: 'add_comment',
  title: 'Add comment',
  description:
    'Add a comment to an issue: progress updates, investigation notes, questions, or the reason ' +
    'for a status or priority change. Comments are append-only history, so prefer this over ' +
    'rewriting the description. Returns the created comment.',
  inputSchema: {
    issueId: issueIdField,
    author: authorField,
    text: commentTextField,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },

  async handler(args, { repo }) {
    const comment = await repo.addComment(args);
    return { comment };
  },
});
