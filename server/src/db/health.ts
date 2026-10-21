import type { DbHealth } from '@marquee/shared';
import { logger } from '../logger.js';
import { checkIntegrity } from './index.js';

// SQLite reports at most this many problems; the admin page shows the first few.
const MAX_PROBLEMS = 200;
const SHOWN_PROBLEMS = 50;

let health: DbHealth = { ok: null, checkedAt: null, durationMs: null, problemCount: 0, problems: [] };

// Runs at startup, daily from the scheduler, and on demand from the admin page.
// It reads the whole database, so it blocks for a moment on a large one.
export function runIntegrityCheck(): DbHealth {
  const started = Date.now();
  let problems: string[];
  try {
    problems = checkIntegrity(MAX_PROBLEMS);
  } catch (err) {
    // Bad enough damage makes the check itself fail.
    problems = [err instanceof Error ? err.message : String(err)];
  }
  health = {
    ok: problems.length === 0,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    problemCount: problems.length,
    problems: problems.slice(0, SHOWN_PROBLEMS),
  };
  if (health.ok) logger.info({ ms: health.durationMs }, 'database integrity check passed');
  else logger.error({ problemCount: problems.length, problems: problems.slice(0, 10) }, 'database integrity check FAILED');
  return health;
}

export function getDbHealth(): DbHealth {
  return health;
}

// True once a check has found damage (and none has passed since).
export function databaseHasProblems(): boolean {
  return health.ok === false;
}
