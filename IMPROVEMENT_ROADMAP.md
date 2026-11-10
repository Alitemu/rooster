# Verbeterroadmap: Dienstrooster 1.4.0

Onderdeel van de audit van 10-11-2026 op commit `6493fce`. De nummers
verwijzen naar `AUDIT_REPORT.md`, `SECURITY_FINDINGS.md` en
`TECHNICAL_DEBT.md`.

## 1. Uitgangspunt

De audit vond geen kritieke fout. Het werk hieronder gaat dus niet over
repareren maar over het vervangen van vertrouwen door mechanisme: wat nu
goed gaat omdat één persoon oplet, moet goed gaan omdat het systeem het
afdwingt.

Drie regels bepalen de volgorde:

1. **Eerst wat weinig kost en elke release raakt.** Een pipeline en een
   alarm leveren vanaf dag één op.
2. **Dan wat een einddatum heeft.** De solverbibliotheek en de vraag over
   eigendom worden niet goedkoper door te wachten.
3. **Structureel werk pas als het vangnet er is.** Het schema naar één bron
   brengen zonder automatische driftcontrole is het risico vergroten om het
   te verkleinen.

Inspanning: S is uren, M is dagen, L is weken, voor één ontwikkelaar die het
systeem kent.

## 2. Overzicht

| Fase | Termijn | Doel | Inspanning | Score daarna |
|---|---|---|---|---|
| 0 | Deze week | Stoppen met blind varen | 3 tot 5 dagen | 6,2 naar 6,5 |
| 1 | 30 dagen | Vangnet en de beveiliging van de toegang | 2 tot 3 weken | naar 7,1 |
| 2 | 90 dagen | Eén schema, minder vast, beter beheerbaar | 4 tot 6 weken | naar 7,5 |
| 3 | 6 tot 12 maanden | Structurele schuld en de solverupgrade | 6 tot 8 weken | naar 8 |

Verwachte scores per domein:

| Domein | Nu | Na fase 0 | Na fase 1 | Na fase 2 | Na fase 3 |
|---|---|---|---|---|---|
| Architectuur | 6 | 6 | 6 | 7 | 8 |
| Security | 7 | 7 | 8 | 8 | 8 |
| Codekwaliteit | 6 | 6 | 6 | 7 | 8 |
| Performance | 7 | 7 | 7 | 7 | 8 |
| DevOps | 5 | 7 | 8 | 8 | 8 |
| Testbaarheid | 7 | 7 | 8 | 8 | 8 |
| Onderhoudbaarheid | 5 | 5 | 6 | 7 | 8 |
| Documentatie | 7 | 7 | 8 | 8 | 8 |

## 3. Fase 0: deze week

Doel: elke wijziging wordt automatisch gecontroleerd en uitval wordt gemeld.
Geen van deze stappen verandert gedrag voor gebruikers.

| # | Actie | Bevinding | Inspanning | Klaar als |
|---|---|---|---|---|
| 0.1 | Workflow op `push` en `pull_request`: typecheck, lint, vitest, beide pytest-suites, `npm audit --omit=dev` | OPS-01, TD-15 | S | Een push met een falende test geeft een rood kruis |
| 0.2 | `schema-drift` en `upgrade-drift` in dezelfde workflow | ARCH-01 | S | Een kolom die alleen in het schema staat, laat de workflow falen |
| 0.3 | De health-route doet een query en meldt de leeftijd van de laatste geplande taak | OPS-02, TD-16 | S | De route geeft 503 als de database niet antwoordt |
| 0.4 | Een externe controle die bij uitval mailt (bewaking van de NAS of een uptime-controle op het interne netwerk) | OPS-02 | S | Een gestopte container geeft binnen 10 minuten een mail |
| 0.5 | Het startscript stopt bij een mislukte schema-update | OPS-03, TD-17 | S | Een kapotte `ALTER` geeft een container die niet start, met de reden in het log |
| 0.6 | De 13 ongebruikte pakketten verwijderen, de stacktabellen corrigeren | DEP-01, TD-23, TD-28 | S | `npm ls` toont alleen pakketten met een import |
| 0.7 | Dependabot aan voor npm, pip, Docker en Actions | SEC-09, DEP-04 | S | Er komt een eerste reeks voorstellen binnen |
| 0.8 | De vraag over eigendom en licentie op tafel leggen bij de instelling | DOC-03 | S, niet technisch | Er is een afspraak op papier of een datum waarop die er is |

Afhankelijkheden: 0.2 vraagt 0.1. De rest staat los van elkaar.

**Besluit dat de eigenaar nu moet nemen:** blijft de repository openbaar?
Zolang er geen licentie is en dit rapport erin staat, is besloten maken de
veiligste stand.

## 4. Fase 1: binnen 30 dagen

Doel: de toegang tot het systeem hangt niet meer aan één wachtwoord en één
mailbox en de zwaarste tests draaien zonder dat iemand ze start.

### Beveiliging

