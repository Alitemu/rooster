ALTER TABLE `dienstrooster_pending_undo` ADD `onderdeel` text DEFAULT 'ROOSTER' NOT NULL;
--> statement-breakpoint
CREATE TABLE `dienstrooster_app_setting` (
	`sleutel` text PRIMARY KEY NOT NULL,
	`waarde` text NOT NULL,
	`gewijzigd_op` text NOT NULL,
	`gewijzigd_door` text,
	FOREIGN KEY (`gewijzigd_door`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
