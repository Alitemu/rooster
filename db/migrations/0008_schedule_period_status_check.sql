CREATE TABLE `__new_dienstrooster_schedule_period` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`naam` text NOT NULL,
	`start_datum` text NOT NULL,
	`eind_datum` text NOT NULL,
	`deadline` text NOT NULL,
	`status` text DEFAULT 'CONCEPT' NOT NULL CHECK(`status` IN ('CONCEPT', 'OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD')),
	`bevroren_ruleset_json` text,
	`overloop_bevestigd_op` text,
	`gepubliceerd_op` text,
	`gepubliceerd_door_person_id` text,
	`row_version` integer DEFAULT 1 NOT NULL,
	`aangemaakt_op` text NOT NULL,
	`verwijderd_op` text,
	FOREIGN KEY (`pool_id`) REFERENCES `dienstrooster_pool`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gepubliceerd_door_person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_dienstrooster_schedule_period`("id", "pool_id", "naam", "start_datum", "eind_datum", "deadline", "status", "bevroren_ruleset_json", "overloop_bevestigd_op", "gepubliceerd_op", "gepubliceerd_door_person_id", "row_version", "aangemaakt_op", "verwijderd_op") SELECT "id", "pool_id", "naam", "start_datum", "eind_datum", "deadline", "status", "bevroren_ruleset_json", "overloop_bevestigd_op", "gepubliceerd_op", "gepubliceerd_door_person_id", "row_version", "aangemaakt_op", "verwijderd_op" FROM `dienstrooster_schedule_period`;
--> statement-breakpoint
DROP TABLE `dienstrooster_schedule_period`;
--> statement-breakpoint
ALTER TABLE `__new_dienstrooster_schedule_period` RENAME TO `dienstrooster_schedule_period`;
