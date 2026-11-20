import { NotFoundError } from '../lib/errors.js';
import { issueIdField } from './schemas.js';
import { defineTool } from './types.js';

export const getIssueTool = defineTool({
  name: 'get_issue',
  title: 'Get issue',
  description:
    'Get one issue by its ID, with the FULL description and all comments (oldest first). ' +
    'Use this when you need complete details of a specific issue; list_issues and ' +
    'search_issues only return shortened descriptions and no comments.',
  inputSchema: {
    id: issueIdField,
  },
  annotations: { readOnlyHint: true },

  async handler({ id }, { repo }) {
    const issue = await repo.getIssue(id);
    if (!issue) throw new NotFoundError('Issue', id);
    const comments = await repo.listComments(id);
    return { ...issue, comments };
  },
});
