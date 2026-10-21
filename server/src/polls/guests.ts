import crypto from 'node:crypto';
import { and, isNotNull, isNull, sql } from 'drizzle-orm';
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

// The network a vote came from, as a keyed hash so no IP address is stored.
// IPv6 clients rotate addresses within their /64, so that's one network.
export function networkFingerprint(ip: string): string {
  let key = ip;
  if (key.startsWith('::ffff:') && key.includes('.')) key = key.slice(7);
  else if (key.includes(':')) key = expandIpv6(key).slice(0, 4).join(':');
  return crypto.createHmac('sha256', config.sessionSecret).update(`network:${key}`).digest('base64url').slice(0, 22);
}

function expandIpv6(ip: string): string[] {
  const [head = '', tail] = ip.split('%')[0]!.split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0');
  return [...front, ...zeros, ...back].map((part) => part.toLowerCase().replace(/^0+(?=.)/, ''));
}
