ALTER TABLE `dienstrooster_schedule_period` ADD `definitief_op` text;--> statement-breakpoint
ALTER TABLE `dienstrooster_schedule_period` ADD `definitief_door_person_id` text REFERENCES dienstrooster_person(id);--> statement-breakpoint
ALTER TABLE `dienstrooster_schedule_period` ADD `voorlopig_rooster_json` text;--> statement-breakpoint
UPDATE `dienstrooster_schedule_period`
SET `definitief_op` = `gepubliceerd_op`, `definitief_door_person_id` = `gepubliceerd_door_person_id`
WHERE `status` = 'GEPUBLICEERD';
