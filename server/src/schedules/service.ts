import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media, scheduledPicks } from '../db/schema.js';
import { announcePick } from '../discord/bot.js';
import { logger } from '../logger.js';
import { pickRandomMedia, type RandomFilters } from '../randomizer/service.js';

type ScheduleRow = typeof scheduledPicks.$inferSelect;

export function parseFilters(row: ScheduleRow): RandomFilters {
  try {
    return row.filters ? (JSON.parse(row.filters) as RandomFilters) : {};
  } catch {
    return {};
  }
}

// Execute one schedule: draw a pick, record it, and optionally announce on
// Discord. Only `scheduled` runs retire a one-shot — "Run now" is a preview and
// must not cancel the occurrence the user is still waiting for.
export async function runSchedule(
  row: ScheduleRow,
  opts: { scheduled?: boolean } = {},
): Promise<typeof media.$inferSelect | null> {
  // An unattended schedule draws only from lists its creator personally owns
  // or that are shared — never via admin override in a background job.
  const pick = await pickRandomMedia(parseFilters(row), { id: row.createdBy, isAdmin: false });
  db.update(scheduledPicks)
    .set({
      lastRunAt: new Date(),
      lastPickMediaId: pick?.id ?? null,
      ...(opts.scheduled && row.kind === 'once' ? { enabled: false } : {}),
    })
    .where(eq(scheduledPicks.id, row.id))
    .run();
  logger.info({ schedule: row.name, pick: pick?.title ?? null }, 'scheduled pick ran');
  if (pick && row.postToDiscord) void announcePick(row.name, pick);
  return pick;
}

// Schedules whose pick is still being drawn. A pick can outlast a scheduler tick
// (e.g. an unwatched-only draw walking a slow Plex library), and a one-shot is
// only disabled once it finishes — without this it would fire again next minute.
const inFlight = new Set<number>();

// How late a weekly occurrence may still be caught up. Longer than any DST
// shift, so the hour the clocks move never pushes a genuinely due pick out of
// range; short enough that a pick announced after downtime is still tonight's
// rather than some previous week's.
const CATCH_UP_MS = 2 * 60 * 60 * 1000;

// Most recent dayOfWeek/timeOfDay in server-local time at or before `now`.
// Matching the occurrence instead of the wall clock makes a run idempotent
// across the repeated hour when clocks go back, and lets a tick that arrives
// late still fire. A time lost to the spring-forward gap lands on the next
// valid minute, which is where Date resolves it.
function lastWeeklyOccurrence(now: Date, dayOfWeek: number, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h ?? 0, m ?? 0, 0, 0);
  at.setDate(at.getDate() - ((at.getDay() - dayOfWeek + 7) % 7));
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 7);
  return at;
}

// Occurrences already reported as missed, so one stale schedule doesn't log every minute.
const reportedMissed = new Map<number, number>();

// Called every minute by the scheduler.
export function runDueSchedules(now: Date): void {
  const rows = db.select().from(scheduledPicks).where(eq(scheduledPicks.enabled, true)).all();
  for (const row of rows) {
    let due: boolean;
    if (row.kind === 'weekly') {
      if (row.dayOfWeek === null || !row.timeOfDay) continue;
      const occurrence = lastWeeklyOccurrence(now, row.dayOfWeek, row.timeOfDay).getTime();
      const pending = !row.lastRunAt || row.lastRunAt.getTime() < occurrence;
      due = pending && now.getTime() - occurrence <= CATCH_UP_MS;
      if (pending && !due && reportedMissed.get(row.id) !== occurrence) {
        reportedMissed.set(row.id, occurrence);
        logger.warn(
          { schedule: row.name, occurrence: new Date(occurrence).toISOString() },
          'scheduled pick missed and too stale to catch up',
        );
      }
    } else {
      due = row.runAt !== null && row.runAt.getTime() <= now.getTime();
    }
    if (!due || inFlight.has(row.id)) continue;
    inFlight.add(row.id);
    runSchedule(row, { scheduled: true })
      .catch((err) => logger.error({ err, schedule: row.name }, 'scheduled pick failed'))
      .finally(() => inFlight.delete(row.id));
  }
}
