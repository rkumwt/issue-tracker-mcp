/**
 * Repository factory: picks the storage backend from configuration.
 *
 * Design decision: implementations are loaded with dynamic `import()`.
 * better-sqlite3 is a native C++ addon; on Lambda we run DynamoDB and never want
 * to load (or even bundle) it. Lazy imports keep each deployment target from
 * paying for the other backend's dependencies.
 */
import type { AppConfig } from '../config.js';
import { ConfigError } from '../lib/errors.js';
import type { IssueRepository } from './IssueRepository.js';

export type { IssueRepository } from './IssueRepository.js';

export async function createRepository(config: AppConfig): Promise<IssueRepository> {
  switch (config.storage) {
    case 'sqlite': {
      const { SqliteIssueRepository } = await import('./sqlite/SqliteIssueRepository.js');
      return SqliteIssueRepository.open(config.sqlitePath);
    }
    case 'dynamodb': {
      // loadConfig() guarantees this for STORAGE=dynamodb; checked again for type safety.
      if (!config.dynamodb)
        throw new ConfigError('DYNAMODB_TABLE is required when STORAGE=dynamodb');
      const { DynamoIssueRepository } = await import('./dynamodb/DynamoIssueRepository.js');
      return DynamoIssueRepository.create(config.dynamodb);
    }
  }
}
