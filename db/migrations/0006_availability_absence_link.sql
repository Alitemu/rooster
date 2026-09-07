ALTER TABLE `dienstrooster_availability` ADD `bron_absence_id` text REFERENCES dienstrooster_absence(id);
