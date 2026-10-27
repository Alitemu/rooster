# Deployment

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Deployment

**Images:** node:22-alpine (Node 20 is end-of-life), dev dependencies
pruned after the build; `.npmrc` sets legacy-peer-deps because npm 10
crashes resolving vitest 4's optional peers, and `npm ci` must match the
lockfile. `npm audit` reports issues in build-time tools only (braces via
Tailwind 3's chokidar, postcss-selector-parser): none ship in the image, no
fixed version exists short of Tailwind 4, and they only ever read this
repository's own source; `npm audit --omit=dev` must stay at 0. Built only by hand. "Bouwen (test)" (.github/workflows/images.yml)
builds `ghcr.io/alitemu/rooster-web`, `rooster-solver` and, from 0.74.0,
`rooster-aios-solver` (amd64 only; docs/development/aios-solver.md)
tagged with package.json's `version` and `test`, only after the app's and
both solvers' tests pass and only for a version not built before (bump
package.json for every build); "Vrijgeven (productie)"
(release.yml) points `stable` at an already built, tested version without
rebuilding (rooster-aios-solver only when that version has one: going back
to a version before 0.74.0 leaves its `stable` where it is; in
docker-compose.yml web waits for the achterwacht's solver only, since
0.84.0, so the achterwacht starts whether or not the AIOS's does), and makes the GitHub release `v<version>` with the commits
since the release before it, marked as the latest. Releasing a version
again only moves that mark, so the latest release is always what
production runs. The release goes on the tag `v<version>` that "Bouwen
(test)" sets on the commit it built: the workflow's GITHUB_TOKEN may not
create a tag on an older commit whose workflow files differ from the
default branch ("Resource not accessible by integration"), and this
session may not push tags. Versions before 0.72.0 have no such tag, except
0.71.0: the user made that release by hand on GitHub. Compose pulls `${ROOSTER_VERSION:-stable}` (a test
installation sets `test`) and keeps `build` for building from source.
Updating is `docker compose pull && docker compose up -d`. The schema of an
existing database is brought up to date at every start either way:
docker-entrypoint.sh runs the seed (SEED_ON_START=planner, the default, or
true) or else
`scripts/seed.ts --schema-only` (tables, LATER_COLUMNS, reworded
templates, no data; skipped for a migration-built database).

**One file (0.800.0):** docker-compose.yml is the whole installation. The
Caddyfile is a heredoc in the caddy service's `sh -c` (written to
/tmp/Caddyfile at start, `$$` for `$`), so there is no file next to the
compose file to forget (a missing bind-mounted file becomes a directory and
Caddy fails). It works on any Compose version, unlike `configs: content`.
deployConfig.test.ts reads the Caddyfile back out of the compose file, and
validates it with a real Caddy when `caddy` (or CADDY_BIN) is on the machine:
have one for the release gate.

**Port and address:** Caddy listens on APP_PORT (compose default 443; a NAS
that uses 443 itself sets APP_PORT=8010 in .env),
on any host name, with an on-demand certificate per name, so a renamed
server needs no config change. `http://:80` in the Caddyfile redirects to
https on APP_PORT; port 80 is published on every interface by default,
so a server needs no .env for that. A NAS that has it taken sets
HTTP_PORT (8080, say) in .env.
**Certificate:** TLS_MODUS in .env picks the snippet the Caddyfile imports (./certs is created empty by Docker when missing, which `intern` does not mind).
`intern` (the default) is Caddy's own CA, on demand per name. `bestand` is
the organisation's own certificate: ./certs/rooster.pem and rooster.key,
mounted read-only at /certs. Caddy does not renew it; replacing the files
needs `docker compose restart caddy`. The caddy service starts through a
small `sh -c` in docker-compose.yml that says in Dutch what is wrong with
TLS_MODUS or the files, and then execs Caddy (which fails on them anyway,
the whole site then being down: a wrong certificate is not hidden by a
fallback on purpose). The web image carries docker-compose.yml and
docs/installatie-it.md in /app/installatie (Dockerfile), the very ones of
that version: the IT department extracts them with `docker run ... tar`
(the doc says how), so installing needs nothing from GitHub but the image.
deployConfig.test.ts keeps the
Caddyfile, the compose file and .env.example in step (README "Certificaat",
Optie 3, is the instruction for the IT department).
With BASE_URL empty the app takes its address from the Host header
(resolveBaseUrl) and remembers it per period (basis_url) for mails.

