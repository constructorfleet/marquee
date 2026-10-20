import type { SyncMode } from '@marquee/shared';
import { logger } from '../logger.js';
import { getSetting } from '../settings.js';
import { getConfiguredSources, isSyncRunning, runLibrarySync } from './index.js';

export interface SyncSchedule {
  mode: SyncMode;
  intervalHours: number;
  timeOfDay: string; // 'HH:MM' server-local, for daily
}

export function getSyncSchedule(): SyncSchedule {
  const mode = getSetting('sync.mode');
  return {
    mode: mode === 'interval' || mode === 'daily' ? mode : 'off',
    intervalHours: Number(getSetting('sync.intervalHours')) || 6,
    timeOfDay: getSetting('sync.timeOfDay') ?? '03:00',
  };
}

function lastRunMs(): number | null {
  const ms = Date.parse(getSetting('sync.lastRunAt') ?? '');
  return Number.isNaN(ms) ? null : ms;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// When the next automatic sync will run, or null when it's off. Intervals count
// from the last sync of any kind — so syncing by hand pushes the next automatic
// one back — rounded down to the minute to line up with the scheduler's tick.
export function nextScheduledSync(now = new Date()): Date | null {
  const { mode, intervalHours, timeOfDay } = getSyncSchedule();
  if (mode === 'interval') {
    const last = lastRunMs();
    return last === null ? now : new Date(Math.floor(last / 60_000) * 60_000 + intervalHours * 3_600_000);
  }
  if (mode === 'daily') {
    const [h, m] = timeOfDay.split(':').map(Number);
    const next = new Date(now);
    next.setHours(h!, m!, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }
  return null;
}

function isSyncDue(now: Date): boolean {
  const { mode, timeOfDay } = getSyncSchedule();
  if (mode === 'interval') return nextScheduledSync(now)!.getTime() <= now.getTime();
  if (mode === 'daily') {
    const last = lastRunMs();
    // restart guard, and skips the run if the library was synced by hand moments ago
    return hhmm(now) === timeOfDay && (last === null || now.getTime() - last > 90_000);
  }
  return false;
}

// Called every minute by the scheduler.
export function runDueLibrarySync(now: Date): void {
  if (isSyncRunning() || !getConfiguredSources().length || !isSyncDue(now)) return;
  logger.info('scheduled library sync starting');
  // Failures are already logged per source and recorded for the admin page.
  runLibrarySync().catch(() => {});
}

// The schedule and the last sync's outcome, for the admin settings payload.
export function syncStatus() {
  const { mode, intervalHours, timeOfDay } = getSyncSchedule();
  return {
    syncMode: mode,
    syncIntervalHours: intervalHours,
    syncTimeOfDay: timeOfDay,
    lastSyncAt: getSetting('sync.lastRunAt'),
    lastSyncError: getSetting('sync.lastError'),
    nextSyncAt: nextScheduledSync()?.toISOString() ?? null,
    syncRunning: isSyncRunning(),
    serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
