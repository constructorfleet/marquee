import { Cron } from 'croner';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { runIntegrityCheck } from './db/health.js';
import { db } from './db/index.js';
import { polls } from './db/schema.js';
import { emitPollUpdate } from './events.js';
import { logger } from './logger.js';
import { closePoll } from './polls/service.js';
import { runDueSchedules } from './schedules/service.js';
import { runDueLibrarySync } from './sources/syncSchedule.js';

function openDuePolls(now: Date) {
  const toOpen = db
    .select()
    .from(polls)
    .where(and(eq(polls.status, 'draft'), isNotNull(polls.opensAt), lte(polls.opensAt, now)))
    .all();
  for (const poll of toOpen) {
    db.update(polls).set({ status: 'open' }).where(eq(polls.id, poll.id)).run();
    emitPollUpdate(poll.shareToken);
  }
}

// Once a day in the early morning (server time), when nobody's voting.
function dailyIntegrityCheck(now: Date) {
  if (now.getHours() === 4 && now.getMinutes() === 30) runIntegrityCheck();
}

function closeDuePolls(now: Date) {
  const toClose = db
    .select()
    .from(polls)
    .where(and(eq(polls.status, 'open'), isNotNull(polls.closesAt), lte(polls.closesAt, now)))
    .all();
  for (const poll of toClose) closePoll(poll.id);
}

// Every minute: open drafts whose opensAt has passed, close open polls whose
// closesAt has passed, fire any due scheduled randomizer picks, start the
// automatic library sync when it's due, and check the database once a day. Each step is isolated so one failing
// (e.g. SQLITE_BUSY while a backup holds a lock) doesn't skip the others.
// croner computes the next tick from now, so a tick overrunning 60s swallows the
// following minute. Polls, picks and the library sync fire on a due timestamp
// rather than an exact wall-clock match, so they catch up on the next tick;
// dailyIntegrityCheck below still matches the clock and can be swallowed.
export function startScheduler() {
  const steps: [string, (now: Date) => void][] = [
    ['scheduled picks', runDueSchedules],
    ['library sync', runDueLibrarySync],
    ['open polls', openDuePolls],
    ['close polls', closeDuePolls],
    ['integrity check', dailyIntegrityCheck],
  ];
  new Cron(
    '* * * * *',
    // Without a catch, croner turns any throw into an unhandled rejection, which ends the process.
    { catch: (err) => logger.error({ err }, 'scheduler tick failed') },
    () => {
      const now = new Date();
      for (const [name, step] of steps) {
        try {
          step(now);
        } catch (err) {
          logger.error({ err, step: name }, 'scheduler step failed');
        }
      }
    },
  );
}