| # | Actie | Bevinding | Inspanning | Klaar als |
|---|---|---|---|---|
| 1.1 | Tweede factor voor de rol beheerder of minimumlengte 12 met een vertraging per account die niet van het IP-adres afhangt | SEC-02 | M | Een beheerder komt niet binnen met alleen een geraden wachtwoord |
| 1.2 | Aanvraaglinks: eerdere ongebruikte links van dezelfde persoon intrekken, korte eigen geldigheid, periodiek opruimen | SEC-01 | M | Tien aanvragen achter elkaar laten per persoon één geldige aanvraaglink over |
| 1.3 | Het beheerdersaccount zonder wachtwoord aanmaken en de eerste installatie alleen met de installatiecode toelaten | SEC-04 | S | Een verse installatie heeft geen account met een bekend wachtwoord |
| 1.4 | Tweestapsverificatie op het Gmail-account vastleggen als eis in de installatiehandleiding. De herstelroute standaard uit | SEC-03 | S | De handleiding noemt de eis. De route werkt alleen met een instelling in `.env` |
| 1.5 | Mislukte inlogpogingen en bereikte grenzen vastleggen en aan de beheerder tonen | SEC-12 | S | Een reeks mislukte pogingen is achteraf te zien |
| 1.6 | Basisimages op digest, een imagescan en `pip-audit` in "Bouwen (test)" | SEC-09 | M | Een image met een bekende kritieke kwetsbaarheid wordt niet gebouwd |
| 1.7 | Privacydocument: welke gegevens, waar, hoe lang, wie, hoe verwijderen. Een waarschuwing bij de toelichtingsvelden | SEC-11, DOC-06 | M | Het document bestaat en is door de instelling gelezen |

### Beheer en testen

| # | Actie | Bevinding | Inspanning | Klaar als |
|---|---|---|---|---|
| 1.8 | Nachtelijke workflow: compose-opstelling met beide solvers, de browsertests, `full-check` en `ui-check` | OPS-01, TEST-03 | M | Elke ochtend staat er een uitkomst zonder dat iemand iets startte |
| 1.9 | Een hersteloefening: een back-up uit OneDrive terugzetten op de testinstallatie. Herstelpunt en hersteltijd vastleggen | OPS-05 | S | De datum van de oefening staat in de documentatie |
| 1.10 | `docs/storingen.md`: symptoom, oorzaak, handeling voor de vijf meest waarschijnlijke storingen | DOC-04, TD-30 | S | Een tweede persoon lost er een gesimuleerde storing mee op |
| 1.11 | Een tweede persoon installeert, werkt bij en herstelt de testinstallatie met alleen de documentatie | MAINT-01 | M, organisatorisch | Het is één keer gedaan en de gaten in de documentatie zijn gedicht |
| 1.12 | Vrijgeven voor productie wordt een aparte handeling van een mens, met een vaste wachttijd op test voor wijzigingen aan gedrag | MAINT-02 | S | De regel in `CLAUDE.md` is aangepast |
| 1.13 | Dekkingsmeting aan, cijfer per map in de workflow | TEST-01, TD-19 | S | De workflow toont een dekkingstabel |

Afhankelijkheden: 1.8 vraagt 0.1. 1.11 vraagt 1.10. 1.3 en 1.1 raken dezelfde
code en horen in één release.

## 5. Fase 2: binnen 90 dagen

Doel: één bron voor het schema, typen op de databasegrens en een weg terug
bij een slechte release.

| # | Actie | Bevinding | Inspanning | Klaar als |
|---|---|---|---|---|
| 2.1 | Productie op de migraties. Voor bestaande databases eenmalig het migratieregister zetten. `LATER_COLUMNS` weg | ARCH-01, TD-01 | L | Een schemawijziging is één migratie en één regel in `db/schema.ts` |
| 2.2 | Het seedscript splitsen: schema en accounts voor productie, demodata alleen voor ontwikkeling. Meecompileren bij de build | ARCH-05, DEP-06, TD-26 | M | De productie-image bevat geen `tsx` en geen demodata |
| 2.3 | Rijtypen afleiden uit het schema. Lintregel tegen `any` in `app/api` | CODE-01, TD-02 | M | Een hernoemde kolom geeft een compilerfout |
| 2.4 | Productie op een versienummer in `.env`. Schemawijzigingen alleen toevoegend. `upgrade-drift` test één versie terug | OPS-04, TD-18 | M | Teruggaan naar de vorige versie is getest |
| 2.5 | De staat van een achterwachtgeneratie in de database. De eis "één webproces" vastgelegd | ARCH-02, TD-05 | M | Een herstart tijdens een generatie geeft de planner een duidelijke melding |
| 2.6 | Bewaartermijnen: wijzigingsgeschiedenis, meldingen, verlopen links | DB-02, SEC-11, TD-21 | S | Een geplande taak ruimt op volgens een instelling |
| 2.7 | `CHANGELOG.md`, de README terug naar wat het systeem is en hoe je het installeert | DOC-01, TD-27 | S | De README is korter dan 400 regels |
| 2.8 | Tien beslisdocumenten voor de grote keuzes | DOC-02, TD-29 | S | Elke keuze heeft context, gevolg en een voorwaarde voor herziening |
| 2.9 | De gedeelde tellers herzien en het aantal vertrouwde proxy's instelbaar maken | SEC-05 | S | Eén bezoeker kan "Link kwijt?" niet voor iedereen blokkeren |
| 2.10 | `better-sqlite3`, Next.js en `nodemailer` bijwerken | DEP-03, TD-24 | M | `npm outdated` toont geen achterstand op deze drie |
| 2.11 | Begin van de solverupgrade: tests onafhankelijk maken van de zoekvolgorde | DEP-02, TD-22 | M | De solvertests slagen op twee versies van OR-Tools |

