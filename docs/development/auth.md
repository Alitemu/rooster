# Authentication and sessions

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Authentication

**Two mechanisms:**

1. **Personal Links** (participants)
   - Long random token → SHA256 hash in DB
   - Grants access to own period/preferences only
   - Read-only after deadline
   - Valid for its own period; a new export issues an extra link rather
     than retiring earlier ones, so someone can still use the link in the
     original invitation mail. `ingetrokken_op` is honoured on every
     request (lib/auth-context.ts), but no flow sets it - revoking is a
     deliberate manual act, not a side effect of exporting.

**Writes from another page (0.112.0):** the session cookie is SameSite=Lax,
which stops a page on another site, but "same site" ignores the port and
the sub-domain: another web app on the same address (a different port on the
NAS) still sends the cookie, and a form or a `text/plain` fetch needs no
preflight. proxy.ts therefore refuses, for every /api route that is not
GET, HEAD or OPTIONS, a request with Sec-Fetch-Site other than same-origin or
none (403 CROSS_SITE), or, for a browser without Fetch Metadata, with an
Origin that is not the Host or X-Forwarded-Host (lib/crossSite.ts), and a
body of a form type (text/plain, urlencoded, multipart: 415). A request
with neither header comes from no browser page (curl, the checks, a
server) and is let through. GET /api/auth/verify-link sets a cookie, so it
refuses a request from another site too: a link in a mail opens the page,
which calls it itself. Do not run other web apps on the hostname of this one:
the cookie is not scoped to a port (docs/installatie-it.md).
A signed token that is not a session (the setup token, the password-reset link)
is not read as one: verifySessionToken accepts only kind staff and person.

