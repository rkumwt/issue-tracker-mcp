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
    case 'dynamodb':
      // Implemented in phase 5.
      throw new ConfigError('STORAGE=dynamodb is not implemented yet (coming in phase 5).');
  }
}
