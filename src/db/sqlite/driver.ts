/**
 * Loads the better-sqlite3 native driver on first use.
 *
 * Why not a normal `import Database from 'better-sqlite3'`?
 * The Lambda bundle (esbuild, ESM, one file) inlines this SQLite module even
 * though db/index.ts only loads it lazily, and it HOISTS every external import
 * to the top of the bundle. A static import of the native addon would then run
 * when Lambda loads the bundle, and fail with ERR_MODULE_NOT_FOUND, because the
 * addon is deliberately not shipped to Lambda (which uses DynamoDB).
 *
 * `createRequire()` is opaque to the bundler, so the driver is loaded only when
 * a SQLite repository is actually opened: always locally, never on Lambda.
 * infra/test/bundle.test.ts guards this by loading the bundle with no
 * node_modules available.
 */
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

const requireNative = createRequire(import.meta.url);

export function loadSqliteDriver(): typeof BetterSqlite3 {
  return requireNative('better-sqlite3') as typeof BetterSqlite3;
}
