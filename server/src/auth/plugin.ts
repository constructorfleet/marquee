import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { getSetting } from '../settings.js';

export interface SessionUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

const COOKIE_NAME = 'marquee_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days (absolute cap)
// Only rewrite lastSeenAt when it's this stale, so an active session doesn't
// take a DB write on every single request.
const LAST_SEEN_THROTTLE_MS = 60 * 1000;

// Prune expired rows at most this often; they're filtered out at read time
// anyway, so this is only about keeping the table from growing forever.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPrunedAt = 0;

// Idle window for a session, in ms, based on the account's role.
export function idleLimitMs(isAdmin: boolean): number {
  return (isAdmin ? config.adminIdleMinutes : config.userIdleMinutes) * 60 * 1000;
}

// The admin-configured app.url, validated. Null when unset or unusable — the
// one URL for this instance that no request header can influence, so WebAuthn
// origins and OAuth redirect targets must come from here rather than Host,
// which the client picks and can also malform into a URL parse throw.
function appUrl(): URL | null {
  const raw = getSetting('app.url')?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// For building links back to this instance; keeps any subpath, no trailing slash.
export function publicBaseUrl(): string | null {
  const url = appUrl();
  return url ? url.href.replace(/\/+$/, '') : null;
}

// scheme://host[:port] — what a WebAuthn origin check needs; a path is invalid there.
export function publicOrigin(): string | null {
  return appUrl()?.origin ?? null;
}

// Whether to mark cookies Secure. A TLS-terminating proxy that forgets
// X-Forwarded-Proto makes request.protocol read "http" on an https site, which
// would hand out the session cookie without Secure; app.url is the scheme we
// already trust elsewhere, so fall back to the header only when it's unset.
export function cookieSecure(request: FastifyRequest): boolean {
  const origin = publicOrigin();
  if (origin) return origin.startsWith('https:');
  return request.protocol === 'https';
}

// Delete sessions past their absolute expiry. Called opportunistically on
// sign-in rather than from the scheduler, so it never needs its own timer.
export function pruneExpiredSessions(): number {
  lastPrunedAt = Date.now();
  return db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run().changes;
}

export async function createSession(reply: FastifyReply, userId: number) {
  const request = reply.request;
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  // This browser is being handed a new session, so whatever it held before is
  // dead weight — revoke it instead of leaving an orphan row that still works.
  const previous = request.cookies[COOKIE_NAME] ? request.unsignCookie(request.cookies[COOKIE_NAME]) : null;
  if (previous?.valid && previous.value) {
    db.delete(sessions).where(eq(sessions.token, previous.value)).run();
  }
  db.insert(sessions)
    .values({ token, userId, expiresAt: new Date(now.getTime() + SESSION_TTL_MS), lastSeenAt: now })
    .run();
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    secure: cookieSecure(request),
    maxAge: SESSION_TTL_MS / 1000,
  });
  if (now.getTime() - lastPrunedAt > PRUNE_INTERVAL_MS) pruneExpiredSessions();
}

// Sign the user out everywhere except the browser that asked. Used after a
// password change, where the point is to evict whoever else had a session.
export function revokeOtherSessions(request: FastifyRequest, userId: number): number {
  const raw = request.cookies[COOKIE_NAME];
  const unsigned = raw ? request.unsignCookie(raw) : null;
  const keep = unsigned?.valid && unsigned.value ? unsigned.value : null;
  return db
    .delete(sessions)
    .where(keep ? and(eq(sessions.userId, userId), ne(sessions.token, keep)) : eq(sessions.userId, userId))
    .run().changes;
}

export function destroySession(request: FastifyRequest, reply: FastifyReply) {
  const raw = request.cookies[COOKIE_NAME];
  if (raw) {
    const unsigned = request.unsignCookie(raw);
    if (unsigned.valid && unsigned.value) {
      db.delete(sessions).where(eq(sessions.token, unsigned.value)).run();
    }
  }
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    const raw = request.cookies[COOKIE_NAME];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const token = unsigned.value;
    const now = new Date();
    const row = db
      .select({
        id: users.id,
        username: users.username,
        isAdmin: users.isAdmin,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, now)))
      .get();
    if (!row) return;

    // Idle auto-logout: if the session has gone untouched longer than the
    // role's window, revoke it and clear the cookie instead of authenticating.
    const lastSeen = row.lastSeenAt ?? now;
    if (now.getTime() - lastSeen.getTime() > idleLimitMs(row.isAdmin)) {
      db.delete(sessions).where(eq(sessions.token, token)).run();
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return;
    }

    request.user = { id: row.id, username: row.username, isAdmin: row.isAdmin };
    // Refresh activity, throttled to avoid a write per request.
    if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.token, token)).run();
    }
  });
});

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
  if (!request.user.isAdmin) return reply.code(403).send({ error: 'Admin access required' });
}
