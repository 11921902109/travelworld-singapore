CREATE TABLE `travel_planning_draft_turns` (
	`token_hash` text NOT NULL,
	`turn_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`draft_version` integer NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`token_hash`, `turn_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_travel_planning_draft_turns_created` ON `travel_planning_draft_turns` (`created_at`);--> statement-breakpoint
CREATE TABLE `travel_planning_drafts` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`handoff_id` text NOT NULL,
	`source_intent_state_version` integer NOT NULL,
	`draft_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_travel_planning_drafts_updated` ON `travel_planning_drafts` (`updated_at`);--> statement-breakpoint
CREATE TABLE `travel_planning_handoffs` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`handoff_id` text NOT NULL,
	`source_intent_state_version` integer NOT NULL,
	`handoff_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_travel_planning_handoffs_updated` ON `travel_planning_handoffs` (`updated_at`);--> statement-breakpoint
ALTER TABLE `travel_agent_visits` ADD `planning_session_id` text;--> statement-breakpoint
ALTER TABLE `travel_agent_visits` ADD `planning_intent_version` integer;