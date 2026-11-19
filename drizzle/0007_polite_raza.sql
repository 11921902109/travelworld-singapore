CREATE TABLE `travel_agent_visits` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_travel_agent_visits_expires` ON `travel_agent_visits` (`expires_at`);