/**
 * Seed the local database with realistic demo issues, so MCP Inspector and
 * Claude Desktop have something to work with straight away.
 *
 *   npm run seed            # seeds only if the database is empty
 *   npm run seed -- --force # adds the demo issues even if data exists
 *
 * Uses the same config as the server (STORAGE, SQLITE_PATH).
 */
import { loadConfig } from '../src/config.js';
import { createRepository } from '../src/db/index.js';
import type { CreateIssueInput, IssueStatus } from '../src/models/issue.js';

interface SeedIssue extends CreateIssueInput {
  status?: IssueStatus;
  comments?: { author: string; text: string }[];
}

const ISSUES: SeedIssue[] = [
  {
    title: 'Checkout times out for card payments',
    description:
      'Customers paying by card see a spinner for ~30s and then "Payment failed". ' +
      'Started after the payment-gateway SDK upgrade. Roughly 8% of checkouts affected.',
    priority: 'critical',
    assignee: 'alice',
    labels: ['bug', 'payments', 'backend'],
    status: 'in_progress',
    comments: [
      {
        author: 'alice',
        text: 'Reproduced locally. The new SDK defaults to a 5s connect timeout.',
      },
    ],
  },
  {
    title: 'Password reset email never arrives',
    description:
      'Users report no reset email. Mail provider dashboard shows bounces for our domain.',
    priority: 'high',
    labels: ['bug', 'auth', 'email'],
  },
  {
    title: 'Add dark mode',
    description: 'Many requests for a dark theme. Should follow the OS preference by default.',
    priority: 'low',
    labels: ['feature', 'ui'],
  },
  {
    title: 'Dashboard loads slowly for large accounts',
    description:
      'Accounts with 10k+ projects wait 12s for the dashboard. The projects query has no index on owner_id.',
    priority: 'medium',
    assignee: 'bob',
    labels: ['performance', 'backend'],
  },
  {
    title: 'Typo on pricing page',
    description: '"Anual" should be "Annual" on the pricing toggle.',
    priority: 'low',
    assignee: 'carol',
    labels: ['ui', 'content'],
    status: 'resolved',
    comments: [{ author: 'carol', text: 'Fixed in the latest deploy.' }],
  },
  {
    title: 'CSV export cuts off at 1,000 rows',
    description:
      'Exporting reports silently truncates to 1,000 rows. Customers expect the full data set.',
    priority: 'high',
    labels: ['bug', 'reports'],
  },
  {
    title: 'Mobile menu does not close after navigation',
    description: 'On iOS Safari the hamburger menu stays open after tapping a link.',
    priority: 'medium',
    labels: ['bug', 'ui', 'mobile'],
    status: 'closed',
  },
];

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const config = loadConfig();
  const repo = await createRepository(config);

  try {
    const existing = await repo.getSummary();
    if (existing.total > 0 && !force) {
      console.log(`Database already has ${existing.total} issue(s); nothing to do (use --force).`);
      return;
    }

    for (const { status, comments = [], ...input } of ISSUES) {
      const issue = await repo.createIssue(input);
      for (const comment of comments) await repo.addComment({ issueId: issue.id, ...comment });
      if (status) await repo.updateIssue(issue.id, { status });
    }
    console.log(
      `Seeded ${ISSUES.length} issues into ${config.storage === 'sqlite' ? config.sqlitePath : config.storage}.`,
    );
  } finally {
    await repo.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
