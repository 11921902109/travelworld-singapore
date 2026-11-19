CREATE TABLE IF NOT EXISTS `travel_planning_help_sessions` (
	`token_hash` text NOT NULL,
	`handoff_id` text NOT NULL,
	`visit_created_at` integer NOT NULL,
	`session_id` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`token_hash`, `handoff_id`, `visit_created_at`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_travel_help_sessions_updated` ON `travel_planning_help_sessions` (`updated_at`);