2. **Password** (planner/admin). Two-step verification (TOTP) was removed in 0.805.0: the
   routes, the dialog and the check at login are gone, `person.totp_secret` stays in the
   table unused, and a leftover value never blocks a login.
   - bcrypt (the native binding) for password hashing; a password needs 8+
     characters with lower case, upper case, a digit and a special
     character (validatePasswordStrength)
   - The codenaam at login is case-insensitive (COLLATE NOCASE in
     staff-login, first-run-setup and the server scripts; an exact match
     wins if two staff accounts differ only in case). New staff accounts
     can't differ from an existing codenaam only in case (asked again in
     the transaction that writes it: two requests at once both passed the
     check while the password was hashed, audit 10).
   - Ten wrong guesses per account (and per client) per quarter of an
     hour, also when they arrive at the same moment: staff-login,
     change-password and first-run-setup take
     an attempt with lib/rateLimit.ts `takeAttempt` before bcrypt or the
     code check runs and give it back (`releaseAttempt`) once the secret
     matched. Checking first and counting after the asynchronous compare
     let a burst of thirty all through (audit 8,
     app/api/auth/rateLimitConcurrency.test.ts).
   - No email required (pseudonymous)
   - The password is changed through POST /api/auth/change-password
     ("Wachtwoord wijzigen" on the period list), which requires the
     current one. /api/auth/first-run-setup only ever claims an account
     that has none yet, so it is not a reset path.
   - `scripts/seed.ts` sets a known password from `lib/seedPassword.ts` -
     deliberate, so a seeded database is immediately usable while this is
     being built. The app logs a warning on every start while an account
     still has it. The repository is public, so a login with it gets a
     session flagged `wachtwoordWijzigen` (lib/session.ts): requirePlannerAccess
     refuses it, only change-password (requireStaffSession), logout and
     /api/auth/me accept it, and the login page asks for a new password
     first; the seed password itself is refused as the new one.
     ALLOW_SEED_PASSWORD=true lifts this for local test runs only;
     docker-compose.yml does not pass it through.
   - A forgotten password: `scripts/reset-password.ts <codenaam>` on the
     server (`docker compose exec -u node web ...`) asks for a new one twice
     without echo (NIEUW_WACHTWOORD without a terminal, never an argument),
     applies validatePasswordStrength, refuses the seed password, raises
     sessie_versie and writes the audit log. Deliberately no reset for
     planners on the login page: no e-mail address to send to.
   - The beheerder's way back from the start page (lib/wachtwoordHerstel.ts):
     the Gmail address of Mailinstellingen typed in "Link kwijt?"
     (POST /api/link-aanvragen, the achterwacht's route only: the form asks
     the AIOS's too, which does not know the address) mails that account one
     link per active ADMIN. The link is `<base>/wachtwoord-herstel#token=...`:
     a signed token (signPayload, kind `wachtwoordherstel`, 30 minutes) bound
     to the account and a fingerprint of its current wachtwoord_hash, so it
     works once and a new password kills the older links; the token is in the
     fragment, never in a server log. `<base>` is BASE_URL, else a period's
     basis_url, else the address a beheerder last logged in on (stored
     after a correct password in app setting `herstel.basis_url`), never the
     Host header of the asker. The answer is the same for any address
     (the mail is awaited like a participant's, so the time says little too)
     and the caller's limit is the Link kwijt limit (3 an hour). POST
     /api/auth/wachtwoord-herstel { token, wachtwoord } sets it (same rules as
     every password, the seed password refused), ends every session and
     writes the audit log; ten wrong tokens per 15 minutes stop the
     caller. Mail off (MAIL_UITGESCHAKELD) or not set up: nothing goes.
   - ADMIN ("beheerder") = everything a planner can (requirePlannerAccess)
     plus the staff accounts (requireAdminAccess, lib/staffAccounts.ts,
     /api/admin/accounts, page /planner/accounts linked from the period
     list for ADMIN only; a planner who opens it anyway sees only "Alleen
     een beheerder kan accounts beheren", no list and no form, and a list
     that fails to load says so instead of "Accounts laden..." for good,
     tests/e2e/accounts-access.e2e.ts, audit 16): add a PLANNER/ADMIN with a temporary password,
     give an account a temporary password, switch it
     off or change its role. A temporary password sets
     `person.wachtwoord_moet_wijzigen` (migration 0021): the login session
     is flagged wachtwoordWijzigen like a seed-password login (login says
     "tijdelijk wachtwoord"), change-password clears it. Every change
     revokes that account's sessions and is audit-logged without password
     material. Never one's own account (409), never the last active admin.
     A staff account has a `dienst_type` (migration 0022; DIENST_TYPES
     ACHTERWACHT | AIOS, lib/staffAccounts.ts): the admin picks it when
     adding an account (until 0.81.0, step 5 of docs/aios-rooster.md, AIOS
     was refused with "nog niet in productie"). It decides what a planner sees
     (see "Diensten: the achterwacht and the AIOS"). A production start
     (--alleen-planner) creates only 'admin' (ADMIN, seed password or
     SEED_PLANNER_PASSWORD) as staff, who adds the planners with names of their own;
     the demo seed also creates 'planner', which the browser checks log in
     as. Every start, whatever SEED_ON_START says (seed.ts addAdminIfNone, also
     in --schema-only and the already-seeded demo run), adds 'admin' to an
     existing database while it has no ADMIN at all; an existing 'planner'
     stays. A migration-built database that hasn't caught up yet gets it at
     the start after. The backup on the
     server: scripts/reset-password.ts, and `scripts/create-account.ts
     <codenaam> [--planner | --beheerder]` (hidden prompt,
     scripts/hiddenPrompt.ts; --beheerder promotes an existing planner).
     No real account name goes into the repository.
   - The login page's `redirect` only goes to a /planner path on this site
     (lib/safeRedirect.ts, checked with the URL parser: "/\\host" leaves
     the site in a browser).

**Revoking a personal link (0.802.0)**

The beheerder, and only the beheerder, sees the section "Persoonlijke links"
on a period page (the achterwacht's and the AIOS's each have their own): the
links issued for that period with when each was made, last used and
revoked, never the link itself (only its hash is stored). "Intrekken" asks
first, then sets `ingetrokken_op` (verify-link refuses the link from then on)
and ends the sessions of that person (`revokeAllSessions`). The second step
is needed because lib/auth-context.ts only asks for *a* valid link of the
person: without it, whoever came in through the revoked link would stay in
while the person has another one. The person gets back in with a link that
is still valid, or a new one ("Link kwijt?" or the next invitation). Revoking
is audit-logged (person_access_link), twice answers 409, a link of another
period 404, and the achterwacht's route refuses an AIOS period. Revoking
the last link of a person locks them out until a new one; the question says so.
"Alles intrekken" (0.803.0, POST .../toegangslinks/alles-intrekken, one audit
entry on the period with the numbers) revokes every working link of the period
and ends the sessions of each of those people once; links of other periods
stay, so a person who has one is back in with a fresh session. The question
says how many links and people it is about.

**Session revocation**

Session cookies are self-contained signed tokens, so nothing server-side
knows they exist. `person.sessie_versie` is the one thing that does: it is
baked into every token and compared on each request (lib/sessionVersion.ts).
Raising it invalidates every token issued for that person in one UPDATE.

- Logging out revokes every session for that person, not just this
  browser's cookie. `{ "alleenDezeBrowser": true }` on POST /api/auth/logout
  keeps the others.
- Changing the password revokes them too, and re-issues a cookie for the
  browser that made the change.
- A token from before the column existed carries no version and is
  refused, so everyone logs in once more after that upgrade.
