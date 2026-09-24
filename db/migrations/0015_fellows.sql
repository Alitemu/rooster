ALTER TABLE `dienstrooster_availability` ADD `fellow_blok` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE `dienstrooster_period_fellow` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`person_id` text NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `period_fellow_uniq` ON `dienstrooster_period_fellow` (`period_id`,`person_id`);
