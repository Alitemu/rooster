CREATE TABLE `__new_dienstrooster_availability` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`blocking_level` text CHECK(`blocking_level` IN ('ABSOLUUT', 'LIEVER_NIET', 'VOORKEUR')),
	`source` text NOT NULL CHECK(`source` IN ('MANUAL', 'PARTTIME', 'ABSENCE')),
	`bron_pattern_id` text,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `dienstrooster_shift_slot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bron_pattern_id`) REFERENCES `dienstrooster_parttime_pattern`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_dienstrooster_availability`("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "aangemaakt_op") SELECT "id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "aangemaakt_op" FROM `dienstrooster_availability`;
--> statement-breakpoint
DROP TABLE `dienstrooster_availability`;
--> statement-breakpoint
ALTER TABLE `__new_dienstrooster_availability` RENAME TO `dienstrooster_availability`;
--> statement-breakpoint
CREATE UNIQUE INDEX `availability_uniq` ON `dienstrooster_availability` (`person_id`,`slot_id`);