**Sub-folder (basePath):** NEXT_PUBLIC_BASE_PATH at build time (Dockerfile
arg BASE_PATH, "Bouwen (test)" input `basispad`, empty by default -
the app got its own subdomain instead;
empty = root, as before) sets next.config basePath. Next.js prefixes
<Link> and router.push itself; everything else goes through
lib/basePath.ts `withBasePath` - every client fetch('/api/...'), plain
<a href>, window.location - and `withoutBasePath` for a browser pathname.
The session cookie's path is the sub-folder, resolveBaseUrl appends it
(BASE_URL must include it), the Docker healthcheck uses it, and Caddy
redirects anything outside it to it (BASE_PATH in .env). A new client
fetch without withBasePath works at the root and breaks only in a
sub-folder, so run the browser checks against a sub-folder build too:
`NEXT_PUBLIC_BASE_PATH=/achterwacht npm run build`, start it the same
way (the variable set at `npm start` too: next.config is read again
there), and run them with `APP_URL=http://localhost:3000/achterwacht`
(scripts and tests/e2e read APP_URL). No Next.js metadata file
convention under app/ (icon.tsx, apple-icon, opengraph-image, favicon.ico,
manifest, sitemap, robots): Turbopack, which builds this app, links those
without the base path, and the tab icon was a 404 on every page in a
sub-folder (audit 16). The icon is its own route, app/tab-icon/route.tsx,
linked in app/layout.tsx's metadata through withBasePath;
app/basePathSweep.test.ts refuses such a file and tests/e2e/tab-icon.e2e.ts
fetches the icon where the page links it.

