# Mail: the verzendlijst, reminders, swap mails, "Link kwijt?"

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Mailing personal links (verzendlijst)

The AIOS have their own address setting (docs/aios-rooster.md, "Mail"), and since 0.105.0 the
same flow can serve both: every verzendlijst carries `dienst` (`ACHTERWACHT` or `AIOS`),
set by buildVerzendlijst in each copy, never by a caller, and the flow picks its rows by
it (docs/verzendlijst-power-automate.md). The AIOS's mail
goes through lib/aiosMail.ts, a copy of the sending here, to the address
under `aios.mail.verzendlijst_aan`, from the same Gmail account. Their
automatic reminders (lib/aiosAutoHerinneringen.ts, 0.73.0) are a copy of
the achterwacht's below: the same moments, the same groups and claims in
dienstrooster_reminder_run, their own texts, /aios/ links and flow, and a
switch per period in dienstrooster_aios_periode.auto_herinneren (the
period's own auto_herinneren stays 0, so the achterwacht's never take an
AIOS period). Asked for because the AIOS's only went by hand in 0.72.0.
Swaps between AIOS (lib/aiosRuilen.ts, 0.80.0) send RUILVERZOEK,
RUIL_BEVESTIGING, RUIL_UITKOMST, RUIL_INGETROKKEN, since 0.102.0 also
RUIL_HERINNERING and RUIL_HERINNERING_BEVESTIGING, and on approval
RUIL_DOORGEVEN to the AIOS's flow, a request anonymous until it goes
through, as the achterwacht's. Since 0.102.0 the AIOS has a queue of its
own for them (lib/aiosRuilMail.ts, table dienstrooster_aios_mail_queue):
a mail that can't go out waits and goes at the hourly run, after saving the
AIOS's address and after any other successful send; dropped after 7 days,
a request mail once the request was answered, and a withdrawal for a
request the colleague never heard of takes that request's mails with it.
The personal link is made when the mail is sent. The beheerder sees what
waits (kind, codenaam, since when) in Mailinstellingen, no addresses and
no texts. Swapping only on a definitief roster; there is no status
vervallen: what can never go through any more is INGETROKKEN, the colleague
(and for a third party's request or a roster change the requester too) is
told (meldAiosRuilenIngetrokken).

RUIL_DOORGEVEN (0.102.0): ONE bericht, to the codenaam Roosterbureau, with
`cc` (codenamen: the requester, the colleague and Planner) and `personen`
the two who swapped. The app never holds an address; the flow looks the
codenamen up in its own sheet, so the operator updates the flow once to
put the `cc` codenamen in the CC. Until then the field is ignored and the
bericht goes to the Roosterbureau alone. The colleague who approved gets
a RUIL_UITKOMST of their own, with the requester's name.

Reminders (0.102.0, lib/ruilHerinnering.ts for the achterwacht, lib/aiosRuilen.ts
for the AIOS): automatic once, at the last 09:00 at or before 7 x 24 hours
after the request (a Friday afternoon request: the next Friday morning),
by the hourly check (instrumentation-node.ts); by hand, by the requester
or the planner, after a yes in the page (`bevestigd: true`), not within 24
hours of the last one. Columns laatste_herinnering_op and
laatste_herinnering_door (AUTOMATISCH, AANVRAGER, PLANNER) on both swap
tables. The colleague gets RUIL_HERINNERING (anonymous), the requester
RUIL_HERINNERING_BEVESTIGING with the advice to consider another day or
colleague, that more than one request is possible and that the others are
withdrawn when someone accepts.

Contact addresses (0.102.0): a participant never sees the flow's mailbox.
What they mail about a voorlopig roster, or a swap the app can't make, is
the planner's own address per dienst, set by the beheerder in
Mailinstellingen (`mail.contact_planner` for the achterwacht,
`aios.contact.planner` for the AIOS; lib/appSettings.ts getContactPlanner,
lib/aiosMail.ts aiosContactAdres). Without one the text says "Meld dat bij
de planner" and no address.
Publishing the AIOS's roster (lib/aiosPublicatie.ts, 0.78.0) sends the
verzendlijst kinds ROOSTER_VOORLOPIG and ROOSTER_DEFINITIEF to that flow,
with their own texts: per AIOS their diensten, their dienstpercentage
and an /aios/ link, the definitieve one with what changed. Withdrawing a
publication sends nothing: the verzendlijst has no kind for it, and
adding one would change the contract with both flows.
What follows is the achterwacht's, unchanged for the AIOS
(docs/development/diensten.md, "Copied, not changed").

The app never stores e-mail addresses, so it never mails participants
itself. It hands a "verzendlijst" (lib/verzendlijst.ts: fixed subject
`DIENSTROOSTER-VERZENDLIJST` + a JSON attachment: summary fields plus
`berichten`, each `{soort, codenaam, personen, onderwerp, tekst}`; `personen` = every codenaam
the text names, longest first, so a flow can swap in real names from its
sheet without "Persoon-1" matching inside "Persoon-10") to a Power Automate flow on the planner's
side, which looks each codenaam up in its own Excel list and sends the
mail. The server sends that mail itself (lib/verzendlijstMail.ts) once an
account is set up, in the app only ("Mailinstellingen" under Exporteren &
communicatie, `/api/planner/mail-settings`, lib/appSettings.ts; saved and
removed by the beheerder only, shared by both diensten. Since 0.87.0 only
the beheerder gets the button at all, as on the AIOS's page: a planner
sees how the mail stands (components/MailStatus.tsx), the warning at the
top tells them to ask the beheerder, and the texts that pointed a planner
to Mailinstellingen say the beheerder does it. Without the mail every
button that sends is off and says why (GEEN_MAIL in PlannerDashboard and
ExportDialog): "Herinnering sturen" per person and to everyone,
"Deadlineherinnering versturen" and the two send choices of the export
dialog; they answered with an error only after the click. The downloads
stay on (tests/e2e/export.e2e.ts) - Gmail
only, a 16-letter app password, the login is tried before saving, the
password is stored AES-GCM encrypted with a key derived from the session
secret, lib/settingsCrypto.ts, and never returned). .env is not read for
it any more (SMTP_USER/SMTP_PASS/VERZENDLIJST_AAN were removed on
purpose); SMTP_HOST/SMTP_PORT exist only so tests can point it at
tests/smtpSink.ts. The one mail variable left is MAIL_UITGESCHAKELD=true, a
kill switch for a test installation on a copy of production's data: nothing
is sent (readConfig returns null) and MailWarning says so. Without it the export dialog says sending isn't
set up, and MailWarning at the top of the period page says no mail goes
out at all. That warning also shows the last failed send (stored as
`mail.laatste_fout` in app_setting by sendVerzendlijst, cleared by the
next successful send or new settings; "not set up" is never recorded as
a failure) - automatic reminders and swap mails fail where nobody
watches. There is deliberately no other way out: the old manual JSON
download and the per-person mailto links are gone, and a single reminder
goes through the flow too. The invitations download (a workbook) stays. The recipient is always the flow mailbox from Mailinstellingen, never
anything from a request. Links in mails a participant sets off (swap
mails, lib/meldingMail.ts) use lib/baseUrl.ts `mailBaseUrl`: BASE_URL or
the period's `basis_url` from the planner's export, never the Host header
of the participant's request (anyone can forge it, and the colleague's
fresh personal link would go to that host); with neither known the mail
has no link. resolveBaseUrl (Host header) is for planner exports only. Swap requests use the same channel (lib/meldingMail.ts):
a new request mails the colleague (SWAP_REQUESTED) and confirms to the
requester, and approve/reject mails the requester (SWAP_RESULT), each a
one-bericht verzendlijst with a fresh personal link and the swap spelled
out from the reader's side (lib/swapMailDetails.ts). A mail about a swap
that hasn't gone through names nobody but its reader (request
SWAP_REQUESTED_MAIL_TEMPLATE "Nieuw ruilverzoek", confirmation, rejection,
withdrawal SWAP_WITHDRAWN_MAIL_TEMPLATE, lapse; `personen` holds only the
reader), so the flow can't put a real name to it: the colleague can say
no without knowing to whom. The in-app notices and lists keep the
codenamen, which are pseudonyms. The approval mail (`goedgekeurd`) names
the colleague, and the approval also sends a RUIL_DOORGEVEN verzendlijst
(DoorgevenMail in lib/meldingMail.ts, queued like any swap mail, built from
the swap row when sent) with one bericht each for the fixed codenamen
`Planner` and `Roosterbureau` (DOORGEVEN_AAN, lib/swapMailDetails.ts):
who now does which shift, `personen` = both who swapped, no link. The
operator adds those two rows to the flow's sheet; the app never puts an
address in a verzendlijst, so a forged one can't reach anyone outside it. The swap dialog says only an equal swap goes through the app (one shift
for one of the same kind, which the create route enforces); any other
trade colleagues agree themselves and mail it themselves to the planner
(the contact address of the dienst, lib/appSettings.ts getSwapContacts,
GET /api/person/[id]/swap-contacts; not the flow mailbox since 0.102.0) and to "het roosterbureau", named
without an address. The address lives in the app, never in code. Started after the
commit and never awaited, so a mail failure can't fail or slow the swap.
A swap mail that can't go out (not set up, or refused) waits in
dienstrooster_mail_queue with its MeldingMail as JSON - built, personal
link included, only when it is sent - and flushMailQueue sends it hourly
(instrumentation-node.ts), right after mail settings are saved and after
any other successful send (flushAfterSend, via a dynamic import from
lib/verzendlijstMail.ts), oldest first, stopping at the first refusal.
What no longer applies is pruned on every run, also while sending isn't
set up, so MailWarning's count stays honest. A withdrawal waits for its
own request mail if that is still being tried (requestsInFlight). Dropped after 7 days, a
RUILVERZOEK/RUIL_BEVESTIGING as soon as the swap is no longer PENDING,
and a withdrawal notice whose request mail never went out takes that
request mail with it instead of being sent. The create route returns
`mail_vertraagd` (not set up, a remembered failure, or a non-empty queue)
so the requester is told the colleague may only see it in the app for
now; MailWarning counts what waits. Every
bericht carries a `soort` (UITNODIGING, HERINNERING, LAATSTE_HERINNERING,
RUILVERZOEK, RUIL_BEVESTIGING, RUIL_UITKOMST, RUIL_INGETROKKEN, LINK_AANVRAAG,
ROOSTER_VOORLOPIG, ROOSTER_DEFINITIEF, RUIL_DOORGEVEN) and an
`html` field: `tekst` escaped with <br> for line breaks (tekstNaarHtml).
The flow must use `html` as the mail body, never build HTML from `tekst`:
the text can hold words a participant typed (swap toelichting, rejection
reason, both capped at 1000 characters by lib/freeText.ts). Withdrawing a
swap tells the colleague. One shift may be offered to several colleagues
at once (the candidates list marks who was already asked, `al_gevraagd`;
the exact same request twice is refused): the first to approve wins. That
approval withdraws the other open requests of either side of that swap
(INGETROKKEN, only the colleague each was sent to is told; the requester
hears it in the approval mail, the approver on screen from the response's
`afgesloten`) and withdraws anyone else's request on either shift as
well (INGETROKKEN with the reason that one of the diensten was swapped, both
sides told; before 0.102.0 it was AFGEWEZEN) (lib/swapLifecycle.ts). One
participant may start at most 20 swap requests per 24 hours, withdrawn
ones included (lib/swapQuota.ts, 429): each mails two people, and the
sending account's daily limit is shared with invitations and reminders. Invitations go out only for an OPEN period before
its deadline, like reminders (lib/reminderGate.ts); the download of links is
not gated. SMTP on any port but 465 requires STARTTLS (requireTLS).

