/**
 * Reusable Zod field schemas for MCP tool inputs.
 *
 * Every field has `.describe()`: the SDK turns these schemas into the JSON
 * Schema the LLM sees, so the descriptions are effectively the "docs" the model
 * reads when deciding what to send. Size limits come from LIMITS so they match
 * the data model.
 *
 * Strings are `.trim()`-ed before length checks, so "   " is rejected as empty.
 */
import { z } from 'zod';
import { IssuePrioritySchema, IssueStatusSchema, LIMITS } from '../models/issue.js';

export const issueIdField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('Issue ID as returned by other tools, e.g. "iss_3f9a1c2b7d4e".');

export const titleField = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.titleMax)
  .describe(`Short one-line summary of the issue (max ${LIMITS.titleMax} characters).`);

export const descriptionField = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.descriptionMax)
  .describe(
    'Full details: what happened, expected vs actual behaviour, steps to reproduce. ' +
      `Markdown allowed (max ${LIMITS.descriptionMax} characters).`,
  );

export const priorityField = IssuePrioritySchema.describe(
  'Urgency: "critical" = outage/data loss/security, "high" = major feature broken, ' +
    '"medium" = real problem with a workaround, "low" = cosmetic or nice-to-have. ' +
    'See the issues://workflow resource for full definitions.',
);

export const statusField = IssueStatusSchema.describe(
  'Workflow status: "open", "in_progress", "resolved" or "closed".',
);

export const assigneeField = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.assigneeMax)
  .describe('Username of the person responsible, e.g. "alice".');

export const labelsField = z
  .array(z.string().trim().min(1).max(LIMITS.labelMax))
  .max(LIMITS.labelsMax)
  .describe(
    `Tags such as "bug", "ui", "backend" (max ${LIMITS.labelsMax}). ` +
      'Stored lower-case and de-duplicated.',
  );

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(LIMITS.listMax)
  .describe(
    `Maximum number of issues to return (1-${LIMITS.listMax}, default ${LIMITS.listDefault}).`,
  );

export const keywordField = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.keywordMax)
  .describe('Word or phrase to look for in issue titles and descriptions (case-insensitive).');

export const authorField = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.authorMax)
  .describe('Username of the person writing the comment.');

export const commentTextField = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.commentMax)
  .describe(`Comment body. Markdown allowed (max ${LIMITS.commentMax} characters).`);
