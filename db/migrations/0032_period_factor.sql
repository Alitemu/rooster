CREATE TABLE `dienstrooster_period_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`person_id` text NOT NULL,
	`factor` real NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `period_factor_uniq` ON `dienstrooster_period_factor` (`period_id`,`person_id`);
