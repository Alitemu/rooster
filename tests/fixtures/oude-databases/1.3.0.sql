CREATE TABLE dienstrooster_absence (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      van_datum TEXT NOT NULL,
      tot_datum TEXT NOT NULL,
      soort TEXT NOT NULL
        CHECK(soort IN ('VAKANTIE', 'CONGRES', 'ONDERWIJS', 'OVERIG')),
      notitie TEXT,
      aangemaakt_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_aios_beginstand (
      id TEXT PRIMARY KEY NOT NULL,
      pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id) ON DELETE CASCADE,
      nachten INTEGER NOT NULL,
      avonden INTEGER NOT NULL,
      avonden_weekend INTEGER NOT NULL,
      dagdiensten INTEGER NOT NULL,
      uitloopdiensten INTEGER NOT NULL,
      feestdagdiensten INTEGER NOT NULL,
      fte REAL NOT NULL,
      maanden REAL NOT NULL,
      ingelezen_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_aios_blokkeuze (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id) ON DELETE CASCADE,
      blok_id TEXT NOT NULL REFERENCES dienstrooster_shift_block(id) ON DELETE CASCADE,
      opknippen INTEGER NOT NULL,
      gekozen_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_aios_doel (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id) ON DELETE CASCADE,
      doel_punten REAL NOT NULL,
      doel_feestdagen REAL NOT NULL,
      doel_nachten REAL,
      doel_dagen REAL,
      doel_weekendavonden REAL,
      doel_weekavonden REAL,
      doel_uitloopdiensten REAL
    );
CREATE TABLE dienstrooster_aios_generatie (
      period_id TEXT PRIMARY KEY NOT NULL REFERENCES dienstrooster_schedule_period(id) ON DELETE CASCADE,
      gemaakt_op TEXT NOT NULL,
      solver_status TEXT NOT NULL,
      gevuld INTEGER NOT NULL,
      tijd_seconden REAL NOT NULL,
      leeg_json TEXT NOT NULL
    );
CREATE TABLE dienstrooster_aios_mail_queue (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      ruil_id TEXT,
      soort TEXT NOT NULL,
      melding_json TEXT NOT NULL,
      pogingen INTEGER NOT NULL DEFAULT 0,
      laatste_poging_op TEXT,
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_aios_periode (
      period_id TEXT PRIMARY KEY NOT NULL REFERENCES dienstrooster_schedule_period(id) ON DELETE CASCADE,
      uitgenodigd_op TEXT,
      basis_url TEXT,
      auto_herinneren INTEGER NOT NULL DEFAULT 1,
      oudjaar_aantal INTEGER NOT NULL DEFAULT 2,
      voortgangstoets TEXT
    );
CREATE TABLE dienstrooster_aios_reden (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id) ON DELETE CASCADE,
      datum TEXT NOT NULL,
      tekst TEXT NOT NULL,
      gewijzigd_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_aios_ruil (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id) ON DELETE CASCADE,
      aanvrager_id TEXT NOT NULL REFERENCES dienstrooster_person(id) ON DELETE CASCADE,
      respondent_id TEXT NOT NULL REFERENCES dienstrooster_person(id) ON DELETE CASCADE,
      aangeboden_json TEXT NOT NULL,
      gevraagd_json TEXT NOT NULL,
      status TEXT NOT NULL,
      toelichting TEXT,
      reden_afwijzing TEXT,
      aangemaakt_op TEXT NOT NULL,
      beantwoord_op TEXT,
      gezien_op TEXT,
      laatste_herinnering_op TEXT,
      laatste_herinnering_door TEXT,
      CONSTRAINT aios_ruil_status_check CHECK(status IN ('IN_BEHANDELING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN', 'VERVALLEN'))
    );
CREATE TABLE dienstrooster_aios_wens (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id) ON DELETE CASCADE,
      vier_avonden INTEGER NOT NULL DEFAULT 0,
      vier_nachten INTEGER NOT NULL DEFAULT 0,
      twee_dagdiensten INTEGER NOT NULL DEFAULT 0,
      inwerken_van TEXT,
      inwerken_tot TEXT,
      onderbreking_van TEXT,
      onderbreking_tot TEXT,
      opmerking TEXT,
      gewijzigd_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_app_setting (
      sleutel TEXT PRIMARY KEY NOT NULL,
      waarde TEXT NOT NULL,
      gewijzigd_op TEXT NOT NULL,
      gewijzigd_door TEXT REFERENCES dienstrooster_person(id)
    );
