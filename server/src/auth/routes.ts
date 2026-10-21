import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { getOidcConfiguration, getOidcSettings, oidcRedirectUri } from './oidc.js';
import { config } from '../config.js';
import { encryptSecret } from '../crypto.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { authenticateJf, getJfConfig } from '../jellyfin/client.js';
import { logger } from '../logger.js';
import { buildAuthUrl, checkLoginPin, createLoginPin, getPlexAccount, hasServerAccess } from '../plex/plextv.js';
import { getPlexConfig, getSetting } from '../settings.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';
import { cookieSecure, createSession, destroySession, publicBaseUrl, requireUser, revokeOtherSessions } from './plugin.js';
import { recordFailure, recordSuccess, retryAfterSeconds, type ThrottleProvider } from './throttle.js';
import { uniqueUsername, usernameIs, usernameTaken } from './usernames.js';

const credentialsSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(32, 'Username must be at most 32 characters')
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, numbers, dots, dashes, and underscores'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

// Per-IP brute-force protection on credential endpoints. Only a speed bump
// behind a reverse proxy, where the client can pick its own request.ip (see
// config.ts) — the per-account backoff in throttle.js is the real control.
const AUTH_RATE = { rateLimit: { max: 10, timeWindow: '1 minute' } };
// The Plex login page polls every 3s (20/min); leave room for a few people on one connection.
const PLEX_POLL_RATE = { rateLimit: { max: 120, timeWindow: '1 minute' } };
const PLEX_PIN_COOKIE = 'marquee_plex_pin';
// The login page gives up polling after 5 minutes; a PIN binding that outlives
// the attempt is just a longer window for a phished approval to be collected.
const PLEX_PIN_COOKIE_MAX_AGE = 5 * 60;

// A throwaway hash so login spends the same scrypt time whether or not the
// username exists — closes the timing side channel that would otherwise let an
// attacker enumerate valid local accounts. Written at the current cost, so a
// failed login against a legacy (cheaper) hash has to be padded to match it.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function userCount(): number {
  return db.select({ c: sql<number>`count(*)` }).from(users).get()!.c;
}

// Closed unless an admin opened it. A self-registered account can immediately
// read who is watching what, the member roster and the whole catalogue, so an
// exposed instance must not hand that out by default; first-run setup creates
// the admin without needing this. Gates new Jellyfin/Emby accounts too — see
// the find-or-create branch below.
export function registrationOpen(): boolean {
  return getSetting('auth.allowRegistration') === 'true';
}

// Refuse early when this account is in backoff. The counter covers usernames
// that don't exist too, so the response is identical either way and still
// can't be used to enumerate accounts.
function throttled(provider: ThrottleProvider, username: string, reply: FastifyReply): boolean {
  const retryAfter = retryAfterSeconds(provider, username);
  if (retryAfter === 0) return false;
  reply
    .code(429)
    .header('retry-after', String(retryAfter))
    .send({ error: `Too many failed sign-in attempts — try again in ${describeWait(retryAfter)}` });
  return true;
}

