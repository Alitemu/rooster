import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ============================================================================
// PERSON & AUTH
// ============================================================================

export const person = sqliteTable(
  'dienstrooster_person',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    codenaam: text('codenaam').notNull().unique(),
    rol: text('rol', {
      enum: ['ADMIN', 'PLANNER', 'DEELNEMER'],
    }).notNull(),
    actief: integer('actief', { mode: 'boolean' }).default(true).notNull(),
    wachtwoord_hash: text('wachtwoord_hash'),
    totp_secret: text('totp_secret'),
    // Bumped to invalidate every session already issued for this person.
    // Session cookies are self-contained signed tokens (lib/session.ts),
    // so logging out can only clear the cookie in the browser that asked -
    // a copy taken elsewhere keeps working until it expires. The number is
    // baked into each token and compared on every request
    // (lib/sessionVersion.ts), which turns "log out everywhere" and
    // "changing the password kicks out whoever else was logged in" into
    // one integer update.
    sessie_versie: integer('sessie_versie').notNull().default(1),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  }
);

export const personAccessLink = sqliteTable(
  'dienstrooster_person_access_link',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    token_hash: text('token_hash').notNull().unique(),
    geldt_voor_periode_id: text('geldt_voor_periode_id').references(() => schedulePeriod.id), // NULL = general admin link
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
    ingetrokken_op: text('ingetrokken_op'),
    laatst_gebruikt_op: text('laatst_gebruikt_op'),
  },
  (table) => ({
    // Backs the revocation check lib/auth-context.ts runs on every
    // DEELNEMER request (WHERE person_id = ? AND ingetrokken_op IS NULL) -
    // without it, that check is a full table scan on every participant
    // request, on the hot auth path.
    personIdx: index('person_access_link_person_idx').on(table.person_id),
  })
);

// ============================================================================
// POOL & MEMBERSHIP
// ============================================================================

export const pool = sqliteTable(
  'dienstrooster_pool',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    naam: text('naam').notNull(),
    type: text('type', {
      enum: ['ACHTERWACHT', 'NEURO', 'KINDER', 'INTERVENTIE', 'AIOS'],
    }).default('ACHTERWACHT').notNull(),
    ruleset_id: text('ruleset_id').notNull().references(() => ruleset.id),
    verdeelmodus: text('verdeelmodus', {
      enum: ['GELIJK', 'NAAR_RATO'],
    }).default('GELIJK').notNull(),
    actief: integer('actief', { mode: 'boolean' }).default(true).notNull(),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  }
);

export const poolMembership = sqliteTable(
  'dienstrooster_pool_membership',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    pool_id: text('pool_id').notNull().references(() => pool.id),
    deelnamefactor: real('deelnamefactor').default(1.0).notNull(), // e.g., 0.8 for part-time capacity
    geldig_vanaf: text('geldig_vanaf').notNull(), // ISO date YYYY-MM-DD
    geldig_tot: text('geldig_tot').notNull(), // ISO date YYYY-MM-DD
  },
  (table) => ({
    uniq: uniqueIndex('pool_membership_uniq').on(table.person_id, table.pool_id, table.geldig_vanaf, table.geldig_tot),
  })
);

// ============================================================================
// ABSENCE & PARTTIME
// ============================================================================

export const absence = sqliteTable(
  'dienstrooster_absence',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    van_datum: text('van_datum').notNull(), // ISO date
    tot_datum: text('tot_datum').notNull(), // ISO date
    soort: text('soort', {
      enum: ['VAKANTIE', 'CONGRES', 'OVERIG'],
    }).notNull(),
    notitie: text('notitie'), // Optional, no sensitive data allowed
    aangemaakt_door: text('aangemaakt_door').notNull().references(() => person.id),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  }
);

