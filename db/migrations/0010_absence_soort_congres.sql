CREATE TABLE `__new_dienstrooster_absence` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`van_datum` text NOT NULL,
	`tot_datum` text NOT NULL,
	`soort` text NOT NULL CHECK(`soort` IN ('VAKANTIE', 'ZIEK', 'VERLOF', 'CONGRES', 'OVERIG')),
	`notitie` text,
	`aangemaakt_door` text NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aangemaakt_door`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_dienstrooster_absence`("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") SELECT "id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op" FROM `dienstrooster_absence`;
--> statement-breakpoint
DROP TABLE `dienstrooster_absence`;
--> statement-breakpoint
ALTER TABLE `__new_dienstrooster_absence` RENAME TO `dienstrooster_absence`;
