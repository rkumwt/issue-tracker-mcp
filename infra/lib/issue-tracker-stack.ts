/**
 * The production stack: API Gateway (HTTP API) → Lambda → DynamoDB.
 *
 *   MCP client ──HTTPS + Bearer──▶ API Gateway HTTP API ──▶ Lambda (Node 22, arm64)
 *                                   (throttled)               │        │
 *                                                             ▼        ▼
 *                                                       DynamoDB   SSM Parameter Store
 *                                                      (on-demand)  (API key, SecureString)
 *
 * Cost design (target: well under $10/month for personal/team use):
 *  - HTTP API instead of REST API: ~70% cheaper per request, and enough here.
 *  - Lambda on arm64 (Graviton): ~20% cheaper per GB-second than x86.
 *  - DynamoDB on-demand: pay per request, $0 when idle (no provisioned capacity).
 *  - SSM standard parameters: free (Secrets Manager would be $0.40/secret/month).
 *  - CloudWatch log retention: 2 weeks, so logs don't accumulate cost forever.
 *  - Stage throttling caps how fast anyone (including a leaked key) can spend money.
 *  - Optional AWS Budget alert (context `budgetEmail`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_budgets as budgets,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import { HttpApi, HttpMethod, HttpStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

/** Repository root (infra/lib/ → ../..), where src/ and package-lock.json live. */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface IssueTrackerStackProps extends StackProps {
  /** Name of the SecureString SSM parameter holding the API key (created outside CDK). */
  apiKeyParameterName: string;
  /** If set, creates a monthly AWS Budget that emails this address. */
  budgetEmail?: string | undefined;
  monthlyBudgetUsd?: number;
  /** API Gateway throttling (steady-state requests/second and burst). */
  throttle?: { rateLimit: number; burstLimit: number };
}

export class IssueTrackerStack extends Stack {
  constructor(scope: Construct, id: string, props: IssueTrackerStackProps) {
    super(scope, id, props);

    // --- DynamoDB: single table, keys must match src/db/dynamodb/table.ts ---
    const table = new dynamodb.TableV2(this, 'IssuesTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      globalSecondaryIndexes: [
        {
          indexName: 'gsi1',
          partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
        },
        {
          indexName: 'gsi2',
          partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
        },
      ],
      // Restore to any second in the last 35 days. Costs cents for a small table.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Keep the data if the stack is deleted: deleting a stack should never
      // silently destroy production data.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- API key: SecureString parameter, created once by hand (see README) ---
    // CloudFormation cannot create SecureString parameters, which is good: the
    // secret never passes through the template or the repository.
    const apiKeyParameter = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'ApiKeyParameter',
      { parameterName: props.apiKeyParameterName },
    );

    // --- Lambda ---
    const logGroup = new logs.LogGroup(this, 'McpFunctionLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, 'McpFunction', {
      description: 'Issue Tracker MCP server (Streamable HTTP, stateless)',
      entry: path.join(PROJECT_ROOT, 'src', 'lambda.ts'),
      handler: 'handler',
      projectRoot: PROJECT_ROOT,
      depsLockFilePath: path.join(PROJECT_ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512, // more memory = more CPU = faster cold starts; still tiny cost
      timeout: Duration.seconds(15), // API Gateway HTTP APIs time out at 30s anyway
      logGroup,
      environment: {
        STORAGE: 'dynamodb',
        DYNAMODB_TABLE: table.tableName,
        // Only the parameter NAME; the value is read at runtime with decryption.
        MCP_API_KEY_PARAMETER: props.apiKeyParameterName,
        LOG_LEVEL: 'info',
        RATE_LIMIT_PER_MINUTE: '120',
        TRUST_PROXY: '1', // API Gateway is one proxy hop
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        // ESM output, because the code uses import.meta.url. The banner gives
        // CommonJS dependencies (express, ...) a working `require`.
        format: OutputFormat.ESM,
        target: 'node22',
        mainFields: ['module', 'main'],
        banner:
          "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
        // Native SQLite addon: only loaded when STORAGE=sqlite, never on Lambda.
        externalModules: ['better-sqlite3'],
        // Bundle our pinned AWS SDK version instead of relying on the runtime's copy.
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
      },
    });

    table.grantReadWriteData(fn);
    apiKeyParameter.grantRead(fn);

    // --- API Gateway HTTP API ---
    const api = new HttpApi(this, 'McpApi', {
      apiName: 'issue-tracker-mcp',
      description: 'Issue Tracker MCP server (Streamable HTTP)',
      createDefaultStage: false, // we create it below, with throttling
    });

    const throttle = props.throttle ?? { rateLimit: 10, burstLimit: 20 };
    new HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle,
    });

    const integration = new HttpLambdaIntegration('McpIntegration', fn);
    // Only these routes reach Lambda; anything else is a 404 from API Gateway,
    // which costs nothing in Lambda time.
    api.addRoutes({
      path: '/mcp',
      methods: [HttpMethod.POST, HttpMethod.GET, HttpMethod.DELETE],
      integration,
    });
    api.addRoutes({ path: '/health', methods: [HttpMethod.GET], integration });

    // --- Optional monthly budget alert ---
    if (props.budgetEmail) {
      const subscribers = [{ subscriptionType: 'EMAIL', address: props.budgetEmail }];
      const notify = (notificationType: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
        notification: {
          notificationType,
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers,
      });
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: 'issue-tracker-mcp-monthly',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.monthlyBudgetUsd ?? 10, unit: 'USD' },
        },
        notificationsWithSubscribers: [notify('ACTUAL', 80), notify('FORECASTED', 100)],
      });
    }

    // --- Outputs ---
    new CfnOutput(this, 'McpEndpoint', {
      value: `${api.apiEndpoint}/mcp`,
      description: 'URL for MCP clients (POST, Authorization: Bearer <key>)',
    });
    new CfnOutput(this, 'HealthUrl', { value: `${api.apiEndpoint}/health` });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
  }
}
