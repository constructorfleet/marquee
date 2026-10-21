import crypto from 'node:crypto';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { uniqueUsername } from '../auth/usernames.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { users, votes } from '../db/schema.js';

// Visitors to a public poll link get an account so the one-vote rule holds, but
// it's a hidden record: an internal username (the name they typed lives on their
// vote), kept out of Watch With, and removed once none of its votes remain.

// Guest votes accepted per poll from one network — a household or watch party
// on shared Wi-Fi fits, one person clearing cookies to vote again doesn't.
export const GUEST_VOTES_PER_NETWORK = 10;

// …and a ceiling for the whole poll, because the per-network cap keys on
// request.ip, which a client behind a reverse proxy can choose (see config.ts).
// Nothing else bounds a public poll: the voter-name check is a UX collision
// guard that homoglyphs walk past, and omitting the guest cookie mints a fresh
// guest. A movie-night poll does not legitimately draw this many strangers.
export const GUEST_VOTES_PER_POLL = 200;

export function guestUsername(guestId: string): string {
  return uniqueUsername(`guest-${guestId.slice(0, 6)}`);
}

// Accounts a person actually signs in as — not public-poll guests or the
// shadow accounts behind Discord button votes.
export const isMemberAccount = and(isNull(users.guestId), isNull(users.discordId));

// After votes go away (a poll or option was deleted), drop guests left without any.
export function pruneGuestsWithoutVotes(): number {
  return db
    .delete(users)
    .where(and(isNotNull(users.guestId), sql`not exists (select 1 from ${votes} where ${votes.userId} = ${users.id})`))
    .run().changes;
}

// Domain-separated from the raw instance secret, which @fastify/cookie also
// uses verbatim for signatures — same derivation as crypto.ts.
const NETWORK_KEY = crypto.createHash('sha256').update(`marquee-network:${config.sessionSecret}`).digest();

// The network a vote came from, as a keyed hash so no IP address is stored.
// IPv6 clients rotate addresses within their /64, so that's one network.
export function networkFingerprint(ip: string): string {
  let key = ip;
  if (key.startsWith('::ffff:') && key.includes('.')) key = key.slice(7);
  else if (key.includes(':')) key = expandIpv6(key).slice(0, 4).join(':');
  return crypto.createHmac('sha256', NETWORK_KEY).update(`network:${key}`).digest('base64url').slice(0, 22);
}

// Why a guest may not vote in this poll, or null to let them through. Guest
// votes are the ones carrying a voterName — signed-in and Discord votes don't.
export function guestVoteRejection(pollId: number, network: string): string | null {
  const guestVotes = db
    .select({ n: sql<number>`count(*)` })
    .from(votes)
    .where(and(eq(votes.pollId, pollId), isNotNull(votes.voterName)))
    .get()!.n;
  if (guestVotes >= GUEST_VOTES_PER_POLL) {
    return 'This poll has taken all the guest votes it accepts — sign in to vote';
  }
  const fromNetwork = db
    .select({ n: sql<number>`count(*)` })
    .from(votes)
    .where(and(eq(votes.pollId, pollId), eq(votes.voterNetwork, network)))
    .get()!.n;
  if (fromNetwork >= GUEST_VOTES_PER_NETWORK) {
    return 'Lots of guests have already voted from your network on this poll — sign in to vote';
  }
  return null;
}

function expandIpv6(ip: string): string[] {
  const [head = '', tail] = ip.split('%')[0]!.split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0');
  return [...front, ...zeros, ...back].map((part) => part.toLowerCase().replace(/^0+(?=.)/, ''));
}