Automatic reminders (lib/autoReminders.ts, run every hour from
instrumentation-node.ts): for an OPEN period with `auto_herinneren` on,
one moment per reminder_schedule milestone (7 and 1 days by default) at
the last 09:00 at least N*24h before the deadline, to everyone not
BEVESTIGD (own text for NIET_BEGONNEN/no row and for BEZIG), minus anyone
with a REMINDER/FINAL_WARNING in notification_log in the last 24h (manual
sends log there too). Each moment is claimed in dienstrooster_reminder_run
keyed on (period, milestone, deadline) before sending and released if the
send fails; a moment more than 12h late, or due together with a more
urgent one, is recorded as OVERGESLAGEN instead. Links use BASE_URL or the
period's `basis_url`, remembered from the planner's last export request.
There is no separate summary mail: every verzendlijst is an object
(lib/verzendlijst.ts `Verzendlijst`) whose fields around `berichten` -
soort, automatisch, periode, deadline, aantal, and for reminders
nog_niets_ingevuld/nog_niet_ingediend - let the flow report back to the
planner itself. runAutoReminders takes `onlyPeriodIds` for tests: the
test database is shared across test files. Setup for the operator, in
Dutch: docs/verzendlijst-power-automate.md.

The "Deeltijd" step's check ("my part-time days and absences are right")
is stored on the submission row (`deeltijd_gecontroleerd_op`, migration
0019, lib/submissionStatus.ts get/set/clearParttimeCheck, GET/PUT
/api/person/[id]/parttime-check), not in the browser: it holds on every
device, "Status voorkeuren" shows it ("Deeltijd gecontroleerd"), every
create/edit/delete of a part-time pattern or absence clears it (next to
markSubmissionStarted in those routes), and the submission route refuses
to hand in without it (the client's old `parttime_confirmed` flag is
ignored).

