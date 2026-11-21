/**
 * Environment configuration, validated once at startup.
 *
 * Design decision: parse `process.env` through Zod schemas and fail fast with
 * a readable message. A typo such as STORAGE=dynamo should stop the process at
 * boot, not surface as a confusing error on the first tool call.
 *
 * Config is split: `loadConfig()` is what every entry point needs (storage,
 * logging); `loadHttpConfig()` adds what only the HTTP server needs (port,
 * API key, limits), so the stdio server doesn't demand an API key.
 */
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigError } from './lib/errors.js';
import { LOG_LEVELS, type LogLevel } from './lib/logger.js';

/**
 * Default DB location: <project root>/data/issues.db, as an ABSOLUTE path.
 * Clients like Claude Desktop start the server with an unpredictable working
 * directory (often "/"), so a relative default would put the database in a
 * random place or fail. `..` from this file is the project root both when run
 * from src/ (tsx) and from dist/ (compiled).
 */
const DEFAULT_SQLITE_PATH = fileURLToPath(new URL('../data/issues.db', import.meta.url));

/** Minimum API key length: forces something generated, not "secret123". */
export const MIN_API_KEY_LENGTH = 32;

const ConfigSchema = z
  .object({
    STORAGE: z.enum(['sqlite', 'dynamodb']).default('sqlite'),
    SQLITE_PATH: z.string().min(1).default(DEFAULT_SQLITE_PATH),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    /** DynamoDB table name (required when STORAGE=dynamodb). */
    DYNAMODB_TABLE: z.string().min(3).max(255).optional(),
    /** DynamoDB Local endpoint for development, e.g. http://localhost:8000. Unset on AWS. */
    DYNAMODB_ENDPOINT: z.url().optional(),
    /** Set automatically by Lambda; needed locally only with real AWS. */
    AWS_REGION: z.string().min(1).optional(),
  })
  .refine((env) => env.STORAGE !== 'dynamodb' || env.DYNAMODB_TABLE !== undefined, {
    message: 'DYNAMODB_TABLE is required when STORAGE=dynamodb',
    path: ['DYNAMODB_TABLE'],
  });

const HttpConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  /** 127.0.0.1 by default: reachable only from this machine unless you opt in. */
  HOST: z.string().min(1).default('127.0.0.1'),
  MCP_API_KEY: z
    .string({ error: 'MCP_API_KEY is required for the HTTP server' })
    .min(MIN_API_KEY_LENGTH, `MCP_API_KEY must be at least ${MIN_API_KEY_LENGTH} characters`),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(102_400),
  /** Comma-separated Host header allow-list (DNS-rebinding protection). */
  ALLOWED_HOSTS: z.string().optional(),
  /** Express "trust proxy" hops, so rate limiting sees the real client IP behind a proxy. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

export interface AppConfig {
  storage: 'sqlite' | 'dynamodb';
  sqlitePath: string;
  logLevel: LogLevel;
  dynamodb?: {
    tableName: string;
    endpoint?: string | undefined;
    region?: string | undefined;
  };
}

export interface HttpConfig {
  port: number;
  host: string;
  apiKey: string;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  allowedHosts: string[] | undefined;
  trustProxy: number;
}

function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.output<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Messages name the variable but never echo its value (it may be a secret).
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const data = parseEnv(ConfigSchema, env);
  return {
    storage: data.STORAGE,
    sqlitePath: data.SQLITE_PATH,
    logLevel: data.LOG_LEVEL,
    ...(data.DYNAMODB_TABLE !== undefined && {
      dynamodb: {
        tableName: data.DYNAMODB_TABLE,
        endpoint: data.DYNAMODB_ENDPOINT,
        region: data.AWS_REGION,
      },
    }),
  };
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const data = parseEnv(HttpConfigSchema, env);
  const allowedHosts = data.ALLOWED_HOSTS?.split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return {
    port: data.PORT,
    host: data.HOST,
    apiKey: data.MCP_API_KEY,
    rateLimitPerMinute: data.RATE_LIMIT_PER_MINUTE,
    maxBodyBytes: data.MAX_BODY_BYTES,
    allowedHosts: allowedHosts && allowedHosts.length > 0 ? allowedHosts : undefined,
    trustProxy: data.TRUST_PROXY,
  };
}
