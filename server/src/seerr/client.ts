import { getSetting } from '../settings.js';

// Request-service integration. Overseerr and Jellyseerr share one API; Ombi has its own.

export interface SeerrConfig {
  url: string;
  apiKey: string;
  kind: 'overseerr' | 'ombi';
}

export function getSeerrConfig(): SeerrConfig | null {
  const url = getSetting('seerr.url');
  const apiKey = getSetting('seerr.apiKey');
  const kind = getSetting('seerr.kind') === 'ombi' ? 'ombi' : 'overseerr';
  return url && apiKey ? { url, apiKey, kind } : null;
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function testSeerr(cfg: SeerrConfig): Promise<void> {
  const target =
    cfg.kind === 'ombi' ? `${base(cfg.url)}/api/v1/Status` : `${base(cfg.url)}/api/v1/settings/main`;
  const res = await fetch(target, { headers: { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${cfg.kind} responded ${res.status} — check the URL and API key`);
}

// Who in Marquee is asking, by the media-server accounts Seerr knows them by.
export interface Requester {
  isAdmin: boolean;
  plexId: string | null;
  jellyfinId: string | null;
  embyId: string | null;
}

interface SeerrUser {
  id: number;
  plexId?: number | null;
  jellyfinUserId?: string | null;
}

// Seerr's user list changes only when its admin adds people, so a short cache
// spares a lookup per request. Cleared whenever the request settings change.
const USER_CACHE_MS = 5 * 60_000;
let userCache: { at: number; users: SeerrUser[] } | null = null;

// What one title is similar to barely changes, and a single randomizer spin
// seeds from several titles — so hold recommendations for an hour.
const RECS_CACHE_MS = 60 * 60_000;
const RECS_CACHE_MAX = 500;
const recsCache = new Map<string, { at: number; tmdbIds: number[] }>();

// Called when the request-service settings change: a new URL or key may be a
// different instance, so nothing cached from the old one still applies.
export function clearSeerrCaches() {
  userCache = null;
  recsCache.clear();
}

async function seerrUsers(cfg: SeerrConfig): Promise<SeerrUser[]> {
  if (userCache && Date.now() - userCache.at < USER_CACHE_MS) return userCache.users;
  const users: SeerrUser[] = [];
  for (let skip = 0; ; skip += 100) {
    const res = await fetch(`${base(cfg.url)}/api/v1/user?take=100&skip=${skip}`, {
      headers: { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`The request service responded ${res.status} while looking up its users`);
    const page = ((await res.json()) as { results?: SeerrUser[] }).results ?? [];
    users.push(...page);
    if (page.length < 100) break;
  }
  userCache = { at: Date.now(), users };
  return users;
}

// Jellyfin user ids show up with and without dashes depending on the API.
const sameJfId = (a: string | null | undefined, b: string | null) =>
  !!a && !!b && a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase();

// The Overseerr/Jellyseerr account that is the same person: matched by Plex
// account id, or by Jellyfin/Emby user id (Jellyseerr).
export async function findSeerrUserId(cfg: SeerrConfig, who: Requester): Promise<number | null> {
  const match = (await seerrUsers(cfg)).find(
    (u) =>
      (who.plexId !== null && u.plexId != null && String(u.plexId) === who.plexId) ||
      sameJfId(u.jellyfinUserId, who.jellyfinId) ||
      sameJfId(u.jellyfinUserId, who.embyId),
  );
  return match?.id ?? null;
}

// Requests are made as the person's own Seerr account, so the permissions,
// auto-approval and quotas set there apply. Admins without a Seerr account
// request as the API key's owner, as before. Ombi has no per-user mapping
// here, so only admins can request through it.
export type RequestRoute = { allowed: true; asSeerrUser: number | null } | { allowed: false; reason: string };

export async function requestRoute(cfg: SeerrConfig, who: Requester): Promise<RequestRoute> {
  if (cfg.kind === 'ombi') {
    return who.isAdmin
      ? { allowed: true, asSeerrUser: null }
      : { allowed: false, reason: 'Requests through Ombi are limited to admins — ask one to request this' };
  }
  const seerrId = await findSeerrUserId(cfg, who);
  if (seerrId !== null) return { allowed: true, asSeerrUser: seerrId };
  if (who.isAdmin) return { allowed: true, asSeerrUser: null };
  return { allowed: false, reason: 'Your account isn’t set up in the request service yet — ask an admin to add you there' };
}

// Whether to show request buttons to this person. If Seerr can't be reached,
// show them and let the request itself explain what went wrong.
export async function canRequest(who: Requester): Promise<boolean> {
  const cfg = getSeerrConfig();
  if (!cfg) return false;
  try {
    return (await requestRoute(cfg, who)).allowed;
  } catch {
    return true;
  }
}

// TMDb ids Overseerr/Jellyseerr considers related to one title: its
// "recommendations" and "similar" lists merged. Ombi exposes no equivalent, so
// callers must check cfg.kind first.
export async function similarTmdbIds(
  cfg: SeerrConfig,
  type: 'movie' | 'tv',
  tmdbId: number,
): Promise<number[]> {
  const cacheKey = `${type}:${tmdbId}`;
  const cached = recsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RECS_CACHE_MS) return cached.tmdbIds;

  const found = new Set<number>();
  for (const list of ['recommendations', 'similar'] as const) {
    const res = await fetch(`${base(cfg.url)}/api/v1/${type}/${tmdbId}/${list}`, {
      headers: { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`The request service responded ${res.status} while looking up ${list}`);
    for (const result of ((await res.json()) as { results?: { id?: number }[] }).results ?? []) {
      if (typeof result.id === 'number') found.add(result.id);
    }
  }

  // Insertion-ordered eviction bounds the cache on a long-running instance.
  if (!recsCache.has(cacheKey) && recsCache.size >= RECS_CACHE_MAX) {
    const oldest = recsCache.keys().next().value;
    if (oldest !== undefined) recsCache.delete(oldest);
  }
  const tmdbIds = [...found];
  recsCache.set(cacheKey, { at: Date.now(), tmdbIds });
  return tmdbIds;
}

export async function requestMovie(cfg: SeerrConfig, tmdbId: number, asSeerrUser: number | null): Promise<void> {
  const target = cfg.kind === 'ombi' ? `${base(cfg.url)}/api/v1/Request/movie` : `${base(cfg.url)}/api/v1/request`;
  const body = cfg.kind === 'ombi' ? { theMovieDbId: tmdbId } : { mediaType: 'movie', mediaId: tmdbId };
  const res = await fetch(target, {
    method: 'POST',
    headers: {
      'X-Api-Key': cfg.apiKey,
      'Content-Type': 'application/json',
      ...(asSeerrUser !== null ? { 'X-Api-User': String(asSeerrUser) } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 409) throw new Error('This title has already been requested');
  if (res.status === 403) throw new Error('The request service says your account isn’t allowed to request this');
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      // non-JSON error body
    }
    throw new Error(`Request failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
}
