# Dienstrooster - Fair Shift Scheduling

A sophisticated shift scheduling application for medical wards with automatic roster generation, fair distribution, and preference management.

## Phase 0: Foundation (Current)

This is Phase 0 implementation with:
- Project setup and Docker Compose configuration
- Drizzle ORM schema with SQLite database
- Authentication (personal links + password + TOTP)
- Holiday calculations for all Dutch holidays
- Capacity checking utilities
- Seed script with 30 pseudonymous staff members

## Stack

- **Frontend/Backend:** Next.js 15 + TypeScript
- **Styling:** Tailwind CSS + shadcn/ui
- **Database:** SQLite (WAL mode) + Drizzle ORM
- **Auth:** Custom (tokens, bcrypt, TOTP)
- **Testing:** Vitest + fast-check
- **Container:** Docker Compose (3 services: caddy, web, solver)

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- npm

### Setup

```bash
# Install dependencies
npm install

# Create database and seed with sample data
npm run seed

# Start development (Docker Compose)
npm run dev

# Run tests
npm run test
```

### Access

- **Web:** https://localhost (via Caddy with internal TLS)
- **Health Check:** https://localhost/health
- **Solver:** http://localhost:8000 (internal network only)

### Test Users

After running `npm run seed`:

- **Admin:** Codenaam `ADMIN`, Password `Admin@12345`
- **Planner:** Codenaam `PLANNER`, Password `Planner@12345`
- **Staff:** Persoon-01 through Persoon-30 (personal access links)

## Development

### Project Structure

```
├── app/                    # Next.js App Router
├── components/             # React components (TODO)
├── lib/                    # Utilities (holidays, auth, capacity)
├── db/                     # Drizzle schema & migrations
├── server/                 # Server-side functions (TODO)
├── types/                  # TypeScript types
├── scripts/                # Setup scripts (seed.ts)
├── solver/                 # Python solver service
├── CLAUDE.md               # Design rules & conventions
└── docker-compose.yml      # Services: caddy, web, solver
```

### Code Conventions

**Critical: Read CLAUDE.md before writing code.**

Key points:
- **No real names/emails** - only pseudonymous codenamen
- **Sign convention:** delta < 0 = fewer shifts, delta > 0 = more shifts
- **UI language:** Always in words, never raw numbers
- **Tests:** One test per hard rule that proves it can't be broken
- **No mock data:** Use seed scripts only

### Running Tests

```bash
# Run all tests
npm run test

# Watch mode
npm run test -- --watch

# UI mode
npm run test:ui

# Coverage
npm run test -- --coverage
```

### Database

```bash
# Generate migrations
npm run db:migrate

# Open Drizzle Studio
npm run db:studio

# Seed database
npm run seed
```

### Building

```bash
# Build Next.js
npm run build

# Start production server
npm run start
```

## Architecture Highlights

### Database Schema

Key tables in Phase 0:
- `person` - Staff with codenamen, roles
- `pool` - Shift pools (e.g., Achterwacht)
- `pool_membership` - Who's in which pool when
- `schedule_period` - Time periods (rounded to ISO weeks)
- `shift_slot` - Individual slots to fill
- `ledger_entry` - Balance tracking (append-only)
- `holiday_history` - Holiday rotation tracking
- `audit_log` - All actions by admin/planner

### Holiday Calculation

All Dutch holidays calculated using Meeus algorithm:
- Nieuwjaarsdag
- Pasen (Easter + related)
- Koningsdag (with Sunday adjustment)
- Bevrijdingsdag (every 5 years)
- Hemelvaart
- Pinksteren
- Kerst

### Authentication

**For Staff:**
- Personal access links (long random token → SHA256)
- No emails stored (pseudonymous)
- Read-only access post-deadline

**For Admin/Planner:**
- Username/password (bcryptjs)
- TOTP 2FA (speakeasy)

### Capacity Checks

Two formulas live in settings:

1. **Total Capacity:** pool_capacity ≥ slots needed
2. **Distinct People:** active_participants ≥ 7 × windowWeeks

Formula 2 is typically more restrictive.

## Phases

| Phase | Content | Status |
|-------|---------|--------|
| **0** | Foundation, auth, datamodel, holidays, capacity | Current |
| **1** | Slot generation, prior assignments, preferences, dashboard, exports | Next |
| **2** | Solver (Python + CP-SAT), generation, diagnosis | Planned |
| **3** | Publishing, swaps, corrections, messages, period close | Planned |
| **4+** | Nice-to-have: AIOS, subpools | Future |

## Deployment

### Docker Compose

Three containers with internal networking:

```
caddy:8010 ──→ web:3000 ──→ solver:8000
  (TLS)       (Next.js)    (Python/FastAPI)
```

- Caddy: TLS termination with internal certificates
- Web: Next.js + SQLite (WAL mode)
- Solver: Python FastAPI (healthcheck only in Phase 0)

Set `SEED_ON_START=true` in `.env` to auto-create the ADMIN/PLANNER
accounts and demo data the first time the `db_data` volume is empty -
useful for testing/demo deployments. Safe to leave on across restarts and
reinstalls (it only acts once, on a genuinely fresh database), but leave
it unset for a real deployment with real staff.

### Production

1. Use `docker-compose up` on dedicated hardware (not cloud/Kubernetes)
2. Automatic backups via `VACUUM INTO` (weekly)
3. Manual backup download button in admin dashboard
4. Test restore before going live

## Security

- **No credentials in repo** (.env is git-ignored)
- **TOTP 2FA** for planner/admin
- **TLS only** via Caddy (internal certs acceptable for hospital network)
- **Personal links** with SHA256 hashing
- **Audit log** for all admin/planner actions
- **Pseudonymous** - no identifying data in database

## Testing Strategy

From CLAUDE.md: "One rule = one test that proves it can't be broken"

Critical tests in Phase 0:
1. Holiday calculation (2024-2035)
2. ISO week rounding
3. Capacity formulas
4. Auth token hashing
5. TOTP verification

Run with `npm run test`.

## Known Limitations (Phase 0)

- No UI for period setup (coming Phase 1)
- No preference management (coming Phase 1)
- No solver (placeholder only, coming Phase 2)
- No assignment/publishing (coming Phase 3)
- No email integration (by design - exports + mailto)

## Contributing

1. Read CLAUDE.md first
2. Follow code conventions (TypeScript strict, no default exports, etc.)
3. Write test for any hard rule you add
4. Use meaningful commit messages
5. Reference the implementation plan (v14)

## License

Internal use only.

## Support

See CLAUDE.md for:
- Code structure
- Database conventions
- Sign conventions
- UI terminology
- Common pitfalls

See `/DIENSTROOSTER_PLAN_v14.md` for full requirements.
