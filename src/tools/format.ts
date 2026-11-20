/**
 * Output shaping helpers.
 *
 * Design decision: list and search results TRUNCATE descriptions. Tool output
 * goes straight into the LLM's context window, and 200 issues × 10 KB of
 * description would waste tokens (and money) on text the model rarely needs.
 * The model is told to call get_issue when it wants the full text.
 */
import type { Issue } from '../models/issue.js';

export const PREVIEW_LENGTH = 200;

export function truncate(text: string, max = PREVIEW_LENGTH): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** An issue as shown in list/search results (description shortened). */
export function toListItem(issue: Issue): Issue {
  return { ...issue, description: truncate(issue.description) };
}

/** Standard envelope for list-style results, with a hint when results were capped. */
export function listResult(issues: Issue[], limit: number): object {
  return {
    count: issues.length,
    issues: issues.map(toListItem),
    ...(issues.length === limit && {
      note: `Showing the first ${limit} results; more may exist. Narrow the filters or raise "limit".`,
    }),
  };
}
