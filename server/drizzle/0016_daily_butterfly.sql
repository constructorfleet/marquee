DROP INDEX `users_username_unique`;--> statement-breakpoint
-- Usernames that differ only in capitals can't coexist under the new rule: the
-- oldest account keeps its name and later ones get their id appended
-- ("michael" -> "michael-14"). Run twice in case an appended name was taken.
UPDATE `users` SET `username` = `username` || '-' || `id` WHERE `id` NOT IN (SELECT min(`id`) FROM `users` GROUP BY lower(`username`));--> statement-breakpoint
UPDATE `users` SET `username` = `username` || '-' || `id` WHERE `id` NOT IN (SELECT min(`id`) FROM `users` GROUP BY lower(`username`));--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_lower_unique` ON `users` (lower("username"));
