ALTER TABLE `dienstrooster_shift_type` ADD `code` text;
--> statement-breakpoint
ALTER TABLE `dienstrooster_shift_type` ADD `soort` text CHECK(`soort` IN ('UITLOOP', 'DAG', 'AVOND', 'NACHT'));
--> statement-breakpoint
ALTER TABLE `dienstrooster_shift_type` ADD `punten` real;
--> statement-breakpoint
CREATE TABLE `dienstrooster_shift_block` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`soort` text NOT NULL CHECK(`soort` IN ('AVOND', 'NACHT')),
	`vorm` text NOT NULL CHECK(`vorm` IN ('ZO_DI', 'WO_VR', 'ZA', 'LOS')),
	`start_datum` text NOT NULL,
	`eind_datum` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shift_block_period_idx` ON `dienstrooster_shift_block` (`period_id`);