function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/status', async (request) => {
    return {
      needsSetup: userCount() === 0,
      user: request.user,
      idleTimeoutMinutes: request.user
        ? request.user.isAdmin
          ? config.adminIdleMinutes
          : config.userIdleMinutes
        : null,
      authMethods: {
        plex: !!getPlexConfig(),
        jellyfin: !!getJfConfig('jellyfin'),
        emby: !!getJfConfig('emby'),
        oidc: !!getOidcSettings(),
        oidcLabel: getOidcSettings()?.label ?? null,
        allowRegistration: registrationOpen(),
      },
    };
  });

  // First-run: create the initial admin account.
  app.post('/api/auth/setup', { config: AUTH_RATE }, async (request, reply) => {
    if (userCount() > 0) return reply.code(403).send({ error: 'Setup has already been completed' });
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const user = db
      .insert(users)
      .values({
        username: parsed.data.username,
        passwordHash: hashPassword(parsed.data.password),
        isAdmin: true,
      })
      .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin })
      .get();
    await createSession(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/register', { config: AUTH_RATE }, async (request, reply) => {
    if (userCount() === 0) return reply.code(400).send({ error: 'Use setup to create the first admin account' });
    if (!registrationOpen()) {
      return reply.code(403).send({ error: 'Registration is disabled on this server — ask your admin for an account' });
    }
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    if (usernameTaken(parsed.data.username)) return reply.code(409).send({ error: 'That username is already taken' });
    const user = db
      .insert(users)
      .values({ username: parsed.data.username, passwordHash: hashPassword(parsed.data.password) })
      .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin })
      .get();
    await createSession(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', { config: AUTH_RATE }, async (request, reply) => {
    const parsed = z.object({ username: z.string(), password: z.string() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    if (throttled('local', parsed.data.username, reply)) return reply;
    const user = db.select().from(users).where(usernameIs(parsed.data.username)).get();
    // Always verify against a hash (a dummy one when the account is missing or
    // has no local password) so response time doesn't reveal which usernames exist.
    const passwordOk = verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user?.passwordHash || !passwordOk) {
      // A legacy hash is cheap enough to answer noticeably sooner than the
      // dummy, which would give the account away; spend the difference.
      if (user?.passwordHash && needsRehash(user.passwordHash)) {
        verifyPassword(parsed.data.password, DUMMY_PASSWORD_HASH);
      }
      recordFailure('local', parsed.data.username);
      logger.warn({ username: parsed.data.username, ip: request.ip }, 'failed login attempt');
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    recordSuccess('local', parsed.data.username);
    // The only moment the plaintext exists: move an old-cost hash up to the
    // current one. Failing here must not fail the sign-in.
    if (needsRehash(user.passwordHash)) {
      try {
        db.update(users).set({ passwordHash: hashPassword(parsed.data.password) }).where(eq(users.id, user.id)).run();
      } catch (err) {
        logger.warn({ userId: user.id, err }, 'could not upgrade password hash cost');
      }
    }
    await createSession(reply, user.id);
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });

  // Self-service password change. Needs the current password, and signs every
  // other browser out so a stolen session can't outlive the rotation.
  app.post('/api/auth/password', { config: AUTH_RATE, preHandler: requireUser }, async (request, reply) => {
    const parsed = z
      .object({ currentPassword: z.string(), newPassword: credentialsSchema.shape.password })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const user = db.select().from(users).where(eq(users.id, request.user!.id)).get();
    if (!user?.passwordHash) {
      return reply.code(409).send({ error: 'This account signs in without a password — ask your admin to set one' });
    }
    if (throttled('local', user.username, reply)) return reply;
    if (!verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
      recordFailure('local', user.username);
      logger.warn({ userId: user.id, ip: request.ip }, 'failed password change attempt');
      return reply.code(401).send({ error: 'That current password is not right' });
    }
    recordSuccess('local', user.username);
    db.update(users).set({ passwordHash: hashPassword(parsed.data.newPassword) }).where(eq(users.id, user.id)).run();
    const revoked = revokeOtherSessions(request, user.id);
    logger.info({ userId: user.id, revoked }, 'password changed');
    return { ok: true, revokedSessions: revoked };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    destroySession(request, reply);
    return reply.code(204).send();
  });

  // OIDC step 1: stash PKCE/state in a short-lived signed cookie and redirect to the provider.
  // Rate-limited like the credential endpoints: each call makes the server fetch
  // the provider's discovery document.
  app.get('/api/auth/oidc/start', { config: AUTH_RATE }, async (_request, reply) => {
    const fail = (message: string) => reply.redirect(`/login?oidcError=${encodeURIComponent(message)}`);
    if (userCount() === 0) return fail('Complete first-run setup first');
    try {
      const config = await getOidcConfiguration();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const authUrl = oidc.buildAuthorizationUrl(config, {
        redirect_uri: oidcRedirectUri(),
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      reply.setCookie('marquee_oidc', JSON.stringify({ state, nonce, codeVerifier }), {
        path: '/api/auth/oidc',
        httpOnly: true,
        sameSite: 'lax',
        signed: true,
        secure: cookieSecure(reply.request),
        maxAge: 600,
      });
      return reply.redirect(authUrl.href);
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'OIDC sign-in failed');
    }
  });

  // OIDC step 2: the provider redirects back here with a code; exchange and sign in.
  app.get('/api/auth/oidc/callback', { config: AUTH_RATE }, async (request, reply) => {
    const fail = (message: string) => reply.redirect(`/login?oidcError=${encodeURIComponent(message)}`);
    try {
      const raw = request.cookies['marquee_oidc'];
      const unsigned = raw ? request.unsignCookie(raw) : null;
      reply.clearCookie('marquee_oidc', { path: '/api/auth/oidc' });
      if (!unsigned?.valid || !unsigned.value) return fail('Sign-in session expired — try again');
      const { state, nonce, codeVerifier } = JSON.parse(unsigned.value) as {
        state: string;
        nonce: string;
        codeVerifier: string;
      };

      const config = await getOidcConfiguration();
      const currentUrl = new URL(request.raw.url!, oidcRedirectUri());
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
      });
      const claims = tokens.claims();
      if (!claims?.sub) return fail('The identity provider returned no subject');

      let user = db.select().from(users).where(eq(users.oidcSub, claims.sub)).get();
      if (!user) {
        const email = typeof claims.email === 'string' ? claims.email : null;
        const preferred =
          (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
          (typeof claims.name === 'string' && claims.name) ||
          email?.split('@')[0] ||
          `user-${claims.sub.slice(0, 8)}`;
        user = db
          .insert(users)
          .values({ username: uniqueUsername(preferred), passwordHash: null, oidcSub: claims.sub })
          .returning()
          .get();
      }
      await createSession(reply, user.id);
      return reply.redirect('/');
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'OIDC sign-in failed');
    }
  });

  // Username/password sign-in against the configured Jellyfin or Emby server.
  for (const kind of ['jellyfin', 'emby'] as const) {
    const label = kind === 'jellyfin' ? 'Jellyfin' : 'Emby';
    app.post(`/api/auth/${kind}`, { config: AUTH_RATE }, async (request, reply) => {
      if (userCount() === 0) return reply.code(400).send({ error: 'Complete first-run setup first' });
      const parsed = z.object({ username: z.string().min(1), password: z.string() }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
      if (!getJfConfig(kind)) {
        return reply.code(503).send({ error: `${label} sign-in is not enabled on this server` });
      }
      // This endpoint is also a password oracle against the media server, so it
      // gets the same per-account backoff as local sign-in.
      if (throttled(kind, parsed.data.username, reply)) return reply;

      let account;
      try {
        account = await authenticateJf(kind, parsed.data.username, parsed.data.password);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sign-in failed';
        if (message === 'INVALID_CREDENTIALS') {
          recordFailure(kind, parsed.data.username);
          return reply.code(401).send({ error: 'Invalid username or password' });
        }
        return reply.code(502).send({ error: message });
      }
      recordSuccess(kind, parsed.data.username);

      const idColumn = kind === 'jellyfin' ? users.jellyfinId : users.embyId;
      let user = db.select().from(users).where(eq(idColumn, account.id)).get();
      if (!user) {
        // Configuring a Jellyfin/Emby server is also how library sync is set up,
        // so creating accounts here unasked would silently give everyone on that
        // server a way in. Minting one is registration, and obeys the setting.
        if (!registrationOpen()) {
          logger.warn({ provider: kind, account: account.name }, 'rejected new federated account: registration closed');
          return reply
            .code(403)
            .send({ error: `This server doesn't create accounts from ${label} sign-ins — ask your admin for an account` });
        }
        user = db
          .insert(users)
          .values({
            username: uniqueUsername(account.name),
            passwordHash: null,
            ...(kind === 'jellyfin' ? { jellyfinId: account.id } : { embyId: account.id }),
          })
          .returning()
          .get();
        logger.info({ userId: user.id, username: user.username, provider: kind }, 'new user created via federated sign-in');
      }
      await createSession(reply, user.id);
      return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
    });
  }

  // "Sign in with Plex" step 1: create a PIN and hand back the approval URL.
  // The PIN is bound to this browser with a short-lived signed cookie, so only
  // it can finish the sign-in (see step 2).
  app.post('/api/auth/plex/start', { config: AUTH_RATE }, async (request, reply) => {
    if (userCount() === 0) return reply.code(400).send({ error: 'Complete first-run setup before signing in with Plex' });
    try {
      const pin = await createLoginPin();
      // Only ask plex.tv to redirect back if we have an admin-configured URL to
      // redirect to. A Host-header-derived one would send the popup wherever the
      // request claimed to be for; without it, plex.tv just shows its own
      // confirmation page and the opener tab's polling finishes the sign-in.
      const baseUrl = publicBaseUrl();
      reply.setCookie(PLEX_PIN_COOKIE, String(pin.id), {
        path: '/api/auth/plex',
        httpOnly: true,
        sameSite: 'lax',
        signed: true,
        secure: cookieSecure(request),
        maxAge: PLEX_PIN_COOKIE_MAX_AGE,
      });
      // `code` goes to the client so it can be shown next to the Plex prompt:
      // a device-code flow can't tell an approval the user meant from one they
      // were phished into, and matching the code by eye is the only check left.
      return { pinId: pin.id, code: pin.code, authUrl: buildAuthUrl(pin.code, baseUrl ? `${baseUrl}/login?plexDone=1` : undefined) };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
  });

  // Step 2: the client polls this (every 3s) until the user approves the PIN in the Plex tab.
  app.post('/api/auth/plex/complete', { config: PLEX_POLL_RATE }, async (request, reply) => {
    const parsed = z.object({ pinId: z.number().int() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    // Only the browser that started this sign-in may finish it. Without this,
    // anyone who guessed another person's PIN id could collect their session.
    const raw = request.cookies[PLEX_PIN_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (!unsigned?.valid || unsigned.value !== String(parsed.data.pinId)) {
      return reply.code(403).send({ error: 'This Plex sign-in has expired or was started elsewhere — try again' });
    }

    let token: string | null;
    try {
      token = await checkLoginPin(parsed.data.pinId);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
    if (!token) return { pending: true };
    // The PIN is spent once plex.tv hands over a token, whatever happens next.
    reply.clearCookie(PLEX_PIN_COOKIE, { path: '/api/auth/plex' });

    const cfg = getPlexConfig();
    if (!cfg) return reply.code(503).send({ error: 'Plex is not configured on this server yet — ask your admin' });

    let account;
    try {
      account = await getPlexAccount(token);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
    let allowed;
    try {
      allowed = await hasServerAccess(cfg, token);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
    if (!allowed) {
      return reply.code(403).send({ error: 'Your Plex account does not have access to this Plex server' });
    }

    const user = upsertPlexUser(account, token);
    await createSession(reply, user.id);
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });

}

// Find-or-create the Marquee account for a plex.tv identity (regular or managed).
function upsertPlexUser(
  account: { id: number; username: string; thumb: string | null },
  token: string,
): typeof users.$inferSelect {
  const plexId = String(account.id);
  const storedToken = encryptSecret(token);
  const existing = db.select().from(users).where(eq(users.plexId, plexId)).get();
  if (existing) {
    db.update(users).set({ plexToken: storedToken, avatar: account.thumb }).where(eq(users.id, existing.id)).run();
    logger.info({ userId: existing.id }, 'plex sign-in');
    return existing;
  }
  // Plex usernames may collide with existing local accounts — pick a free variant.
  const username = uniqueUsername(account.username);
  const created = db
    .insert(users)
    .values({ username, passwordHash: null, plexId, plexToken: storedToken, avatar: account.thumb })
    .returning()
    .get();
  logger.info({ userId: created.id, username }, 'new user created via plex sign-in');
  return created;
}
