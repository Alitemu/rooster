CREATE TABLE `__new_dienstrooster_shift_slot` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`datum` text NOT NULL,
	`iso_jaar` integer NOT NULL,
	`iso_week` integer NOT NULL,
	`weekend_id` text,
	`is_feestdag` integer DEFAULT false NOT NULL,
	`feestdag_naam` text,
	`feestdag_groep` text CHECK(`feestdag_groep` IN ('NIEUWJAAR', 'PASEN', 'KONINGSDAG', 'BEVRIJDINGSDAG', 'HEMELVAART', 'PINKSTEREN', 'KERST')),
	`benodigd_aantal_personen` integer DEFAULT 1 NOT NULL,
	`shift_block_id` text,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_type_id`) REFERENCES `dienstrooster_shift_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_dienstrooster_shift_slot`("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") SELECT "id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id" FROM `dienstrooster_shift_slot`;
--> statement-breakpoint
DROP TABLE `dienstrooster_shift_slot`;
--> statement-breakpoint
ALTER TABLE `__new_dienstrooster_shift_slot` RENAME TO `dienstrooster_shift_slot`;
--> statement-breakpoint
CREATE INDEX `slot_period_idx` ON `dienstrooster_shift_slot` (`period_id`);
--> statement-breakpoint
CREATE INDEX `slot_datum_idx` ON `dienstrooster_shift_slot` (`datum`);
--> statement-breakpoint
CREATE TABLE `__new_dienstrooster_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`entiteit` text NOT NULL,
	`entiteit_id` text NOT NULL,
	`actie` text NOT NULL CHECK(`actie` IN ('CREATE', 'UPDATE', 'DELETE', 'PUBLISH', 'IMPORT', 'GENERATE_ROSTER', 'MANUAL_ASSIGN', 'CANCEL', 'REJECT', 'APPROVE')),
	`oud_json` text,
	`nieuw_json` text,
	`tijdstip` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_dienstrooster_audit_log`("id", "actor_id", "entiteit", "entiteit_id", "actie", "oud_json", "nieuw_json", "tijdstip") SELECT "id", "actor_id", "entiteit", "entiteit_id", "actie", "oud_json", "nieuw_json", "tijdstip" FROM `dienstrooster_audit_log`;
--> statement-breakpoint
DROP TABLE `dienstrooster_audit_log`;
--> statement-breakpoint
ALTER TABLE `__new_dienstrooster_audit_log` RENAME TO `dienstrooster_audit_log`;
--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `dienstrooster_audit_log` (`actor_id`);
--> statement-breakpoint
CREATE INDEX `audit_entiteit_idx` ON `dienstrooster_audit_log` (`entiteit`,`entiteit_id`);
