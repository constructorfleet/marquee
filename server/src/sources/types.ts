// Normalized shapes every media source (Plex, Jellyfin, Emby) maps into.
// Fetchers produce these; the generic writer persists them.

export type SourceKind = 'plex' | 'jellyfin' | 'emby';

export interface NormalizedItem {
  ratingKey: string;
  title: string;
  year: number | null;
  type: 'movie' | 'show';
  thumb: string | null; // source-specific artwork reference (Plex path / Jellyfin item id)
  summary: string | null;
  durationMs: number | null;
  librarySection: string | null;
  genres: string[] | null;
  imdbId: string | null;
  tmdbId: string | null;
  rating: number | null;
  contentRating: string | null;
  directors: string[] | null;
  actors: string[] | null;
  watched: boolean;
}

export interface NormalizedCollection {
  ratingKey: string;
  title: string;
  librarySection: string | null;
  // null when the members couldn't be fetched this time: keep the ones we have.
  childRatingKeys: string[] | null;
}

export interface SourceSyncData {
  source: SourceKind;
  // The server's own id (Plex machine identifier / Jellyfin server id), when
  // known. ratingKeys only mean something on one server, so a change matters.
  serverId: string | null;
  sections: number;
  items: NormalizedItem[];
  collections: NormalizedCollection[];
  // False when some collection listing failed, so missing collections may just
  // be unfetched: none are pruned this time.
  collectionsComplete: boolean;
}
