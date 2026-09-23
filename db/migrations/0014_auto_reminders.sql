ALTER TABLE `dienstrooster_schedule_period` ADD `auto_herinneren` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `dienstrooster_schedule_period` ADD `basis_url` text;
--> statement-breakpoint
CREATE TABLE `dienstrooster_reminder_run` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`dagen_voor_deadline` integer NOT NULL,
	`deadline` text NOT NULL,
	`moment` text NOT NULL,
	`uitkomst` text NOT NULL CHECK(`uitkomst` IN ('VERSTUURD', 'OVERGESLAGEN')),
	`aantal_niet_begonnen` integer DEFAULT 0 NOT NULL,
	`aantal_bezig` integer DEFAULT 0 NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_run_moment_uniq` ON `dienstrooster_reminder_run` (`period_id`,`dagen_voor_deadline`,`deadline`);
