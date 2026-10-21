import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config, warnIfProxyTrustIsLoose } from './config.js';
import { logger } from './logger.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { adminRoutes } from './routes/admin.js';
import { adminUserRoutes } from './routes/adminUsers.js';
import { collectionRoutes } from './routes/collections.js';
import { discordRoutes } from './routes/discord.js';
import { franchiseRoutes } from './routes/franchises.js';
import { issueRoutes } from './routes/issues.js';
import { requestRoutes } from './routes/requests.js';
import { listRoutes } from './routes/lists.js';
import { mediaRoutes } from './routes/media.js';
import { nowPlayingRoutes } from './routes/nowplaying.js';
import { passkeyRoutes } from './routes/passkeys.js';
import { pollRoutes } from './routes/polls.js';
import { publicPollRoutes } from './routes/publicPolls.js';
import { scheduleRoutes } from './routes/schedules.js';
import { traktRoutes } from './routes/trakt.js';
import { versionRoutes } from './routes/version.js';
import { watchWithRoutes } from './routes/watchwith.js';
import { widgetRoutes } from './routes/widget.js';

export async function buildApp() {
  warnIfProxyTrustIsLoose();
  const app = Fastify({
    loggerInstance: logger,
    // Which reverse proxies' X-Forwarded-* to believe (secure cookies + rate-limit IPs); see config.ts.
    trustProxy: config.trustProxy,
    // Drop open connections on shutdown, including live-result streams that never end on their own.
    forceCloseConnections: true,
  });

  // Must come before any route is registered: Fastify fixes each route's error
  // handler at registration, so routes added earlier would keep the default one
  // and send raw internal error messages (e.g. SQLite errors) to clients.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error(error);
    else request.log.info({ err: error.message, status }, 'request rejected');
    reply.code(status).send({ error: status === 500 ? 'Internal server error' : error.message });
  });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false, // the SPA sets what it needs; CSP here would break inline Vite assets
    crossOriginEmbedderPolicy: false,
  });
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(passkeyRoutes);
  await app.register(pollRoutes);
  await app.register(publicPollRoutes);
  await app.register(mediaRoutes);
  await app.register(listRoutes);
  await app.register(collectionRoutes);
  await app.register(franchiseRoutes);
  await app.register(requestRoutes);
  await app.register(traktRoutes);
  await app.register(watchWithRoutes);
  await app.register(nowPlayingRoutes);
  await app.register(scheduleRoutes);
  await app.register(discordRoutes);
  await app.register(issueRoutes);
  await app.register(adminRoutes);
  await app.register(adminUserRoutes);
  await app.register(versionRoutes);
  await app.register(widgetRoutes);

  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  // In production the server also serves the built client (SPA fallback for client routes).
  const clientDist = path.join(import.meta.dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