export const parttimePattern = sqliteTable(
  'dienstrooster_parttime_pattern',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    weekdag: text('weekdag', {
      enum: ['MA', 'DI', 'WO', 'DO', 'VR', 'ZA', 'ZO'],
    }).notNull(),
    frequentie: text('frequentie', {
      enum: ['ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN'],
    }).notNull(),
    geldig_vanaf: text('geldig_vanaf').notNull(), // ISO date
    geldig_tot: text('geldig_tot').notNull(), // ISO date
    aangemaakt_door: text('aangemaakt_door').notNull().references(() => person.id),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    uniq: uniqueIndex('parttime_pattern_uniq').on(table.person_id, table.weekdag, table.geldig_vanaf, table.geldig_tot),
  })
);

// ============================================================================
// RULESET & SETTINGS
// ============================================================================

export const ruleset = sqliteTable(
  'dienstrooster_ruleset',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    naam: text('naam').notNull(),
    config_json: text('config_json').notNull(), // JSON: { windowWeeks, blockBudget, softBlockBudget, ... }
    versie: integer('versie').default(1).notNull(),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  }
);

// ============================================================================
// PERIOD & SCHEDULING
// ============================================================================

export const schedulePeriod = sqliteTable(
  'dienstrooster_schedule_period',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    pool_id: text('pool_id').notNull().references(() => pool.id),
    naam: text('naam').notNull(),
    start_datum: text('start_datum').notNull(), // ISO date, rounded to Monday
    eind_datum: text('eind_datum').notNull(), // ISO date, rounded to Sunday
    deadline: text('deadline').notNull(), // ISO datetime
    status: text('status', {
      enum: ['CONCEPT', 'OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'],
    }).default('CONCEPT').notNull(),
    bevroren_ruleset_json: text('bevroren_ruleset_json'), // Frozen at OPEN status
    overloop_bevestigd_op: text('overloop_bevestigd_op'), // When prior assignments are confirmed
    gepubliceerd_op: text('gepubliceerd_op'), // Phase 3: when roster was published
    gepubliceerd_door_person_id: text('gepubliceerd_door_person_id').references(() => person.id), // Phase 3: who published
    row_version: integer('row_version').default(1).notNull(), // Optimistic locking
    // Automatic reminders (lib/autoReminders.ts) on for this period. Off =
    // paused by the planner; manual reminders still work.
    auto_herinneren: integer('auto_herinneren', { mode: 'boolean' }).default(true).notNull(),
    // The address personal links for this period were last issued under
    // (from the planner's own request). Automatic reminders run without a
    // request, so they use this unless BASE_URL pins one.
    basis_url: text('basis_url'),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
    verwijderd_op: text('verwijderd_op'), // Soft-delete marker; null = not in trash. Purged 30 days after this.
  }
);

export const periodExcludedDay = sqliteTable(
  'dienstrooster_period_excluded_day',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    period_id: text('period_id').notNull().references(() => schedulePeriod.id),
    datum: text('datum').notNull(), // ISO date
    reden: text('reden').notNull(), // Why excluded (e.g., "already assigned in period 2027-1")
    bron_period_id: text('bron_period_id').references(() => schedulePeriod.id), // Which period it came from
  },
  (table) => ({
    uniq: uniqueIndex('period_excluded_day_uniq').on(table.period_id, table.datum),
  })
);

// ============================================================================
// PRIOR ASSIGNMENTS (OVERLOOPDIENSTEN)
// ============================================================================

