CREATE TABLE `dienstrooster_aios_wens` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`person_id` text NOT NULL,
	`vier_avonden` integer DEFAULT false NOT NULL,
	`vier_nachten` integer DEFAULT false NOT NULL,
	`twee_dagdiensten` integer DEFAULT false NOT NULL,
	`inwerken_van` text,
	`inwerken_tot` text,
	`onderbreking_van` text,
	`onderbreking_tot` text,
	`opmerking` text,
	`gewijzigd_op` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aios_wens_uniq` ON `dienstrooster_aios_wens` (`period_id`,`person_id`);
--> statement-breakpoint
CREATE TABLE `dienstrooster_aios_periode` (
	`period_id` text PRIMARY KEY NOT NULL,
	`uitgenodigd_op` text,
	`basis_url` text,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE cascade
);
