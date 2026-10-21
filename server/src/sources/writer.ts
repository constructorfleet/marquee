import { and, eq, inArray, isNull, like, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { collectionItems, collections, media } from '../db/schema.js';
import { logger } from '../logger.js';
import { getSetting, setSetting } from '../settings.js';
import type { SourceSyncData } from './types.js';

// Rows from a server this source no longer points at keep their history under
// this ratingKey prefix, so the new server's keys can't overwrite them.
const REPLACED = 'replaced:';

// Persist one source's fetched data in a single transaction (one disk flush per
// sync). Upserts are keyed on (source, ratingKey). Titles the server no longer
// has are marked removed rather than deleted — old polls and lists keep them —
// and collections that vanished are pruned, both only within that source.
export function writeSourceData(data: SourceSyncData): { items: number; collections: number; removed: number } {
  const syncedAt = new Date();
  let items = 0;
  let removed = 0;
  db.transaction((tx) => {
    const toJson = (list: string[] | null) => (list?.length ? JSON.stringify(list) : null);

    // A different server behind the same source: its ratingKeys name other
    // titles. Set the old rows aside; titles found again are re-adopted below.
    const serverKey = `${data.source}.syncedServerId`;
    const previousServer = getSetting(serverKey);
    if (data.serverId && previousServer && previousServer !== data.serverId) {
      const moved = tx
        .update(media)
        .set({ ratingKey: sql`${`${REPLACED}${previousServer}:`} || ${media.ratingKey}` })
        .where(and(eq(media.source, data.source), sql`${media.ratingKey} NOT LIKE ${`${REPLACED}%`}`))
        .run().changes;
      tx.delete(collections).where(eq(collections.source, data.source)).run();
      logger.warn({ source: data.source, previousServer, server: data.serverId, titles: moved }, 'media server changed; re-matching its titles');
    }
    const readopting = !!tx
      .select({ id: media.id })
      .from(media)
      .where(and(eq(media.source, data.source), like(media.ratingKey, `${REPLACED}%`)))
      .get();

    for (const item of data.items) {
      // After a server change, a title already in Marquee (same TMDb/IMDb id)
      // takes over its old row, keeping its polls, lists and watch history.
      if (readopting && (item.tmdbId || item.imdbId)) {
        const current = tx
          .select({ id: media.id })
          .from(media)
          .where(and(eq(media.source, data.source), eq(media.ratingKey, item.ratingKey)))
          .get();
        if (!current) {
          const previous = tx
            .select({ id: media.id })
            .from(media)
            .where(
              and(
                eq(media.source, data.source),
                eq(media.type, item.type),
                like(media.ratingKey, `${REPLACED}%`),
                or(item.tmdbId ? eq(media.tmdbId, item.tmdbId) : undefined, item.imdbId ? eq(media.imdbId, item.imdbId) : undefined),
              ),
            )
            .get();
          if (previous) tx.update(media).set({ ratingKey: item.ratingKey }).where(eq(media.id, previous.id)).run();
        }
      }

      const fields = {
        title: item.title,
        year: item.year,
        type: item.type,
        thumb: item.thumb,
        summary: item.summary,
        durationMs: item.durationMs,
        librarySection: item.librarySection,
        genres: toJson(item.genres),
        imdbId: item.imdbId,
        tmdbId: item.tmdbId,
        rating: item.rating,
        contentRating: item.contentRating,
        directors: toJson(item.directors),
        actors: toJson(item.actors),
        watched: item.watched,
        syncedAt,
        removedAt: null, // back on the server
      };
      tx.insert(media)
        .values({ source: data.source, ratingKey: item.ratingKey, ...fields })
        .onConflictDoUpdate({ target: [media.source, media.ratingKey], set: fields })
        .run();
      items++;
    }

    // Titles this sync didn't see are gone from the server — but only judge
    // library sections that returned something: one that comes back empty (or
    // missing) is more likely a hiccup than everything being deleted.
    const sections = [...new Set(data.items.map((i) => i.librarySection).filter((s): s is string => !!s))];
    const seen = new Set(data.items.map((i) => i.ratingKey));
    const gone = tx
      .select({ id: media.id, ratingKey: media.ratingKey })
      .from(media)
      .where(
        and(
          eq(media.source, data.source),
          isNull(media.removedAt),
          or(
            like(media.ratingKey, `${REPLACED}%`), // never on the current server
            sections.length ? inArray(media.librarySection, sections) : undefined,
          ),
        ),
      )
      .all()
      .filter((r) => r.ratingKey.startsWith(REPLACED) || !seen.has(r.ratingKey))
      .map((r) => r.id);
    for (let i = 0; i < gone.length; i += 500) {
      tx.update(media).set({ removedAt: syncedAt }).where(inArray(media.id, gone.slice(i, i + 500))).run();
    }
    removed = gone.length;

    for (const col of data.collections) {
      const fields = { title: col.title, librarySection: col.librarySection, syncedAt };
      const row = tx
        .insert(collections)
        .values({ source: data.source, ratingKey: col.ratingKey, ...fields })
        .onConflictDoUpdate({ target: [collections.source, collections.ratingKey], set: fields })
        .returning()
        .get();
      if (col.childRatingKeys === null) continue; // couldn't fetch its members this time: keep the ones we have
      tx.delete(collectionItems).where(eq(collectionItems.collectionId, row.id)).run();
      for (const childKey of col.childRatingKeys) {
        const m = tx
          .select({ id: media.id })
          .from(media)
          .where(and(eq(media.source, data.source), eq(media.ratingKey, childKey)))
          .get();
        if (m) {
          tx.insert(collectionItems).values({ collectionId: row.id, mediaId: m.id }).onConflictDoNothing().run();
        }
      }
    }

    // Prune collections only when every listing succeeded; otherwise a missing
    // one may just not have been fetched.
    if (data.collectionsComplete) {
      const seen = data.collections.map((c) => c.ratingKey);
      tx.delete(collections)
        .where(
          seen.length
            ? and(eq(collections.source, data.source), notInArray(collections.ratingKey, seen))
            : eq(collections.source, data.source),
        )
        .run();
    }

    if (data.serverId) setSetting(serverKey, data.serverId);
  });

  return { items, collections: data.collections.length, removed };
}
