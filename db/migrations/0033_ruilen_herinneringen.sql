ALTER TABLE `dienstrooster_swap_request` ADD `laatste_herinnering_op` text;
--> statement-breakpoint
ALTER TABLE `dienstrooster_swap_request` ADD `laatste_herinnering_door` text;
--> statement-breakpoint
ALTER TABLE `dienstrooster_aios_ruil` ADD `gezien_op` text;
--> statement-breakpoint
ALTER TABLE `dienstrooster_aios_ruil` ADD `laatste_herinnering_op` text;
--> statement-breakpoint
ALTER TABLE `dienstrooster_aios_ruil` ADD `laatste_herinnering_door` text;
--> statement-breakpoint
CREATE TABLE `dienstrooster_aios_mail_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`ruil_id` text,
	`soort` text NOT NULL,
	`melding_json` text NOT NULL,
	`pogingen` integer DEFAULT 0 NOT NULL,
	`laatste_poging_op` text,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
UPDATE `dienstrooster_aios_ruil` SET `status` = 'INGETROKKEN' WHERE `status` = 'VERVALLEN';
--> statement-breakpoint
UPDATE `dienstrooster_aios_ruil` SET `status` = 'INGETROKKEN', `reden_afwijzing` = 'Het rooster is nog voorlopig.', `beantwoord_op` = datetime('now')
WHERE `status` = 'IN_BEHANDELING' AND `period_id` IN (SELECT `id` FROM `dienstrooster_schedule_period` WHERE `definitief_op` IS NULL);
--> statement-breakpoint
UPDATE `dienstrooster_swap_request` SET `status` = 'INGETROKKEN', `reden_afwijzing` = 'Het rooster is nog voorlopig.', `beantwoord_op` = datetime('now')
WHERE `status` = 'PENDING' AND `periode_id` IN (SELECT `id` FROM `dienstrooster_schedule_period` WHERE `definitief_op` IS NULL);
