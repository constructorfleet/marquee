import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { getSeerrConfig, requestMovie, requestRoute, type Requester } from '../seerr/client.js';

// The signed-in user as the request service knows them.
export function requesterFor(user: { id: number; isAdmin: boolean }): Requester {
  const ids = db
    .select({ plexId: users.plexId, jellyfinId: users.jellyfinId, embyId: users.embyId })
    .from(users)
    .where(eq(users.id, user.id))
    .get();
  return { isAdmin: user.isAdmin, plexId: ids?.plexId ?? null, jellyfinId: ids?.jellyfinId ?? null, embyId: ids?.embyId ?? null };
}

export async function requestRoutes(app: FastifyInstance) {
  // Forward a movie request to the configured Overseerr/Jellyseerr/Ombi instance,
  // as the requester's own account there (see requestRoute).
  app.post(
    '/api/requests',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const cfg = getSeerrConfig();
      if (!cfg) return reply.code(503).send({ error: 'No request service is configured — ask your admin' });
      const parsed = z.object({ tmdbId: z.number().int().positive() }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
      try {
        const route = await requestRoute(cfg, requesterFor(request.user!));
        if (!route.allowed) return reply.code(403).send({ error: route.reason });
        await requestMovie(cfg, parsed.data.tmdbId, route.asSeerrUser);
        return { ok: true };
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'Request failed' });
      }
    },
  );
}
