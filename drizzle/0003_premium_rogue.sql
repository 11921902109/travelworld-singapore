ALTER TABLE `activities` ADD `source_activity_id` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `ends_at` text;--> statement-breakpoint
CREATE INDEX `idx_activities_source` ON `activities` (`source_activity_id`);