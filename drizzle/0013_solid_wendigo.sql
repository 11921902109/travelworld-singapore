CREATE TABLE `travel_planning_agent_locks` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL,
	`visit_created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `travel_planning_hotel_jobs` (
	`token_hash` text NOT NULL,
	`job_id` text NOT NULL,
	`handoff_id` text NOT NULL,
	`source_intent_state_version` integer NOT NULL,
	`input_hash` text NOT NULL,
	`query_json` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`poll_owner` text,
	`poll_expires_at` integer,
	PRIMARY KEY(`token_hash`, `job_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_travel_hotel_jobs_updated` ON `travel_planning_hotel_jobs` (`updated_at`);