"Status voorkeuren" and the statusrapport download are one query
(lib/periodProgress.ts loadPeriodProgress: the period's members, fellows
last, blocked days without a fellow's weekend blocks, Deeltijd only for a
pattern that overlaps the period, Deeltijd gecontroleerd, Fellow). The
download had its own: it counted the fellow blocks as days blocked by
hand, and both ticked Deeltijd for a pattern that ended a year before
(audit 16, lib/periodProgress.test.ts).

The planner reminds by hand from "Status voorkeuren": a "Herinnering
sturen" per person (disabled once BEVESTIGD) and one below the table for
everyone not BEVESTIGD, both POST /api/planner/period/[id]/remind - the
automatic reminder's text (reminderBericht), fresh links, logged like any
reminder, only while OPEN before the deadline. (There used to be a
"submit on behalf" button there; it is gone on purpose.)

Nobody is reminded by hand twice within 24 hours without the planner
saying so: the table shows "Laatst herinnerd" (`laatste_herinnering_op` in
the progress route, lib/autoReminders.ts lastRemindedAt over
notification_log, automatic and manual alike; lib/herinnerdOp.ts words
it), and the server enforces it, so a refresh doesn't undo it. One person
reminded within the day: 409 RECENT_HERINNERD with the time, the row asks
"Toch versturen". Everyone: without `opnieuw` those people are skipped
(`overgeslagen`), the confirmation offers "Alleen de andere n" or
"Iedereen". The export dialog's send route sends nothing while one of
them is recent (409 with `recent`), and the dialog asks the same way.

