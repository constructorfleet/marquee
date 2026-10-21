import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { lists, pollOptions, polls, sessions, users, votes } from '../db/schema.js';
import { requireAdmin } from '../auth/plugin.js';
import { runIntegrityCheck } from '../db/health.js';
import { hashPassword } from '../auth/passwords.js';
import { uniqueUsername, usernameTaken } from '../auth/usernames.js';
import { getOptionCounts } from '../polls/service.js';
import { getFriends, getHomeUsers } from '../plex/plextv.js';
import { getJfConfig, listJfUsers } from '../jellyfin/client.js';
import { getPlexConfig } from '../settings.js';

function serializeUser(u: typeof users.$inferSelect, guestName: string | null = null) {
  return {
    id: u.id,
    username: u.username,
    isAdmin: u.isAdmin,
    hasPassword: !!u.passwordHash,
    plex: !!u.plexId,
    jellyfin: !!u.jellyfinId,
    emby: !!u.embyId,
    discord: !!u.discordId,
    oidc: !!u.oidcSub,
    guest: !!u.guestId,
    guestName,
    createdAt: u.createdAt,
  };
}

// Redoes a closed poll's winner once one vote is gone: votes cascade on user
// delete, winnerOptionId does not. 'tie' defers to closePoll's own tie-break.
function winnerWithoutVote(pollId: number, dropOptionId: number): number | null | 'tie' {
  const options = db.select({ id: pollOptions.id }).from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
  const counts = getOptionCounts(pollId);
  const left = (optionId: number) => (counts.get(optionId) ?? 0) - (optionId === dropOptionId ? 1 : 0);
  const max = Math.max(0, ...options.map((o) => left(o.id)));
  if (max === 0) return null;
  const top = options.filter((o) => left(o.id) === max);
  return top.length === 1 ? top[0]!.id : 'tie';
}

