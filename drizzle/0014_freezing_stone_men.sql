CREATE TABLE `travel_planning_scene_jobs` (
	`token_hash` text NOT NULL,
	`job_id` text NOT NULL,
	`handoff_id` text NOT NULL,
	`source_intent_state_version` integer NOT NULL,
	`input_hash` text NOT NULL,
	`query_json` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`poll_owner` text,
	`poll_expires_at` integer,
	PRIMARY KEY(`token_hash`, `job_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_travel_scene_jobs_updated` ON `travel_planning_scene_jobs` (`updated_at`);