export const priorAssignment = sqliteTable(
  'dienstrooster_prior_assignment',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    period_id: text('period_id').notNull().references(() => schedulePeriod.id),
    datum: text('datum').notNull(), // ISO date
    iso_jaar: integer('iso_jaar').notNull(),
    iso_week: integer('iso_week').notNull(),
    person_id: text('person_id').references(() => person.id), // NULL if bron = ONBEKEND
    teller: text('teller', {
      enum: ['AVOND', 'WEEKEND', 'FEESTDAG'],
    }).notNull(),
    bron: text('bron', {
      enum: ['AFGELEID', 'HANDMATIG', 'ONBEKEND'],
    }).notNull(),
    bron_period_id: text('bron_period_id').references(() => schedulePeriod.id), // Which period this was derived from
    aangemaakt_door: text('aangemaakt_door').notNull().references(() => person.id),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    // Per (period, date, teller): a day can carry over an AVOND, WEEKEND
    // and FEESTDAG entry independently (matches generateSkeletonPriorAssignments
    // and the confirm gate's expected-entry count, which both assume up to
    // three rows per day). A (period, date)-only index made the second and
    // third teller row for any date fail with a UNIQUE violation, so the
    // confirm gate could never actually be satisfied.
    uniq: uniqueIndex('prior_assignment_uniq').on(table.period_id, table.datum, table.teller),
  })
);

// ============================================================================
// SHIFT TYPES & SLOTS
// ============================================================================

export const shiftType = sqliteTable(
  'dienstrooster_shift_type',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    pool_id: text('pool_id').notNull().references(() => pool.id),
    naam: text('naam').notNull(),
    teller: text('teller', {
      enum: ['AVOND', 'WEEKEND', 'FEESTDAG'],
    }).notNull(),
    start_tijd: text('start_tijd'), // HH:MM for future use
    eind_tijd: text('eind_tijd'), // HH:MM for future use
  }
);

export const shiftSlot = sqliteTable(
  'dienstrooster_shift_slot',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    period_id: text('period_id').notNull().references(() => schedulePeriod.id),
    shift_type_id: text('shift_type_id').notNull().references(() => shiftType.id),
    datum: text('datum').notNull(), // ISO date
    iso_jaar: integer('iso_jaar').notNull(), // Computed once at slot creation
    iso_week: integer('iso_week').notNull(), // Computed once at slot creation
    weekend_id: text('weekend_id'), // e.g., "2027-W01-SAT", "2027-W01-SUN"
    is_feestdag: integer('is_feestdag', { mode: 'boolean' }).default(false).notNull(),
    feestdag_naam: text('feestdag_naam'), // e.g., "Kerstmis", "Eerste Paasdag"
    feestdag_groep: text('feestdag_groep', {
      enum: ['NIEUWJAAR', 'PASEN', 'KONINGSDAG', 'BEVRIJDINGSDAG', 'HEMELVAART', 'PINKSTEREN', 'KERST'],
    }), // NULL if not a holiday
    benodigd_aantal_personen: integer('benodigd_aantal_personen').default(1).notNull(), // Always 1 in phase 0
    shift_block_id: text('shift_block_id'), // For phase 4+ (AIOS blocks)
  },
  (table) => ({
    periodIdx: index('slot_period_idx').on(table.period_id),
    datumIdx: index('slot_datum_idx').on(table.datum),
  })
);

// ============================================================================
// LEDGER (BALANCE TRACKING)
// ============================================================================

export const ledgerEntry = sqliteTable(
  'dienstrooster_ledger_entry',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    pool_id: text('pool_id').notNull().references(() => pool.id),
    teller: text('teller', {
      enum: ['AVOND', 'WEEKEND', 'FEESTDAG'],
    }).notNull(),
    geldt_voor_periode_id: text('geldt_voor_periode_id').notNull().references(() => schedulePeriod.id),
    datum: text('datum'), // ISO date of the relevant event (optional)
    delta: integer('delta').notNull(), // Negative = fewer shifts, positive = more shifts
    reden: text('reden').notNull(), // Always required for audit
    categorie: text('categorie', {
      enum: ['CARRY_OVER', 'CORRECTIE', 'BEGINSALDO'],
    }).notNull(),
    aangemaakt_door: text('aangemaakt_door').notNull().references(() => person.id),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    personPeriodIdx: index('ledger_person_period_idx').on(table.person_id, table.geldt_voor_periode_id),
  })
);

