/**
 * Create the issues table in DynamoDB Local, for running the server locally
 * with STORAGE=dynamodb:
 *
 *   docker run -d -p 8000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -sharedDb
 *   DYNAMODB_ENDPOINT=http://localhost:8000 DYNAMODB_TABLE=issues npm run dynamodb:create-table
 *   STORAGE=dynamodb DYNAMODB_ENDPOINT=http://localhost:8000 DYNAMODB_TABLE=issues npm run dev:stdio
 *
 * On AWS the table is created by CDK (infra/), never by this script.
 */
import { DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import { createIssueTable } from '../src/db/dynamodb/table.js';

const endpoint = process.env.DYNAMODB_ENDPOINT;
const tableName = process.env.DYNAMODB_TABLE ?? 'issues';

if (!endpoint) {
  console.error(
    'Set DYNAMODB_ENDPOINT (e.g. http://localhost:8000). This script is for DynamoDB Local only.',
  );
  process.exit(1);
}

const client = new DynamoDBClient({
  endpoint,
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

try {
  await createIssueTable(client, tableName);
  console.log(`Created table "${tableName}" at ${endpoint}.`);
} catch (err) {
  if (err instanceof ResourceInUseException) {
    console.log(`Table "${tableName}" already exists at ${endpoint}.`);
  } else {
    throw err;
  }
} finally {
  client.destroy();
}
