CREATE TABLE `dienstrooster_aios_generatie` (
	`period_id` text PRIMARY KEY NOT NULL,
	`gemaakt_op` text NOT NULL,
	`solver_status` text NOT NULL,
	`gevuld` integer NOT NULL,
	`tijd_seconden` real NOT NULL,
	`leeg_json` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `dienstrooster_schedule_period`(`id`) ON UPDATE no action ON DELETE cascade
);
