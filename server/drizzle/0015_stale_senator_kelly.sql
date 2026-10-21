CREATE INDEX `poll_options_poll_id_idx` ON `poll_options` (`poll_id`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `votes_user_id_idx` ON `votes` (`user_id`);--> statement-breakpoint
CREATE INDEX `votes_option_id_idx` ON `votes` (`option_id`);