// ============================================================================
// HOLIDAY HISTORY
// ============================================================================

export const holidayHistory = sqliteTable(
  'dienstrooster_holiday_history',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    feestdag_groep: text('feestdag_groep', {
      enum: ['NIEUWJAAR', 'PASEN', 'KONINGSDAG', 'BEVRIJDINGSDAG', 'HEMELVAART', 'PINKSTEREN', 'KERST'],
    }).notNull(),
    jaar: integer('jaar').notNull(),
    bron: text('bron', {
      enum: ['SYSTEEM', 'IMPORT', 'HANDMATIG'],
    }).notNull(),
  },
  (table) => ({
    uniq: uniqueIndex('holiday_history_uniq').on(table.person_id, table.feestdag_groep, table.jaar),
  })
);

// ============================================================================
// NOTIFICATIONS & REMINDERS
// ============================================================================

export const notificationTemplate = sqliteTable(
  'dienstrooster_notification_template',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    sleutel: text('sleutel', {
      enum: [
        'PERIOD_OPENED',
        'PARTTIME_CHECK',
        'REMINDER',
        'FINAL_WARNING',
        'DEADLINE_PASSED',
        'BLOCK_OVERRIDDEN',
        'SCHEDULE_PUBLISHED',
        'SWAP_REQUESTED',
        'SWAP_RESULT',
        'CORRECTION_BOOKED',
      ],
    }).notNull().unique(),
    onderwerp: text('onderwerp').notNull(),
    body_md: text('body_md').notNull(), // Markdown with placeholders
  }
);

export const reminderSchedule = sqliteTable(
  'dienstrooster_reminder_schedule',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    period_id: text('period_id').notNull().references(() => schedulePeriod.id),
    dagen_voor_deadline: integer('dagen_voor_deadline').notNull(),
    actief: integer('actief', { mode: 'boolean' }).default(true).notNull(),
  }
);

/**
 * One row per automatic reminder moment that has been dealt with, so a
 * moment is never sent twice (not across restarts either). Keyed on the
 * deadline it was computed from: moving the deadline starts a fresh set of
 * moments. OVERGESLAGEN = its moment went by without sending (server down
 * too long, or a more urgent moment was due at the same time).
 */
export const reminderRun = sqliteTable(
  'dienstrooster_reminder_run',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    period_id: text('period_id').notNull().references(() => schedulePeriod.id),
    dagen_voor_deadline: integer('dagen_voor_deadline').notNull(),
    deadline: text('deadline').notNull(),
    moment: text('moment').notNull(), // ISO timestamp of the 09:00 it was due
    uitkomst: text('uitkomst', { enum: ['VERSTUURD', 'OVERGESLAGEN'] }).notNull(),
    aantal_niet_begonnen: integer('aantal_niet_begonnen').default(0).notNull(),
    aantal_bezig: integer('aantal_bezig').default(0).notNull(),
    aangemaakt_op: text('aangemaakt_op').notNull(),
  },
  (table) => ({
    runUniq: uniqueIndex('reminder_run_moment_uniq').on(table.period_id, table.dagen_voor_deadline, table.deadline),
  })
);

export const notificationLog = sqliteTable(
  'dienstrooster_notification_log',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    period_id: text('period_id').references(() => schedulePeriod.id),
    type: text('type', {
      enum: [
        'PERIOD_OPENED',
        'PARTTIME_CHECK',
        'REMINDER',
        'FINAL_WARNING',
        'DEADLINE_PASSED',
        'BLOCK_OVERRIDDEN',
        'SCHEDULE_PUBLISHED',
        'SWAP_REQUESTED',
        'SWAP_RESULT',
        'CORRECTION_BOOKED',
      ],
    }).notNull(),
    opgesteld_op: text('opgesteld_op').notNull().$defaultFn(() => new Date().toISOString()),
    gemaild_op: text('gemaild_op'),
    geexporteerd_op: text('geexporteerd_op'),
    afgevinkt_op: text('afgevinkt_op'), // For override messages
    resultaat: text('resultaat'), // success, failed, pending
    foutmelding: text('foutmelding'),
  }
);

