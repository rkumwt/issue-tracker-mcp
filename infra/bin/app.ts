/**
 * CDK app entry point.
 *
 *   npx cdk deploy IssueTrackerMcp            # the MCP server (CI deploys this)
 *   npx cdk deploy IssueTrackerMcpGitHubOidc  # one-time: GitHub Actions deploy role
 *
 * Settings come from cdk.json "context" and can be overridden on the command
 * line, e.g. `npx cdk deploy IssueTrackerMcp -c budgetEmail=you@example.com`.
 */
import { App, Tags } from 'aws-cdk-lib';
import { GitHubOidcStack } from '../lib/github-oidc-stack.js';
import { IssueTrackerStack } from '../lib/issue-tracker-stack.js';

const app = new App();

const context = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key);
  return value === undefined || value === null || value === '' ? undefined : String(value);
};

// Account/region come from the credentials the CLI is using.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new IssueTrackerStack(app, 'IssueTrackerMcp', {
  env,
  description: 'Issue Tracker MCP server: API Gateway HTTP API + Lambda + DynamoDB',
  apiKeyParameterName: context('apiKeyParameterName') ?? '/issue-tracker-mcp/api-key',
  budgetEmail: context('budgetEmail'),
  monthlyBudgetUsd: Number(context('monthlyBudgetUsd') ?? 10),
});

new GitHubOidcStack(app, 'IssueTrackerMcpGitHubOidc', {
  env,
  description: 'GitHub Actions OIDC deploy role for the Issue Tracker MCP server',
  repository: context('githubRepository') ?? 'rkumwt/issue-tracker-mcp',
  environment: context('githubEnvironment') ?? 'production',
  ownerId: context('githubOwnerId'),
  repositoryId: context('githubRepositoryId'),
  existingProviderArn: context('githubOidcProviderArn'),
});

// Tags make cost reports filterable by project (Cost Explorer → Tag: project).
Tags.of(app).add('project', 'issue-tracker-mcp');
