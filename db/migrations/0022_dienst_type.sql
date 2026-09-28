ALTER TABLE `dienstrooster_person` ADD `dienst_type` text;--> statement-breakpoint
UPDATE `dienstrooster_person` SET `dienst_type` = 'ACHTERWACHT' WHERE `rol` IN ('ADMIN', 'PLANNER');