export async function adminUserRoutes(app: FastifyInstance) {
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => {
    // Guests' usernames are internal, so show the name each last voted under.
    const guestNames = new Map(
      db
        .select({ userId: votes.userId, name: votes.voterName })
        .from(votes)
        .where(isNotNull(votes.voterName))
        .orderBy(votes.createdAt)
        .all()
        .map((v) => [v.userId, v.name]),
    );
    return db
      .select()
      .from(users)
      .orderBy(sql`lower(${users.username})`)
      .all()
      .map((u) => serializeUser(u, guestNames.get(u.id) ?? null));
  });

  // Manually create a local account (username + password).
  app.post('/api/admin/users', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({
        username: z
          .string()
          .min(3, 'Username must be at least 3 characters')
          .max(32)
          .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, numbers, dots, dashes, and underscores'),
        password: z.string().min(8, 'Password must be at least 8 characters').max(200),
        isAdmin: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    if (usernameTaken(parsed.data.username)) return reply.code(409).send({ error: 'That username is already taken' });
    const user = db
      .insert(users)
      .values({
        username: parsed.data.username,
        passwordHash: hashPassword(parsed.data.password),
        isAdmin: parsed.data.isAdmin,
      })
      .returning()
      .get();
    return reply.code(201).send(serializeUser(user));
  });

  app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = z
      .object({
        isAdmin: z.boolean().optional(),
        password: z.string().min(8, 'Password must be at least 8 characters').max(200).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const user = db.select().from(users).where(eq(users.id, id)).get();
    if (!user) return reply.code(404).send({ error: 'User not found' });
    if (user.id === request.user!.id && parsed.data.isAdmin === false) {
      return reply.code(400).send({ error: 'You cannot remove your own admin role' });
    }
    db.update(users)
      .set({
        ...(parsed.data.isAdmin !== undefined ? { isAdmin: parsed.data.isAdmin } : {}),
        ...(parsed.data.password ? { passwordHash: hashPassword(parsed.data.password) } : {}),
      })
      .where(eq(users.id, id))
      .run();
    // A password reset must lock out anyone holding a stolen session for this
    // account, so revoke all of the user's existing sessions.
    if (parsed.data.password) db.delete(sessions).where(eq(sessions.userId, id)).run();
    return serializeUser(db.select().from(users).where(eq(users.id, id)).get()!);
  });

  app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const user = db.select().from(users).where(eq(users.id, id)).get();
    if (!user) return reply.code(404).send({ error: 'User not found' });
    if (user.id === request.user!.id) return reply.code(400).send({ error: 'You cannot delete your own account' });
    const pollCount = db.select({ c: sql<number>`count(*)` }).from(polls).where(eq(polls.createdBy, id)).get()!.c;
    if (pollCount > 0) {
      return reply.code(409).send({ error: `${user.username} created ${pollCount} poll(s) — delete those first` });
    }

    // Each closed poll they voted in loses that vote, so its frozen winner can
    // name an option that no longer leads — recompute before deleting.
    const closedVotes = db
      .select({ pollId: votes.pollId, optionId: votes.optionId, winnerOptionId: polls.winnerOptionId })
      .from(votes)
      .innerJoin(polls, eq(votes.pollId, polls.id))
      .where(and(eq(votes.userId, id), eq(polls.status, 'closed')))
      .all();
    const rewinners: { pollId: number; winnerOptionId: number | null }[] = [];
    const tied: number[] = [];
    for (const v of closedVotes) {
      const winner = winnerWithoutVote(v.pollId, v.optionId);
      if (winner === 'tie') tied.push(v.pollId);
      else if (winner !== v.winnerOptionId) rewinners.push({ pollId: v.pollId, winnerOptionId: winner });
    }
    if (tied.length) {
      return reply.code(409).send({
        error: `Deleting ${user.username} would leave ${tied.length} closed poll(s) tied — delete those polls first`,
      });
    }

    // Lists cascade from their owner, so a departing housemate's shared list
    // would vanish for everyone using it. Hand them to the acting admin instead.
    const reassigned = db
      .select({ name: lists.name })
      .from(lists)
      .where(and(eq(lists.ownerId, id), eq(lists.isShared, true)))
      .all()
      .map((l) => l.name);

    db.transaction((tx) => {
      for (const r of rewinners) {
        tx.update(polls).set({ winnerOptionId: r.winnerOptionId }).where(eq(polls.id, r.pollId)).run();
      }
      tx.update(lists)
        .set({ ownerId: request.user!.id })
        .where(and(eq(lists.ownerId, id), eq(lists.isShared, true)))
        .run();
      tx.delete(users).where(eq(users.id, id)).run();
    });
    return { reassignedLists: reassigned, recountedPolls: rewinners.length };
  });

  // Import Plex Home members and friends as Marquee accounts (like Overseerr's
  // user import). They sign in later with Plex and get matched by plex id.
  app.post('/api/admin/users/import-plex', { preHandler: requireAdmin }, async (_request, reply) => {
    const cfg = getPlexConfig();
    if (!cfg) return reply.code(503).send({ error: 'Plex is not configured' });
    // Existing accounts are found by Plex id. With a damaged index that lookup
    // misses them and every Plex user gets imported a second time, so check first.
    if (!runIntegrityCheck().ok) {
      return reply.code(409).send({
        error: 'The database check found problems, so importing is paused to avoid duplicate accounts — see the Admin overview',
      });
    }

    let candidates: { plexId: string; name: string }[];
    try {
      const [home, friends] = await Promise.all([
        getHomeUsers(cfg.token).catch(() => []),
        getFriends(cfg.token).catch(() => []),
      ]);
      candidates = [
        ...home.map((u) => ({ plexId: String(u.id), name: u.title })),
        ...friends.map((f) => ({ plexId: String(f.id), name: f.username || f.title || `plex-${f.id}` })),
      ];
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }

    const seen = new Set<string>();
    let imported = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      if (seen.has(candidate.plexId)) continue;
      seen.add(candidate.plexId);
      if (db.select({ id: users.id }).from(users).where(eq(users.plexId, candidate.plexId)).get()) {
        skipped++;
        continue;
      }
      db.insert(users)
        .values({ username: uniqueUsername(candidate.name), passwordHash: null, plexId: candidate.plexId })
        .run();
      imported++;
    }
    return { imported, skipped };
  });

  // The Jellyfin/Emby counterpart. With registration closed by default, this is
  // how a Jellyfin household gets accounts without letting anyone self-provision.
  app.post<{ Params: { kind: string } }>(
    '/api/admin/users/import/:kind',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const kind = request.params.kind;
      if (kind !== 'jellyfin' && kind !== 'emby') return reply.code(404).send({ error: 'Unknown media server' });
      if (!getJfConfig(kind)) return reply.code(503).send({ error: `${kind} is not configured` });
      // A damaged index makes the existing-account lookup miss, which would
      // import every user a second time.
      if (!runIntegrityCheck().ok) {
        return reply.code(409).send({
          error:
            'The database check found problems, so importing is paused to avoid duplicate accounts — see the Admin overview',
        });
      }

      let candidates: { id: string; name: string }[];
      try {
        candidates = await listJfUsers(kind);
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : `Could not reach ${kind}` });
      }

      const idColumn = kind === 'jellyfin' ? users.jellyfinId : users.embyId;
      const seen = new Set<string>();
      let imported = 0;
      let skipped = 0;
      for (const candidate of candidates) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        if (db.select({ id: users.id }).from(users).where(eq(idColumn, candidate.id)).get()) {
          skipped++;
          continue;
        }
        db.insert(users)
          .values({
            username: uniqueUsername(candidate.name),
            passwordHash: null,
            ...(kind === 'jellyfin' ? { jellyfinId: candidate.id } : { embyId: candidate.id }),
          })
          .run();
        imported++;
      }
      return { imported, skipped };
    },
  );
}
