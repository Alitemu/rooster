CREATE INDEX `availability_slot_idx` ON `dienstrooster_availability` (`slot_id`);
--> statement-breakpoint
CREATE INDEX `assignment_slot_idx` ON `dienstrooster_assignment` (`slot_id`);
--> statement-breakpoint
CREATE INDEX `assignment_person_idx` ON `dienstrooster_assignment` (`person_id`);
