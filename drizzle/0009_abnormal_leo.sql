CREATE TABLE `travel_intent_states` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`state_version` integer NOT NULL,
	`result_json` text,
	`slot_meta_json` text NOT NULL,
	`last_turn_id` text,
	`last_input_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_travel_intent_states_updated` ON `travel_intent_states` (`updated_at`);--> statement-breakpoint
CREATE TABLE `travel_intent_turns` (
	`token_hash` text NOT NULL,
	`turn_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`state_version` integer NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`token_hash`, `turn_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_travel_intent_turns_created` ON `travel_intent_turns` (`created_at`);