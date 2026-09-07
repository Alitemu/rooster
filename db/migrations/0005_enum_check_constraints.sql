CREATE TABLE `__new_dienstrooster_absence` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`van_datum` text NOT NULL,
	`tot_datum` text NOT NULL,
	`soort` text NOT NULL CHECK(`soort` IN ('VAKANTIE', 'ZIEK', 'VERLOF', 'OVERIG')),
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
--> statement-breakpoint
CREATE TABLE `__new_dienstrooster_holiday_history` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`feestdag_groep` text NOT NULL CHECK(`feestdag_groep` IN ('NIEUWJAAR', 'PASEN', 'KONINGSDAG', 'BEVRIJDINGSDAG', 'HEMELVAART', 'PINKSTEREN', 'KERST')),
	`jaar` integer NOT NULL,
	`bron` text NOT NULL CHECK(`bron` IN ('SYSTEEM', 'IMPORT', 'HANDMATIG')),
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_dienstrooster_holiday_history`("id", "person_id", "feestdag_groep", "jaar", "bron") SELECT "id", "person_id", "feestdag_groep", "jaar", "bron" FROM `dienstrooster_holiday_history`;
--> statement-breakpoint
DROP TABLE `dienstrooster_holiday_history`;
--> statement-breakpoint
ALTER TABLE `__new_dienstrooster_holiday_history` RENAME TO `dienstrooster_holiday_history`;
--> statement-breakpoint
CREATE UNIQUE INDEX `holiday_history_uniq` ON `dienstrooster_holiday_history` (`person_id`,`feestdag_groep`,`jaar`);
--> statement-breakpoint
CREATE TABLE `__new_dienstrooster_pool` (
	`id` text PRIMARY KEY NOT NULL,
	`naam` text NOT NULL,
	`type` text DEFAULT 'ACHTERWACHT' NOT NULL CHECK(`type` IN ('ACHTERWACHT', 'NEURO', 'KINDER', 'INTERVENTIE', 'AIOS')),
	`ruleset_id` text NOT NULL,
	`verdeelmodus` text DEFAULT 'GELIJK' NOT NULL CHECK(`verdeelmodus` IN ('GELIJK', 'NAAR_RATO')),
	`actief` integer DEFAULT true NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`ruleset_id`) REFERENCES `dienstrooster_ruleset`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_dienstrooster_pool`("id", "naam", "type", "ruleset_id", "verdeelmodus", "actief", "aangemaakt_op") SELECT "id", "naam", "type", "ruleset_id", "verdeelmodus", "actief", "aangemaakt_op" FROM `dienstrooster_pool`;
--> statement-breakpoint
DROP TABLE `dienstrooster_pool`;
--> statement-breakpoint
ALTER TABLE `__new_dienstrooster_pool` RENAME TO `dienstrooster_pool`;
