/**
 * DynamoDB repository tests, run against DynamoDB Local.
 *
 *   docker run -d -p 8000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
 *   DYNAMODB_ENDPOINT=http://localhost:8000 npm test
 *
 * Without DYNAMODB_ENDPOINT these tests are skipped, so `npm test` still works
 * without Docker. CI always sets it (DynamoDB Local runs as a service container).
 *
 * Every test gets its own freshly created table, so tests are independent.
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DynamoIssueRepository } from '../../src/db/dynamodb/DynamoIssueRepository.js';
import { createIssueTable, deleteIssueTable } from '../../src/db/dynamodb/table.js';
import { createRepository } from '../../src/db/index.js';
import { describeRepositoryContract } from './repositoryContract.js';

const endpoint = process.env.DYNAMODB_ENDPOINT;

const admin = new DynamoDBClient({
  endpoint: endpoint ?? 'http://localhost:8000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

afterAll(() => {
  admin.destroy();
});

/** New table + repository; closing the repository drops the table. */
async function freshRepository(
  options: { now?: () => Date; pageSize?: number } = {},
): Promise<DynamoIssueRepository> {
  const tableName = `issues-test-${randomUUID()}`;
  await createIssueTable(admin, tableName);
  const repo = DynamoIssueRepository.create({ tableName, endpoint, ...options });

  let dropped = false;
  const close = repo.close.bind(repo);
  repo.close = async () => {
    if (!dropped) {
      dropped = true;
      await deleteIssueTable(admin, tableName);
    }
    await close();
  };
  return repo;
}

if (endpoint) {
  // 1. The shared contract, with default paging...
  describeRepositoryContract('DynamoDB Local', (now) => freshRepository({ now }));

  // ...and with 1-item pages, so every query must follow pagination correctly.
  describeRepositoryContract('DynamoDB Local (1-item pages)', (now) =>
    freshRepository({ now, pageSize: 1 }),
  );

  // 2. Behaviour specific to the DynamoDB implementation.
  describe('DynamoIssueRepository specifics', () => {
    it('deletes an issue with more comments than one BatchWrite (25) can hold', async () => {
      const repo = await freshRepository();
      const issue = await repo.createIssue({ title: 't', description: 'd', priority: 'low' });
      for (let i = 0; i < 30; i++) {
        await repo.addComment({ issueId: issue.id, author: 'bot', text: `comment ${i}` });
      }
      expect(await repo.listComments(issue.id)).toHaveLength(30);

      await repo.deleteIssue(issue.id);

      expect(await repo.getIssue(issue.id)).toBeNull();
      expect(await repo.listComments(issue.id)).toEqual([]);
      await repo.close();
    }, 30_000);

    it('finds filtered matches beyond the first page', async () => {
      const repo = await freshRepository({ pageSize: 2 });
      const match = await repo.createIssue({ title: 'needle', description: 'd', priority: 'high' });
      for (let i = 0; i < 5; i++) {
        await repo.createIssue({ title: `hay ${i}`, description: 'd', priority: 'low' });
      }
      // The only match is the OLDEST issue, i.e. on the last page newest-first.
      expect((await repo.listIssues({ priority: 'high' })).map((i) => i.id)).toEqual([match.id]);
      expect((await repo.searchIssues('needle')).map((i) => i.id)).toEqual([match.id]);
      await repo.close();
    });

    it('is created by the factory when STORAGE=dynamodb', async () => {
      const tableName = `issues-test-${randomUUID()}`;
      await createIssueTable(admin, tableName);
      const repo = await createRepository(
        loadConfig({ STORAGE: 'dynamodb', DYNAMODB_TABLE: tableName, DYNAMODB_ENDPOINT: endpoint }),
      );
      expect(repo).toBeInstanceOf(DynamoIssueRepository);
      expect((await repo.getSummary()).total).toBe(0);
      await repo.close();
      await deleteIssueTable(admin, tableName);
    });
  });
} else {
  describe.skip('DynamoDB repository (set DYNAMODB_ENDPOINT to run against DynamoDB Local)', () => {
    it('contract suite', () => undefined);
  });
}
