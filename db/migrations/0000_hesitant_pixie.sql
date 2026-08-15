CREATE TABLE `dienstrooster_absence` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`van_datum` text NOT NULL,
	`tot_datum` text NOT NULL,
	`soort` text NOT NULL,
	`notitie` text,
	`aangemaakt_door` text NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aangemaakt_door`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_version_id` text NOT NULL,
	`person_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`bron` text NOT NULL,
	`row_version` integer DEFAULT 1 NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `dienstrooster_shift_slot`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_assignment_edit` (
	`id` text PRIMARY KEY NOT NULL,
	`toewijzing_id` text NOT NULL,
	`periode_id` text NOT NULL,
	`person_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`edit_type` text NOT NULL CHECK(`edit_type` IN ('HANDMATIG_TOEWIJZEN', 'HANDMATIG_VERWIJDEREN', 'RUIL', 'OVERRIDE')),
	`oorspronkelijke_person_id` text,
	`reden` text,
	`bewerkt_door_person_id` text NOT NULL,
	`row_version` integer DEFAULT 1 NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`toewijzing_id`) REFERENCES `dienstrooster_assignment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`periode_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `dienstrooster_shift_slot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`oorspronkelijke_person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bewerkt_door_person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`entiteit` text NOT NULL,
	`entiteit_id` text NOT NULL,
	`actie` text NOT NULL,
	`oud_json` text,
	`nieuw_json` text,
	`tijdstip` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_availability` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`blocking_level` text,
	`source` text NOT NULL,
	`bron_pattern_id` text,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `dienstrooster_shift_slot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bron_pattern_id`) REFERENCES `dienstrooster_parttime_pattern`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_holiday_history` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`feestdag_groep` text NOT NULL,
	`jaar` integer NOT NULL,
	`bron` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_import_run` (
	`id` text PRIMARY KEY NOT NULL,
	`soort` text NOT NULL,
	`bestandsnaam` text NOT NULL,
	`aantal_regels` integer NOT NULL,
	`aantal_fouten` integer NOT NULL,
	`uitgevoerd_door` text NOT NULL,
	`uitgevoerd_op` text NOT NULL,
	`resultaat_json` text,
	FOREIGN KEY (`uitgevoerd_door`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_ledger_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`teller` text NOT NULL,
	`geldt_voor_periode_id` text NOT NULL,
	`datum` text,
	`delta` integer NOT NULL,
	`reden` text NOT NULL,
	`categorie` text NOT NULL,
	`aangemaakt_door` text NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pool_id`) REFERENCES `dienstrooster_pool`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`geldt_voor_periode_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aangemaakt_door`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_notification` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`periode_id` text,
	`type` text NOT NULL CHECK(`type` IN ('ROSTER_GEREED', 'TOEWIJZING', 'RUILVERZOEK', 'RUIL_GOEDGEKEURD', 'PUBLICATIE_BERICHT')),
	`onderwerp` text NOT NULL,
	`inhoud` text NOT NULL,
	`gelezen` integer DEFAULT false NOT NULL,
	`gesloten_op` text,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`periode_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_notification_log` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`period_id` text,
	`type` text NOT NULL,
	`opgesteld_op` text NOT NULL,
	`gemaild_op` text,
	`geexporteerd_op` text,
	`afgevinkt_op` text,
	`resultaat` text,
	`foutmelding` text,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_notification_template` (
	`id` text PRIMARY KEY NOT NULL,
	`sleutel` text NOT NULL,
	`onderwerp` text NOT NULL,
	`body_md` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_parttime_pattern` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`weekdag` text NOT NULL,
	`frequentie` text NOT NULL,
	`geldig_vanaf` text NOT NULL,
	`geldig_tot` text NOT NULL,
	`aangemaakt_door` text NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aangemaakt_door`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_period_excluded_day` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`datum` text NOT NULL,
	`reden` text NOT NULL,
	`bron_period_id` text,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bron_period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_person` (
	`id` text PRIMARY KEY NOT NULL,
	`codenaam` text NOT NULL,
	`rol` text NOT NULL,
	`actief` integer DEFAULT true NOT NULL,
	`wachtwoord_hash` text,
	`totp_secret` text,
	`aangemaakt_op` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_person_access_link` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`geldt_voor_periode_id` text,
	`aangemaakt_op` text NOT NULL,
	`ingetrokken_op` text,
	`laatst_gebruikt_op` text,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`geldt_voor_periode_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_pool` (
	`id` text PRIMARY KEY NOT NULL,
	`naam` text NOT NULL,
	`type` text DEFAULT 'ACHTERWACHT' NOT NULL,
	`ruleset_id` text NOT NULL,
	`verdeelmodus` text DEFAULT 'GELIJK' NOT NULL,
	`actief` integer DEFAULT true NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`ruleset_id`) REFERENCES `dienstrooster_ruleset`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_pool_membership` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`deelnamefactor` real DEFAULT 1 NOT NULL,
	`geldig_vanaf` text NOT NULL,
	`geldig_tot` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pool_id`) REFERENCES `dienstrooster_pool`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_prior_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`datum` text NOT NULL,
	`iso_jaar` integer NOT NULL,
	`iso_week` integer NOT NULL,
	`person_id` text,
	`teller` text NOT NULL,
	`bron` text NOT NULL,
	`bron_period_id` text,
	`aangemaakt_door` text NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bron_period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aangemaakt_door`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_reminder_schedule` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`dagen_voor_deadline` integer NOT NULL,
	`actief` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_ruleset` (
	`id` text PRIMARY KEY NOT NULL,
	`naam` text NOT NULL,
	`config_json` text NOT NULL,
	`versie` integer DEFAULT 1 NOT NULL,
	`aangemaakt_op` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_schedule_period` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`naam` text NOT NULL,
	`start_datum` text NOT NULL,
	`eind_datum` text NOT NULL,
	`deadline` text NOT NULL,
	`status` text DEFAULT 'CONCEPT' NOT NULL,
	`bevroren_ruleset_json` text,
	`overloop_bevestigd_op` text,
	`gepubliceerd_op` text,
	`gepubliceerd_door_person_id` text,
	`row_version` integer DEFAULT 1 NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `dienstrooster_pool`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gepubliceerd_door_person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_shift_slot` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`datum` text NOT NULL,
	`iso_jaar` integer NOT NULL,
	`iso_week` integer NOT NULL,
	`weekend_id` text,
	`is_feestdag` integer DEFAULT false NOT NULL,
	`feestdag_naam` text,
	`feestdag_groep` text,
	`benodigd_aantal_personen` integer DEFAULT 1 NOT NULL,
	`shift_block_id` text,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_type_id`) REFERENCES `dienstrooster_shift_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_shift_type` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`naam` text NOT NULL,
	`teller` text NOT NULL,
	`start_tijd` text,
	`eind_tijd` text,
	FOREIGN KEY (`pool_id`) REFERENCES `dienstrooster_pool`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_submission` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`schedule_period_id` text NOT NULL,
	`status` text NOT NULL,
	`ingediend_op` text,
	`row_version` integer DEFAULT 1 NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`schedule_period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dienstrooster_swap_request` (
	`id` text PRIMARY KEY NOT NULL,
	`periode_id` text NOT NULL,
	`aanvrager_person_id` text NOT NULL,
	`aangeboden_slot_id` text NOT NULL,
	`gevraagde_slot_id` text NOT NULL,
	`respondent_person_id` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL CHECK(`status` IN ('PENDING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN')),
	`aangemaakt_op` text NOT NULL,
	`beantwoord_op` text,
	`afgehandeld_door_person_id` text,
	`opmerkingen` text,
	`row_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`periode_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aanvrager_person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aangeboden_slot_id`) REFERENCES `dienstrooster_shift_slot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gevraagde_slot_id`) REFERENCES `dienstrooster_shift_slot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`respondent_person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`afgehandeld_door_person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignment_uniq` ON `dienstrooster_assignment` (`schedule_version_id`,`slot_id`);--> statement-breakpoint
