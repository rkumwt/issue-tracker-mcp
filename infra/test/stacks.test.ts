/**
 * Infrastructure tests: synthesize the stacks and assert on the CloudFormation
 * template. They catch accidental changes to things that matter (billing mode,
 * runtime, permissions, throttling, the OIDC trust condition) before deploy.
 *
 *   npm test   (inside infra/)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GitHubOidcStack, githubSubject } from '../lib/github-oidc-stack.js';
import { IssueTrackerStack } from '../lib/issue-tracker-stack.js';

const env = { account: '123456789012', region: 'eu-west-1' };

function synthMain(props: { budgetEmail?: string } = {}) {
  const app = new App();
  const stack = new IssueTrackerStack(app, 'Test', {
    env,
    apiKeyParameterName: '/issue-tracker-mcp/api-key',
    ...props,
  });
  return Template.fromStack(stack);
}

// Synthesizing bundles the Lambda with esbuild, so do it once and share it.
const template = synthMain();

describe('IssueTrackerStack', () => {
  it('creates an on-demand DynamoDB table with both GSIs and PITR, retained on delete', () => {
    template.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          Match.objectLike({ IndexName: 'gsi1' }),
          Match.objectLike({ IndexName: 'gsi2' }),
        ],
        Replicas: [
          Match.objectLike({
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          }),
        ],
      }),
    });
  });

  it('runs the function on Node 22 / arm64 with config but no secrets in its environment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Environment: {
        Variables: Match.objectLike({
          STORAGE: 'dynamodb',
          MCP_API_KEY_PARAMETER: '/issue-tracker-mcp/api-key',
        }),
      },
    });
    const fns = template.findResources('AWS::Lambda::Function');
    const envVars = JSON.stringify(Object.values(fns).map((f) => f.Properties?.Environment));
    assert.ok(
      !envVars.includes('"MCP_API_KEY"'),
      'the API key itself must never be in the template',
    );
  });

  it('lets the function read only its own SSM parameter', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['ssm:GetParameter']),
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp(':parameter/issue-tracker-mcp/api-key')]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  it('keeps logs for two weeks only', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
  });

  it('exposes only /mcp and /health, with stage throttling', () => {
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map(
      (r) => (r.Properties as { RouteKey: string }).RouteKey,
    );
    assert.deepEqual(routes.sort(), ['DELETE /mcp', 'GET /health', 'GET /mcp', 'POST /mcp']);
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
    });
  });

  it('creates a budget alert only when an email is given', () => {
    template.resourceCountIs('AWS::Budgets::Budget', 0);
    synthMain({ budgetEmail: 'alerts@example.com' }).hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: 'USD' }, TimeUnit: 'MONTHLY' }),
    });
  });
});

describe('GitHubOidcStack', () => {
  const oidc = Template.fromStack(
    new GitHubOidcStack(new App(), 'Oidc', {
      env,
      repository: 'owner/repo',
      environment: 'production',
      ownerId: '111',
      repositoryId: '222',
    }),
  );

  it('trusts only the production environment of one repository', () => {
    oidc.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:owner@111/repo@222:environment:production',
              },
            },
          }),
        ],
      },
    });
  });

  it('builds ID-based subjects (what GitHub sends today) and the legacy name-only form', () => {
    assert.equal(
      githubSubject({
        repository: 'rkumwt/issue-tracker-mcp',
        environment: 'production',
        ownerId: '21355037',
        repositoryId: '1465100792',
      }),
      // Exactly the userName CloudTrail recorded for the rejected deploy.
      'repo:rkumwt@21355037/issue-tracker-mcp@1465100792:environment:production',
    );
    assert.equal(
      githubSubject({ repository: 'owner/repo', environment: 'production' }),
      'repo:owner/repo:environment:production',
    );
    assert.throws(() => githubSubject({ repository: 'no-slash', environment: 'production' }));
  });

  it('can only assume the CDK bootstrap roles', () => {
    oidc.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                ['arn:', { Ref: 'AWS::Partition' }, ':iam::123456789012:role/cdk-hnb659fds-*'],
              ],
            },
          },
        ],
      },
    });
  });
});
