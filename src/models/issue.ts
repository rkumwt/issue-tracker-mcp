/**
 * Domain model for the issue tracker.
 *
 * Design decision: Zod schemas are the SINGLE SOURCE OF TRUTH.
 * TypeScript types are derived from them with `z.infer`, so the runtime
 * validation (what the LLM is allowed to send) and the compile-time types
 * (what our code works with) can never drift apart. The same enums and
 * limits are reused by the MCP tool schemas, both repositories and the tests.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ISSUE_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export const ISSUE_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

export const IssueStatusSchema = z.enum(ISSUE_STATUSES);
export const IssuePrioritySchema = z.enum(ISSUE_PRIORITIES);

export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

// ---------------------------------------------------------------------------
// Input size limits (guardrail: an LLM or a malicious client must not be able
// to push megabytes of text into a single field).
// ---------------------------------------------------------------------------

export const LIMITS = {
  titleMax: 200,
  descriptionMax: 10_000,
  assigneeMax: 100,
  labelMax: 50,
  labelsMax: 20,
  commentMax: 5_000,
  authorMax: 100,
  keywordMax: 200,
  listDefault: 50,
  listMax: 200,
} as const;

// ---------------------------------------------------------------------------
// Entities (what is stored and returned)
// ---------------------------------------------------------------------------

/** ISO-8601 UTC timestamp, e.g. "2026-11-20T12:00:00.000Z". */
const TimestampSchema = z.iso.datetime();

export const IssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: IssueStatusSchema,
  priority: IssuePrioritySchema,
  /** `null` = unassigned. Stored explicitly so "unassigned" is a queryable state. */
  assignee: z.string().nullable(),
  labels: z.array(z.string()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Issue = z.infer<typeof IssueSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  author: z.string(),
  text: z.string(),
  createdAt: TimestampSchema,
});
export type Comment = z.infer<typeof CommentSchema>;

// ---------------------------------------------------------------------------
// Repository inputs
// ---------------------------------------------------------------------------

export interface CreateIssueInput {
  title: string;
  description: string;
  priority: IssuePriority;
  assignee?: string | null;
  labels?: string[];
}

/**
 * Partial update. Only the keys that are present are changed.
 * `assignee: null` explicitly un-assigns; omitting `assignee` leaves it as is.
 */
export interface UpdateIssueInput {
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee?: string | null;
  labels?: string[];
}

export interface IssueFilter {
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee?: string;
  /** Matches issues that carry this label (labels are normalised to lower-case). */
  label?: string;
  /** Only issues created at/after this ISO timestamp (used by the weekly report). */
  createdAfter?: string;
  /** Only issues updated at/after this ISO timestamp (used by the weekly report). */
  updatedAfter?: string;
  /** Max rows to return. Defaults to LIMITS.listDefault, capped at LIMITS.listMax. */
  limit?: number;
}

export interface AddCommentInput {
  issueId: string;
  author: string;
  text: string;
}

/** Aggregate counts, served by the `issues://summary` resource. */
export interface IssueSummary {
  total: number;
  byStatus: Record<IssueStatus, number>;
  byPriority: Record<IssuePriority, number>;
}

/** An issue together with its comments (what `get_issue` returns). */
export interface IssueWithComments extends Issue {
  comments: Comment[];
}

// ---------------------------------------------------------------------------
// Small pure helpers shared by every repository implementation
// ---------------------------------------------------------------------------

/**
 * Normalise labels so "Bug", " bug " and "bug" are the same label:
 * trim, lower-case, drop empties, de-duplicate, keep first-seen order.
 */
export function normalizeLabels(labels: readonly string[] | undefined): string[] {
  if (!labels) return [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const label = raw.trim().toLowerCase();
    if (label.length > 0) seen.add(label);
  }
  return [...seen];
}

/** Clamp a caller-supplied limit into [1, LIMITS.listMax]. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LIMITS.listDefault;
  return Math.min(Math.max(Math.trunc(limit), 1), LIMITS.listMax);
}

/** Zero-filled summary skeleton, so every status/priority key is always present. */
export function emptySummary(): IssueSummary {
  return {
    total: 0,
    byStatus: { open: 0, in_progress: 0, resolved: 0, closed: 0 },
    byPriority: { low: 0, medium: 0, high: 0, critical: 0 },
  };
}