CREATE TABLE dienstrooster_assignment (
      id TEXT PRIMARY KEY NOT NULL,
      schedule_version_id TEXT NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      bron TEXT NOT NULL CHECK(bron IN ('SOLVER', 'MANUAL', 'OVERRIDE')),
      row_version INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_assignment_edit (
      id TEXT PRIMARY KEY NOT NULL,
      -- no FK to assignment: this row records deletions too and must outlive them
      toewijzing_id TEXT NOT NULL,
      periode_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      edit_type TEXT NOT NULL CHECK(edit_type IN ('HANDMATIG_TOEWIJZEN', 'HANDMATIG_VERWIJDEREN', 'RUIL', 'OVERRIDE')),
      oorspronkelijke_person_id TEXT REFERENCES dienstrooster_person(id),
      reden TEXT,
      bewerkt_door_person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      row_version INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_audit_log (
      id TEXT PRIMARY KEY NOT NULL,
      actor_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      entiteit TEXT NOT NULL,
      entiteit_id TEXT NOT NULL,
      actie TEXT NOT NULL
        CHECK(actie IN ('CREATE', 'UPDATE', 'DELETE', 'PUBLISH', 'IMPORT', 'GENERATE_ROSTER', 'MANUAL_ASSIGN', 'CANCEL', 'REJECT', 'APPROVE')),
      oud_json TEXT,
      nieuw_json TEXT,
      tijdstip TEXT NOT NULL
    );
CREATE TABLE dienstrooster_availability (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      blocking_level TEXT CHECK(blocking_level IN ('ABSOLUUT', 'LIEVER_NIET', 'VOORKEUR')),
      source TEXT NOT NULL CHECK(source IN ('MANUAL', 'PARTTIME', 'ABSENCE')),
      bron_pattern_id TEXT REFERENCES dienstrooster_parttime_pattern(id),
      bron_absence_id TEXT REFERENCES dienstrooster_absence(id),
      fellow_blok INTEGER NOT NULL DEFAULT 0,
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_holiday_history (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      feestdag_groep TEXT NOT NULL
        CHECK(feestdag_groep IN ('NIEUWJAAR', 'PASEN', 'KONINGSDAG', 'BEVRIJDINGSDAG', 'HEMELVAART', 'PINKSTEREN', 'KERST')),
      jaar INTEGER NOT NULL,
      bron TEXT NOT NULL
        CHECK(bron IN ('SYSTEEM', 'IMPORT', 'HANDMATIG'))
    );
CREATE TABLE dienstrooster_import_run (
      id TEXT PRIMARY KEY NOT NULL,
      soort TEXT NOT NULL CHECK(soort IN ('BEGINSALDI', 'FEESTDAG_HISTORIE')),
      bestandsnaam TEXT NOT NULL,
      aantal_regels INTEGER NOT NULL,
      aantal_fouten INTEGER NOT NULL,
      uitgevoerd_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      uitgevoerd_op TEXT NOT NULL,
      resultaat_json TEXT
    );
CREATE TABLE dienstrooster_ledger_entry (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id),
      teller TEXT NOT NULL CHECK(teller IN ('AVOND', 'WEEKEND', 'FEESTDAG')),
      geldt_voor_periode_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      datum TEXT,
      delta INTEGER NOT NULL,
      reden TEXT NOT NULL,
      categorie TEXT NOT NULL CHECK(categorie IN ('CARRY_OVER', 'CORRECTIE', 'BEGINSALDO')),
      aangemaakt_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_mail_queue (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      swap_id TEXT,
      soort TEXT NOT NULL,
      melding_json TEXT NOT NULL,
      pogingen INTEGER NOT NULL DEFAULT 0,
      laatste_poging_op TEXT,
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_notification (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      periode_id TEXT REFERENCES dienstrooster_schedule_period(id),
      type TEXT NOT NULL CHECK(type IN ('ROSTER_GEREED', 'TOEWIJZING', 'RUILVERZOEK', 'RUIL_GOEDGEKEURD', 'RUIL_AFGEWEZEN', 'PUBLICATIE_BERICHT', 'BLOCK_OVERRIDDEN')),
      onderwerp TEXT NOT NULL,
      inhoud TEXT NOT NULL,
      gelezen INTEGER NOT NULL DEFAULT 0,
      gesloten_op TEXT,
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_notification_log (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      period_id TEXT REFERENCES dienstrooster_schedule_period(id),
      type TEXT NOT NULL CHECK(type IN (
        'PERIOD_OPENED', 'PARTTIME_CHECK', 'REMINDER', 'FINAL_WARNING',
        'DEADLINE_PASSED', 'BLOCK_OVERRIDDEN', 'SCHEDULE_PUBLISHED',
        'SWAP_REQUESTED', 'SWAP_RESULT', 'CORRECTION_BOOKED'
      )),
      opgesteld_op TEXT NOT NULL,
      gemaild_op TEXT,
      geexporteerd_op TEXT,
      afgevinkt_op TEXT,
      resultaat TEXT,
      foutmelding TEXT
    );
CREATE TABLE dienstrooster_notification_template (
      id TEXT PRIMARY KEY NOT NULL,
      sleutel TEXT NOT NULL UNIQUE CHECK(sleutel IN (
        'PERIOD_OPENED', 'PARTTIME_CHECK', 'REMINDER', 'FINAL_WARNING',
        'DEADLINE_PASSED', 'BLOCK_OVERRIDDEN', 'SCHEDULE_PUBLISHED',
        'SWAP_REQUESTED', 'SWAP_RESULT', 'CORRECTION_BOOKED'
      )),
      onderwerp TEXT NOT NULL,
      body_md TEXT NOT NULL
    );
CREATE TABLE dienstrooster_parttime_pattern (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      weekdag TEXT NOT NULL CHECK(weekdag IN ('MA', 'DI', 'WO', 'DO', 'VR', 'ZA', 'ZO')),
      frequentie TEXT NOT NULL CHECK(frequentie IN ('ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN')),
      geldig_vanaf TEXT NOT NULL,
      geldig_tot TEXT NOT NULL,
      aangemaakt_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_pending_undo (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('PERIOD_ASSIGNMENT', 'POOL_MEMBERSHIP')),
      scope_id TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK(action_type IN ('ASSIGN', 'REASSIGN', 'REMOVE', 'MEMBERSHIP_DELETE')),
      payload_json TEXT NOT NULL,
      label TEXT NOT NULL,
      onderdeel TEXT NOT NULL DEFAULT 'ROOSTER',
      actor_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_period_excluded_day (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      datum TEXT NOT NULL,
      reden TEXT NOT NULL,
      bron_period_id TEXT REFERENCES dienstrooster_schedule_period(id)
    );
CREATE TABLE dienstrooster_period_factor (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id) ON DELETE CASCADE,
      factor REAL NOT NULL
    );
CREATE TABLE dienstrooster_period_fellow (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_person (
      id TEXT PRIMARY KEY NOT NULL,
      codenaam TEXT NOT NULL UNIQUE,
      rol TEXT NOT NULL CHECK(rol IN ('ADMIN', 'PLANNER', 'DEELNEMER')),
      actief INTEGER NOT NULL DEFAULT 1,
      wachtwoord_hash TEXT,
      totp_secret TEXT,
      sessie_versie INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL,
      wachtwoord_moet_wijzigen INTEGER NOT NULL DEFAULT 0,
      dienst_type TEXT
    );
CREATE TABLE dienstrooster_person_access_link (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      token_hash TEXT NOT NULL UNIQUE,
      geldt_voor_periode_id TEXT REFERENCES dienstrooster_schedule_period(id),
      aangemaakt_op TEXT NOT NULL,
      ingetrokken_op TEXT,
      laatst_gebruikt_op TEXT
    );
CREATE TABLE dienstrooster_pool (
      id TEXT PRIMARY KEY NOT NULL,
      naam TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'ACHTERWACHT'
        CHECK(type IN ('ACHTERWACHT', 'NEURO', 'KINDER', 'INTERVENTIE', 'AIOS')),
      ruleset_id TEXT NOT NULL REFERENCES dienstrooster_ruleset(id),
      verdeelmodus TEXT NOT NULL DEFAULT 'GELIJK'
        CHECK(verdeelmodus IN ('GELIJK', 'NAAR_RATO')),
      actief INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_pool_membership (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id),
      deelnamefactor REAL NOT NULL DEFAULT 1.0,
      geldig_vanaf TEXT NOT NULL,
      geldig_tot TEXT NOT NULL
    );
CREATE TABLE dienstrooster_prior_assignment (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      datum TEXT NOT NULL,
      iso_jaar INTEGER NOT NULL,
      iso_week INTEGER NOT NULL,
      person_id TEXT REFERENCES dienstrooster_person(id),
      teller TEXT NOT NULL CHECK(teller IN ('AVOND', 'WEEKEND', 'FEESTDAG')),
      bron TEXT NOT NULL CHECK(bron IN ('AFGELEID', 'HANDMATIG', 'ONBEKEND')),
      bron_period_id TEXT REFERENCES dienstrooster_schedule_period(id),
      aangemaakt_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_reminder_run (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      dagen_voor_deadline INTEGER NOT NULL,
      deadline TEXT NOT NULL,
      moment TEXT NOT NULL,
      uitkomst TEXT NOT NULL CHECK(uitkomst IN ('VERSTUURD', 'OVERGESLAGEN')),
      aantal_niet_begonnen INTEGER NOT NULL DEFAULT 0,
      aantal_bezig INTEGER NOT NULL DEFAULT 0,
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_reminder_schedule (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      dagen_voor_deadline INTEGER NOT NULL,
      actief INTEGER NOT NULL DEFAULT 1
    );
CREATE TABLE dienstrooster_ruleset (
      id TEXT PRIMARY KEY NOT NULL,
      naam TEXT NOT NULL,
      config_json TEXT NOT NULL,
      versie INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );
CREATE TABLE dienstrooster_schedule_period (
      id TEXT PRIMARY KEY NOT NULL,
      pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id),
      naam TEXT NOT NULL,
      start_datum TEXT NOT NULL,
      eind_datum TEXT NOT NULL,
      deadline TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONCEPT'
        CHECK(status IN ('CONCEPT', 'OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD')),
      bevroren_ruleset_json TEXT,
      overloop_bevestigd_op TEXT,
      gepubliceerd_op TEXT,
      gepubliceerd_door_person_id TEXT REFERENCES dienstrooster_person(id),
      row_version INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL,
      verwijderd_op TEXT,
      auto_herinneren INTEGER NOT NULL DEFAULT 1,
      basis_url TEXT,
      uitgenodigd_op TEXT,
      definitief_op TEXT,
      definitief_door_person_id TEXT REFERENCES dienstrooster_person(id),
      voorlopig_rooster_json TEXT
    );
CREATE TABLE dienstrooster_shift_block (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      soort TEXT NOT NULL CHECK(soort IN ('AVOND', 'NACHT')),
      vorm TEXT NOT NULL CHECK(vorm IN ('ZO_DI', 'WO_VR', 'ZA', 'LOS')),
      start_datum TEXT NOT NULL,
      eind_datum TEXT NOT NULL
    );
CREATE TABLE dienstrooster_shift_slot (
      id TEXT PRIMARY KEY NOT NULL,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      shift_type_id TEXT NOT NULL REFERENCES dienstrooster_shift_type(id),
      datum TEXT NOT NULL,
      iso_jaar INTEGER NOT NULL,
      iso_week INTEGER NOT NULL,
      weekend_id TEXT,
      is_feestdag INTEGER NOT NULL DEFAULT 0,
      feestdag_naam TEXT,
      feestdag_groep TEXT
        CHECK(feestdag_groep IN ('NIEUWJAAR', 'PASEN', 'KONINGSDAG', 'BEVRIJDINGSDAG', 'HEMELVAART', 'PINKSTEREN', 'KERST')),
      benodigd_aantal_personen INTEGER NOT NULL DEFAULT 1,
      shift_block_id TEXT
    );
CREATE TABLE dienstrooster_shift_type (
      id TEXT PRIMARY KEY NOT NULL,
      pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id),
      naam TEXT NOT NULL,
      teller TEXT NOT NULL CHECK(teller IN ('AVOND', 'WEEKEND', 'FEESTDAG')),
      start_tijd TEXT,
      eind_tijd TEXT,
      code TEXT,
      soort TEXT CHECK(soort IN ('UITLOOP', 'DAG', 'AVOND', 'NACHT')),
      punten REAL
    );
CREATE TABLE dienstrooster_submission (
      id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      schedule_period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      status TEXT NOT NULL CHECK(status IN ('NIET_BEGONNEN', 'BEZIG', 'BEVESTIGD')),
      ingediend_op TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL,
      deeltijd_gecontroleerd_op TEXT
    );
CREATE TABLE dienstrooster_swap_request (
      id TEXT PRIMARY KEY NOT NULL,
      periode_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      aanvrager_person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangeboden_slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      gevraagde_slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      respondent_person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN')),
      aangemaakt_op TEXT NOT NULL,
      beantwoord_op TEXT,
      afgehandeld_door_person_id TEXT REFERENCES dienstrooster_person(id),
      opmerkingen TEXT,
      reden_afwijzing TEXT,
      melding_id TEXT,
      row_version INTEGER NOT NULL DEFAULT 1
    , laatste_herinnering_op TEXT, laatste_herinnering_door TEXT);
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('091e9d8d-d547-44ec-a3d7-6c75b52341c4', '1f18147a-eadc-42db-91a9-b200a7f624c5', '2027-03-09', '2027-03-13', 'VAKANTIE', NULL, '1f18147a-eadc-42db-91a9-b200a7f624c5', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('0b3f7ed3-2dde-4e7a-a148-9cace346efe5', 'eede9cd4-9e44-4172-bc70-2426293fdd1a', '2027-03-19', '2027-03-28', 'VAKANTIE', NULL, 'eede9cd4-9e44-4172-bc70-2426293fdd1a', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('147cae63-bf1a-4e12-b0b9-810dedc9d79a', '88777dde-ca0c-484c-bc6a-742930dad2a9', '2027-03-10', '2027-03-13', 'VAKANTIE', NULL, '88777dde-ca0c-484c-bc6a-742930dad2a9', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('1b9e3863-c218-4988-8c1f-71672bd4246c', '4fc357ef-e072-4326-9f21-bcd6163dd095', '2027-04-04', '2027-04-13', 'VAKANTIE', NULL, '4fc357ef-e072-4326-9f21-bcd6163dd095', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('2fa81280-796e-48f3-8f98-d76b3ed39558', '08e20b01-79eb-4fcc-878e-d7aab101752a', '2027-04-03', '2027-04-07', 'VAKANTIE', NULL, '08e20b01-79eb-4fcc-878e-d7aab101752a', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('44cab16d-9df7-4ab7-904b-25db2cc893b6', 'af4b4817-120c-4b12-89cc-524722936f34', '2027-03-01', '2027-03-10', 'VAKANTIE', NULL, 'af4b4817-120c-4b12-89cc-524722936f34', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('71c501c3-6ed8-4511-a465-0ceaf12f321f', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', '2027-04-10', '2027-04-14', 'VAKANTIE', NULL, 'dd9c4096-28a1-4f1a-9d13-923bc66be168', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('c5cfae44-769f-42d8-9c70-3aee85ef70ff', '3f0863f0-bc7d-4313-bdd2-75cb876db221', '2027-04-05', '2027-04-12', 'VAKANTIE', NULL, '3f0863f0-bc7d-4313-bdd2-75cb876db221', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('cb4143d8-e721-4013-9b9f-e72f2ef79844', '5ded5a97-730c-48d2-82e7-e5c12828590d', '2027-03-11', '2027-03-15', 'VAKANTIE', NULL, '5ded5a97-730c-48d2-82e7-e5c12828590d', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('e00263d5-31db-4187-ad20-7622293b0f57', '26128bc5-1150-4735-a188-af8f16d653db', '2027-02-07', '2027-02-10', 'VAKANTIE', NULL, '26128bc5-1150-4735-a188-af8f16d653db', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('017e35c3-f435-41a5-9961-ccc7f0cd872b', '50a3affa-a335-4883-9f6e-61b3dc066da0', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('09283124-6670-463c-b7d8-dd370df8e675', '01d5a9e9-96e8-475b-ab13-114c0b20522c', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('094bc05d-4c79-4160-b054-73225028b6eb', 'e943eb18-cfc8-4f8f-b493-69fba5b90d2c', '8e6594a2-b19e-4ad9-b9ca-3c72e9e5bf36', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('09f26012-c206-48eb-a246-774131240bb9', '08e20b01-79eb-4fcc-878e-d7aab101752a', 'd79d4571-2f89-4dff-8b09-1561c58fd6d5', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('0ac4fc04-6066-40eb-aa32-59f5113b6e8e', '01f1bbbb-30ba-45c0-9875-eb08216753ab', '12012cec-007b-4e95-af19-e1bb8096e270', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('0b1a33b0-0e7e-41ea-996b-ef59c8ca3c45', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', '12012cec-007b-4e95-af19-e1bb8096e270', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('0b82f61f-45df-4ffb-a312-afa843ddffd9', '1f18147a-eadc-42db-91a9-b200a7f624c5', 'edb1b83c-4b65-4acb-be9c-18c0f3fc2c97', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('0d96573f-a9f0-4344-b5b3-ac5cfb965b1a', '88777dde-ca0c-484c-bc6a-742930dad2a9', '8042db2a-de6e-4546-8bad-802ce471a97d', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('134bf525-7cfd-41b9-ac6c-01d3c42ef2e8', '26128bc5-1150-4735-a188-af8f16d653db', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1e5c9332-b57e-44cf-a4ea-713acfd1d665', '1f18147a-eadc-42db-91a9-b200a7f624c5', '5aea77fc-9b19-4515-9c15-9184fc7e2bb2', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('21a003eb-ced2-4fb1-bc12-c11c003c1f38', '78197f39-bf74-48d0-a1ed-20ac3a158a14', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('24a432bd-41fc-4171-8ce5-8f56ff1649a8', '01d5a9e9-96e8-475b-ab13-114c0b20522c', '12012cec-007b-4e95-af19-e1bb8096e270', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('29a31da5-88de-4bdf-9737-a7be10a0c53f', '1f18147a-eadc-42db-91a9-b200a7f624c5', '8042db2a-de6e-4546-8bad-802ce471a97d', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('29a53b5d-2972-4a07-af6a-8d7b1352c0bb', '26128bc5-1150-4735-a188-af8f16d653db', '071696ae-00c5-4f79-bff9-f46788b83de9', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2b02dd4b-999e-4326-924e-58fb8d2939df', '63826f48-ff69-464f-a4d0-e6d67ae8de09', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2f53661b-f7a5-4823-bcf2-f88b712b754d', '4fc357ef-e072-4326-9f21-bcd6163dd095', 'ae175048-2055-4974-b36b-eb5adee57c41', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('35e98de3-44cf-492c-941d-1c743595cdc3', '01d5a9e9-96e8-475b-ab13-114c0b20522c', 'edb1b83c-4b65-4acb-be9c-18c0f3fc2c97', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('3cb0fc94-030f-4873-ae18-1a0d395470cc', '50a3affa-a335-4883-9f6e-61b3dc066da0', '18d0dd42-8826-44fd-8cad-90baed07ee2e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('3d7d5e8e-d623-4a20-a734-6047e8e69b47', '4fc357ef-e072-4326-9f21-bcd6163dd095', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('46238dfe-840b-48f8-ad76-847f781f0c57', '01f1bbbb-30ba-45c0-9875-eb08216753ab', '18d0dd42-8826-44fd-8cad-90baed07ee2e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('489ad90f-dc89-4d52-b525-a1364d89aa0f', '50a3affa-a335-4883-9f6e-61b3dc066da0', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('493e867f-728b-4ded-a0f6-8309a30df8a8', '4fc357ef-e072-4326-9f21-bcd6163dd095', '5aea77fc-9b19-4515-9c15-9184fc7e2bb2', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5496a9ce-e262-4e5e-b0ca-073bf47ccefd', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', 'edb1b83c-4b65-4acb-be9c-18c0f3fc2c97', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('580a53a5-8226-4415-a413-109216cd9912', '4870ea66-e15f-4a1b-93f7-61539f4916a9', 'ae175048-2055-4974-b36b-eb5adee57c41', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('58777cd7-805b-4fa7-859d-3f1fc4fa588f', '900af8d3-56db-4655-bdfb-603cb2f9d00a', '12012cec-007b-4e95-af19-e1bb8096e270', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5a0607a4-538d-41f9-899f-c3f560d379c5', 'e943eb18-cfc8-4f8f-b493-69fba5b90d2c', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5bb4ed37-ffb7-42b9-967a-d080de738e1f', '4fc357ef-e072-4326-9f21-bcd6163dd095', 'd57eba9a-b45f-44ea-a18c-a68bfa4de05b', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5d1894f2-8d03-43b6-90f2-92bc2f7d73bb', '01f1bbbb-30ba-45c0-9875-eb08216753ab', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5fe4f7b3-79cb-4150-a8c5-32e427771e82', '01d5a9e9-96e8-475b-ab13-114c0b20522c', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('62bd4343-d905-4e70-8027-5c916ccc95ba', '4870ea66-e15f-4a1b-93f7-61539f4916a9', 'edb1b83c-4b65-4acb-be9c-18c0f3fc2c97', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6589af42-292c-4ce6-99ef-b8fa7e267171', '66d073e0-9606-4213-8f0e-4f92627ffe2b', '355892af-c339-42f6-a988-6e506534a480', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('66498717-4950-4efc-8833-1cc3ee912b93', '4fc357ef-e072-4326-9f21-bcd6163dd095', '18d0dd42-8826-44fd-8cad-90baed07ee2e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('698bd50a-d34e-4d41-8dc6-b4db720f446b', '01f1bbbb-30ba-45c0-9875-eb08216753ab', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6b962214-c555-4a7c-b24b-29700cc7f762', '63826f48-ff69-464f-a4d0-e6d67ae8de09', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6bb237ef-470f-4be9-9a3d-d708b3fcc16b', '4fc357ef-e072-4326-9f21-bcd6163dd095', '8042db2a-de6e-4546-8bad-802ce471a97d', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6decd798-2828-46e5-bd81-50b4ad8fe6d2', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6e946b6b-590e-4220-a772-7b12992b4a9f', '4fc357ef-e072-4326-9f21-bcd6163dd095', '6f1a7905-f648-40d7-86e2-0ae8178215a3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('75e020e5-21c2-44c3-b959-50f01be25e1c', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', 'ae175048-2055-4974-b36b-eb5adee57c41', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('778c38c2-afec-405a-8693-e97c6f7c27b2', '4fc357ef-e072-4326-9f21-bcd6163dd095', '8e6594a2-b19e-4ad9-b9ca-3c72e9e5bf36', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('81827568-d066-4159-8d41-42a8867ab648', '4fc357ef-e072-4326-9f21-bcd6163dd095', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('8502a06e-9102-403f-83d2-2bc1888bfa69', '50a3affa-a335-4883-9f6e-61b3dc066da0', '8042db2a-de6e-4546-8bad-802ce471a97d', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('863567fa-df08-4882-94ce-c305e17838d5', '9e706ee5-4a7b-4f20-a435-15249ab5fd37', 'ae175048-2055-4974-b36b-eb5adee57c41', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('874d4eb8-e20d-4eb2-afa6-6488267bfc06', '5ded5a97-730c-48d2-82e7-e5c12828590d', '18d0dd42-8826-44fd-8cad-90baed07ee2e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('8a6b1f27-0a63-41a0-9e51-47152f7849c8', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', 'edb1b83c-4b65-4acb-be9c-18c0f3fc2c97', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('964988d8-ae03-44e0-b5ae-2c709befb6ad', '78197f39-bf74-48d0-a1ed-20ac3a158a14', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('9a81596b-1f2c-42b4-b47b-09c8904f3b5a', 'e943eb18-cfc8-4f8f-b493-69fba5b90d2c', 'd57eba9a-b45f-44ea-a18c-a68bfa4de05b', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('9b45d539-18b3-43b1-8f31-f1e1e8d36b33', 'e943eb18-cfc8-4f8f-b493-69fba5b90d2c', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('a146e854-23b7-434f-93e1-b903ed076ec0', '01f1bbbb-30ba-45c0-9875-eb08216753ab', '8042db2a-de6e-4546-8bad-802ce471a97d', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('a56aa69e-d026-4617-b837-929cada22d56', '1f18147a-eadc-42db-91a9-b200a7f624c5', 'ae175048-2055-4974-b36b-eb5adee57c41', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('aa0b5e97-b689-4c3f-9868-d0d28d180eb6', '50a3affa-a335-4883-9f6e-61b3dc066da0', 'ae175048-2055-4974-b36b-eb5adee57c41', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('adcf8df5-041f-4c7b-b59b-10ef22ad9bd0', '26128bc5-1150-4735-a188-af8f16d653db', 'edb1b83c-4b65-4acb-be9c-18c0f3fc2c97', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b0514feb-6ab4-4120-8a48-8887f6206881', '3f0863f0-bc7d-4313-bdd2-75cb876db221', '071696ae-00c5-4f79-bff9-f46788b83de9', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b28fadc0-c268-454b-8cd9-3d24fd857a36', '01f1bbbb-30ba-45c0-9875-eb08216753ab', 'ae175048-2055-4974-b36b-eb5adee57c41', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b4a80293-88ca-4c73-87e1-834dde909858', '26128bc5-1150-4735-a188-af8f16d653db', '12012cec-007b-4e95-af19-e1bb8096e270', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('bc0d99a8-e453-4a0b-91c0-1952376fd201', 'eede9cd4-9e44-4172-bc70-2426293fdd1a', '355892af-c339-42f6-a988-6e506534a480', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('c5929269-6e8e-4fd5-b5a7-28b412fa200b', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('c78e0eb7-1c2e-403e-b74d-e2b7d02cd658', '9e706ee5-4a7b-4f20-a435-15249ab5fd37', 'edb1b83c-4b65-4acb-be9c-18c0f3fc2c97', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d41401a4-3d41-440d-8a3b-920e69399d74', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d674f976-4a43-46be-895c-5aaac6541d99', '88777dde-ca0c-484c-bc6a-742930dad2a9', '204816ae-1803-4b77-b440-1c0d1bfc4230', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d8145685-26cd-42ed-b284-dd3bdd3c3df6', '88777dde-ca0c-484c-bc6a-742930dad2a9', 'ae175048-2055-4974-b36b-eb5adee57c41', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('df2fa8c8-a5b4-4cce-afa2-e0f306938229', '1f18147a-eadc-42db-91a9-b200a7f624c5', '18d0dd42-8826-44fd-8cad-90baed07ee2e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e0ba1dbd-6745-4be3-81ca-ae3d983acc27', '4fc357ef-e072-4326-9f21-bcd6163dd095', 'edb1b83c-4b65-4acb-be9c-18c0f3fc2c97', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e12e515d-1e3a-4ba8-a7d7-5a119e9a756a', '78197f39-bf74-48d0-a1ed-20ac3a158a14', '18d0dd42-8826-44fd-8cad-90baed07ee2e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e28ccff6-7704-44f8-bf0b-e5aeddb05e16', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', '12012cec-007b-4e95-af19-e1bb8096e270', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e331e49b-f3c0-4b3c-9e35-fdfeb8c96a82', '63826f48-ff69-464f-a4d0-e6d67ae8de09', '18d0dd42-8826-44fd-8cad-90baed07ee2e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e6f20618-8471-41f9-ba34-14df5c1b0b30', '4fc357ef-e072-4326-9f21-bcd6163dd095', '071696ae-00c5-4f79-bff9-f46788b83de9', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e9c56f2e-b491-4654-aebf-693392b27899', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', '6a845022-c233-487c-89cc-6152796bd623', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('eb18f1b7-c95c-4a5b-aa4a-8f587f2197a0', '4fc357ef-e072-4326-9f21-bcd6163dd095', '12012cec-007b-4e95-af19-e1bb8096e270', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f08f7e01-eb5a-4975-8d0b-d6cfcb7dfaf5', '01d5a9e9-96e8-475b-ab13-114c0b20522c', '6f1a7905-f648-40d7-86e2-0ae8178215a3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f54d23dd-5d90-4497-8a53-efa582a21d01', '4fc357ef-e072-4326-9f21-bcd6163dd095', '355892af-c339-42f6-a988-6e506534a480', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f5f8cf49-64c4-4421-9da6-f6dd7850cf43', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', '18d0dd42-8826-44fd-8cad-90baed07ee2e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f8bbe6dc-b542-428b-956c-b9531a89467c', 'e943eb18-cfc8-4f8f-b493-69fba5b90d2c', '18d0dd42-8826-44fd-8cad-90baed07ee2e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('fed74648-448a-43e4-b0e7-52f0263300f5', '50a3affa-a335-4883-9f6e-61b3dc066da0', '355892af-c339-42f6-a988-6e506534a480', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('02999737-90f3-4e8d-9a87-8f33945d968c', '4fc357ef-e072-4326-9f21-bcd6163dd095', 'PASEN', 2028, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('03c5a8c9-0b9f-4373-8c72-6f027c75d932', '3f0863f0-bc7d-4313-bdd2-75cb876db221', 'KONINGSDAG', 2027, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('1d2f0de0-4576-46e6-a6a1-6c15fdb30a9e', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', 'PINKSTEREN', 2025, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('28ce42e6-0f08-4714-966c-2a54c2aebf46', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', 'KONINGSDAG', 2028, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('2d388a70-432d-4e78-9ac3-8eaa31fdb3dd', '26128bc5-1150-4735-a188-af8f16d653db', 'KONINGSDAG', 2026, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('34fd6899-c2ae-47c5-8939-0226b264ad4b', '78197f39-bf74-48d0-a1ed-20ac3a158a14', 'KERST', 2025, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('367988b9-fd23-4e14-be51-01d945e6a331', '1f18147a-eadc-42db-91a9-b200a7f624c5', 'PASEN', 2026, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('37635cd1-8435-4bfe-a6cd-36a1615cba7f', '08e20b01-79eb-4fcc-878e-d7aab101752a', 'PINKSTEREN', 2026, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('80401220-d9c9-4120-8226-845a2202657a', '88777dde-ca0c-484c-bc6a-742930dad2a9', 'KERST', 2028, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('9ed70cc4-7020-48c6-81c3-619536ba749b', '5ded5a97-730c-48d2-82e7-e5c12828590d', 'PINKSTEREN', 2027, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('afe6c96a-5365-4578-af1e-965f0a083d57', '02a0530d-6a5a-478d-932f-9d827bce6449', 'KERST', 2026, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('bdef0385-c2f2-4f21-a06b-393633683593', 'eede9cd4-9e44-4172-bc70-2426293fdd1a', 'KERST', 2027, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('e39db369-e686-475a-99bd-5ca628f88bf8', 'bdf26050-7cab-42b6-84b7-f98acaddb4f4', 'KONINGSDAG', 2025, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('e512f99e-2dcd-4d3b-801b-3e6d583ff934', 'af4b4817-120c-4b12-89cc-524722936f34', 'PASEN', 2027, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('fcd59101-ee2a-4423-a5e5-ff6f2e9603af', 'aa97f2ca-c9bf-44c4-9852-9d2992c0b759', 'PASEN', 2025, 'IMPORT');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('8a414daa-128b-4226-9e4f-f3b45b28f203', 'af4b4817-120c-4b12-89cc-524722936f34', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'AVOND', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', NULL, -1, 'Beginsaldo vanuit import', 'BEGINSALDO', '56ec6d8c-133e-407d-b06a-bdbd9cc231cc', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('af354681-74f5-4986-bcb4-6d6554339d6e', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'AVOND', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', NULL, -1, 'Beginsaldo vanuit import', 'BEGINSALDO', '56ec6d8c-133e-407d-b06a-bdbd9cc231cc', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('b8a48201-7694-427a-93bc-e5f81fbf5e2d', '26128bc5-1150-4735-a188-af8f16d653db', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'AVOND', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', NULL, -1, 'Beginsaldo vanuit import', 'BEGINSALDO', '56ec6d8c-133e-407d-b06a-bdbd9cc231cc', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('c5ecc063-9c4c-4ee1-9288-d0b8e5e67489', '1f18147a-eadc-42db-91a9-b200a7f624c5', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'AVOND', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', NULL, 1, 'Beginsaldo vanuit import', 'BEGINSALDO', '56ec6d8c-133e-407d-b06a-bdbd9cc231cc', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('d1943906-a042-4e86-a4bf-15b838cf95ec', 'bdf26050-7cab-42b6-84b7-f98acaddb4f4', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'AVOND', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', NULL, 1, 'Beginsaldo vanuit import', 'BEGINSALDO', '56ec6d8c-133e-407d-b06a-bdbd9cc231cc', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('f34e32ee-79d0-4c49-9be2-3f47b9fd508b', '78197f39-bf74-48d0-a1ed-20ac3a158a14', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'AVOND', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', NULL, -1, 'Beginsaldo vanuit import', 'BEGINSALDO', '56ec6d8c-133e-407d-b06a-bdbd9cc231cc', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('fd0cc371-f4b9-4800-b694-318f1ef2b05b', 'eede9cd4-9e44-4172-bc70-2426293fdd1a', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'AVOND', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', NULL, 1, 'Beginsaldo vanuit import', 'BEGINSALDO', '56ec6d8c-133e-407d-b06a-bdbd9cc231cc', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('059bddaf-be75-4108-90c1-df8532ba70ca', 'BLOCK_OVERRIDDEN', '{{periode}}: een van je voorkeuren kon niet worden gehonoreerd', 'Beste {{codenaam}},

Bij het samenstellen van **{{periode}}** konden we een van je markeringen niet honoreren:

{{details}}

Reden: {{reden}}

Neem contact op met de planner als dit een probleem is.');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('07a2dbad-db96-48f0-8e7c-01599c0cc400', 'SCHEDULE_PUBLISHED', '{{periode}}: het rooster is gepubliceerd', 'Beste {{codenaam}},

Het voorlopige rooster voor **{{periode}}** staat klaar. Kijk je diensten na en laat het de planner weten als er iets niet klopt.

{{link}}

Je kunt vanuit je eigen overzicht een ruil met een collega aanvragen.');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('1c9fa62e-9bcb-44a5-bb28-deb411acb5a5', 'FINAL_WARNING', 'Laatste kans: voorkeuren {{periode}} sluiten binnenkort', 'Beste {{codenaam}},

De deadline voor **{{periode}}** is **{{deadline}}** en je voorkeuren ontbreken nog.

Als er niets binnenkomt, wordt het rooster gegenereerd zonder je geblokkeerde dagen.

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('20e59083-76e2-465d-8cf5-63d1d0e7033e', 'SWAP_RESULT', 'Je ruilverzoek is {{uitkomst}}', 'Beste {{codenaam}},

Je ruilverzoek is **{{uitkomst}}**.

{{details}}

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('51cea6a9-cb54-4b7f-bd3b-397d842bd980', 'SWAP_REQUESTED', 'Ruilverzoek van {{aanvrager}}', 'Beste {{codenaam}},

{{aanvrager}} wil een dienst met je ruilen.

{{details}}

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('666f2c50-f9f6-4993-b2fc-c3889f0a5d60', 'REMINDER', 'Herinnering: voorkeuren {{periode}} nog niet ontvangen', 'Beste {{codenaam}},

We hebben je voorkeuren voor **{{periode}}** nog niet ontvangen.

De deadline is **{{deadline}}**.

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('7bf89c19-3e50-4010-9464-22c23c131e7a', 'CORRECTION_BOOKED', '{{periode}}: een correctie is geregistreerd', 'Beste {{codenaam}},

Er is een correctie voor je geregistreerd die wordt toegepast op **{{periode}}**.

{{details}}

Reden: {{reden}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('9e141775-51ee-4b6d-a9a7-c55b728d7390', 'PARTTIME_CHECK', '{{periode}}: controleer je deeltijddagen', 'Beste {{codenaam}},

We hebben je deeltijddagen voor **{{periode}}** gegenereerd op basis van je patroon.

Controleer ze goed, vooral rond de jaarwisseling. Daar kunnen weeknummers verschuiven.

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('db6dd815-8551-4e6f-b5e8-04fe480da77d', 'PERIOD_OPENED', '{{periode}}: voorkeuren staan open', 'Beste {{codenaam}},

Het rooster voor **{{periode}}** staat open voor invoer.

Geef de dagen waarop je niet kunt werken door vóór **{{deadline}}**.

{{link}}

Vergeet niet je vakantiedagen te blokkeren. Die worden nergens anders vandaan gehaald.');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('ffef87c1-7566-484f-90bc-c86892d15f07', 'DEADLINE_PASSED', '{{periode}}: de deadline is verstreken', 'Beste {{codenaam}},

De deadline voor **{{periode}}** is verstreken en voorkeuren zijn nu alleen-lezen.

Neem rechtstreeks contact op met de planner als er iets moet veranderen.');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('05fe1317-04c4-44e9-a325-948f755d6466', '02a0530d-6a5a-478d-932f-9d827bce6449', 'VR', 'EVEN_WEKEN', '2027-01-04', '2027-06-06', '02a0530d-6a5a-478d-932f-9d827bce6449', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('0fe4880a-9abb-4098-b536-6fe13d9810da', '1f18147a-eadc-42db-91a9-b200a7f624c5', 'ZA', 'ONEVEN_WEKEN', '2027-01-04', '2027-06-06', '1f18147a-eadc-42db-91a9-b200a7f624c5', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('5969b01b-e20f-4691-aca6-6dd5ba9600fd', '78197f39-bf74-48d0-a1ed-20ac3a158a14', 'MA', 'ELKE_WEEK', '2027-01-04', '2027-06-06', '78197f39-bf74-48d0-a1ed-20ac3a158a14', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('8796eeed-771c-487d-8acb-67913745f0a4', 'aa97f2ca-c9bf-44c4-9852-9d2992c0b759', 'DI', 'EVEN_WEKEN', '2027-01-04', '2027-06-06', 'aa97f2ca-c9bf-44c4-9852-9d2992c0b759', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('9d42d711-ac71-407f-9d46-907ead44c3bb', 'af4b4817-120c-4b12-89cc-524722936f34', 'WO', 'ELKE_WEEK', '2027-01-04', '2027-06-06', 'af4b4817-120c-4b12-89cc-524722936f34', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('b12f42b9-e10f-4776-9897-227657ffb45b', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', 'DO', 'ELKE_WEEK', '2027-01-04', '2027-06-06', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('cec89ee2-debf-46a6-8bf1-89193ce13065', '08e20b01-79eb-4fcc-878e-d7aab101752a', 'MA', 'EVEN_WEKEN', '2027-01-04', '2027-06-06', '08e20b01-79eb-4fcc-878e-d7aab101752a', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('cf5d323b-ea82-4c61-b1bc-878aa4e5034d', 'bdf26050-7cab-42b6-84b7-f98acaddb4f4', 'WO', 'ONEVEN_WEKEN', '2027-01-04', '2027-06-06', 'bdf26050-7cab-42b6-84b7-f98acaddb4f4', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('e88e2835-6862-4003-8c5b-e765b928e1ab', '26128bc5-1150-4735-a188-af8f16d653db', 'ZO', 'ELKE_WEEK', '2027-01-04', '2027-06-06', '26128bc5-1150-4735-a188-af8f16d653db', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('ff58cb34-e7e3-4052-b69a-cb0f9681f74c', 'eede9cd4-9e44-4172-bc70-2426293fdd1a', 'DI', 'ONEVEN_WEKEN', '2027-01-04', '2027-06-06', 'eede9cd4-9e44-4172-bc70-2426293fdd1a', '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('01d5a9e9-96e8-475b-ab13-114c0b20522c', 'Persoon-28', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('01f1bbbb-30ba-45c0-9875-eb08216753ab', 'Persoon-27', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('02a0530d-6a5a-478d-932f-9d827bce6449', 'Persoon-05', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('08e20b01-79eb-4fcc-878e-d7aab101752a', 'Persoon-08', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('0e5815fb-8d23-4cef-864c-51088ebe12a0', 'Persoon-21', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('1f18147a-eadc-42db-91a9-b200a7f624c5', 'Persoon-06', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('26128bc5-1150-4735-a188-af8f16d653db', 'Persoon-07', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('38a7d715-9f11-43af-8fae-5338fc853c89', 'Persoon-18', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('3f0863f0-bc7d-4313-bdd2-75cb876db221', 'Persoon-11', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('46372dd6-d448-4f2f-9e48-2dab479a1d80', 'admin', 'ADMIN', 1, '$2b$12$ZZvo6VwoU6gOPfComUkxI.wLZRzI0dofwlzNT21Wg.Il1lOBQcmlu', NULL, 1, '2026-11-11T17:24:04.651Z', 0, 'ACHTERWACHT');
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('4870ea66-e15f-4a1b-93f7-61539f4916a9', 'Persoon-23', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('4b0865f1-e6b3-4792-aeec-2e859a1284b6', 'Persoon-17', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('4fc357ef-e072-4326-9f21-bcd6163dd095', 'Persoon-14', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('50a3affa-a335-4883-9f6e-61b3dc066da0', 'Persoon-29', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('56ec6d8c-133e-407d-b06a-bdbd9cc231cc', 'planner', 'PLANNER', 1, '$2b$12$irEPVp0LKD73M1XJImY0ae94vz/4/C5bz59ro9Vqb3wxtZE1hJ8Pe', NULL, 1, '2026-11-11T17:24:04.232Z', 0, 'ACHTERWACHT');
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('5ded5a97-730c-48d2-82e7-e5c12828590d', 'Persoon-12', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('63826f48-ff69-464f-a4d0-e6d67ae8de09', 'Persoon-30', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('66d073e0-9606-4213-8f0e-4f92627ffe2b', 'Persoon-26', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('78197f39-bf74-48d0-a1ed-20ac3a158a14', 'Persoon-01', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('88777dde-ca0c-484c-bc6a-742930dad2a9', 'Persoon-13', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('900af8d3-56db-4655-bdfb-603cb2f9d00a', 'Persoon-24', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('9e706ee5-4a7b-4f20-a435-15249ab5fd37', 'Persoon-16', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', 'Persoon-04', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('aa97f2ca-c9bf-44c4-9852-9d2992c0b759', 'Persoon-02', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('af4b4817-120c-4b12-89cc-524722936f34', 'Persoon-10', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('bc6c4007-7e22-4260-85e5-880ac386824f', 'Persoon-19', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('bdf26050-7cab-42b6-84b7-f98acaddb4f4', 'Persoon-03', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('d2935c0b-0678-4f57-959c-393e66fd754a', 'Persoon-31', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('dd9c4096-28a1-4f1a-9d13-923bc66be168', 'Persoon-15', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('e943eb18-cfc8-4f8f-b493-69fba5b90d2c', 'Persoon-20', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('eede9cd4-9e44-4172-bc70-2426293fdd1a', 'Persoon-09', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('efc57ff4-a803-497a-a083-260c4b9217b6', 'Persoon-25', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('fed7a218-22a6-4500-b168-32b17744e7a2', 'Persoon-22', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', 0, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('045d5633-39c2-47db-87fb-124c28a9e633', '88777dde-ca0c-484c-bc6a-742930dad2a9', '59bbd1cb4bb08c02f11cdbdbe2d340f79afdd62079612f2b83f3d1a5ebc2df87', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('13341c70-8142-49a1-9c2d-d643a12b9c04', '63826f48-ff69-464f-a4d0-e6d67ae8de09', '5c9cc68de22ddd1a74628898af895070135107104a3e44c3d99125fc8b25664b', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('148c78c2-29b2-4a9e-88f2-ff7e163c0cbd', 'bdf26050-7cab-42b6-84b7-f98acaddb4f4', '608e60725cd8eab58885f267b3587cc5ae7379a87b5e666b48ac03cebb762c86', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('2936624e-10cf-4121-9d0c-0306ba9c7fa0', '50a3affa-a335-4883-9f6e-61b3dc066da0', '0dcec26adb24832315cddf5503d97091d888489985398786fd20243f5c439836', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('2aeb798f-c666-4e1a-bb2a-42ff0969a47f', '4b0865f1-e6b3-4792-aeec-2e859a1284b6', '74c38b65f3229c0692c5887c70199143137f162f0ba2677d0d56739dde2fd322', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('30a8d7c4-219b-4450-9ef2-475ef5d0be9d', '02a0530d-6a5a-478d-932f-9d827bce6449', 'cf1712484321c6bd2465d7a3b2a5a399dc1265e2c3ff3858775e688dfd16ca35', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('33362ff3-153c-4b17-8032-44aa1f30ff5b', '900af8d3-56db-4655-bdfb-603cb2f9d00a', '7fd77c53ce18a57551ab426cd8edb09e6618d79bce0581273751e9b7c74b2189', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('389d87bd-c0f7-4518-8c5e-d6d1efb6b351', '4fc357ef-e072-4326-9f21-bcd6163dd095', '0a470224a1c9b6819d8842d952df10fe9413c4549398b34b75ba3b18458f1326', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('38be5263-b132-47db-bdc5-3228c69d8e8c', '78197f39-bf74-48d0-a1ed-20ac3a158a14', 'f5264cf2b35e113dcd0ec6f3b6631ac593bc45a37100a75d20c5b55ae7361e1a', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('39852f35-b80d-4b2a-b855-443fd74136fd', '08e20b01-79eb-4fcc-878e-d7aab101752a', '75912f26e7977f890b999d227539019990355d56f16e343dd88f1ba7047cb0d7', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('3dcd4ab2-683e-4500-8207-946e37c91243', 'efc57ff4-a803-497a-a083-260c4b9217b6', '7d9d62021e14622caa79f8d01c8103a3648ba00a074d4172edbc9f07bc4a077b', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('4757d272-ee05-4b66-bf43-f91723107690', 'aa97f2ca-c9bf-44c4-9852-9d2992c0b759', '92d27516d33f7136d797014699ebf2621803dfef00f8d3a9304ab894ccefbbf5', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('4c40a3a0-78b3-47ef-9d58-0a87979f83b7', '01d5a9e9-96e8-475b-ab13-114c0b20522c', '1d5015310dfd498c2c779ed51400717b87d2efe4e330c4e6a393be5fa2bbc4f0', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('56601ad6-f1a1-44b1-8e87-6629fdaebe0d', '26128bc5-1150-4735-a188-af8f16d653db', '526fd5354cf778c51cf6e1877e0d53422d16050cbe6c1525f25e861327f7c9c9', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('5ab70143-60e5-456e-a06c-e42a64d504ec', 'e943eb18-cfc8-4f8f-b493-69fba5b90d2c', '474d2f6a5e13e4989948ab26f481156b21bd2f8b2816f0ec26d6032fcb75a056', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('61a9b657-00d9-4bfa-afa0-2431edf2ea24', 'bc6c4007-7e22-4260-85e5-880ac386824f', 'de2eb7ef7649e1d597ef79fc14cee5efad1245b7d1ac29804a1fed3de78c4712', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('66b3e126-6bc8-4f91-8136-8a0bca0d4ba4', 'd2935c0b-0678-4f57-959c-393e66fd754a', 'd208f94cb6fb988675358c66031fa0a1b206d6a5bf7c18290ed2c0c3dea2e6da', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('7598d18c-4bbe-4ccc-8217-41d6c9315701', '1f18147a-eadc-42db-91a9-b200a7f624c5', '5440e683fe54714d8fe919affe244069b8201aa9a66ebbaa0c53a3ef92902121', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('85abc8a0-b238-4688-919d-1a9f5907bc59', '4870ea66-e15f-4a1b-93f7-61539f4916a9', '55486260095f4d1b9e0c6f79a8a50d9a89e083896c2546d1cdf41e74db467d6c', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('873c8ce2-ba6a-48fc-bbbc-b69942ffb8d9', '9e706ee5-4a7b-4f20-a435-15249ab5fd37', '9903bb0fe7b4a68d36c7b8ddd5f0bd0bc6e234cdafa6ac3adf06bf15c7d49644', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('8dd7fb41-8950-4dd1-b9fb-ceddde52bdae', 'af4b4817-120c-4b12-89cc-524722936f34', 'b7bc6d65b681c1b9b4071cc837fd929c511855457a53e64776548b2c0d43de71', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('99308d7d-a3f8-4d3c-bae7-19aed7040791', '3f0863f0-bc7d-4313-bdd2-75cb876db221', '39150601b30797dccd52f52afa3e739a8ae37bb28251e57fee4cd124699e430f', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('b8e62ab2-9014-49d1-9506-adc02393964d', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', 'fbee3544a7f0c000c6661a479fe3464529386d4841d28fd3bdf4f5eed1679701', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('bee1bf69-afe3-4105-96b7-16684322e527', '0e5815fb-8d23-4cef-864c-51088ebe12a0', '1dd011aed62a8258af36970d5e60fb226a09998eef9e37cc7971d6f1da3903bc', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('cbdc7248-88bb-4888-838b-2f6ca43fd7a6', 'eede9cd4-9e44-4172-bc70-2426293fdd1a', '8fc0e3f36a5d133bb3d024bc0fbbbc50c1f5ad063b7a1a71e35c26e692f0ec93', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('d68f305b-860d-424e-97e5-fc8b28c986f2', '5ded5a97-730c-48d2-82e7-e5c12828590d', '2e7b97e2fc41cb451ab2f66b553717a9e1fafea8a99852803afa9574c0bbffe9', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('d7bf9f9b-eef8-463f-9e2f-3fadedcbb868', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', 'ef3542e3284fa5d21d91380489a46ee9e256a02a1298050e1a5cb3e8426fe76a', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('d8f3c845-320c-4d8f-a63e-4095a14baf5c', 'fed7a218-22a6-4500-b168-32b17744e7a2', '2c88b32dd4c03e1d28bedece168cdf5319befa3446ba3d737a9f763280cc0430', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('e78cb88e-7fd4-4654-9191-e60419c4f213', '01f1bbbb-30ba-45c0-9875-eb08216753ab', 'f7003186ead98b95e088c80782d6d4d9caeb37a297f9e4e8e0614d1f75467ffc', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('e8afee56-c1aa-4706-ae3a-d5245765c066', '66d073e0-9606-4213-8f0e-4f92627ffe2b', 'd562b39f68553eefc46a6912bf4105f271c86139f2c863c753381b3951318439', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('e8efde3a-ffac-4cd1-b71c-ba90d17e6f8d', '38a7d715-9f11-43af-8fae-5338fc853c89', '3a31a33fff1c5ee6aa4b91da9a7fdc2b5c89ba14dc989d62131a2c88f204e481', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '2026-11-11T17:24:04.232Z', NULL, NULL);
INSERT INTO "dienstrooster_pool" ("id", "naam", "type", "ruleset_id", "verdeelmodus", "actief", "aangemaakt_op") VALUES ('9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'Achterwacht', 'ACHTERWACHT', '7371fe16-9f17-4c54-98a0-af0ffe4862c2', 'GELIJK', 1, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_pool" ("id", "naam", "type", "ruleset_id", "verdeelmodus", "actief", "aangemaakt_op") VALUES ('b116b0c8-8616-4c8e-9a76-1625fef7438e', 'AIOS', 'AIOS', '8720c770-3fe8-4d9e-8ebd-8d1a831eb005', 'NAAR_RATO', 1, '2026-11-11T17:24:04.656Z');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('08c9c6ac-4d54-4047-902a-dadded6da08a', 'efc57ff4-a803-497a-a083-260c4b9217b6', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('09874387-51d1-4d08-a77b-8d6c6766032c', '3f0863f0-bc7d-4313-bdd2-75cb876db221', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('09899dc3-a578-4543-8861-82fb43327685', 'bc6c4007-7e22-4260-85e5-880ac386824f', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('0ca735b6-4097-4f0f-913a-7e67d45d01d4', 'aa97f2ca-c9bf-44c4-9852-9d2992c0b759', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('19f0f1bb-40de-455a-ae13-124a3b6e31de', '900af8d3-56db-4655-bdfb-603cb2f9d00a', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('1e7d9cb2-1e87-4db4-ab17-d9d8f9811bd2', '4b0865f1-e6b3-4792-aeec-2e859a1284b6', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('239bc92f-517c-40b0-891a-17110546a960', 'e943eb18-cfc8-4f8f-b493-69fba5b90d2c', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('2d8c5137-1afc-4028-a592-ed41e71a94fc', '9e706ee5-4a7b-4f20-a435-15249ab5fd37', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('3f994239-fe3a-4e17-b182-8e936f0c4375', '5ded5a97-730c-48d2-82e7-e5c12828590d', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('49143352-b805-4925-99de-e8c84f5fb49a', 'd2935c0b-0678-4f57-959c-393e66fd754a', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('518efc69-2cc2-4f88-9728-4f10887228e6', '01f1bbbb-30ba-45c0-9875-eb08216753ab', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('5ec02924-ba4e-4d1b-a7a1-fb0a0614740b', 'fed7a218-22a6-4500-b168-32b17744e7a2', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('6565861c-67dd-481d-84a0-e37b073e4f9e', '4870ea66-e15f-4a1b-93f7-61539f4916a9', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('72183fcc-59c2-4618-b706-9bc4628d395a', '38a7d715-9f11-43af-8fae-5338fc853c89', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('7c19e109-e710-434f-af0b-24f52e547e41', '4fc357ef-e072-4326-9f21-bcd6163dd095', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('83c815c7-3131-4d5d-9df4-588c95fc332a', '1f18147a-eadc-42db-91a9-b200a7f624c5', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('88a9412b-a68b-4881-96ab-8774c3d77e38', '66d073e0-9606-4213-8f0e-4f92627ffe2b', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('8ba34706-20ec-42ff-9fa7-11f7f1b3d198', '63826f48-ff69-464f-a4d0-e6d67ae8de09', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('8bf1a2da-d6c5-49bc-b0fb-01d4c14c6cbb', '02a0530d-6a5a-478d-932f-9d827bce6449', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('9413e77c-dbd6-4c31-a9de-1cb145ef4263', '08e20b01-79eb-4fcc-878e-d7aab101752a', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('962f998c-d532-479f-a392-68ff7ed3c3ba', '78197f39-bf74-48d0-a1ed-20ac3a158a14', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('96d2d4a3-e547-449d-b2d7-2a975057087d', 'eede9cd4-9e44-4172-bc70-2426293fdd1a', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('996f895a-215b-4c87-a054-c76faa629b09', '26128bc5-1150-4735-a188-af8f16d653db', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('9f2308fc-2e70-48e5-96c9-71fa90458ff5', '50a3affa-a335-4883-9f6e-61b3dc066da0', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('b2989cde-2308-4271-a60f-d5f4f0d73876', 'af4b4817-120c-4b12-89cc-524722936f34', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('b3b83c57-06e8-4129-a075-6c52cec4aa07', 'bdf26050-7cab-42b6-84b7-f98acaddb4f4', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('b757489f-bc39-4438-8721-7e8eae60541f', '01d5a9e9-96e8-475b-ab13-114c0b20522c', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('c47862a3-5007-4c02-aac3-ff61ae0bc392', '0e5815fb-8d23-4cef-864c-51088ebe12a0', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('ca7860c0-3530-4cac-a380-58df6bdc55c2', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('e27da7ef-4307-44ec-b733-154058655afc', '88777dde-ca0c-484c-bc6a-742930dad2a9', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('fe686d7b-22d4-4cea-b558-aff281adc6b7', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_reminder_schedule" ("id", "period_id", "dagen_voor_deadline", "actief") VALUES ('52ccecd7-bbbd-433b-93e3-b6359a53b03c', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 1, 1);
INSERT INTO "dienstrooster_reminder_schedule" ("id", "period_id", "dagen_voor_deadline", "actief") VALUES ('e38e7a53-4f64-4508-a2b9-2db250b6e0c2', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 7, 1);
INSERT INTO "dienstrooster_ruleset" ("id", "naam", "config_json", "versie", "aangemaakt_op") VALUES ('7371fe16-9f17-4c54-98a0-af0ffe4862c2', 'Default Ruleset', '{"windowWeeks":2,"blockBudget":{"AVOND":{"maxFraction":1},"WEEKEND":{"maxFraction":1},"FEESTDAG":{"maxFraction":1},"parttimeExempt":true},"softBlockBudget":{"AVOND":{"maxFraction":1},"WEEKEND":{"maxFraction":1},"FEESTDAG":{"maxFraction":1}},"softBlockPenalty":3,"softBlockPenaltyPerPriorViolation":1,"softBlockPriorViolationCap":3,"largeBalanceThreshold":2,"bandDeviationPenalty":[10,40,160],"bandDeviationMultiplier":4,"holidaySpreadWithinPeriod":5}', 1, '2026-11-11T17:24:04.232Z');
INSERT INTO "dienstrooster_ruleset" ("id", "naam", "config_json", "versie", "aangemaakt_op") VALUES ('8720c770-3fe8-4d9e-8ebd-8d1a831eb005', 'AIOS', '{}', 1, '2026-11-11T17:24:04.656Z');
INSERT INTO "dienstrooster_schedule_period" ("id", "pool_id", "naam", "start_datum", "eind_datum", "deadline", "status", "bevroren_ruleset_json", "overloop_bevestigd_op", "gepubliceerd_op", "gepubliceerd_door_person_id", "row_version", "aangemaakt_op", "verwijderd_op", "auto_herinneren", "basis_url", "uitgenodigd_op", "definitief_op", "definitief_door_person_id", "voorlopig_rooster_json") VALUES ('1e6ce301-318c-4746-b7df-8cb9ae9cb146', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', '2027-1 (Jan-Jun)', '2027-01-04', '2027-06-06', '2026-12-15T17:00:00Z', 'CONCEPT', NULL, NULL, NULL, NULL, 1, '2026-11-11T17:24:04.232Z', NULL, 1, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('071696ae-00c5-4f79-bff9-f46788b83de9', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-07', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('12012cec-007b-4e95-af19-e1bb8096e270', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-11', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('18d0dd42-8826-44fd-8cad-90baed07ee2e', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-15', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('204816ae-1803-4b77-b440-1c0d1bfc4230', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '33088952-0d98-43df-ab10-939ceb4b5f35', '2027-01-17', 2027, 2, '2027-W02-SUN', 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('355892af-c339-42f6-a988-6e506534a480', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '33088952-0d98-43df-ab10-939ceb4b5f35', '2027-01-10', 2027, 1, '2027-W01-SUN', 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('5aea77fc-9b19-4515-9c15-9184fc7e2bb2', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-08', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('6a845022-c233-487c-89cc-6152796bd623', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '33088952-0d98-43df-ab10-939ceb4b5f35', '2027-01-16', 2027, 2, '2027-W02-SAT', 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('6f1a7905-f648-40d7-86e2-0ae8178215a3', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-12', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('8042db2a-de6e-4546-8bad-802ce471a97d', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', '33088952-0d98-43df-ab10-939ceb4b5f35', '2027-01-09', 2027, 1, '2027-W01-SAT', 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('8e6594a2-b19e-4ad9-b9ca-3c72e9e5bf36', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-05', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('ae175048-2055-4974-b36b-eb5adee57c41', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-14', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('d57eba9a-b45f-44ea-a18c-a68bfa4de05b', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-06', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('d79d4571-2f89-4dff-8b09-1561c58fd6d5', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-04', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('edb1b83c-4b65-4acb-be9c-18c0f3fc2c97', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'e88ee4e7-4499-4766-bba1-41f65305d681', '2027-01-13', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('16e495cb-5aa8-465f-9d62-36fc4fae3229', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'Zaterdag', 'WEEKEND', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('33088952-0d98-43df-ab10-939ceb4b5f35', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'Zondag', 'WEEKEND', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('6aa3a9b2-38ef-4959-b022-8946c2cf1d18', 'b116b0c8-8616-4c8e-9a76-1625fef7438e', 'Nachtdienst', 'AVOND', '22:30', '08:30', 'ND', 'NACHT', 1);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('71ab19ed-cd2a-4f67-aa1a-e7c56c794916', 'b116b0c8-8616-4c8e-9a76-1625fef7438e', 'Avonddienst', 'AVOND', '17:36', '23:12', 'AD', 'AVOND', 0.6);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('95b2776b-7280-4e85-8403-4adf6ea71153', 'b116b0c8-8616-4c8e-9a76-1625fef7438e', 'Uitloopdienst', 'AVOND', '17:36', '20:00', 'UD', 'UITLOOP', 0.2);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('aa110824-00cf-4546-a5b4-1c820b07042d', 'b116b0c8-8616-4c8e-9a76-1625fef7438e', 'Dagdienst', 'WEEKEND', '08:30', '18:12', 'DD', 'DAG', 1);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('c97b5dfc-aa6b-492b-91d6-2767627aec49', 'b116b0c8-8616-4c8e-9a76-1625fef7438e', 'Avonddienst weekend', 'WEEKEND', '13:30', '23:12', 'ADW', 'AVOND', 1);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('cea9f2da-2d18-481f-98d4-f3561205ccdd', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'Feestdag', 'FEESTDAG', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('e88ee4e7-4499-4766-bba1-41f65305d681', '9dbe63ee-154f-4f6d-93d6-da48fa2f0e64', 'Avonddienst', 'AVOND', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('169bfb98-73be-4992-b023-04303fc88be6', '3f0863f0-bc7d-4313-bdd2-75cb876db221', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('1ae367b6-9fc9-4962-acf1-141f18ec8743', '900af8d3-56db-4655-bdfb-603cb2f9d00a', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('23fc4a34-6884-4bf7-a378-6403253c3e90', 'bc6c4007-7e22-4260-85e5-880ac386824f', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('2b16e063-08c7-41e0-9fcc-ae76526d94f4', 'e943eb18-cfc8-4f8f-b493-69fba5b90d2c', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('39467693-425c-4cad-abb5-682e6a316e0d', '4870ea66-e15f-4a1b-93f7-61539f4916a9', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('40673c1f-4dd0-4bcb-8d8f-10bb2c2678e3', 'aa97f2ca-c9bf-44c4-9852-9d2992c0b759', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('43d473a8-efe1-4520-a769-c0e2334819e8', 'a40acfc3-3fdb-4b0d-b8e0-3e68b9c6d7b6', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('452c4442-6e17-499f-9027-d14e8d5b332b', '02a0530d-6a5a-478d-932f-9d827bce6449', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('4ca398f4-48f9-433c-924f-637fc1dfc35c', '08e20b01-79eb-4fcc-878e-d7aab101752a', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('4cb4c505-0c49-4b3c-b5c8-348bd12de595', '50a3affa-a335-4883-9f6e-61b3dc066da0', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('50f69d31-fa79-4afd-af08-c4a8da7d178e', '38a7d715-9f11-43af-8fae-5338fc853c89', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('51eb64e0-969d-435b-882f-e666ee5f6013', 'd2935c0b-0678-4f57-959c-393e66fd754a', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('84f461d9-a431-41dc-a50a-145aebd67e26', 'fed7a218-22a6-4500-b168-32b17744e7a2', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('867d6762-72e8-4793-bb73-0288ac5ab804', '0e5815fb-8d23-4cef-864c-51088ebe12a0', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('8c4c30c7-9338-4712-b09c-f06beed80bed', '4fc357ef-e072-4326-9f21-bcd6163dd095', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('8f4a49ba-6a04-4ec0-9368-9bb46340deb0', '01f1bbbb-30ba-45c0-9875-eb08216753ab', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('9da6e058-f216-452d-986a-40f0c48365db', 'bdf26050-7cab-42b6-84b7-f98acaddb4f4', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('9db28ea3-f4e8-4e49-8623-81d855d274ec', '26128bc5-1150-4735-a188-af8f16d653db', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('abedfa36-f41c-45c9-8276-f0f3c4d760db', 'eede9cd4-9e44-4172-bc70-2426293fdd1a', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('bd7781b1-fdf3-4bfa-b6b2-01a7f699da75', '4b0865f1-e6b3-4792-aeec-2e859a1284b6', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('be79024c-ada2-4d5d-923f-f3fd4629cc9a', '01d5a9e9-96e8-475b-ab13-114c0b20522c', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('c607d870-51af-467c-9c28-4234903df3d1', 'af4b4817-120c-4b12-89cc-524722936f34', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('ccc50c07-f3e3-4cc2-9ccf-6e183aab9869', '9e706ee5-4a7b-4f20-a435-15249ab5fd37', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('cf25043d-9a59-4fd8-a55b-358e5eaef028', 'efc57ff4-a803-497a-a083-260c4b9217b6', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('d98a7b35-5248-49b6-a5b7-bbe8c1b13d5a', '88777dde-ca0c-484c-bc6a-742930dad2a9', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('dcda0caa-c4bd-40b5-ba95-947b3aca1769', '1f18147a-eadc-42db-91a9-b200a7f624c5', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('dde847e8-b0d2-443d-8f7a-81f2bf64e84d', '63826f48-ff69-464f-a4d0-e6d67ae8de09', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('e0cb2d0d-f537-46be-83da-f8edcd02855a', 'dd9c4096-28a1-4f1a-9d13-923bc66be168', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('e8411367-3138-4555-9023-f25548d8707b', '66d073e0-9606-4213-8f0e-4f92627ffe2b', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('f23f5668-4144-4e90-a03a-bbba00f202bc', '78197f39-bf74-48d0-a1ed-20ac3a158a14', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEVESTIGD', '2026-11-11T17:24:04.232Z', 1, '2026-11-11T17:24:04.232Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('ff6b6d1d-5f91-46aa-a879-46f296959bb2', '5ded5a97-730c-48d2-82e7-e5c12828590d', '1e6ce301-318c-4746-b7df-8cb9ae9cb146', 'BEZIG', NULL, 1, '2026-11-11T17:24:04.232Z', NULL);
CREATE UNIQUE INDEX aios_beginstand_uniq
      ON dienstrooster_aios_beginstand(pool_id, person_id);
CREATE UNIQUE INDEX aios_blokkeuze_uniq
      ON dienstrooster_aios_blokkeuze(period_id, blok_id);
CREATE UNIQUE INDEX aios_doel_uniq
      ON dienstrooster_aios_doel(period_id, person_id);
CREATE UNIQUE INDEX aios_reden_uniq
      ON dienstrooster_aios_reden(period_id, person_id, datum);
CREATE INDEX aios_ruil_periode_idx ON dienstrooster_aios_ruil(period_id);
CREATE UNIQUE INDEX aios_wens_uniq
      ON dienstrooster_aios_wens(period_id, person_id);
CREATE INDEX assignment_edit_periode_idx ON dienstrooster_assignment_edit(periode_id);
CREATE INDEX assignment_person_idx
      ON dienstrooster_assignment(person_id);
CREATE INDEX assignment_slot_idx
      ON dienstrooster_assignment(slot_id);
CREATE UNIQUE INDEX assignment_uniq
      ON dienstrooster_assignment(schedule_version_id, slot_id);
CREATE INDEX audit_actor_idx ON dienstrooster_audit_log(actor_id);
CREATE INDEX audit_entiteit_idx ON dienstrooster_audit_log(entiteit, entiteit_id);
CREATE INDEX availability_slot_idx
      ON dienstrooster_availability(slot_id);
CREATE UNIQUE INDEX availability_uniq
      ON dienstrooster_availability(person_id, slot_id);
CREATE UNIQUE INDEX holiday_history_uniq
      ON dienstrooster_holiday_history(person_id, feestdag_groep, jaar);
CREATE INDEX ledger_person_period_idx
      ON dienstrooster_ledger_entry(person_id, geldt_voor_periode_id);
CREATE INDEX notification_person_idx ON dienstrooster_notification(person_id);
CREATE INDEX notification_type_idx ON dienstrooster_notification(type);
CREATE UNIQUE INDEX parttime_pattern_uniq
      ON dienstrooster_parttime_pattern(person_id, weekdag, geldig_vanaf, geldig_tot);
CREATE UNIQUE INDEX pending_undo_scope_id_uniq ON dienstrooster_pending_undo(scope_id);
CREATE UNIQUE INDEX period_excluded_day_uniq
      ON dienstrooster_period_excluded_day(period_id, datum);
CREATE UNIQUE INDEX period_factor_uniq
      ON dienstrooster_period_factor(period_id, person_id);
CREATE UNIQUE INDEX period_fellow_uniq
      ON dienstrooster_period_fellow(period_id, person_id);
CREATE INDEX person_access_link_person_idx
      ON dienstrooster_person_access_link(person_id);
CREATE UNIQUE INDEX pool_membership_uniq
      ON dienstrooster_pool_membership(person_id, pool_id, geldig_vanaf, geldig_tot);
CREATE UNIQUE INDEX prior_assignment_uniq
      ON dienstrooster_prior_assignment(period_id, datum, teller);
CREATE UNIQUE INDEX reminder_run_moment_uniq
      ON dienstrooster_reminder_run(period_id, dagen_voor_deadline, deadline);
CREATE INDEX shift_block_period_idx ON dienstrooster_shift_block(period_id);
CREATE INDEX slot_datum_idx ON dienstrooster_shift_slot(datum);
CREATE INDEX slot_period_idx ON dienstrooster_shift_slot(period_id);
CREATE UNIQUE INDEX submission_uniq
      ON dienstrooster_submission(person_id, schedule_period_id);
CREATE INDEX swap_request_periode_idx ON dienstrooster_swap_request(periode_id);
CREATE INDEX swap_request_status_idx ON dienstrooster_swap_request(status);
