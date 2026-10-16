CREATE TABLE `dienstrooster_aios_doel` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`person_id` text NOT NULL,
	`doel_punten` real NOT NULL,
	`doel_feestdagen` real NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aios_doel_uniq` ON `dienstrooster_aios_doel` (`period_id`,`person_id`);
--> statement-breakpoint
CREATE TABLE `dienstrooster_aios_beginstand` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`person_id` text NOT NULL,
	`nachten` integer NOT NULL,
	`avonden` integer NOT NULL,
	`avonden_weekend` integer NOT NULL,
	`dagdiensten` integer NOT NULL,
	`uitloopdiensten` integer NOT NULL,
	`feestdagdiensten` integer NOT NULL,
	`fte` real NOT NULL,
	`maanden` real NOT NULL,
	`ingelezen_op` text NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `dienstrooster_pool`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aios_beginstand_uniq` ON `dienstrooster_aios_beginstand` (`pool_id`,`person_id`);
