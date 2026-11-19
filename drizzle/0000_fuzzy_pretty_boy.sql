CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`organizer_name` text NOT NULL,
	`organizer_avatar` text,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`category_name` text NOT NULL,
	`description` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`area` text NOT NULL,
	`budget_max` integer NOT NULL,
	`budget` text NOT NULL,
	`time` text NOT NULL,
	`short_time` text NOT NULL,
	`people` text NOT NULL,
	`weather` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_activities_status_created` ON `activities` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_activities_owner` ON `activities` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `registrations` (
	`user_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`intent` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `activity_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_registrations_activity_status` ON `registrations` (`activity_id`,`status`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`user_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`rating` integer NOT NULL,
	`review` text NOT NULL,
	`tags_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `activity_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_reviews_activity` ON `reviews` (`activity_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `weekend_plans` (
	`user_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`status` text NOT NULL,
	`teammate_names_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `activity_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_weekend_plans_user_status` ON `weekend_plans` (`user_id`,`status`);