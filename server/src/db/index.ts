import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import * as schema from './schema.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

const sqlite = new Database(config.databasePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// SQLite's full integrity check, returning the problems it found ([] when
// healthy). Deliberately not quick_check: that skips comparing each index with
// its table, which is exactly the damage that once hid every user for months.
export function checkIntegrity(maxProblems: number): string[] {
  const rows = sqlite.pragma(`integrity_check(${maxProblems})`) as { integrity_check: string }[];
  const problems = rows.map((r) => r.integrity_check);
  return problems.length === 1 && problems[0] === 'ok' ? [] : problems;
}

// Checkpoints the WAL into the main file, so a stopped container leaves one tidy marquee.db.
export function closeDatabase() {
  if (sqlite.open) sqlite.close();
}

export function runMigrations() {
  // Works from both src (tsx) and dist (compiled): the drizzle folder sits at the server root.
  migrate(db, { migrationsFolder: path.join(import.meta.dirname, '../../drizzle') });
}
