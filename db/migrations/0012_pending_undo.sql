CREATE TABLE `dienstrooster_pending_undo` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL CHECK(`scope` IN ('PERIOD_ASSIGNMENT', 'POOL_MEMBERSHIP')),
	`scope_id` text NOT NULL,
	`action_type` text NOT NULL CHECK(`action_type` IN ('ASSIGN', 'REASSIGN', 'REMOVE', 'MEMBERSHIP_DELETE')),
	`payload_json` text NOT NULL,
	`label` text NOT NULL,
	`actor_id` text NOT NULL,
	`aangemaakt_op` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `dienstrooster_person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_undo_scope_id_uniq` ON `dienstrooster_pending_undo` (`scope_id`);
