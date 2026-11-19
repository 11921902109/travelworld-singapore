ALTER TABLE `activities` ADD `organizer_contact_type` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `organizer_contact_value` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `is_recurring` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `activities` ADD `gender_policy` text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE `activities` ADD `min_people` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `activities` ADD `max_people` integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE `activities` ADD `application_deadline` text;--> statement-breakpoint
ALTER TABLE `registrations` ADD `contact_type` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `registrations` ADD `contact_value` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `registrations` ADD `applicant_gender` text DEFAULT 'undisclosed' NOT NULL;