**Backups and a clean start:** lib/dbBackup.ts writes one `VACUUM INTO`
copy a day to `<db dir>/backups/database/rooster-YYYY-MM-DD.db` (local
date), from the hourly scheduler, keeping the newest 14 - a plain file copy
of a WAL database misses what is still in -wal. The key for everything stored
encrypted (`<db dir>/.session_secret`, or SESSION_SECRET) is deliberately
not in it; the README tells the operator to keep it apart. SEED_ON_START=planner runs
`scripts/seed.ts --alleen-planner`: beheerder account admin, ruleset, pool, shift
types, notification templates and 30 participants staf01..staf30 in the pool
(addBareStartParticipants: membership from 1 January of the current year to
2099-12-31, factor 1, no access link, preferences, balances, part-time or
holiday history), no period (the
production start and compose's default; true adds the demo data); a rerun
on a seeded database only upgrades the schema.

**Start and stop (0.112.0):** docker-entrypoint.sh ends with `exec
node_modules/.bin/next start`, not `npm start`: npm stays as a parent that
passes no SIGTERM on (reproduced), so `docker stop` ended npm and left the
server to be killed in the middle of its requests. `/data` is re-owned with
`chown -R -h`, a link the app user left there is not followed. The build
context leaves out `certs/`, `*.pem`, `*.key`, `*.crt` and `*.p12`: with
TLS_MODUS=bestand the private key sits next to the compose file, and a build
from the source would copy it into the image. The daily backup removes a
`.db.bezig` left by a stop, and makes no copy when the disk has room for
less than two of them (a copy that fills the disk makes the next save fail
with "database or disk is full").

**Container hardening:** the web image is built in two stages (no
compiler, Python or dev dependencies in the one that runs, no .next/cache),
code owned by root with only /data and .next/cache writable for `node`,
NEXT_TELEMETRY_DISABLED, a HEALTHCHECK that exits as soon as the status
is in (one that never read the response waited ~6 s for keep-alive, past
its 5 s timeout, so web showed "unhealthy" until 0.11.1). The solver image installs wheels only
(--only-binary), no build-essential, own .dockerignore, code root-owned.
Compose: caddy:2-alpine (Caddy 2.8+ dropped on_demand_tls interval/burst),
capped json-file logs, no-new-privileges everywhere, init + mem_limit on
web, cap_drop ALL + mem_limit on the solver. Workflow actions are pinned
to commit SHAs.

**Uploads** (the wizard's beginsaldi, "Eerdere toewijzingen"): an .xlsx
only since 0.806.0 (lib/sheetUpload.ts readUploadedRows refuses anything
else in Dutch, ONLY_XLSX), in the layout of a sjabloon that the page offers
to download next to the file field: GET /api/planner/period/[id]/import-
balances/sjabloon (a row per person who takes part, an earlier import
filled in) and GET /api/periods/[id]/prior-assignments/sjabloon (a row per
day of the carry-over window with its diensttype, who is entered already
filled in); lib/importSjabloonBouwen.ts builds them, lib/importSjablonen.ts
holds their columns and `kopFout`, which refuses a first row that is not the
sjabloon's before a row is read. The roster download has the same four
columns as the "Eerdere toewijzingen" sjabloon, so it goes in as it is; an
empty codenaam there is a row nobody filled in and is left out silently
(priorRowsInWindow). The AIOS has its own sjabloon for its history
(lib/aiosGeschiedenis.ts). The beginsaldo import asks before it replaces one that
is there (0.807.0): GET .../import-balances lists what the period has, the wizard
warns when the file names someone on that list and holds the rows until a yes;
the route answers 409 SALDO_BESTAAT without `bevestigd: true`. A workbook is read by the server,
POST /api/planner/read-workbook (planner only, the same reader as the
preferences import, writes nothing), and the rows come back to the page;
"Eerdere toewijzingen" previews them with lib/priorAssignmentUpload.ts
priorRowsInWindow. A date cell arrives as Excel's day number
(lib/isoDate.ts parseSheetDate, also text dates). lib/csv.ts parseCsv stays
for the other CSV readers; these two imports no longer take a CSV (a re-saved
CSV's separator and encoding depend on the machine).

**Downloads:** every download is a one-sheet workbook (.xlsx, 0.20.0):
rooster, statusrapport, voorkeurenoverzicht, uitnodigingen,
wijzigingsgeschiedenis (app/api/exports). They were CSV, which a Dutch
Excel opened in one column (it splits on ";" and wants a byte order mark),
and a CSV saved again changes with the machine. lib/xlsxWrite.ts writes
them with Node's zlib, no library, like the reader: a date is a real date
(Excel's day number in its own date format, shown the reader's way), a
moment is the Dutch clock time (`{ moment }`; the CSVs gave UTC), the
header row is bold, frozen, filtered and on every printed page, and the
voorkeurenoverzicht keeps its first four columns in view too and prints
landscape with grid lines. A text cell is never a formula (no <f> is ever
written), so no apostrophe guard; what XML can't hold is written as
_xHHHH_ the way Excel does, or Excel calls the file corrupt. The file name
goes through `xlsxAttachment`: an ASCII `filename` and the real name as
`filename*` (UTF-8). A header value holds nothing above U+00FF, and a
period name with an en dash, euro sign or emoji used to make every export
answer 500. Not cached (the invitations hold personal links). lib/csv.ts
stays for the preferences backups on disk and for CSV uploads.

**Limits:** request bodies are capped at 1 MB in Caddy and in
lib/api-errors.ts parseJsonBody (read no further; also before login).
Free text a participant types - swap toelichting, rejection reason,
absence notitie - goes through lib/freeText.ts (1000 characters).
A number in a query string is checked like one in a body: the
participant's notices take `limit` 1-200, anything else the default (it
was parseInt: "abc" a 500, "-1" no limit); app/api/queryInput.test.ts
calls every GET that reads a query parameter, with real ids, with odd
values for each, and allows no 500 (audit 12). app/basePathSweep.test.ts
holds every '/api/' address in pages and components to withBasePath. parseJsonBody only guarantees a plain object: a field holding a number,
list or object where text or rows belong goes through
lib/requestFields.ts (optionalText, rowText, objectRows, badRequest) and
gets a Dutch 400, never a 500; app/api/routeInput.test.ts calls every
mutating route with wrong types to prove it. A single-line name (codenaam,
period name, lib/vrijeTekst.ts) refuses control characters and invisible
format characters (zero-width, bidi overrides, U+2028/2029), which would
otherwise make two names look the same.

**Docker Compose (3 services):**
- `caddy` - TLS termination (internal certs via `tls internal`)
- `web` - Next.js + SQLite
- `solver` - Python FastAPI (healthcheck only, no public ports)

**Volumes:**
- `web`'s `/data` - SQLite database file and the preferences CSV backups
  (`lib/preferencesBackup.ts`). Bind-mounted to `./data` next to
  `docker-compose.yml` by default (override with `DATA_DIR` in `.env`) -
  deliberately a plain host folder rather than a Docker-managed named
  volume, so a NAS's own file manager (e.g. Synology File Station) can
  browse it directly instead of needing Docker's hidden volume storage.
  Ships as an empty, git-tracked folder (`data/.gitkeep`) precisely so a
  fresh clone always has it: a bind mount's host directory has to already
  exist, unlike a named volume, which Docker creates on demand. A custom
  `DATA_DIR` doesn't get this for free - create it once, manually, before
  the first `docker compose up`.
- `caddy_data` - TLS certificate cache (still a regular named volume - not
  something an operator needs to browse directly)

**Networking:**
- All services on internal bridge network
- Only `caddy` exposes the app port (default 443) to host
