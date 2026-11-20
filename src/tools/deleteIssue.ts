import { z } from 'zod';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { issueIdField } from './schemas.js';
import { defineTool } from './types.js';

export const deleteIssueTool = defineTool({
  name: 'delete_issue',
  title: 'Delete issue (permanent)',
  description:
    'PERMANENTLY delete an issue and all of its comments. This cannot be undone. ' +
    'Only use this for spam, test data or issues created by mistake, and only after the user ' +
    'has explicitly confirmed. For duplicates or "won\'t fix", use change_status to "closed" ' +
    'instead, which keeps the history.',
  inputSchema: {
    id: issueIdField,
    confirm: z
      .boolean()
      .describe(
        'Safety switch. Must be true, and only set it to true AFTER the user has explicitly ' +
          'confirmed they want this issue permanently deleted. Any other value refuses.',
      ),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },

  async handler({ id, confirm }, { repo }) {
    // Guardrail: the destructive action requires an explicit opt-in, so a
    // confused or prompt-injected model can't delete by accident.
    if (!confirm) {
      throw new ValidationError(
        `Refusing to delete issue ${id} without confirmation. Ask the user to confirm, ` +
          'then call delete_issue again with confirm: true.',
      );
    }

    const issue = await repo.getIssue(id);
    if (!issue) throw new NotFoundError('Issue', id);
    await repo.deleteIssue(id);
    return { deleted: true, id, title: issue.title };
  },
});
