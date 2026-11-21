/**
 * DynamoDB single-table design for issues and comments.
 *
 * Why one table? In DynamoDB you design for ACCESS PATTERNS, not entities.
 * Keeping an issue and its comments in the same partition means "issue + all
 * comments" is one Query, and deleting an issue finds everything to delete in
 * one place.
 *
 *  Item      pk               sk                              Notes
 *  -------   --------------   -----------------------------   ---------------------------
 *  Issue     ISSUE#<id>       META                            + GSI keys below
 *  Comment   ISSUE#<id>       COMMENT#<createdAt>#<cmtId>     sorted oldest → newest
 *
 *  GSI        pk                 sk                 Serves
 *  --------   ----------------   ----------------   -------------------------------------
 *  gsi1       ISSUES             <createdAt>#<id>   list all issues newest first, search,
 *                                                   summary, createdAfter
 *  gsi2       STATUS#<status>    <createdAt>#<id>   list by status (the most common filter)
 *
 * Trade-off: gsi1 puts every issue in one partition ("ISSUES"). A single
 * partition handles ~3,000 reads/s and 1,000 writes/s, which is far beyond a
 * team issue tracker. At larger scale you would shard the key
 * (ISSUES#0..ISSUES#9) and merge the results.
 *
 * This file is used by tests and the local setup script. The production table
 * is defined in infra/ (CDK) with the same key names, kept in sync by the
 * contract tests running against both.
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

export const KEYS = {
  pk: 'pk',
  sk: 'sk',
  gsi1: { name: 'gsi1', pk: 'gsi1pk', sk: 'gsi1sk' },
  gsi2: { name: 'gsi2', pk: 'gsi2pk', sk: 'gsi2sk' },
} as const;

export const META_SK = 'META';
export const ALL_ISSUES_PK = 'ISSUES';
export const COMMENT_SK_PREFIX = 'COMMENT#';

export const issuePk = (id: string): string => `ISSUE#${id}`;
export const statusPk = (status: string): string => `STATUS#${status}`;
/** Sort key shared by both GSIs: ISO timestamps sort chronologically as strings. */
export const createdSk = (createdAt: string, id: string): string => `${createdAt}#${id}`;
export const commentSk = (createdAt: string, id: string): string =>
  `${COMMENT_SK_PREFIX}${createdAt}#${id}`;

/** Create the table (on-demand billing) and wait until it is ACTIVE. */
export async function createIssueTable(client: DynamoDBClient, tableName: string): Promise<void> {
  const string = (name: string) => ({ AttributeName: name, AttributeType: 'S' as const });
  const gsi = (index: { name: string; pk: string; sk: string }) => ({
    IndexName: index.name,
    KeySchema: [
      { AttributeName: index.pk, KeyType: 'HASH' as const },
      { AttributeName: index.sk, KeyType: 'RANGE' as const },
    ],
    Projection: { ProjectionType: 'ALL' as const },
  });

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        string(KEYS.pk),
        string(KEYS.sk),
        string(KEYS.gsi1.pk),
        string(KEYS.gsi1.sk),
        string(KEYS.gsi2.pk),
        string(KEYS.gsi2.sk),
      ],
      KeySchema: [
        { AttributeName: KEYS.pk, KeyType: 'HASH' },
        { AttributeName: KEYS.sk, KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [gsi(KEYS.gsi1), gsi(KEYS.gsi2)],
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: tableName });
}

export async function deleteIssueTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: tableName }));
}