"Link kwijt?" on the start page (components/LinkAanvraagForm.tsx, public
POST /api/link-aanvragen, lib/linkAanvraag.ts): the app can't map an
address to a codenaam, so it mails the flow a LINK_AANVRAAG verzendlijst
with the typed address (`aanvraag_email`, trimmed, lower case) and a
bericht for every participant of the active period in `kandidaten`, each
with a fresh link (mailBaseUrl - never the request's Host header) and a
line saying what it is good for now (periodeUitleg: preferences until the
deadline, only looking once it passed or the period closed, the roster
once published). The active period (lib/activePeriod.ts, one per pool) is the one
whose invitations went out last (`schedule_period.uitgenodigd_op`, set by
a successful invitation send; a database from before it gets the newest
non-CONCEPT period with a basis_url, LATER_COLUMN_BACKFILL in the seed and
migration 0018). Another period's invitations are refused (409
OTHER_PERIOD_ACTIVE) until the active one is GEPUBLICEERD; the period
list marks it "Actief".
`berichten` stays empty on purpose: a flow that doesn't know this soort
must send nothing rather than mail everyone. The flow looks the address
up in its sheet and sends only that codenaam's bericht, to the sheet's
address. The answer is the same for any address; rate-limited per caller
(3 an hour) and in total (10 per 15 minutes), because every request mints a link
for every participant and costs a Gmail send. The address is never
stored or logged.

## One send at a time, and sending a roster again (0.805.0)

A send that goes to everyone is claimed per period and kind before its first
await (lib/inFlight.ts for the achterwacht, its copy lib/aiosInFlight.ts for
the AIOS): a second click or tab is told `BEZIG` (409). The reminder by hand
and the automatic reminder share one key per period (`remind:<id>`, AIOS
`herinneren:<id>`): the automatic one then leaves its moment unclaimed and goes
on the next tick. Invitations (`invitations:`, AIOS `uitnodigen:`) and the
roster mail (`rooster-mail:`) have their own.

`POST /api/planner/period/[id]/rooster-mail` and
`POST /api/aios/periode/[id]/rooster-mail` send the mail of the publication
again (voorlopig while voorlopig, definitief when definitief) to everyone, for
when it failed. Nothing about the roster changes; the audit log notes it. The
buttons ask first ("Rooster opnieuw mailen").

## The beheerder's password mail (0.805.0)

The one mail that does not go to the flow's mailbox: lib/wachtwoordHerstel.ts
sends it from the Gmail account to that same account
(`sendDirectMail`, lib/verzendlijstMail.ts). See docs/development/auth.md.
