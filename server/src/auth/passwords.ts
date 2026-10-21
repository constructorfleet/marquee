import crypto from 'node:crypto';

// Stored hashes are self-describing so the cost can be raised later without
// invalidating anyone's password: `scrypt2:<N>:<r>:<p>:<salt>:<hash>`. The
// original parameterless `scrypt:<salt>:<hash>` (Node's defaults, N=2^14) still
// verifies forever; needsRehash marks it for an upgrade on the next successful
// sign-in, which is the only moment the plaintext is available.

const SCHEME = 'scrypt2';
const KEYLEN = 64;
const COST = { N: 2 ** 17, r: 8, p: 1 }; // OWASP 2024 guidance for scrypt
const LEGACY_COST = { N: 2 ** 14, r: 8, p: 1 }; // Node's scryptSync defaults

// scrypt needs 128*N*r bytes; Node's default maxmem (32 MB) is below that from
// N=2^16 up, and refuses rather than allocating.
function scryptOptions(cost: { N: number; r: number; p: number }): crypto.ScryptOptions {
  return { ...cost, maxmem: Math.max(32 * 1024 * 1024, 256 * cost.N * cost.r) };
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEYLEN, scryptOptions(COST)).toString('hex');
  return `${SCHEME}:${COST.N}:${COST.r}:${COST.p}:${salt}:${hash}`;
}

interface Parsed {
  cost: { N: number; r: number; p: number };
  salt: string;
  hash: string;
  current: boolean;
}

// A hash from a corrupted or hostile row must not be able to ask for an
// arbitrarily large allocation, so the parsed cost is bounded.
const MAX_N = 2 ** 20;

function parse(stored: string): Parsed | null {
  const parts = stored.split(':');
  if (parts[0] === SCHEME && parts.length === 6) {
    const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
    const cost = { N: Number(n), r: Number(r), p: Number(p) };
    const sane =
      Number.isInteger(cost.N) && cost.N > 1 && cost.N <= MAX_N && (cost.N & (cost.N - 1)) === 0 &&
      Number.isInteger(cost.r) && cost.r > 0 && cost.r <= 32 &&
      Number.isInteger(cost.p) && cost.p > 0 && cost.p <= 16;
    if (!sane || !salt || !hash) return null;
    const current = cost.N === COST.N && cost.r === COST.r && cost.p === COST.p;
    return { cost, salt, hash, current };
  }
  if (parts[0] === 'scrypt' && parts.length === 3 && parts[1] && parts[2]) {
    return { cost: LEGACY_COST, salt: parts[1], hash: parts[2], current: false };
  }
  return null;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    const candidate = crypto.scryptSync(password, parsed.salt, KEYLEN, scryptOptions(parsed.cost));
    const expected = Buffer.from(parsed.hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// True when `stored` verified but was written at a cost we no longer issue.
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !!parsed && !parsed.current;
}
