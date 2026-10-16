CREATE TABLE `dienstrooster_aios_ruil` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`aanvrager_id` text NOT NULL,
	`respondent_id` text NOT NULL,
	`aangeboden_json` text NOT NULL,
	`gevraagd_json` text NOT NULL,
	`status` text NOT NULL,
	`toelichting` text,
	`reden_afwijzing` text,
	`aangemaakt_op` text NOT NULL,
	`beantwoord_op` text,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`aanvrager_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`respondent_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "aios_ruil_status_check" CHECK("dienstrooster_aios_ruil"."status" IN ('IN_BEHANDELING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN', 'VERVALLEN'))
);
--> statement-breakpoint
CREATE INDEX `aios_ruil_periode_idx` ON `dienstrooster_aios_ruil` (`period_id`);
