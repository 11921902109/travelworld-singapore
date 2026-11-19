CREATE TABLE `travel_shared_trips` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_travel_shared_trips_expires` ON `travel_shared_trips` (`expires_at`);