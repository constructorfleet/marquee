import crypto from 'node:crypto';
import { and, eq, gte, inArray, isNull, like, lte, type SQL } from 'drizzle-orm';
import type { SimilarToRecentInfo, SimilarToRecentStatus } from '@marquee/shared';
import { db } from '../db/index.js';
import { collectionItems, listItems, lists, media } from '../db/schema.js';
import { logger } from '../logger.js';
import { getSeerrConfig, similarTmdbIds } from '../seerr/client.js';
import { dedupeMedia, type DedupedMedia } from '../sources/dedupe.js';
import { mapLimit } from '../sources/mapLimit.js';
import { recentlyWatchedForUser, watchedSetForUser } from '../watchwith/service.js';

export interface RandomFilters {
  type?: 'movie' | 'show';
  genre?: string;
  section?: string;
  collectionId?: number;
  listId?: number;
  unwatchedOnly?: boolean;
  yearFrom?: number;
  yearTo?: number;
  minRating?: number;
  similarToRecent?: boolean;
  recentSeedCount?: number;
}

export interface RandomResult {
  pick: typeof media.$inferSelect | null;
  similarToRecent?: SimilarToRecentInfo;
}

const SEED_COUNT_DEFAULT = 5;
const SEED_COUNT_MAX = 10;
// Recommendations are two upstream calls per seed; a handful at a time keeps a
// spin from arriving at the request service as a burst.
const SEERR_CONCURRENCY = 3;

// Keep the pool whenever the narrowing can't be trusted: a filter that can
// silently empty the library would make "spin" fail for reasons the user can't
// act on. The status tells the client it was skipped.
const skipped = (status: SimilarToRecentStatus, seedCount = 0): SimilarToRecentInfo => ({
  status,
  seedCount,
  matchCount: 0,
});

// Narrow to library titles the request service recommends from the viewer's own
// recent watches. Matched on TMDb id — titles and years are too loose.
async function narrowToSimilar(
  pool: DedupedMedia[],
  viewerId: number,
  seedCount: number,
): Promise<{ pool: DedupedMedia[]; info: SimilarToRecentInfo }> {
  const keep = (info: SimilarToRecentInfo) => ({ pool, info });

  const cfg = getSeerrConfig();
  if (!cfg) return keep(skipped('not-configured'));
  if (cfg.kind === 'ombi') return keep(skipped('unsupported'));

  const { mediaIds, stale } = await recentlyWatchedForUser(viewerId, seedCount);
  if (!mediaIds.length) return keep(skipped(stale ? 'history-stale' : 'no-history'));
  const seeds = db
    .select({ type: media.type, tmdbId: media.tmdbId })
    .from(media)
    .where(inArray(media.id, mediaIds))
    .all()
    .flatMap((s) => {
      const tmdbId = Number(s.tmdbId);
      return s.tmdbId && Number.isInteger(tmdbId) && tmdbId > 0 ? [{ type: s.type, tmdbId }] : [];
    });
  if (!seeds.length) return keep(skipped('no-history'));

  const perSeed = await mapLimit(seeds, SEERR_CONCURRENCY, async (seed) => {
    try {
      const ids = await similarTmdbIds(cfg, seed.type === 'show' ? 'tv' : 'movie', seed.tmdbId);
      // TMDb movie and TV ids overlap, so recommendations stay typed (see dedupe.ts).
      return ids.map((id) => `${seed.type}:${id}`);
    } catch (err) {
      logger.warn({ err, tmdbId: seed.tmdbId }, 'seerr recommendation lookup failed');
      return null;
    }
  });
  if (perSeed.every((keys) => keys === null)) return keep(skipped('unavailable', seeds.length));

  const recommended = new Set(perSeed.flatMap((keys) => keys ?? []));
  const narrowed = pool.filter((row) => row.tmdbId && recommended.has(`${row.type}:${row.tmdbId}`));
  if (!narrowed.length) return keep(skipped('no-matches', seeds.length));
  return { pool: narrowed, info: { status: 'applied', seedCount: seeds.length, matchCount: narrowed.length } };
}

// One random title matching the filters, or null. `viewer` personalizes the
// unwatched and similar-to-recent filters (Trakt → own Plex account → sync
// account) and gates the `listId` filter so a caller can only draw from lists
// they may view.
export async function pickRandomMedia(
  filters: RandomFilters,
  viewer: { id: number; isAdmin: boolean },
): Promise<RandomResult> {
  // Titles gone from the media server are never drawn, whatever the pool.
  const conditions: SQL[] = [isNull(media.removedAt)];
  if (filters.type) conditions.push(eq(media.type, filters.type));
  if (filters.genre) conditions.push(like(media.genres, `%"${filters.genre}"%`));
  if (filters.section) conditions.push(eq(media.librarySection, filters.section));
  if (filters.yearFrom) conditions.push(gte(media.year, filters.yearFrom));
  if (filters.yearTo) conditions.push(lte(media.year, filters.yearTo));
  if (filters.minRating) conditions.push(gte(media.rating, filters.minRating));
  const where = and(...conditions);

  let rows: (typeof media.$inferSelect)[];
  if (filters.listId) {
    // Same visibility rule as GET /api/lists/:id — owner, shared, or admin.
    // Anything else is treated as "no match" so it can't be enumerated.
    const list = db.select().from(lists).where(eq(lists.id, filters.listId)).get();
    if (!list || !(list.isShared || list.ownerId === viewer.id || viewer.isAdmin)) return { pick: null };
    rows = db
      .select({ media })
      .from(listItems)
      .innerJoin(media, eq(listItems.mediaId, media.id))
      .where(and(eq(listItems.listId, filters.listId), ...conditions))
      .all()
      .map((r) => r.media);
  } else if (filters.collectionId) {
    rows = db
      .select({ media })
      .from(collectionItems)
      .innerJoin(media, eq(collectionItems.mediaId, media.id))
      .where(and(eq(collectionItems.collectionId, filters.collectionId), ...conditions))
      .all()
      .map((r) => r.media);
  } else {
    rows = db.select().from(media).where(where).all();
  }

  // Cross-source duplicates would double-weight the draw — collapse them first.
  let pool = dedupeMedia(rows);

  if (filters.unwatchedOnly) {
    // A title counts as watched if any of its copies is (e.g. seen on Jellyfin, drawn from Plex).
    const { set } = await watchedSetForUser(viewer.id);
    pool = pool.filter((r) => !r.copyIds.some((id) => set.has(id)));
  }

  let similarToRecent: SimilarToRecentInfo | undefined;
  if (filters.similarToRecent) {
    // Last, so matchCount counts what the other filters already allowed.
    const seedCount = Math.min(Math.max(filters.recentSeedCount ?? SEED_COUNT_DEFAULT, 1), SEED_COUNT_MAX);
    const narrowed = await narrowToSimilar(pool, viewer.id, seedCount);
    pool = narrowed.pool;
    similarToRecent = narrowed.info;
  }

  return { pick: pool.length ? pool[crypto.randomInt(pool.length)]! : null, similarToRecent };
}
