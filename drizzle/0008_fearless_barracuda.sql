CREATE TABLE `travel_agent_turns` (
	`token_hash` text NOT NULL,
	`turn_id` text NOT NULL,
	`session_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`status` text NOT NULL,
	`input_event_id` text,
	`input_created_at` text,
	`reply_text` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`token_hash`, `turn_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_travel_agent_turns_created` ON `travel_agent_turns` (`created_at`);