/**
 * Environment configuration, validated once at startup.
 *
 * Design decision: parse `process.env` through a Zod schema and fail fast with
 * a readable message. A typo such as STORAGE=dynamo should stop the process at
 * boot, not surface as a confusing error on the first tool call.
 *
 * Later phases extend this with the HTTP port, API key and DynamoDB table name.
 */
import { z } from 'zod';
import { ConfigError } from './lib/errors.js';

const ConfigSchema = z.object({
  STORAGE: z.enum(['sqlite', 'dynamodb']).default('sqlite'),
  SQLITE_PATH: z.string().min(1).default('./data/issues.db'),
});

export interface AppConfig {
  storage: 'sqlite' | 'dynamodb';
  sqlitePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration: ${details}`);
  }
  return {
    storage: parsed.data.STORAGE,
    sqlitePath: parsed.data.SQLITE_PATH,
  };
}
