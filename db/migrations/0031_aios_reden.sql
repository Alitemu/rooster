CREATE TABLE `dienstrooster_aios_reden` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`person_id` text NOT NULL,
	`datum` text NOT NULL,
	`tekst` text NOT NULL,
	`gewijzigd_op` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aios_reden_uniq` ON `dienstrooster_aios_reden` (`period_id`,`person_id`,`datum`);
