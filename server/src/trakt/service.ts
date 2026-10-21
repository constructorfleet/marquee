import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { db } from '../db/index.js';
import { media, users, userWatched } from '../db/schema.js';
import { logger } from '../logger.js';
import {
  getTraktApp,
  getWatched,
  refreshAccessToken,
  TraktAuthError,
  type TraktWatchedEntry,
} from './client.js';

// Pull the user's watched movies/shows from Trakt and match them against the
// synced library by IMDb/TMDb id. Replaces the user's user_watched rows.
export async function refreshUserWatched(userId: number): Promise<number> {
  const app = getTraktApp();
  if (!app) throw new Error('Trakt is not configured — ask your admin');
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user?.traktToken) throw new Error('Trakt is not connected');

  const fetchAll = (token: string) =>
    Promise.all([getWatched(app.clientId, token, 'movies'), getWatched(app.clientId, token, 'shows')]);

  let movies: TraktWatchedEntry[];
  let shows: TraktWatchedEntry[];
  try {
    [movies, shows] = await fetchAll(decryptSecret(user.traktToken));
  } catch (err) {
    // Expired access token: refresh once and retry.
    if (!(err instanceof TraktAuthError) || !user.traktRefresh) throw err;
    const renewed = await refreshAccessToken(app.clientId, app.clientSecret, decryptSecret(user.traktRefresh));
    db.update(users)
      .set({ traktToken: encryptSecret(renewed.accessToken), traktRefresh: encryptSecret(renewed.refreshToken) })
      .where(eq(users.id, userId))
      .run();
    logger.info({ userId }, 'refreshed expired trakt token');
    [movies, shows] = await fetchAll(renewed.accessToken);
  }

  // Membership is "the id is present"; the value is only its watch time, which
  // Trakt may omit — so presence is tested with has(), never with the value.
  const idTimes = (list: TraktWatchedEntry[]) => {
    const imdb = new Map<string, string | null>();
    const tmdb = new Map<string, string | null>();
    for (const entry of list) {
      if (entry.ids.imdb) imdb.set(entry.ids.imdb, entry.lastWatchedAt);
      if (entry.ids.tmdb != null) tmdb.set(String(entry.ids.tmdb), entry.lastWatchedAt);
    }
    return { imdb, tmdb };
  };
  const movieIds = idTimes(movies);
  const showIds = idTimes(shows);

  const rows = db
    .select({ id: media.id, type: media.type, imdbId: media.imdbId, tmdbId: media.tmdbId })
    .from(media)
    .all();
  const matched: { id: number; watchedAt: Date | null }[] = [];
  for (const r of rows) {
    const ids = r.type === 'movie' ? movieIds : showIds;
    const at =
      r.imdbId && ids.imdb.has(r.imdbId)
        ? ids.imdb.get(r.imdbId)!
        : r.tmdbId && ids.tmdb.has(r.tmdbId)
          ? ids.tmdb.get(r.tmdbId)!
          : undefined;
    if (at === undefined) continue;
    matched.push({ id: r.id, watchedAt: at ? new Date(at) : null });
  }

  db.transaction((tx) => {
    tx.delete(userWatched).where(eq(userWatched.userId, userId)).run();
    for (const m of matched) {
      tx.insert(userWatched)
        .values({ userId, mediaId: m.id, watchedAt: m.watchedAt })
        .onConflictDoNothing()
        .run();
    }
  });

  return matched.length;
}

// The user's personal watched set, or null when Trakt has nothing to say —
// callers then fall through to the next source.
export function getWatchedSet(userId: number): Set<number> | null {
  const user = db.select({ traktToken: users.traktToken }).from(users).where(eq(users.id, userId)).get();
  if (!user?.traktToken) return null;
  const rows = db
    .select({ mediaId: userWatched.mediaId })
    .from(userWatched)
    .where(eq(userWatched.userId, userId))
    .all();
  // A token whose initial sync failed must not outrank the user's own Plex
  // history by claiming, authoritatively, that they have watched nothing.
  if (!rows.length) return null;
  return new Set(rows.map((r) => r.mediaId));
}

// The user's most recently watched media ids, newest first, or null when they
// haven't connected Trakt. Rows from before watched_at existed carry no time and
// are left out rather than guessed at; connected-but-undated still returns (with
// `undated`) rather than null, because falling through would mix Plex recency
// with a Trakt watched set.
export function getRecentWatchedIds(
  userId: number,
  limit: number,
): { mediaIds: number[]; undated: boolean } | null {
  const user = db.select({ traktToken: users.traktToken }).from(users).where(eq(users.id, userId)).get();
  if (!user?.traktToken) return null;
  const mediaIds = db
    .select({ mediaId: userWatched.mediaId })
    .from(userWatched)
    .where(and(eq(userWatched.userId, userId), isNotNull(userWatched.watchedAt)))
    .orderBy(desc(userWatched.watchedAt))
    .limit(limit)
    .all()
    .map((r) => r.mediaId);
  if (mediaIds.length) return { mediaIds, undated: false };
  // "History is here but predates watched_at" needs a refresh; "no history at
  // all" does not. Only the empty case pays for the count.
  const total = db
    .select({ c: sql<number>`count(*)` })
    .from(userWatched)
    .where(eq(userWatched.userId, userId))
    .get()!.c;
  return { mediaIds, undated: total > 0 };
}