// ============================================================================
// AUDIT LOG
// ============================================================================

export const auditLog = sqliteTable(
  'dienstrooster_audit_log',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    actor_id: text('actor_id').notNull().references(() => person.id),
    entiteit: text('entiteit').notNull(), // Table name
    entiteit_id: text('entiteit_id').notNull(), // Record ID
    // The full set of values every route actually inserts - broader than
    // the original 5-value CRUD-ish set (CREATE/UPDATE/DELETE/PUBLISH/
    // IMPORT still cover generic entity changes; GENERATE_ROSTER,
    // MANUAL_ASSIGN, CANCEL, REJECT, APPROVE are the more specific
    // actions several routes log instead of a generic CREATE/UPDATE).
    actie: text('actie', {
      enum: ['CREATE', 'UPDATE', 'DELETE', 'PUBLISH', 'IMPORT', 'GENERATE_ROSTER', 'MANUAL_ASSIGN', 'CANCEL', 'REJECT', 'APPROVE'],
    }).notNull(),
    oud_json: text('oud_json'), // Previous state
    nieuw_json: text('nieuw_json'), // New state
    tijdstip: text('tijdstip').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    actorIdx: index('audit_actor_idx').on(table.actor_id),
    entiteitIdx: index('audit_entiteit_idx').on(table.entiteit, table.entiteit_id),
  })
);

// ============================================================================
// PENDING UNDO
// ============================================================================

// One reversible action per scope, replaced (not accumulated) by the next
// one - a single "ongedaan maken" button, not a full undo stack. Deliberately
// its own table rather than reconstructed from dienstrooster_audit_log or
// dienstrooster_assignment_edit: a reassign is one undo unit but two rows in
// each of those (delete the old side, create the new side), and manual-assign
// never wrote to assignment_edit at all - parsing that back into "what
// exactly do I reverse" is fragile. Written explicitly by the route that
// just made the change, so it always says precisely what to undo.
//
// Row-per-scope (not per-action) is what makes this survive a reload or a
// different tab/session picking the page back up later: it's read from the
// database like anything else here, not kept in browser memory. It stops
// being available the moment ANYTHING else touches that same scope (the
// affected slot/membership no longer matches what this row expects) - see
// each undo-last route's own staleness check - so "ongedaan maken" can
// never silently clobber a change made after it, by this planner or another
// one, regardless of how long ago the row was written.
export const pendingUndo = sqliteTable(
  'dienstrooster_pending_undo',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    // periodId for PERIOD_ASSIGNMENT, poolId for POOL_MEMBERSHIP - never
    // compared across scopes, so nothing requires the two id spaces to be
    // disjoint, but the scope column is still stored for clarity when
    // reading the table directly.
    scope: text('scope', { enum: ['PERIOD_ASSIGNMENT', 'POOL_MEMBERSHIP'] }).notNull(),
    scope_id: text('scope_id').notNull().unique(),
    action_type: text('action_type', {
      enum: ['ASSIGN', 'REASSIGN', 'REMOVE', 'MEMBERSHIP_DELETE'],
    }).notNull(),
    payload_json: text('payload_json').notNull(),
    // Dutch, human-readable - shown on the button itself, so a planner
    // knows exactly what "ongedaan maken" is about to do before clicking it.
    label: text('label').notNull(),
    actor_id: text('actor_id').notNull().references(() => person.id),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    scopeCheck: check(
      'pending_undo_scope_check',
      sql`${table.scope} IN ('PERIOD_ASSIGNMENT', 'POOL_MEMBERSHIP')`
    ),
    actionTypeCheck: check(
      'pending_undo_action_type_check',
      sql`${table.action_type} IN ('ASSIGN', 'REASSIGN', 'REMOVE', 'MEMBERSHIP_DELETE')`
    ),
  })
);

