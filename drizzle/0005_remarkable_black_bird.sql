CREATE TABLE `admin_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_admin_audit_created` ON `admin_audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admin_audit_target` ON `admin_audit_logs` (`target_type`,`target_id`);--> statement-breakpoint
ALTER TABLE `activities` ADD `review_note` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `reviewed_by` text;