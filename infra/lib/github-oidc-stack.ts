/**
 * One-time setup that lets GitHub Actions deploy WITHOUT long-lived AWS keys.
 *
 * How it works (OpenID Connect):
 *  1. Each workflow run gets a short-lived, signed token from GitHub that says
 *     "I am repo X, running in environment Y".
 *  2. AWS trusts GitHub's token issuer (the OIDC provider below) and lets that
 *     token assume ONE role, and only if the token's claims match exactly.
 *  3. The role can do nothing except assume the CDK bootstrap roles, which
 *     perform the actual deployment.
 *
 * Nothing secret is stored in GitHub: no AWS_ACCESS_KEY_ID, no secret key.
 *
 * Deploy this stack once, by hand, with admin credentials:
 *   cd infra && npx cdk deploy IssueTrackerMcpGitHubOidc
 * An AWS account can only have ONE provider for token.actions.githubusercontent.com;
 * if yours already has one, pass its ARN via context `githubOidcProviderArn`.
 */
import { CfnOutput, Duration, Stack, type StackProps, aws_iam as iam } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const GITHUB_ISSUER = 'token.actions.githubusercontent.com';

export interface GitHubOidcStackProps extends StackProps {
  /** "owner/repo" allowed to deploy. */
  repository: string;
  /** GitHub Environment the deploy job runs in (part of the token's `sub` claim). */
  environment: string;
  /** Reuse an existing GitHub OIDC provider instead of creating one. */
  existingProviderArn?: string | undefined;
}

export class GitHubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, props);

    const provider = props.existingProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(
          this,
          'GitHubProvider',
          props.existingProviderArn,
        )
      : new iam.OidcProviderNative(this, 'GitHubProvider', {
          url: `https://${GITHUB_ISSUER}`,
          clientIds: ['sts.amazonaws.com'],
        });

    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'issue-tracker-mcp-github-deploy',
      description: `GitHub Actions deploys for ${props.repository} (${props.environment})`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_ISSUER}:aud`]: 'sts.amazonaws.com',
          // Jobs that use a GitHub Environment get this exact `sub` format.
          // Pinning it means only the protected "production" environment of
          // this one repository can deploy: not forks, not other branches' PRs.
          [`${GITHUB_ISSUER}:sub`]: `repo:${props.repository}:environment:${props.environment}`,
        },
      }),
    });

    // Least privilege: the CDK CLI only needs to assume the bootstrap roles,
    // which already hold the deployment permissions.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', {
      value: role.roleArn,
      description: 'Set as the AWS_DEPLOY_ROLE_ARN variable of the GitHub "production" environment',
    });
  }
}