// ============================================================================
// IMPORTS
// ============================================================================

export const importRun = sqliteTable(
  'dienstrooster_import_run',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    soort: text('soort', {
      enum: ['BEGINSALDI', 'FEESTDAG_HISTORIE'],
    }).notNull(),
    bestandsnaam: text('bestandsnaam').notNull(),
    aantal_regels: integer('aantal_regels').notNull(),
    aantal_fouten: integer('aantal_fouten').notNull(),
    uitgevoerd_door: text('uitgevoerd_door').notNull().references(() => person.id),
    uitgevoerd_op: text('uitgevoerd_op').notNull().$defaultFn(() => new Date().toISOString()),
    resultaat_json: text('resultaat_json'), // { errors: [], imported: [], skipped: [] }
  }
);

// ============================================================================
// PREFERENCES & BLOCKING (PHASE 1)
// ============================================================================

export const availability = sqliteTable(
  'dienstrooster_availability',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    slot_id: text('slot_id').notNull().references(() => shiftSlot.id),
    blocking_level: text('blocking_level', {
      enum: ['ABSOLUUT', 'LIEVER_NIET', 'VOORKEUR'],
    }), // null = neutral (default is NULL in SQLite)
    source: text('source', {
      enum: ['MANUAL', 'PARTTIME', 'ABSENCE'],
    }).notNull(), // How the blocking was created
    bron_pattern_id: text('bron_pattern_id').references(() => parttimePattern.id), // If source=PARTTIME
    bron_absence_id: text('bron_absence_id').references(() => absence.id), // If source=ABSENCE
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    uniq: uniqueIndex('availability_uniq').on(table.person_id, table.slot_id),
  })
);

export const submission = sqliteTable(
  'dienstrooster_submission',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    schedule_period_id: text('schedule_period_id').notNull().references(() => schedulePeriod.id),
    status: text('status', {
      enum: ['NIET_BEGONNEN', 'BEZIG', 'BEVESTIGD'],
    }).notNull(),
    ingediend_op: text('ingediend_op'), // Timestamp when confirmed
    row_version: integer('row_version').default(1).notNull(), // Optimistic locking
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    uniq: uniqueIndex('submission_uniq').on(table.person_id, table.schedule_period_id),
  })
);

export const assignment = sqliteTable(
  'dienstrooster_assignment',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    schedule_version_id: text('schedule_version_id').notNull(), // Link to generated schedule version
    person_id: text('person_id').notNull().references(() => person.id),
    slot_id: text('slot_id').notNull().references(() => shiftSlot.id),
    bron: text('bron', {
      enum: ['SOLVER', 'MANUAL', 'OVERRIDE'],
    }).notNull(),
    row_version: integer('row_version').default(1).notNull(),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    uniq: uniqueIndex('assignment_uniq').on(table.schedule_version_id, table.slot_id),
  })
);

// ============================================================================
// PHASE 3: SWAPS, NOTIFICATIONS, ASSIGNMENT EDITS
// ============================================================================

