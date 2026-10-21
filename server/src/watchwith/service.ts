import { eq } from 'drizzle-orm';
import { decryptSecret } from '../crypto.js';
import { db } from '../db/index.js';
import { media, users } from '../db/schema.js';
import { getSectionItems, getSections } from '../plex/client.js';
import { getServerAccessToken } from '../plex/plextv.js';
import { getPlexConfig } from '../settings.js';
import { getRecentWatchedIds, getWatchedSet, hasWatchedRows } from '../trakt/service.js';

// Per-person watch history, best source available:
//   1. Trakt (user connected their account)
//   2. Their own Plex account (they signed in with Plex; we query the server with their token)
//   3. The sync account's watch flags (last resort)
export type WatchedMethod = 'trakt' | 'plex' | 'sync-account';

// media id → when they last watched it (epoch ms), null when Plex didn't say.
type PlexWatched = Map<number, number | null>;

const plexWatchedCache = new Map<number, { at: number; watched: PlexWatched }>();
const CACHE_MS = 5 * 60_000;

async function plexWatched(userId: number, plexToken: string): Promise<PlexWatched | null> {
  const cached = plexWatchedCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.watched;
  const cfg = getPlexConfig();
  if (!cfg) return null;

  const rows = db
    .select({ id: media.id, ratingKey: media.ratingKey })
    .from(media)
    .where(eq(media.source, 'plex'))
    .all();
  const byKey = new Map(rows.map((r) => [r.ratingKey, r.id]));

  const watched: PlexWatched = new Map();
  try {
    // Same server, but queried with the user's token, so UserData is theirs.
    // Shared users need their per-server token — the server rejects their account token.
    const serverToken = await getServerAccessToken(cfg, plexToken);
    if (!serverToken) return null; // server no longer shared with them
    const sections = (await getSections(cfg.url, serverToken)).filter(
      (s) => s.type === 'movie' || s.type === 'show',
    );
    for (const section of sections) {
      const items = await getSectionItems(cfg.url, serverToken, section.key);
      for (const item of items) {
        const isWatched =
          item.type === 'show'
            ? (item.leafCount ?? 0) > 0 && (item.viewedLeafCount ?? 0) >= (item.leafCount ?? 0)
            : (item.viewCount ?? 0) > 0;
        if (!isWatched) continue;
        const id = byKey.get(item.ratingKey);
        if (id) watched.set(id, item.lastViewedAt ? item.lastViewedAt * 1000 : null);
      }
    }
  } catch {
    return null; // their token may have expired — fall through to the next method
  }

  plexWatchedCache.set(userId, { at: Date.now(), watched });
  return watched;
}

function ownPlexToken(userId: number): string | null {
  const user = db.select({ plexToken: users.plexToken }).from(users).where(eq(users.id, userId)).get();
  return user?.plexToken ? decryptSecret(user.plexToken) : null;
}

export async function watchedSetForUser(userId: number): Promise<{ set: Set<number>; method: WatchedMethod }> {
  const traktSet = getWatchedSet(userId);
  if (traktSet) return { set: traktSet, method: 'trakt' };

  const token = ownPlexToken(userId);
  if (token) {
    const watched = await plexWatched(userId, token);
    if (watched) return { set: new Set(watched.keys()), method: 'plex' };
  }

  const rows = db.select({ id: media.id }).from(media).where(eq(media.watched, true)).all();
  return { set: new Set(rows.map((r) => r.id)), method: 'sync-account' };
}

// Up to `limit` media ids the user watched most recently, newest first, from the
// same source priority as watchedSetForUser. Empty for 'sync-account': those
// flags belong to the sync account and carry no times, so recency is unknown.
// `stale` marks an empty result the user can fix by re-syncing Trakt, as opposed
// to one that genuinely means "watched nothing".
export async function recentlyWatchedForUser(
  userId: number,
  limit: number,
): Promise<{ mediaIds: number[]; method: WatchedMethod; stale: boolean }> {
  const traktIds = getRecentWatchedIds(userId, limit);
  if (traktIds)
    return { mediaIds: traktIds, method: 'trakt', stale: !traktIds.length && hasWatchedRows(userId) };

  const token = ownPlexToken(userId);
  if (token) {
    const watched = await plexWatched(userId, token);
    if (watched) {
      const mediaIds = [...watched]
        .filter((entry): entry is [number, number] => entry[1] !== null)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id]) => id);
      return { mediaIds, method: 'plex', stale: false };
    }
  }

  return { mediaIds: [], method: 'sync-account', stale: false };
}

// plex.tv Discover watchlist for one account.
export interface WatchlistItem {
  title: string;
  year: number | null;
  type: string;
  guids: string[];
}

export async function fetchWatchlist(token: string): Promise<WatchlistItem[]> {
  const url = new URL('https://discover.provider.plex.tv/library/sections/watchlist/all');
  url.searchParams.set('includeGuids', '1');
  const res = await fetch(url, {
    headers: { 'X-Plex-Token': token, Accept: 'application/json' },
    // Two of these run concurrently per request; without it a stalled plex.tv
    // holds the caller for undici's 300 s header and body timeouts.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`plex.tv watchlist request failed (${res.status})`);
  const json = (await res.json()) as {
    MediaContainer?: { Metadata?: { title: string; year?: number; type?: string; Guid?: { id: string }[] }[] };
  };
  return (json.MediaContainer?.Metadata ?? []).map((m) => ({
    title: m.title,
    year: m.year ?? null,
    type: m.type ?? 'movie',
    guids: (m.Guid ?? []).map((g) => g.id),
  }));
}

// Stable identity for intersecting two watchlists: external id first, title+year fallback.
export function watchlistKey(item: WatchlistItem): string {
  const ext =
    item.guids.find((g) => g.startsWith('imdb://')) ?? item.guids.find((g) => g.startsWith('tmdb://'));
  return ext ?? `t:${item.title.toLowerCase()}|${item.year ?? ''}`;
}
