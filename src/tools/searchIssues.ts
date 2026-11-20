import { clampLimit } from '../models/issue.js';
import { listResult } from './format.js';
import { keywordField, limitField } from './schemas.js';
import { defineTool } from './types.js';

export const searchIssuesTool = defineTool({
  name: 'search_issues',
  title: 'Search issues',
  description:
    'Find issues whose title or description contains a keyword or phrase (case-insensitive ' +
    'substring match, newest first). Use this when the user describes an issue in words, to find ' +
    'an issue ID, or to check for duplicates before create_issue. ' +
    'To filter by status/priority/assignee/label, use list_issues instead.',
  inputSchema: {
    keyword: keywordField,
    limit: limitField.optional(),
  },
  annotations: { readOnlyHint: true },

  async handler({ keyword, limit: requested }, { repo }) {
    const limit = clampLimit(requested);
    const issues = await repo.searchIssues(keyword, limit);
    return listResult(issues, limit);
  },
});
