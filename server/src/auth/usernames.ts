import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

// Usernames are unique regardless of case — "Michael" and "michael" are the
// same account — while the spelling someone chose is kept for display.
// Comparisons go through SQLite's lower(), the same expression the unique
// index is built on, so the lookup and the rule always agree.
export function usernameIs(name: string) {
  return sql`lower(${users.username}) = lower(${name})`;
}

export function usernameTaken(name: string): boolean {
  return !!db.select({ id: users.id }).from(users).where(usernameIs(name)).get();
}

// A free username based on the preferred one: "Michael", else "Michael-2", "Michael-3"…
export function uniqueUsername(preferred: string, fallback = 'user'): string {
  const base = preferred.trim() || fallback;
  let username = base;
  for (let n = 2; usernameTaken(username); n++) username = `${base}-${n}`;
  return username;
}
