CREATE TABLE `dienstrooster_mail_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`swap_id` text,
	`soort` text NOT NULL,
	`melding_json` text NOT NULL,
	`pogingen` integer DEFAULT 0 NOT NULL,
	`laatste_poging_op` text,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
