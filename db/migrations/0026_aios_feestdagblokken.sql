ALTER TABLE `dienstrooster_aios_periode` ADD `oudjaar_aantal` integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
CREATE TABLE `dienstrooster_aios_blokkeuze` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`blok_id` text NOT NULL,
	`opknippen` integer NOT NULL,
	`gekozen_op` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blok_id`) REFERENCES `dienstrooster_shift_block`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aios_blokkeuze_uniq` ON `dienstrooster_aios_blokkeuze` (`period_id`,`blok_id`);
