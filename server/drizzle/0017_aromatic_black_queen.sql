ALTER TABLE `votes` ADD `voter_network` text;--> statement-breakpoint
-- Public-poll guests used the name they typed as their username, which could
-- take a real person's name. Move them to internal names (the typed name is
-- already kept on their votes). OR IGNORE: a clash leaves that guest's name as
-- it was rather than failing the upgrade.
UPDATE OR IGNORE `users` SET `username` = 'guest-' || substr(`guest_id`, 1, 6) WHERE `guest_id` IS NOT NULL;--> statement-breakpoint
UPDATE OR IGNORE `users` SET `username` = 'guest-' || substr(`guest_id`, 1, 6) || '-' || `id` WHERE `guest_id` IS NOT NULL AND `username` <> 'guest-' || substr(`guest_id`, 1, 6);