export const swapRequest = sqliteTable(
  'dienstrooster_swap_request',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    periode_id: text('periode_id').notNull().references(() => schedulePeriod.id),
    aanvrager_person_id: text('aanvrager_person_id').notNull().references(() => person.id),
    aangeboden_slot_id: text('aangeboden_slot_id').notNull().references(() => shiftSlot.id),
    gevraagde_slot_id: text('gevraagde_slot_id').notNull().references(() => shiftSlot.id),
    respondent_person_id: text('respondent_person_id').notNull().references(() => person.id),
    status: text('status', {
      enum: ['PENDING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN'],
    }).notNull().default('PENDING'),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
    beantwoord_op: text('beantwoord_op'), // When approved/rejected
    afgehandeld_door_person_id: text('afgehandeld_door_person_id').references(() => person.id),
    opmerkingen: text('opmerkingen'), // The requester's own note
    // Why the respondent declined - kept apart from opmerkingen, which a
    // rejection used to overwrite, losing the requester's note.
    reden_afwijzing: text('reden_afwijzing'),
    // The in-app notification sent to the respondent, so the planner's
    // overview can show whether it has been read. Null for requests made
    // before this column existed.
    melding_id: text('melding_id'),
    row_version: integer('row_version').default(1).notNull(),
  },
  (table) => ({
    idx: index('swap_request_periode_idx').on(table.periode_id),
    idx2: index('swap_request_status_idx').on(table.status),
    statusCheck: check(
      'swap_request_status_check',
      sql`${table.status} IN ('PENDING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN')`
    ),
  })
);

export const notification = sqliteTable(
  'dienstrooster_notification',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    person_id: text('person_id').notNull().references(() => person.id),
    periode_id: text('periode_id').references(() => schedulePeriod.id), // NULL for non-period notifications
    type: text('type', {
      enum: [
        'ROSTER_GEREED',
        'TOEWIJZING',
        'RUILVERZOEK',
        'RUIL_GOEDGEKEURD',
        'RUIL_AFGEWEZEN',
        'PUBLICATIE_BERICHT',
        'BLOCK_OVERRIDDEN',
      ],
    }).notNull(),
    onderwerp: text('onderwerp').notNull(),
    inhoud: text('inhoud').notNull(), // Markdown format
    gelezen: integer('gelezen', { mode: 'boolean' }).default(false).notNull(),
    gesloten_op: text('gesloten_op'), // When dismissed
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    idx: index('notification_person_idx').on(table.person_id),
    idx2: index('notification_type_idx').on(table.type),
    typeCheck: check(
      'notification_type_check',
      sql`${table.type} IN ('ROSTER_GEREED', 'TOEWIJZING', 'RUILVERZOEK', 'RUIL_GOEDGEKEURD', 'RUIL_AFGEWEZEN', 'PUBLICATIE_BERICHT', 'BLOCK_OVERRIDDEN')`
    ),
  })
);

export const assignmentEdit = sqliteTable(
  'dienstrooster_assignment_edit',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    // Deliberately NOT a foreign key to assignment.id. This table records
    // what was done to an assignment, including HANDMATIG_VERWIJDEREN -
    // and an audit record has to outlive the row it describes. With a hard
    // reference here the edit row blocked the very deletion it was
    // recording, so removing an assignment always failed with
    // SQLITE_CONSTRAINT_FOREIGNKEY. The id is still stored for tracing.
    toewijzing_id: text('toewijzing_id').notNull(),
    periode_id: text('periode_id').notNull().references(() => schedulePeriod.id),
    person_id: text('person_id').notNull().references(() => person.id), // Person being assigned
    slot_id: text('slot_id').notNull().references(() => shiftSlot.id),
    edit_type: text('edit_type', {
      enum: ['HANDMATIG_TOEWIJZEN', 'HANDMATIG_VERWIJDEREN', 'RUIL', 'OVERRIDE'],
    }).notNull(),
    oorspronkelijke_person_id: text('oorspronkelijke_person_id').references(() => person.id), // If swap
    reden: text('reden'), // Reason for edit
    bewerkt_door_person_id: text('bewerkt_door_person_id').notNull().references(() => person.id),
    row_version: integer('row_version').default(1).notNull(),
    aangemaakt_op: text('aangemaakt_op').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    idx: index('assignment_edit_periode_idx').on(table.periode_id),
    editTypeCheck: check(
      'assignment_edit_type_check',
      sql`${table.edit_type} IN ('HANDMATIG_TOEWIJZEN', 'HANDMATIG_VERWIJDEREN', 'RUIL', 'OVERRIDE')`
    ),
  })
);