Afhankelijkheden: 2.1 vraagt 0.2 (de driftcontrole moet draaien voordat het
schema verhuist). 2.2 en 2.3 volgen op 2.1. 2.4 vraagt 2.1.

## 6. Fase 3: 6 tot 12 maanden

Doel: de structurele schuld aflossen die elke wijziging duurder maakt.

| # | Actie | Bevinding | Inspanning | Klaar als |
|---|---|---|---|---|
| 3.1 | OR-Tools en Python bijwerken. Een kwartaal beide versies naast elkaar, uitkomsten beoordeeld door de planners | DEP-02, TD-22 | L | De solvers draaien op een ondersteunde Python, ruim vóór oktober 2027 |
| 3.2 | Een gedeelde kern voor wat tussen de diensten gelijk is: mailwachtrij, vergrendeling, linkuitgifte, herinneringen | ARCH-03, TD-03 | L | Een herstel in die logica gebeurt op één plek |
| 3.3 | De regelcontrole van de AIOS door de solverdienst laten doen, zonder kopie in de app | ARCH-03, TD-04 | M | De regels staan op twee plekken in één taal |
| 3.4 | De generatieroute opdelen: invoer opbouwen en uitvoer verwerken als pure functies | ARCH-04, TD-07 | M | De route is korter dan 300 regels en de functies hebben eigen tests |
| 3.5 | De drie grootste componenten opdelen, een gedeelde `apiFetch`, rendertests | CODE-03, TEST-02, TD-08, TD-10 | L | De vijf grootste componenten hebben rendertests |
| 3.6 | `lib/` in mappen per domein | ARCH-04, TD-09 | S | Geen map met meer dan 60 bestanden |
| 3.7 | De solver als taak met een id in plaats van één lang verzoek | PERF-02, TD-06 | M tot L | Een onderbroken verbinding verliest de uitkomst niet |
| 3.8 | CSP met een nonce, React-lintregels aan, per doel een eigen sleutel met ondersteuning voor wisselen | SEC-06, SEC-08, CODE-02, TD-11 | M | `script-src` zonder `'unsafe-inline'` |
| 3.9 | Opruimen: dode tabel en typen, dynamische kolomnamen, containerrechten, de statusroute | CODE-04, CODE-07, SEC-07, SEC-10, TD-12, TD-13 | S | Eén onderhoudsrelease |

Afhankelijkheden: 3.1 vraagt 2.11. 3.3 past het best na 3.1. 3.4 en 3.7 raken
dezelfde route en horen bij elkaar.

## 7. Wat niet op de roadmap staat

| Niet doen | Waarom |
|---|---|
| Overstappen naar PostgreSQL | Geen probleem dat het oplost bij deze schaal. Wel beheer dat erbij komt |
| Kubernetes of een tweede server | Hoge beschikbaarheid is voor een rooster met wekelijkse piekmomenten geen eis. Een goede back-up en een geoefend herstel zijn dat wel |
| De rauwe SQL vervangen door ORM-query's | De SQL is leesbaar en getest. Alleen de typen ontbreken (2.3) |
| De code van de achterwacht en de AIOS samenvoegen | De scheiding in routes en schermen is een bewuste, verdedigbare keuze. Alleen de bewezen gelijke hulpcode hoort gedeeld (3.2) |
| Een cache | Er is niets traag genoeg |

## 8. Voor een koper of investeerder

Wie dit systeem overweegt over te nemen, stelt de fasen anders:

| Voor de transactie | Na de transactie |
|---|---|
| 0.8: eigendom en licentie op papier | Fase 0 en 1 volledig, in de eerste 30 dagen |
| 1.7: het privacydocument en de verwerkersafspraken met de instelling | Fase 2 als voorwaarde voor een tweede klant |
| 1.11: bewijs dat een tweede persoon het systeem kan beheren | 3.1 met een harde datum |
| Een gesprek met de planners van beide diensten: de waarde zit in hun regels | |

De technische schuld is geschat op 12 tot 16 weken werk. Dat is geen
bezwaar tegen een overname. Het ontbreken van een tweede persoon en van een
antwoord op de eigendomsvraag is dat wel, tot ze zijn opgelost.
