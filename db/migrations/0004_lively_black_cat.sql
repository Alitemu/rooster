CREATE TABLE `__new_dienstrooster_notification` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`periode_id` text,
	`type` text NOT NULL CHECK(`type` IN ('ROSTER_GEREED', 'TOEWIJZING', 'RUILVERZOEK', 'RUIL_GOEDGEKEURD', 'RUIL_AFGEWEZEN', 'PUBLICATIE_BERICHT', 'BLOCK_OVERRIDDEN')),
	`onderwerp` text NOT NULL,
	`inhoud` text NOT NULL,
	`gelezen` integer DEFAULT false NOT NULL,
	`gesloten_op` text,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`periode_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_dienstrooster_notification`("id", "person_id", "periode_id", "type", "onderwerp", "inhoud", "gelezen", "gesloten_op", "aangemaakt_op") SELECT "id", "person_id", "periode_id", "type", "onderwerp", "inhoud", "gelezen", "gesloten_op", "aangemaakt_op" FROM `dienstrooster_notification`;
--> statement-breakpoint
DROP TABLE `dienstrooster_notification`;
--> statement-breakpoint
ALTER TABLE `__new_dienstrooster_notification` RENAME TO `dienstrooster_notification`;
--> statement-breakpoint
CREATE INDEX `notification_person_idx` ON `dienstrooster_notification` (`person_id`);
--> statement-breakpoint
CREATE INDEX `notification_type_idx` ON `dienstrooster_notification` (`type`);
