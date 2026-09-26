ALTER TABLE `dienstrooster_schedule_period` ADD `uitgenodigd_op` text;--> statement-breakpoint
UPDATE `dienstrooster_schedule_period` SET `uitgenodigd_op` = `aangemaakt_op`
WHERE `id` = (
	SELECT `id` FROM `dienstrooster_schedule_period`
	WHERE `verwijderd_op` IS NULL AND `status` != 'CONCEPT' AND `basis_url` IS NOT NULL
	ORDER BY `start_datum` DESC LIMIT 1
);
