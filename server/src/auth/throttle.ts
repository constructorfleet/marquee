// Per-account failed-password backoff, the one brute-force control that does
// not depend on request.ip. Behind a reverse proxy the client's own
// X-Forwarded-For becomes request.ip (see config.ts), so the per-IP rate limit
// alone lets an attacker guess forever by rotating the header; this counter
// can't be rotated away because the attacker has to name the account to attack it.
//
// Deliberately in-memory and deliberately a cooldown, never a lock:
//   * the wait is capped (MAX_DELAY_MS), so no account is ever shut out;
//   * entries are forgotten after IDLE_FORGET_MS of quiet, and on any success;
//   * only password sign-in is gated — Plex, OIDC, and passkeys stay open, so
//     an operator always has another way into their own instance;
//   * a restart clears everything, which is the safe failure direction.
//
// Keys are namespaced per provider and normalised with toLowerCase() to match
// the lower() unique index that usernameIs() looks up with, so the rule and the
// account it guards can never disagree. Unknown usernames are counted too —
// that's what keeps a throttled response from revealing whether an account exists.

const FREE_ATTEMPTS = 5; // mistyping a password shouldn't cost a wait
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15 * 60 * 1000;
const IDLE_FORGET_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 10_000; // bound the map against username-rotating floods

interface Attempts {
  failures: number;
  lastFailureAt: number;
}

const attempts = new Map<string, Attempts>();

export type ThrottleProvider = 'local' | 'jellyfin' | 'emby';

function keyFor(provider: ThrottleProvider, username: string): string {
  return `${provider}:${username.trim().toLowerCase()}`;
}

function delayFor(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS - 1), MAX_DELAY_MS);
}

// Keeps a username-rotating flood from growing the map without bound: forget
// anything idle for an hour, then evict least-recent until back under the cap.
// recordFailure re-inserts on every write, so iteration order is recency order.
function evict(now: number) {
  for (const [key, entry] of attempts) {
    if (now - entry.lastFailureAt > IDLE_FORGET_MS) attempts.delete(key);
  }
  for (const key of attempts.keys()) {
    if (attempts.size < MAX_ENTRIES) break;
    attempts.delete(key);
  }
}

// Seconds the caller must wait before this account will accept another attempt,
// or 0 when it may proceed. Check before touching the database.
export function retryAfterSeconds(provider: ThrottleProvider, username: string): number {
  const entry = attempts.get(keyFor(provider, username));
  if (!entry) return 0;
  const waited = Date.now() - entry.lastFailureAt;
  if (waited > IDLE_FORGET_MS) return 0;
  const remaining = delayFor(entry.failures) - waited;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

export function recordFailure(provider: ThrottleProvider, username: string) {
  const now = Date.now();
  if (attempts.size >= MAX_ENTRIES) evict(now);
  const key = keyFor(provider, username);
  const entry = attempts.get(key);
  // A long-idle entry starts over rather than resuming at its old delay.
  const failures = entry && now - entry.lastFailureAt <= IDLE_FORGET_MS ? entry.failures + 1 : 1;
  attempts.delete(key);
  attempts.set(key, { failures, lastFailureAt: now });
}

export function recordSuccess(provider: ThrottleProvider, username: string) {
  attempts.delete(keyFor(provider, username));
}