CREATE INDEX `assignment_edit_periode_idx` ON `dienstrooster_assignment_edit` (`periode_id`);--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `dienstrooster_audit_log` (`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_entiteit_idx` ON `dienstrooster_audit_log` (`entiteit`,`entiteit_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `availability_uniq` ON `dienstrooster_availability` (`person_id`,`slot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `holiday_history_uniq` ON `dienstrooster_holiday_history` (`person_id`,`feestdag_groep`,`jaar`);--> statement-breakpoint
CREATE INDEX `ledger_person_period_idx` ON `dienstrooster_ledger_entry` (`person_id`,`geldt_voor_periode_id`);--> statement-breakpoint
CREATE INDEX `notification_person_idx` ON `dienstrooster_notification` (`person_id`);--> statement-breakpoint
CREATE INDEX `notification_type_idx` ON `dienstrooster_notification` (`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `dienstrooster_notification_template_sleutel_unique` ON `dienstrooster_notification_template` (`sleutel`);--> statement-breakpoint
CREATE UNIQUE INDEX `parttime_pattern_uniq` ON `dienstrooster_parttime_pattern` (`person_id`,`weekdag`,`geldig_vanaf`,`geldig_tot`);--> statement-breakpoint
CREATE UNIQUE INDEX `period_excluded_day_uniq` ON `dienstrooster_period_excluded_day` (`period_id`,`datum`);--> statement-breakpoint
CREATE UNIQUE INDEX `dienstrooster_person_codenaam_unique` ON `dienstrooster_person` (`codenaam`);--> statement-breakpoint
CREATE UNIQUE INDEX `dienstrooster_person_access_link_token_hash_unique` ON `dienstrooster_person_access_link` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `pool_membership_uniq` ON `dienstrooster_pool_membership` (`person_id`,`pool_id`,`geldig_vanaf`,`geldig_tot`);--> statement-breakpoint
CREATE UNIQUE INDEX `prior_assignment_uniq` ON `dienstrooster_prior_assignment` (`period_id`,`datum`);--> statement-breakpoint
CREATE INDEX `slot_period_idx` ON `dienstrooster_shift_slot` (`period_id`);--> statement-breakpoint
CREATE INDEX `slot_datum_idx` ON `dienstrooster_shift_slot` (`datum`);--> statement-breakpoint
CREATE UNIQUE INDEX `submission_uniq` ON `dienstrooster_submission` (`person_id`,`schedule_period_id`);--> statement-breakpoint
CREATE INDEX `swap_request_periode_idx` ON `dienstrooster_swap_request` (`periode_id`);--> statement-breakpoint
CREATE INDEX `swap_request_status_idx` ON `dienstrooster_swap_request` (`status`);