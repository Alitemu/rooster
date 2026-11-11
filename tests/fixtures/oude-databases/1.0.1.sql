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
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('035c6b8e-931c-479e-a58b-38c433c6e088', 'a17698f4-d0d8-4573-afa8-154df717b1b4', '2027-04-06', '2027-04-15', 'VAKANTIE', NULL, 'a17698f4-d0d8-4573-afa8-154df717b1b4', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('3917ad94-058d-40a9-ac1e-b3f9df7e6a16', '031db379-600e-484f-8e23-cf7ca9e2955b', '2027-02-18', '2027-02-23', 'VAKANTIE', NULL, '031db379-600e-484f-8e23-cf7ca9e2955b', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('57289d00-9e22-4fb6-bcec-0bf4a1ca1a74', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '2027-03-27', '2027-04-04', 'VAKANTIE', NULL, 'a0194126-cd5c-4264-b95b-779af07a0e8b', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('aec0e085-b0d1-4dcb-8667-5c7ec390edf1', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '2027-02-22', '2027-02-27', 'VAKANTIE', NULL, 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('b982afa5-3f57-4e3c-b12f-e9746903a9a7', '90e591be-9486-4506-9e76-08244996c1c9', '2027-02-02', '2027-02-05', 'VAKANTIE', NULL, '90e591be-9486-4506-9e76-08244996c1c9', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('ba1d4c8b-e79e-41f7-88c9-af672b2b70a2', '1e1c3b28-600c-4d58-bfc2-430eea64a360', '2027-03-13', '2027-03-19', 'VAKANTIE', NULL, '1e1c3b28-600c-4d58-bfc2-430eea64a360', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('c4339a13-afd3-47f4-9bae-0919a4151f2f', '05c8677c-25f9-48a5-a629-ecef2f74a708', '2027-03-10', '2027-03-14', 'VAKANTIE', NULL, '05c8677c-25f9-48a5-a629-ecef2f74a708', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('d0703c79-3d02-42e6-882d-8fe31bc5aeff', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', '2027-04-21', '2027-04-30', 'VAKANTIE', NULL, '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('f340e3b5-2d16-476c-8124-bb085c96ea40', '5a851496-e299-414a-afcf-d532bae4c432', '2027-02-20', '2027-03-01', 'VAKANTIE', NULL, '5a851496-e299-414a-afcf-d532bae4c432', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_absence" ("id", "person_id", "van_datum", "tot_datum", "soort", "notitie", "aangemaakt_door", "aangemaakt_op") VALUES ('f91e6055-f0b1-48ff-a6cc-f017e3dd0784', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '2027-04-13', '2027-04-22', 'VAKANTIE', NULL, 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('00b5b8a9-2181-47f1-a788-605401a53933', '356267ed-536d-4e63-9c3d-325e7986d1f1', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('01534157-90e5-4b49-b1c0-4b7fe6850ef9', '1bdfa9d7-f213-4028-91ac-e9d18bf6f7d8', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('02092e57-5734-4a27-bfc7-9cb58062210a', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('02931726-a9a5-4a5e-997f-32467faee550', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('04fd636e-db5d-44ff-87ec-beb9220db1fe', 'a0194126-cd5c-4264-b95b-779af07a0e8b', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('067d6093-cc48-4385-94dc-7a442d094258', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('072f154a-14f2-4815-990d-a1109be06775', '90e591be-9486-4506-9e76-08244996c1c9', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('0819e8e8-1e58-4a1c-855f-c9c7ee69468a', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('0b638665-cc12-4125-8e39-ec5547cf89eb', '90e591be-9486-4506-9e76-08244996c1c9', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('0e51a76b-b039-42d9-9d12-11e0094521e5', '5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('0f70d24d-f9d2-4920-8868-34eaca68f6eb', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('0faf3f74-0cd1-48e1-b829-b6b2850fba5e', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('12a9070c-ed0a-4848-8402-9651b671432e', '90e591be-9486-4506-9e76-08244996c1c9', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('15eb6002-35b3-4bd7-b52a-dc3715c48d40', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('16b33aec-649e-4d92-890d-fd75b4f6a367', '22a45494-3a22-4651-8a02-1ea7a91f261d', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('16f75a55-35aa-47a2-bfc6-1d1c72a06e5e', 'a01cf4bd-73c0-4d2c-aa64-fd9257c2c348', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('18483a78-5233-454d-96df-403ebd4625a7', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1871666c-4eb2-4aee-a65f-e38a86baff10', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1910e3d8-49dd-42a4-8a37-134f94fe75bd', 'f5cc0250-44c2-42a8-9dba-588afc331659', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1b04f855-9414-4b85-8283-2dd720fadf7e', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1b0f845e-25b7-4e5b-8f86-9a47207ab2b3', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1bd37c45-ec15-4ca5-8cf4-804241969d3c', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1cd5ada1-7718-4e4e-b798-3c537693c485', '90e591be-9486-4506-9e76-08244996c1c9', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1d12ffee-ac91-459b-bbe8-da7a8cb22326', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1ee1b46d-5809-461c-9675-290e0013accb', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1f02ff3d-389e-43ed-ad10-75612efd2ec8', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1f3d0961-6cac-429f-8fe2-6e19698a2cb7', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('1ffe7dec-7c82-455a-b575-18c3abad4b66', 'c94975df-820b-40b6-847c-809f245cfd6f', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('205bb980-cf79-4f0c-9b30-27ac6f25628a', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2377887f-b5d1-4d66-89d7-b654aa57307c', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('26441299-c749-4598-ac6e-2d6bbdd0753a', '1e1c3b28-600c-4d58-bfc2-430eea64a360', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('267eb4bd-01cc-4fda-8c17-53fe46f8bed8', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('282d29d0-b1c5-42d7-9141-c13464f2ee27', '356267ed-536d-4e63-9c3d-325e7986d1f1', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('28531ed8-98f4-4079-ac2a-77d731f085a4', 'f5cc0250-44c2-42a8-9dba-588afc331659', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2ac1b5a2-ec5c-45f4-bab0-a2570bb90d72', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2ace473d-7aca-4fcd-ba86-0ab847de9cd8', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2c91f3e4-b71f-4565-93f6-16bbcb30659f', 'af5f86c8-d8c1-426b-84df-0c7f8c1dbe5f', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2cb53989-91cb-414c-af1a-d2a033e63964', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2e1883db-2716-4e22-954e-bb450f716965', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2f3cd852-b0df-410b-829b-dc0e7710fa1e', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2f961ec7-d492-45da-aeb9-82805167ffe7', '22a45494-3a22-4651-8a02-1ea7a91f261d', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('2f9ca9ea-eedf-4639-9740-3ef736749ecf', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('30466c9f-b225-4c5c-8b82-ea213643cff8', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('30facfb4-a292-48af-8d7d-8adec03e82c1', '22a45494-3a22-4651-8a02-1ea7a91f261d', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('31ebce15-a743-4fe2-b9f7-d4741b1f321e', 'b52b2b9c-a14d-496a-81c6-8317b4286756', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('32181c21-3221-47b5-ae72-3ec70a19dfe0', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('323ba346-d4f3-4705-b497-13ee1d3c22a8', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('32ba2c8a-2f61-44ed-8d1d-80ebcf27e472', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('3345c01f-0ec2-4f70-843d-e6defd8b215f', '90e591be-9486-4506-9e76-08244996c1c9', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('359276f4-3797-4924-8f11-6163b8886847', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('35a77785-f329-4854-8777-d867fc819f77', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('3630dceb-1bf2-4a32-866a-8e7c00d4c32a', '5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('363377d0-a337-4b2c-acc1-af0ac6532102', '356267ed-536d-4e63-9c3d-325e7986d1f1', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('36e03e6c-4cbf-4855-9ecd-6ead342c7159', '22a45494-3a22-4651-8a02-1ea7a91f261d', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('37c38bf6-37e1-432e-851f-e37e79326f8d', 'f5cc0250-44c2-42a8-9dba-588afc331659', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('39e3cdc1-e61c-4036-9cdf-b2aedc0760ed', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('39f0bb42-b322-4533-af4e-5dddecb34492', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('3be2ee8a-b380-46da-8949-88048edee32e', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('3c0899e1-c5e9-4efd-a215-65db85f7d04d', '83321516-46f2-48f6-8829-a3c8dabffa3b', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('3de2be45-982f-4e82-9564-9eb32064344f', 'c94975df-820b-40b6-847c-809f245cfd6f', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('3e8fc0ca-1bd1-486f-9a38-ffc289ce1d30', 'c94975df-820b-40b6-847c-809f245cfd6f', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('411a6396-bcec-4b92-8002-477bbfef7669', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('41d0687e-9f5b-49a3-8e34-dbee8e239fc8', '22a45494-3a22-4651-8a02-1ea7a91f261d', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('41fe922c-1d70-48a6-af60-c5769acf65e0', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('43e1a34a-55d7-44ef-8e66-139f26bac5b9', '90e591be-9486-4506-9e76-08244996c1c9', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('44a498a8-7362-4104-9bb2-3211fd9d6065', 'c94975df-820b-40b6-847c-809f245cfd6f', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('454be781-f4aa-42f7-8dbb-73f0d6061cc0', '7d700449-6d98-40b8-971e-9c356e080c51', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('459cf300-a96b-4e6d-b74f-f4f5049d0dc7', '54b69c7d-a465-40b2-b110-efe7bdf81774', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('45e008a4-e965-4b14-952b-adb034493d79', 'af5f86c8-d8c1-426b-84df-0c7f8c1dbe5f', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('46553a26-72b0-4806-9aba-a79e2c9535b8', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('47482cde-5119-41d0-b3a9-f4ea4f154450', '356267ed-536d-4e63-9c3d-325e7986d1f1', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('47573e57-952f-4bf2-9ade-e94baeb61ee0', '05c8677c-25f9-48a5-a629-ecef2f74a708', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('47ad991d-9acb-441b-b07e-3560099025f8', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('47e57418-41cd-4835-ba7e-a49b615f6c91', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('492cfa09-e0a2-4154-bf1f-a0e673f4e976', 'af5f86c8-d8c1-426b-84df-0c7f8c1dbe5f', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('493b1518-0cc9-4e94-ab46-d045c582d1cd', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('498451fd-3214-4bc2-a122-c5146dd3f3ab', 'c94975df-820b-40b6-847c-809f245cfd6f', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4a1d0a0f-48aa-4ed9-8983-79ad9405874a', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4b38f4bd-cf4d-48bf-ba26-e8f04d5c2ea7', 'f5cc0250-44c2-42a8-9dba-588afc331659', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4bf23aec-93ea-45ec-bb3a-99106bb4455f', 'c94975df-820b-40b6-847c-809f245cfd6f', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4c82051d-d19f-4cf3-8bf9-7011a37b646b', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4db9a452-8cba-45f9-9212-9f8568f76e00', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4dddd06c-b281-46cd-953d-7fe0493402da', '5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4e842562-5e52-47c3-b481-aa62ddb1ea42', '7d700449-6d98-40b8-971e-9c356e080c51', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4edbcddc-e05f-47f5-adac-1453cd812a7a', '5a851496-e299-414a-afcf-d532bae4c432', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4eea3b21-e486-4519-b1d2-1fd335faa95f', 'a0194126-cd5c-4264-b95b-779af07a0e8b', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4fc2d695-f7ec-411c-a429-2ebbcc05939b', '031db379-600e-484f-8e23-cf7ca9e2955b', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4fdfe715-97aa-45f4-adf8-4fbfbf09926b', 'a01cf4bd-73c0-4d2c-aa64-fd9257c2c348', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('4feb600b-a5ec-4867-ac9b-3e669f8f92a8', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('519e8795-e5ce-463b-8739-cf2a75e08326', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('524f6737-2d80-4fe5-86a2-10207dcb8d68', 'a723d637-1a32-4e76-b75d-0c23aea3b693', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('58aafe9c-44b4-46c9-9084-442a7c01288c', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('58e2b787-1f9c-4f6e-8972-d10f8a322b3f', '1bdfa9d7-f213-4028-91ac-e9d18bf6f7d8', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5b6fb410-e1a4-4fcf-a95a-d1653308dfc9', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5b9bcbc0-5aa4-431d-90b6-6f93a6afb07b', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5c3b0406-7677-4a0f-890c-be4d77635293', '90e591be-9486-4506-9e76-08244996c1c9', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5c549b1f-ae6c-40fd-b033-163c1ad9d3cd', '1e1c3b28-600c-4d58-bfc2-430eea64a360', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5e9c2d50-60ff-4d1d-a012-4d9fcd5768f4', 'c94975df-820b-40b6-847c-809f245cfd6f', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('5f6adfe4-25c7-4a85-81d5-5f55e74c2b10', 'a17698f4-d0d8-4573-afa8-154df717b1b4', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6169d48c-e7d3-49c2-800f-c1224940816f', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('63d18f49-d3c2-4952-a7cf-7ca345d07961', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6496cad7-0118-462f-b0d6-9579b30899a8', '22a45494-3a22-4651-8a02-1ea7a91f261d', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('64bc766f-9210-4641-976b-9581397fcf22', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('69edd818-6ce8-4c85-9137-4a5b9249b32a', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6bf9aab4-c7fb-4fe4-a80c-08084f3f5789', '1e1c3b28-600c-4d58-bfc2-430eea64a360', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6c1a574f-c1d0-4f62-b859-7c7a1fb82ede', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6c4c2ad8-a9da-48fc-a1fc-ecfd7c42dd4e', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6c92ad2c-d7a7-4f71-a1ab-f5537b523f85', 'f5cc0250-44c2-42a8-9dba-588afc331659', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6e435801-da49-4764-8290-c126399be5a4', '22a45494-3a22-4651-8a02-1ea7a91f261d', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('6ed71bd9-0c3a-4329-97bc-8c799a675451', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7080c478-a092-49f9-a399-3665b5d422b1', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('717cd4fe-261f-49d6-8f88-e8ac282dc810', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('71912510-365f-4e90-8487-f177f41159a4', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('72b92dad-87f1-4965-a04e-6eb446cbe090', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('72c2ae53-ada0-4f95-85bb-28404ed0f93a', 'f5cc0250-44c2-42a8-9dba-588afc331659', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('732ca031-7c32-4525-b6f6-8d06b2938721', '8d6ed3ee-c83f-4f3a-8170-6fc6ebfba424', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('735fc12a-ed23-4dc6-a923-5fde26820047', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('74c1385c-3bbe-4d60-b881-6f1602eb2551', 'c94975df-820b-40b6-847c-809f245cfd6f', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7556ba0f-ce35-4ec1-bf38-96be98c62dc4', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7616103c-38c3-47bd-b5bc-4362ef0726b7', '356267ed-536d-4e63-9c3d-325e7986d1f1', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('76d437a4-7de9-4887-ab6d-9a9d9c761dd5', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7836d951-199e-4923-8833-09c3e539c9b8', '90e591be-9486-4506-9e76-08244996c1c9', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('78c88843-aed7-4e6b-b7c1-e59407f45dbd', 'af5f86c8-d8c1-426b-84df-0c7f8c1dbe5f', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7931b4e5-5800-416a-9850-c41d21689c85', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('79dd9107-ab3b-4a93-b686-da0dc80bb0a3', '90e591be-9486-4506-9e76-08244996c1c9', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7a26b32a-a4f0-4119-aace-71854bdec670', '356267ed-536d-4e63-9c3d-325e7986d1f1', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7a58eff6-e7f1-45d0-b8f5-d404837b674c', '90e591be-9486-4506-9e76-08244996c1c9', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7af9b696-8245-4874-8ba2-08912d941ea0', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7d28a9c2-9bef-4504-8efd-472a142b0269', '8d6ed3ee-c83f-4f3a-8170-6fc6ebfba424', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7edbe71a-4e61-4ea2-89a6-5dc64470557d', '356267ed-536d-4e63-9c3d-325e7986d1f1', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('7f8f1281-f209-4151-9746-3b82332f9b7f', '8d6ed3ee-c83f-4f3a-8170-6fc6ebfba424', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('80144dbf-9ed5-487c-96f2-b49f49c4b4ca', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('80d45a7a-cf3e-4d57-89fb-a81d5acd8680', 'c94975df-820b-40b6-847c-809f245cfd6f', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('81319558-1be0-4c64-bdb3-ec5f300cfef0', 'f5cc0250-44c2-42a8-9dba-588afc331659', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('813c7416-5c37-4519-85c7-751da53c9ee9', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('81ab5343-500b-4491-adb5-792542bb8ed7', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('827f6de6-a771-4296-b588-6629e58fec28', 'a0194126-cd5c-4264-b95b-779af07a0e8b', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('8342aafd-1a0a-4fc6-9f92-0aeb59f9f539', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('83d21633-2196-44b5-8469-b8579e2dc5ac', 'f5cc0250-44c2-42a8-9dba-588afc331659', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('8448e90e-60e3-42a3-b9b5-6c82fa5f63c3', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('84abf0e1-bff3-489e-bcc0-27a5a315f133', 'f5cc0250-44c2-42a8-9dba-588afc331659', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('84bd6e6e-f30c-49b1-9b5a-d81909219d34', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('8c601dee-0082-4c9d-8420-0edee0681b81', '5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('8dc987cd-2552-414b-9abf-ad2c9bbed1ab', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('8e1cbfce-6509-4feb-b7c0-5eeec4e62c9a', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('8f419a7b-b60a-49b5-b491-cfe2962fd671', '5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('8f8973de-760e-4f96-9e46-5672b2888448', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('90a2a2c4-c5c0-4746-acec-2fc1e417469a', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('91669039-ff65-4f72-9b17-8d98867f269a', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('92cdf499-4112-4fdb-93a8-2497c4600532', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('93f13c3b-416f-4ba7-8c84-261d445a9cd5', '356267ed-536d-4e63-9c3d-325e7986d1f1', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('947231bf-a0a6-4d9a-989d-7847878d8c27', 'c94975df-820b-40b6-847c-809f245cfd6f', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('95d8978c-794d-4718-8f0e-9b64e3a68d77', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('96ebcd98-1534-47c5-bef6-934469ad838e', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('97595bd6-307b-4365-8f06-a722e51a87b0', '356267ed-536d-4e63-9c3d-325e7986d1f1', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('98363ac9-0f25-4989-8df2-6b3777c7aa54', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('98565f4e-bee7-449f-bb9a-0dd40fdf5b56', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('99d7a4f1-d294-4e40-ae3b-8a6733e83dc6', 'b52b2b9c-a14d-496a-81c6-8317b4286756', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('9af4edd1-efef-4071-8b41-335246bb3a6e', 'c94975df-820b-40b6-847c-809f245cfd6f', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('9ccacd6b-5158-44cf-b4d2-d4bb4653c3f7', 'f5cc0250-44c2-42a8-9dba-588afc331659', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('9d54fe89-0234-4a22-801f-65f9e4011ff3', '356267ed-536d-4e63-9c3d-325e7986d1f1', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('9d71e970-9d91-464d-a451-ce41c09935c2', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('9e23f0b3-39cb-41dd-9ef8-ebdd1c8e0fc5', 'a723d637-1a32-4e76-b75d-0c23aea3b693', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('9fee6466-f08a-419a-a009-4805b7f77a94', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('a2a02085-f079-4930-b87c-007b0e8ec580', '7d700449-6d98-40b8-971e-9c356e080c51', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('a6844b51-861c-4bf0-bf0d-305b70d58878', '031db379-600e-484f-8e23-cf7ca9e2955b', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('a8639df3-520d-4f8b-9a08-b84a2afee1bf', 'a01cf4bd-73c0-4d2c-aa64-fd9257c2c348', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('a90c1bcc-7304-466a-b606-90596c0ab015', '7d700449-6d98-40b8-971e-9c356e080c51', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('a91fb3c5-499e-4f20-98d8-08a7b4e9a66b', 'a723d637-1a32-4e76-b75d-0c23aea3b693', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('abafcf38-2e4b-4d7c-8553-8ce9ca5798b0', '356267ed-536d-4e63-9c3d-325e7986d1f1', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ace023cd-dd89-4862-a0df-1e641c269830', '22a45494-3a22-4651-8a02-1ea7a91f261d', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('acf7875e-b4be-4a29-93c0-0dc82f4029fe', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ae69affa-afdb-40e8-ae4b-f689074a69e0', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ae936c9c-c2f3-42ec-b78b-302d12e9401e', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ae9ee821-e643-4dfc-a73a-9fb6616ccc67', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('aeba96ee-c25b-4e14-97de-9978533c6f13', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('aeeb4352-c2ce-4feb-8962-d28d81dbb273', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('af75ae63-1ffa-417c-be1a-e8b99d950d54', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('afe0f7a8-0a62-4b1c-8a8f-2a35bca3894e', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b0b0dd42-2e68-4f13-bacc-8a2eb5d5ea1a', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b350f25e-7552-463e-8c41-b482ceb96b2c', '5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b4044fde-b224-45c9-9ced-77a1f63b6205', '90e591be-9486-4506-9e76-08244996c1c9', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b41fd6e7-f954-4ff8-8932-3637878a2c66', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b43baf7b-c4ed-4863-9060-8b4a310d401c', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b5260b46-2e34-431e-9b2e-cedcd878bd28', 'b52b2b9c-a14d-496a-81c6-8317b4286756', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b5b3be07-1a45-4a32-a4e3-2bfe3c4694c7', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b6406660-e054-42f3-9c95-4aece5ad2f54', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('b7871695-4ed5-4a38-8585-509fc1128415', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ba056a19-2692-4d70-a078-596d869eb7e3', '05c8677c-25f9-48a5-a629-ecef2f74a708', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ba3c01ff-0374-4c95-a1f1-7d4aa78208d9', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('bae353ed-dd3a-43b0-b6d8-9bd1a216dd1f', '7d700449-6d98-40b8-971e-9c356e080c51', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('bcb5d340-8fe2-44e1-b8e6-5cb598e10963', 'a723d637-1a32-4e76-b75d-0c23aea3b693', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('c32bfd1a-742b-4f74-9e0b-e809c6bda86d', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('c491693d-1b86-4c7e-83ad-096596e1b0d9', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('c4f23990-7177-4c18-abfa-f35c893beada', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('c52030a3-b657-4d77-b8f4-ec53a2699a16', 'a01cf4bd-73c0-4d2c-aa64-fd9257c2c348', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('c8dfc716-76a1-461b-ba87-14fc3dd715f4', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('c9423ab8-2a31-4a85-bd18-ce693bd4a9cc', 'a0194126-cd5c-4264-b95b-779af07a0e8b', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('c9927530-476a-4fa4-97e7-e97af43410ae', 'f5cc0250-44c2-42a8-9dba-588afc331659', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ca372d6c-9554-472b-9895-755905dc6861', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('cabc2b30-ffb7-4468-94fd-775d72925bb6', '356267ed-536d-4e63-9c3d-325e7986d1f1', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('cb5a8d49-a6a3-444d-b02d-240061138fcc', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('cbf83aab-5c83-4576-9dc5-445da268fb39', '22a45494-3a22-4651-8a02-1ea7a91f261d', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ce9703c0-350e-4613-81c2-41e1f29a1926', '54b69c7d-a465-40b2-b110-efe7bdf81774', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('cf85d2bd-c884-4190-93bf-f3fa25e69b48', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d21364b0-6395-488f-9d91-c96d888447b4', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d53354f3-45b9-4b4c-923c-caddb6b49c96', 'c94975df-820b-40b6-847c-809f245cfd6f', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d55998d7-6eb3-409b-b5d5-7d3a896299fa', '031db379-600e-484f-8e23-cf7ca9e2955b', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d59c32e8-3ef9-4c47-b03d-d61d2a0762a1', '22a45494-3a22-4651-8a02-1ea7a91f261d', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d6abbbe3-ffc0-4cd2-b283-a66a4118adfa', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d869da75-4b32-4e9b-8d47-57ec2570d589', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('d86c95fa-82a3-4ee7-b228-1f473fc1e0ae', '356267ed-536d-4e63-9c3d-325e7986d1f1', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('da75049a-d3ef-42fd-b1e9-f1657cebd87d', '22a45494-3a22-4651-8a02-1ea7a91f261d', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('df20227a-cbe6-485d-9e70-258625eeee6b', 'a17698f4-d0d8-4573-afa8-154df717b1b4', 'e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('df3bd26f-fe65-42fd-af00-1128071fd765', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e01c5ba9-2af7-4d8e-9387-3b69ed6d2189', '22a45494-3a22-4651-8a02-1ea7a91f261d', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e05c7e8d-4c3d-4834-82fb-c69d79851e25', '90e591be-9486-4506-9e76-08244996c1c9', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e18e3097-6428-4bad-a63c-acb5324a273d', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e34bff81-ca0f-41b2-997b-c9b25fb15da6', 'c94975df-820b-40b6-847c-809f245cfd6f', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e3adc147-53ef-42f0-a35c-a9f978eb80ed', 'b52b2b9c-a14d-496a-81c6-8317b4286756', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e41f30b3-e0cc-492c-8caf-d233419ac019', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e75d383d-25a5-4547-b1a7-7e14f6362a7a', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e76f4817-4622-4caa-a561-ee5b691cc0ae', 'f5cc0250-44c2-42a8-9dba-588afc331659', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e7af15de-9bab-4803-a05e-8493d25a03d4', '83321516-46f2-48f6-8829-a3c8dabffa3b', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'LIEVER_NIET', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e8034c36-7ae9-4da2-9781-71ed59255fd3', 'f5cc0250-44c2-42a8-9dba-588afc331659', '557efee7-cf19-48ff-a4a4-99940638461a', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('e842c29e-fce5-4cbd-b846-d7867d914825', 'af5f86c8-d8c1-426b-84df-0c7f8c1dbe5f', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('eaf4e698-936a-4f40-a7e8-ea654ee91caa', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('eb44fdc1-3286-490b-ab93-aea117882493', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ebf6485f-c62f-401a-b4c9-89c9e59fa45a', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ec810d48-d5d6-4aa8-ac3b-310c1e8ba80f', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ed222cce-3a76-41bc-890a-fca10e999ebf', '83321516-46f2-48f6-8829-a3c8dabffa3b', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ee8bbefe-3db5-401b-929f-ca75061e093d', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ef5a14b2-d6be-4b07-9dce-010af2a62f2d', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f037cb0b-2228-4bbc-b646-3978dd4d2742', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f0e7c90d-596a-4a65-a3b0-f9dfd5cd3683', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', 'f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f10b7e58-f754-47ee-a95d-c85c68c736ee', '90e591be-9486-4506-9e76-08244996c1c9', '955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f339f280-2451-4bf7-a36a-925cdfd09f44', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f385039e-e479-41b7-a618-95a219093cd3', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f3b5fc68-55d8-43d4-9412-c4bad8703010', '1e1c3b28-600c-4d58-bfc2-430eea64a360', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f557c063-f4e8-4c09-adbe-4cab4fbc358c', '22a45494-3a22-4651-8a02-1ea7a91f261d', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f5f905c6-182a-4784-b8b1-e6edf7a4a64d', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', 'a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f6c45254-c5ce-4b0d-b6a5-f650797850d8', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('f9cfeb2e-6d96-4cff-a949-9aa6edd8484a', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '640b659d-3160-4cce-8f56-9e79b14f7677', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('fa962d04-caf6-440c-a22a-b1d16a8f1645', '54b69c7d-a465-40b2-b110-efe7bdf81774', '520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('fbb0dc51-2d24-4696-ac73-e082ab0eac05', 'a01cf4bd-73c0-4d2c-aa64-fd9257c2c348', '2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('fd1574a6-a73b-4683-bc5a-5c13c3222e1e', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', 'cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_availability" ("id", "person_id", "slot_id", "blocking_level", "source", "bron_pattern_id", "bron_absence_id", "fellow_blok", "aangemaakt_op") VALUES ('ffb6496c-5770-43be-8f54-ad1e130dc382', 'a723d637-1a32-4e76-b75d-0c23aea3b693', '856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ABSOLUUT', 'MANUAL', NULL, NULL, 0, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('0066403b-2b0e-4918-92a6-3ed8f3f52098', '5a851496-e299-414a-afcf-d532bae4c432', 'KONINGSDAG', 2027, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('0fc5bf9b-5460-4fe2-bd25-3188c4e832f7', '7d700449-6d98-40b8-971e-9c356e080c51', 'PINKSTEREN', 2025, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('0fcbe32e-b316-4dc8-ab77-66f51ff0851a', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', 'PASEN', 2025, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('1c366900-307c-47b2-8351-006d6bda3f2f', '1e1c3b28-600c-4d58-bfc2-430eea64a360', 'KONINGSDAG', 2028, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('357ae484-d23c-4f68-8661-113d22feca51', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', 'PINKSTEREN', 2026, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('52553cd7-b538-4dec-8bde-27d384178013', 'a0194126-cd5c-4264-b95b-779af07a0e8b', 'KERST', 2027, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('528849a0-1a28-4f1a-998b-c2faa5b329f7', '05c8677c-25f9-48a5-a629-ecef2f74a708', 'KERST', 2028, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('53713860-9522-4cd1-befd-62b2d6656908', 'a17698f4-d0d8-4573-afa8-154df717b1b4', 'PINKSTEREN', 2027, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('7426733b-64be-448e-9a16-6a948a5c99bc', '54b69c7d-a465-40b2-b110-efe7bdf81774', 'KERST', 2025, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('8d3fad83-6e83-4c14-9266-266eadd51a0f', '031db379-600e-484f-8e23-cf7ca9e2955b', 'KONINGSDAG', 2026, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('91fd7fde-52de-423c-b745-b6912955b5ad', 'b52b2b9c-a14d-496a-81c6-8317b4286756', 'KONINGSDAG', 2025, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('96bea33f-35ec-44bf-8f81-110d8097e908', 'f5cc0250-44c2-42a8-9dba-588afc331659', 'KERST', 2026, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('9cb4b7e0-4ee8-4e74-a49a-b994a5d352d6', '90e591be-9486-4506-9e76-08244996c1c9', 'PASEN', 2027, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('b702989e-ed03-4a8d-b960-07291dad21d6', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', 'PASEN', 2028, 'IMPORT');
INSERT INTO "dienstrooster_holiday_history" ("id", "person_id", "feestdag_groep", "jaar", "bron") VALUES ('bc2cf7a0-7899-42f8-a7bb-590b48206181', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', 'PASEN', 2026, 'IMPORT');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('12b00b20-ea1c-4138-b296-c8c86402683f', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'AVOND', 'ef95c519-d62e-4941-8b7d-a92631e9906f', NULL, 1, 'Beginsaldo vanuit import', 'BEGINSALDO', 'dcdca171-4b41-4a5c-ab8e-6595d100f4fa', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('28a89994-c19f-4c98-a729-e480a3efb924', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'AVOND', 'ef95c519-d62e-4941-8b7d-a92631e9906f', NULL, 1, 'Beginsaldo vanuit import', 'BEGINSALDO', 'dcdca171-4b41-4a5c-ab8e-6595d100f4fa', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('446594f8-dd95-45dc-8acc-39083f5a96f8', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'AVOND', 'ef95c519-d62e-4941-8b7d-a92631e9906f', NULL, 1, 'Beginsaldo vanuit import', 'BEGINSALDO', 'dcdca171-4b41-4a5c-ab8e-6595d100f4fa', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('8af47802-0b27-492d-900c-261236f6ea38', '7d700449-6d98-40b8-971e-9c356e080c51', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'AVOND', 'ef95c519-d62e-4941-8b7d-a92631e9906f', NULL, -1, 'Beginsaldo vanuit import', 'BEGINSALDO', 'dcdca171-4b41-4a5c-ab8e-6595d100f4fa', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('8afb6c1d-938d-4ff3-b352-5f025ceb6bdd', '90e591be-9486-4506-9e76-08244996c1c9', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'AVOND', 'ef95c519-d62e-4941-8b7d-a92631e9906f', NULL, -1, 'Beginsaldo vanuit import', 'BEGINSALDO', 'dcdca171-4b41-4a5c-ab8e-6595d100f4fa', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('b773481e-2cec-45db-9ab1-34c69aa4178b', '54b69c7d-a465-40b2-b110-efe7bdf81774', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'AVOND', 'ef95c519-d62e-4941-8b7d-a92631e9906f', NULL, -1, 'Beginsaldo vanuit import', 'BEGINSALDO', 'dcdca171-4b41-4a5c-ab8e-6595d100f4fa', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_ledger_entry" ("id", "person_id", "pool_id", "teller", "geldt_voor_periode_id", "datum", "delta", "reden", "categorie", "aangemaakt_door", "aangemaakt_op") VALUES ('d9b49d41-1da6-4bd5-8fee-0ced2ba05e88', '031db379-600e-484f-8e23-cf7ca9e2955b', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'AVOND', 'ef95c519-d62e-4941-8b7d-a92631e9906f', NULL, -1, 'Beginsaldo vanuit import', 'BEGINSALDO', 'dcdca171-4b41-4a5c-ab8e-6595d100f4fa', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('1a9b4573-80c8-434a-8373-1a97b3422c40', 'FINAL_WARNING', 'Laatste kans: voorkeuren {{periode}} sluiten binnenkort', 'Beste {{codenaam}},

De deadline voor **{{periode}}** is **{{deadline}}** en je voorkeuren ontbreken nog.

Als er niets binnenkomt, wordt het rooster gegenereerd zonder je geblokkeerde dagen.

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('24eb185c-305d-4ce6-90cd-dfcdad77099e', 'REMINDER', 'Herinnering: voorkeuren {{periode}} nog niet ontvangen', 'Beste {{codenaam}},

We hebben je voorkeuren voor **{{periode}}** nog niet ontvangen.

De deadline is **{{deadline}}**.

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('79edbab4-6eec-4962-b287-620be98d2da9', 'SWAP_REQUESTED', 'Ruilverzoek van {{aanvrager}}', 'Beste {{codenaam}},

{{aanvrager}} wil een dienst met je ruilen.

{{details}}

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('887afe85-8eed-49d0-a434-48bcee133db6', 'PARTTIME_CHECK', '{{periode}}: controleer je deeltijddagen', 'Beste {{codenaam}},

We hebben je deeltijddagen voor **{{periode}}** gegenereerd op basis van je patroon.

Controleer ze goed, vooral rond de jaarwisseling. Daar kunnen weeknummers verschuiven.

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('8a8de488-b283-465f-89e4-485477cf5f87', 'DEADLINE_PASSED', '{{periode}}: de deadline is verstreken', 'Beste {{codenaam}},

De deadline voor **{{periode}}** is verstreken en voorkeuren zijn nu alleen-lezen.

Neem rechtstreeks contact op met de planner als er iets moet veranderen.');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('9e739197-3370-4f3d-92e4-ce5586221d93', 'BLOCK_OVERRIDDEN', '{{periode}}: een van je voorkeuren kon niet worden gehonoreerd', 'Beste {{codenaam}},

Bij het samenstellen van **{{periode}}** konden we een van je markeringen niet honoreren:

{{details}}

Reden: {{reden}}

Neem contact op met de planner als dit een probleem is.');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('a247cfcb-e83d-40c4-82c5-d4a79bdc9638', 'SCHEDULE_PUBLISHED', '{{periode}}: het rooster is gepubliceerd', 'Beste {{codenaam}},

Het voorlopige rooster voor **{{periode}}** staat klaar. Kijk je diensten na en laat het de planner weten als er iets niet klopt.

{{link}}

Je kunt vanuit je eigen overzicht een ruil met een collega aanvragen.');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('b5398e1b-195f-47bb-b51e-8814ee5daf0a', 'SWAP_RESULT', 'Je ruilverzoek is {{uitkomst}}', 'Beste {{codenaam}},

Je ruilverzoek is **{{uitkomst}}**.

{{details}}

{{link}}');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('b9f832ac-53e3-4e15-b52b-54a99cd128da', 'PERIOD_OPENED', '{{periode}}: voorkeuren staan open', 'Beste {{codenaam}},

Het rooster voor **{{periode}}** staat open voor invoer.

Geef de dagen waarop je niet kunt werken door vóór **{{deadline}}**.

{{link}}

Vergeet niet je vakantiedagen te blokkeren. Die worden nergens anders vandaan gehaald.');
INSERT INTO "dienstrooster_notification_template" ("id", "sleutel", "onderwerp", "body_md") VALUES ('f915e582-bcd4-41e2-a77e-2f37f6e47820', 'CORRECTION_BOOKED', '{{periode}}: een correctie is geregistreerd', 'Beste {{codenaam}},

Er is een correctie voor je geregistreerd die wordt toegepast op **{{periode}}**.

{{details}}

Reden: {{reden}}');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('1bd22522-5e48-4555-b2d7-b3087859eb5e', '031db379-600e-484f-8e23-cf7ca9e2955b', 'ZO', 'ELKE_WEEK', '2027-01-04', '2027-06-06', '031db379-600e-484f-8e23-cf7ca9e2955b', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('597c8aff-1624-4fb7-81e1-0af44ddb4e13', '90e591be-9486-4506-9e76-08244996c1c9', 'WO', 'ELKE_WEEK', '2027-01-04', '2027-06-06', '90e591be-9486-4506-9e76-08244996c1c9', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('59f9c179-86c5-470e-b8f0-98d380b9e2bd', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', 'MA', 'EVEN_WEKEN', '2027-01-04', '2027-06-06', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('63ec61ac-642f-4eac-ac2b-40a4296755e5', '54b69c7d-a465-40b2-b110-efe7bdf81774', 'MA', 'ELKE_WEEK', '2027-01-04', '2027-06-06', '54b69c7d-a465-40b2-b110-efe7bdf81774', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('66210efe-0fd7-4e6a-ab96-9dbac12b22b3', 'f5cc0250-44c2-42a8-9dba-588afc331659', 'VR', 'EVEN_WEKEN', '2027-01-04', '2027-06-06', 'f5cc0250-44c2-42a8-9dba-588afc331659', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('69285f80-a7f7-4ff2-9a82-8dc98e36a4ce', 'b52b2b9c-a14d-496a-81c6-8317b4286756', 'WO', 'ONEVEN_WEKEN', '2027-01-04', '2027-06-06', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('b59d9230-1d70-4d5d-8ef2-ddd8824b9903', 'a0194126-cd5c-4264-b95b-779af07a0e8b', 'DI', 'ONEVEN_WEKEN', '2027-01-04', '2027-06-06', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('e371d557-7a99-4b40-9d53-5eb2b55e3f67', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', 'ZA', 'ONEVEN_WEKEN', '2027-01-04', '2027-06-06', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('e58dbc78-9c55-4445-92a7-30d4489b2f06', '7d700449-6d98-40b8-971e-9c356e080c51', 'DO', 'ELKE_WEEK', '2027-01-04', '2027-06-06', '7d700449-6d98-40b8-971e-9c356e080c51', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_parttime_pattern" ("id", "person_id", "weekdag", "frequentie", "geldig_vanaf", "geldig_tot", "aangemaakt_door", "aangemaakt_op") VALUES ('f0aac0ea-d41c-48ca-97b0-005883ff6167', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', 'DI', 'EVEN_WEKEN', '2027-01-04', '2027-06-06', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('031db379-600e-484f-8e23-cf7ca9e2955b', 'Persoon-07', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('05c8677c-25f9-48a5-a629-ecef2f74a708', 'Persoon-13', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('1bdfa9d7-f213-4028-91ac-e9d18bf6f7d8', 'Persoon-16', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('1e1c3b28-600c-4d58-bfc2-430eea64a360', 'Persoon-15', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('22a45494-3a22-4651-8a02-1ea7a91f261d', 'Persoon-24', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('2bfb215d-ce7d-4a3e-bbb9-98b03698fdc4', 'admin', 'ADMIN', 1, '$2b$12$CZGoQ3jPfUD3YIi0ho.Ghe8fNFAV.Kg3uo9jBTGC85hD10gTIXtrS', NULL, 1, '2026-11-11T17:24:02.296Z', 0, 'ACHTERWACHT');
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('356267ed-536d-4e63-9c3d-325e7986d1f1', 'Persoon-17', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('37430f8b-82ee-4e6d-84eb-377a2a0758a8', 'Persoon-26', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('43368a7d-525d-4d0b-a4ef-2a62d272b8ad', 'Persoon-18', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('54b69c7d-a465-40b2-b110-efe7bdf81774', 'Persoon-01', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('5a851496-e299-414a-afcf-d532bae4c432', 'Persoon-11', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', 'Persoon-29', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', 'Persoon-25', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('7b11af0d-7a68-4af9-a7b9-782c49f3fedd', 'Persoon-06', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('7d700449-6d98-40b8-971e-9c356e080c51', 'Persoon-04', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('81d985d9-defe-440e-bb4b-2d5484dcbf8e', 'Persoon-19', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('83321516-46f2-48f6-8829-a3c8dabffa3b', 'Persoon-23', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('8d6ed3ee-c83f-4f3a-8170-6fc6ebfba424', 'Persoon-30', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('90e591be-9486-4506-9e76-08244996c1c9', 'Persoon-10', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('97de82a7-5cbf-44b7-ad26-303687bc5e4b', 'Persoon-21', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('a0194126-cd5c-4264-b95b-779af07a0e8b', 'Persoon-09', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('a01cf4bd-73c0-4d2c-aa64-fd9257c2c348', 'Persoon-28', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('a17698f4-d0d8-4573-afa8-154df717b1b4', 'Persoon-12', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('a723d637-1a32-4e76-b75d-0c23aea3b693', 'Persoon-27', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('af5f86c8-d8c1-426b-84df-0c7f8c1dbe5f', 'Persoon-20', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('b52b2b9c-a14d-496a-81c6-8317b4286756', 'Persoon-03', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', 'Persoon-14', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('c54c8baf-f638-4a8f-80da-2a9abf0e84ef', 'Persoon-02', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('c94975df-820b-40b6-847c-809f245cfd6f', 'Persoon-31', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('db87270f-05ee-417b-b8c1-ca39b2a7650c', 'Persoon-22', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('dcdca171-4b41-4a5c-ab8e-6595d100f4fa', 'planner', 'PLANNER', 1, '$2b$12$NDfk/MlEY6lfMf72zhFkVeo/SrNgX9MCwHt8nKQT2mfHw4ExqRNQK', NULL, 1, '2026-11-11T17:24:01.882Z', 0, 'ACHTERWACHT');
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('f5cc0250-44c2-42a8-9dba-588afc331659', 'Persoon-05', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person" ("id", "codenaam", "rol", "actief", "wachtwoord_hash", "totp_secret", "sessie_versie", "aangemaakt_op", "wachtwoord_moet_wijzigen", "dienst_type") VALUES ('fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', 'Persoon-08', 'DEELNEMER', 1, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', 0, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('003a759b-45bd-4352-aa98-d1ac67dab79e', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '0ac05a84fb2a397558ab56d32df14b37a0a425dc080129327379558cae3dae38', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('05b5752b-74b5-4dbb-ab3b-6e13df7b343c', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '120569fcdf3641575a4d4aefe5b8ddb10788d5d8e546a105083f655fd1644343', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('09fb89b1-64d1-40b0-a663-8e85e1a5089c', '1bdfa9d7-f213-4028-91ac-e9d18bf6f7d8', '743bff63726e04e83715f93afef4a63e68a2d24b9225a92eaef6f6b96fbbcbe3', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('116ed1d6-629c-4a9f-a697-9498bb7d29d5', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '2dc419d5f24f358ceea54c0353174b1b31cb7e123fd0fec21a021e1016196694', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('186c77b4-6a0d-457c-976c-4ac90534f420', 'a01cf4bd-73c0-4d2c-aa64-fd9257c2c348', '3f1075b11b226c30c37728c5cf3b93d898335805e6028b2370e361ef42db6342', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('18eb4d15-5cc9-4afb-835f-47fff2d3b3ef', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '66b5117db819ae615b2f820d8b53f47e9938b3de4d2c6695c76e5b60b2b69f30', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('1a6b712e-bba5-47f6-93a1-a5a371e707ad', 'f5cc0250-44c2-42a8-9dba-588afc331659', '9df4f948fe95642d6e662d399f74ad0d0372c59ddc382d8b5c4cf28b3439bc6c', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('1f94eef5-1088-4929-a76c-4c5557b1fbd6', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '74162b27de6b8b96e8a2c255a9ec5d1e7894c7ef6035493b7d44c77e12d4472d', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('21cbbca0-1d98-49dd-b774-0791537923a0', '5a851496-e299-414a-afcf-d532bae4c432', '65ca6e67286c90c78d835c75ad9e3ca1eeb217833759aa7d1d0888625836a4ba', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('290c1dfa-645b-4965-a2b5-3abfc79a0d0f', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '50a31d89751e471f67028bc140352bf3cb20724003ec95261429fc3fcdd0b834', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('2da430de-50d6-4ed9-8712-c7ccdb034bcd', '5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', 'ff3e98995f8f9ae137c96010c5bd11899934215fd80e1900164ac2ae085eb105', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('3e34a1f9-1995-4673-94af-c6972a3b7084', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', 'd9c14877b7edf15074f5e7d67f82b6c117a0279510420674e36f0f6a97d87065', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('418ed578-48c9-49ee-82ca-b63f5a56d27a', 'a17698f4-d0d8-4573-afa8-154df717b1b4', 'f30f39079799953467fa3bae4959e352e110e33410278e8e095707e5cfbe0c42', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('6126b7ad-98d7-4fe4-b00f-22a97c5efa0d', '031db379-600e-484f-8e23-cf7ca9e2955b', 'f3d5e5098e3e5deedcad9c6da0a61555c8dfa276ee7029297549c3d5aeabc95c', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('620cdf08-b946-4352-8a36-4152f5adb61f', 'c94975df-820b-40b6-847c-809f245cfd6f', '1a057dbff9c5f2a031453b69a445c70d83cd5abb34bcf002b0305b4fc18ea5e4', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('6bed15bf-cff0-4d0e-8c4c-d99633406278', '83321516-46f2-48f6-8829-a3c8dabffa3b', '5c663073e53acc3559e4d6a274d416ffb4f3d69d374b03e2bddaa78cd931d613', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('771bb026-5e54-4d4c-9896-bef14557204d', '22a45494-3a22-4651-8a02-1ea7a91f261d', 'df819f8070bf3ea99553ad041c3a22efe598ffc59cf2e12f9331b92128aaaf2c', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('aefd7c1a-bd75-4071-ba96-5314022bd889', 'a723d637-1a32-4e76-b75d-0c23aea3b693', 'c7b0f3dac5b76d692478f8a31d482766faf3cfd934254d1c4765bfe8b685dd61', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('b3c2650a-5af2-40c5-9cf8-7dd0739c5552', 'a0194126-cd5c-4264-b95b-779af07a0e8b', 'a82a16349649e77d5d5be88e297d8f3c02f11519a2433c148075890656229f3c', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('b521675a-9c38-4d67-a94e-a7e4ca41218f', '8d6ed3ee-c83f-4f3a-8170-6fc6ebfba424', '9b000fe4fa8bfadfa89f14f3dab203bcf0cf6ef0fe57848d2649208219997b3e', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('b7d0c1a6-7dd9-4e0d-85f7-efea59e308e8', 'af5f86c8-d8c1-426b-84df-0c7f8c1dbe5f', 'f00eb25f7a6b38e206c10a2ec0b035d3b5fbbf5338d62f27ae4786311158484f', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('c216b900-9856-4d91-bd0c-172b357cec16', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '9ae80ac9566d506d920183cfe8d6590d8b0fede530e7f79de6286b8b6b0888af', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('d31d6a62-aa49-4484-b362-cf3273c8d82c', '05c8677c-25f9-48a5-a629-ecef2f74a708', '54f5fa8f79f318104073e3cb40b0a6be39c3c46871a299a435897beb6c468480', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('d82f9800-dccd-4014-a4db-7ad9ebf1bbe8', '90e591be-9486-4506-9e76-08244996c1c9', '3e45d301d6e025c7fe60f2c23c742a9eb1f221f63e84f58f6b9041621f05f44e', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('dd27e1c4-0a50-48ab-8caf-c5fd1de44b1d', '54b69c7d-a465-40b2-b110-efe7bdf81774', '7ec17bab8f06b2bde695ce975635b389d00d744480a5fa3cd6037f8a07d5458a', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('de986a50-0f48-447a-9e1f-052210468543', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '5f4f2337f88ed44af237a82d7eec030aff38ca7867d45d154e3925b50ccbe4d4', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('dedbb355-c79e-4ef9-8620-8df875280656', '7d700449-6d98-40b8-971e-9c356e080c51', '67d9c6d3daa949369c6bba71fa012905652fc2d992b66184c11888fa614cb9c6', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('e50aeb16-d0d3-416a-bc62-353260e009a7', '356267ed-536d-4e63-9c3d-325e7986d1f1', '64124360b31efbe6d49dc279c5e2ca8443088ca4f3f58c91466f2432cee819c0', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('e8acdae1-4e66-4f30-b649-f695ef9fb99a', '1e1c3b28-600c-4d58-bfc2-430eea64a360', 'a293020f331f982f3ab94b7fd3eb99a9f6b8f407cbc271bd3cbdd1436028342f', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('edfd5cb3-e524-4c70-ab11-788127b7bae6', '81d985d9-defe-440e-bb4b-2d5484dcbf8e', '6824f0bfb21a97857545b056d649bdaa54cef10b89b17bef60307e14e6ecbb73', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_person_access_link" ("id", "person_id", "token_hash", "geldt_voor_periode_id", "aangemaakt_op", "ingetrokken_op", "laatst_gebruikt_op") VALUES ('ff8ca078-f414-4229-a5da-fd0f50416b34', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '776af3b979e6daa32ed66ded650ce2fe5d4ee1abe0e49f28a94a45415bd7fcb5', 'ef95c519-d62e-4941-8b7d-a92631e9906f', '2026-11-11T17:24:01.882Z', NULL, NULL);
INSERT INTO "dienstrooster_pool" ("id", "naam", "type", "ruleset_id", "verdeelmodus", "actief", "aangemaakt_op") VALUES ('0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'Achterwacht', 'ACHTERWACHT', '51a5ac27-32cf-4af1-8a36-f1e18aba9cb4', 'GELIJK', 1, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_pool" ("id", "naam", "type", "ruleset_id", "verdeelmodus", "actief", "aangemaakt_op") VALUES ('f681dcc3-5c08-4dcf-93f0-b34b71741c5c', 'AIOS', 'AIOS', 'c9294476-70b7-428b-95de-10e49b029bf7', 'NAAR_RATO', 1, '2026-11-11T17:24:02.301Z');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('01529d61-8bca-4da2-89e6-3e814c07eed2', 'a723d637-1a32-4e76-b75d-0c23aea3b693', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('16a78f7b-7618-412c-bb65-a2cedc40a193', '7d700449-6d98-40b8-971e-9c356e080c51', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('29596744-31d4-455c-a55b-7a80519d7a49', '1e1c3b28-600c-4d58-bfc2-430eea64a360', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('2a8e6d98-6743-42e6-ad26-51e5af82353a', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('2c7316a8-9d08-4e60-8946-169ad42d3174', '5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('521b70f2-38d0-4153-a472-a1e0cd88daba', '356267ed-536d-4e63-9c3d-325e7986d1f1', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('539a3035-9736-43a4-8a50-eb3a87019a8e', '05c8677c-25f9-48a5-a629-ecef2f74a708', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('53cccf7a-a8d4-473e-a9b9-6d9bf9b67fdf', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('547b3a5c-367f-41a9-963e-be71a7b1c397', 'a0194126-cd5c-4264-b95b-779af07a0e8b', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('5afa51dd-e7fd-4607-a723-1d6fb037fd25', '5a851496-e299-414a-afcf-d532bae4c432', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('5def3212-13c5-4abe-a6b0-56bdaf5e9ff8', '54b69c7d-a465-40b2-b110-efe7bdf81774', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('6534f431-9700-4675-8287-e9abee714d44', '81d985d9-defe-440e-bb4b-2d5484dcbf8e', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('66fa35df-5974-479b-adc2-8e20c443ccc6', 'b52b2b9c-a14d-496a-81c6-8317b4286756', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('6907d193-e7bf-49f9-bf66-e2adbf4e2703', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('779c529e-8295-442e-8c41-d5c45e4c2573', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('7c036405-b65f-47fe-92bc-a826dec8bd17', 'af5f86c8-d8c1-426b-84df-0c7f8c1dbe5f', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('7c9c6d4a-0831-4ba2-85f6-8d0861888430', 'c94975df-820b-40b6-847c-809f245cfd6f', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('89542b58-09bd-4a3c-9269-11bf2a715d7b', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('8a63b9c1-3e8f-4e85-9934-e7fef38044a3', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('8ab1281e-487f-4788-9c10-34e58c4b4fcb', 'a17698f4-d0d8-4573-afa8-154df717b1b4', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('94a3bf64-25f6-483a-ab9f-d318a0740dbb', '031db379-600e-484f-8e23-cf7ca9e2955b', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('98dac03f-2ee4-4e12-b072-6daa184b2f68', '22a45494-3a22-4651-8a02-1ea7a91f261d', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('9ce24c30-6f84-4d5b-bd9f-d421df49866a', '83321516-46f2-48f6-8829-a3c8dabffa3b', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('a0f9efe5-1cdf-478e-ab54-6c66013ee7c7', '1bdfa9d7-f213-4028-91ac-e9d18bf6f7d8', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('ab2e1b93-59f8-47ba-9972-abb602232b9b', '90e591be-9486-4506-9e76-08244996c1c9', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('bb5db372-9381-4cf1-a5ae-12739329dfc1', 'f5cc0250-44c2-42a8-9dba-588afc331659', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('d2335b20-4512-4258-8eb6-7ec0d0acad5a', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('db954eb6-359e-4b01-bbf7-49811cc1c13e', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('e55b1134-75ec-40bd-baa9-2a0bbe93b520', '8d6ed3ee-c83f-4f3a-8170-6fc6ebfba424', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('ec5d822a-a426-4d64-b16c-0e084e824a44', 'a01cf4bd-73c0-4d2c-aa64-fd9257c2c348', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_pool_membership" ("id", "person_id", "pool_id", "deelnamefactor", "geldig_vanaf", "geldig_tot") VALUES ('f0755677-63c6-4ad5-9d18-1fc7732a340d', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 1, '2027-01-01', '2029-12-31');
INSERT INTO "dienstrooster_reminder_schedule" ("id", "period_id", "dagen_voor_deadline", "actief") VALUES ('0099f27c-1bc2-455b-9844-643e1754ee27', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 7, 1);
INSERT INTO "dienstrooster_reminder_schedule" ("id", "period_id", "dagen_voor_deadline", "actief") VALUES ('c9216252-df9a-45c6-b4e1-7b868766655d', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 1, 1);
INSERT INTO "dienstrooster_ruleset" ("id", "naam", "config_json", "versie", "aangemaakt_op") VALUES ('51a5ac27-32cf-4af1-8a36-f1e18aba9cb4', 'Default Ruleset', '{"windowWeeks":2,"blockBudget":{"AVOND":{"maxFraction":1},"WEEKEND":{"maxFraction":1},"FEESTDAG":{"maxFraction":1},"parttimeExempt":true},"softBlockBudget":{"AVOND":{"maxFraction":1},"WEEKEND":{"maxFraction":1},"FEESTDAG":{"maxFraction":1}},"softBlockPenalty":3,"softBlockPenaltyPerPriorViolation":1,"softBlockPriorViolationCap":3,"largeBalanceThreshold":2,"bandDeviationPenalty":[10,40,160],"bandDeviationMultiplier":4,"holidaySpreadWithinPeriod":5}', 1, '2026-11-11T17:24:01.882Z');
INSERT INTO "dienstrooster_ruleset" ("id", "naam", "config_json", "versie", "aangemaakt_op") VALUES ('c9294476-70b7-428b-95de-10e49b029bf7', 'AIOS', '{}', 1, '2026-11-11T17:24:02.301Z');
INSERT INTO "dienstrooster_schedule_period" ("id", "pool_id", "naam", "start_datum", "eind_datum", "deadline", "status", "bevroren_ruleset_json", "overloop_bevestigd_op", "gepubliceerd_op", "gepubliceerd_door_person_id", "row_version", "aangemaakt_op", "verwijderd_op", "auto_herinneren", "basis_url", "uitgenodigd_op", "definitief_op", "definitief_door_person_id", "voorlopig_rooster_json") VALUES ('ef95c519-d62e-4941-8b7d-a92631e9906f', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', '2027-1 (Jan-Jun)', '2027-01-04', '2027-06-06', '2026-12-15T17:00:00Z', 'CONCEPT', NULL, NULL, NULL, NULL, 1, '2026-11-11T17:24:01.882Z', NULL, 1, NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('17b3deec-f351-40f1-ad76-848d38cf2c4c', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-07', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('2bbf2761-0003-4ffc-bd53-d1ee347f6820', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-12', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('520f0e89-a3cb-419a-bbc8-caa9c3f87e43', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-15', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('557efee7-cf19-48ff-a4a4-99940638461a', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-06', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('60315b93-a7b8-4018-853d-030c0f00a0f1', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-04', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('640b659d-3160-4cce-8f56-9e79b14f7677', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-11', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('65d59b21-31ad-4ed7-a0d5-2403310f7ec3', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-08', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('856d3242-7ac0-493e-bb0f-bd96b6839ca5', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-14', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('8a2dd9fc-00f0-42ee-b5fb-1873e500ff4f', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'd1ad2425-1713-4e54-bc0a-2dd50b6b6a59', '2027-01-10', 2027, 1, '2027-W01-SUN', 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('955b2089-bcec-4a30-b6ee-cec4fa1c2fb7', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'd1ad2425-1713-4e54-bc0a-2dd50b6b6a59', '2027-01-16', 2027, 2, '2027-W02-SAT', 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('a2752d8f-3e9b-4b07-ad82-0c0e86fb21bf', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-13', 2027, 2, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('cf9e2e14-1586-4b21-af70-2cfe1d44c1f8', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '2027-01-05', 2027, 1, NULL, 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('e79bc9c0-b8de-4b08-afd7-bc4368533ad7', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'd1ad2425-1713-4e54-bc0a-2dd50b6b6a59', '2027-01-17', 2027, 2, '2027-W02-SUN', 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_slot" ("id", "period_id", "shift_type_id", "datum", "iso_jaar", "iso_week", "weekend_id", "is_feestdag", "feestdag_naam", "feestdag_groep", "benodigd_aantal_personen", "shift_block_id") VALUES ('f22ef7a5-32bd-4d58-af89-5d626fa5303e', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'd1ad2425-1713-4e54-bc0a-2dd50b6b6a59', '2027-01-09', 2027, 1, '2027-W01-SAT', 0, NULL, NULL, 1, NULL);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('11165e05-85c7-4983-8e1e-c8f7f76914cb', 'f681dcc3-5c08-4dcf-93f0-b34b71741c5c', 'Avonddienst', 'AVOND', '17:36', '23:12', 'AD', 'AVOND', 0.6);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('1d4366b3-c85a-48d6-b349-5c1cc36d6226', 'f681dcc3-5c08-4dcf-93f0-b34b71741c5c', 'Uitloopdienst', 'AVOND', '17:36', '20:00', 'UD', 'UITLOOP', 0.2);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('3fa8afa4-ee18-4a3a-ac1a-67013618a423', 'f681dcc3-5c08-4dcf-93f0-b34b71741c5c', 'Nachtdienst', 'AVOND', '22:30', '08:30', 'ND', 'NACHT', 1);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('6f6a9548-cb88-4134-bc23-1b4f9d6d8d4e', 'f681dcc3-5c08-4dcf-93f0-b34b71741c5c', 'Dagdienst', 'WEEKEND', '08:30', '18:12', 'DD', 'DAG', 1);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('760f49c4-61b4-4c88-95e8-d3d1fd99a35f', 'f681dcc3-5c08-4dcf-93f0-b34b71741c5c', 'Avonddienst weekend', 'WEEKEND', '13:30', '23:12', 'ADW', 'AVOND', 1);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('7a083bfa-19b6-4c34-9a39-bcf869f3015e', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'Feestdag', 'FEESTDAG', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('aa8468c8-054e-41d9-b226-f3ea899e3937', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'Zaterdag', 'WEEKEND', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('d1ad2425-1713-4e54-bc0a-2dd50b6b6a59', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'Zondag', 'WEEKEND', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_shift_type" ("id", "pool_id", "naam", "teller", "start_tijd", "eind_tijd", "code", "soort", "punten") VALUES ('e7ec34b3-ec28-45ce-9a43-7b1e9870034f', '0fbc787b-0294-4a22-a4c1-df8fb10e37b9', 'Avonddienst', 'AVOND', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('04395b57-8edb-48ff-926b-bcfaf3bcea56', 'a01cf4bd-73c0-4d2c-aa64-fd9257c2c348', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('04430c3d-0109-44a7-9050-dba0a47eff24', 'f5cc0250-44c2-42a8-9dba-588afc331659', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('08479812-4a13-4846-9f24-391491f91a5d', '7d700449-6d98-40b8-971e-9c356e080c51', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('0d3b8994-e281-4b13-9b30-e23857cda21a', '8d6ed3ee-c83f-4f3a-8170-6fc6ebfba424', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('1c6491c4-42be-4c63-8f18-f52ea17db79d', 'fe06fc2d-7f7e-40f1-8fa7-10777e9a1ded', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('3d0abe47-9198-47a4-b04a-fa9b324f44d8', '5c9b0b44-dddb-4c22-83d2-1b1ba5c89c8b', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('3e31b490-cd0a-43de-bbe5-ea3c14afd30e', '83321516-46f2-48f6-8829-a3c8dabffa3b', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('469487d8-9be7-46fb-8710-cb99b91230cc', '7b11af0d-7a68-4af9-a7b9-782c49f3fedd', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('481ff88c-5eb4-4260-ad46-caac30bf54ba', 'b52b2b9c-a14d-496a-81c6-8317b4286756', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('52500005-23f4-4436-b640-4c5e357bb610', '031db379-600e-484f-8e23-cf7ca9e2955b', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('609e3d0c-c036-4916-8ec9-1eb1c7aea87a', '1e1c3b28-600c-4d58-bfc2-430eea64a360', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('62a63237-3081-4d18-ab21-b9c3e4f39df2', '97de82a7-5cbf-44b7-ad26-303687bc5e4b', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('68f3a7e3-3b60-4d0c-974f-961f4adef00d', 'a0194126-cd5c-4264-b95b-779af07a0e8b', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('78eb70dc-8a1c-4352-a4ca-addbd1840033', '37430f8b-82ee-4e6d-84eb-377a2a0758a8', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('7b4030d6-a3af-4e8b-9fad-fe972ce72399', '22a45494-3a22-4651-8a02-1ea7a91f261d', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('7e9096d9-2a87-4be3-ba52-9f0e2db8daf0', 'a723d637-1a32-4e76-b75d-0c23aea3b693', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('801b4a2f-8bcd-4436-9bac-5ff82b709cce', 'af5f86c8-d8c1-426b-84df-0c7f8c1dbe5f', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('8527f62f-c5c7-4963-a174-82dd0efefd01', 'c94975df-820b-40b6-847c-809f245cfd6f', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('8b63b632-ceae-49ed-93c7-1d57be0c8753', '5a851496-e299-414a-afcf-d532bae4c432', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('a854639a-c81b-4b68-acc3-e94be96c525e', '356267ed-536d-4e63-9c3d-325e7986d1f1', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('aea802c2-ba82-4fdd-8c66-95ffc2c85a87', 'db87270f-05ee-417b-b8c1-ca39b2a7650c', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('af1b43eb-8a0b-46f8-906c-95b4d39b2ce3', 'c54c8baf-f638-4a8f-80da-2a9abf0e84ef', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('badc089c-7ae4-49cf-8f4a-785f66c71785', '90e591be-9486-4506-9e76-08244996c1c9', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('c0229688-6c27-4b85-8c7f-3387b7ef521b', 'b64b7e3e-5ec7-45c5-ac6b-d37d6bbaf931', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('c7992c0f-3105-4671-819f-6460bc27d728', '81d985d9-defe-440e-bb4b-2d5484dcbf8e', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('d9721b58-b956-45da-b000-4ba0b9def1b0', '43368a7d-525d-4d0b-a4ef-2a62d272b8ad', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('e60f71e3-db0e-46c0-94f1-c2f136c6e028', 'a17698f4-d0d8-4573-afa8-154df717b1b4', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('e769aeb4-6604-4d41-ad16-cbea74943872', '05c8677c-25f9-48a5-a629-ecef2f74a708', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('e836ffc3-2141-45d0-8744-ce0eda9a3ea5', '1bdfa9d7-f213-4028-91ac-e9d18bf6f7d8', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEZIG', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('e8a8171d-2e4b-4721-ac62-3304e9bd8b78', '744ecb7a-6f1b-4232-ba23-d58d6ddbf4d8', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'NIET_BEGONNEN', NULL, 1, '2026-11-11T17:24:01.882Z', NULL);
INSERT INTO "dienstrooster_submission" ("id", "person_id", "schedule_period_id", "status", "ingediend_op", "row_version", "aangemaakt_op", "deeltijd_gecontroleerd_op") VALUES ('ffb39630-d314-4587-9c7d-c2833b9409d7', '54b69c7d-a465-40b2-b110-efe7bdf81774', 'ef95c519-d62e-4941-8b7d-a92631e9906f', 'BEVESTIGD', '2026-11-11T17:24:01.882Z', 1, '2026-11-11T17:24:01.882Z', NULL);
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
