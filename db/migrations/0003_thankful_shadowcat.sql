DROP INDEX IF EXISTS `prior_assignment_uniq`;--> statement-breakpoint
CREATE UNIQUE INDEX `prior_assignment_uniq` ON `dienstrooster_prior_assignment` (`period_id`,`datum`,`teller`);