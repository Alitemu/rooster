# Auditrapport: Dienstrooster 1.4.0

Software due diligence en production readiness review.

| | |
|---|---|
| Datum | 10-11-2026 |
| Versie | 1.4.0, commit `6493fce` |
| Referentiekader | `.claude/AUDIT_PLAYBOOK.md` |
| Bijbehorende documenten | `TECHNICAL_DEBT.md`, `IMPROVEMENT_ROADMAP.md` en `SECURITY_FINDINGS.md` (niet in de repository) |
| Wijzigingen aan code | Geen. Alleen de auditdocumenten zijn toegevoegd |

## 1. Executive summary

**Totaaloordeel: geschikt voor het huidige gebruik, onder voorwaarden. Voor
een koper is het geen product maar een goed gebouwd maatwerksysteem met één
persoon en één AI-werkwijze erachter. Totaalscore: 6,2 van 10.**

De code is zorgvuldiger dan de organisatie eromheen. De domeinregels zijn
streng getest, de beveiligingsbasis is goed en de documentatie is uitgebreid.
Daartegenover staat dat niets automatisch bewaakt wordt: geen controle bij
een wijziging, geen alarm bij uitval, geen bewaking van afhankelijkheden. De
kwaliteit hangt aan de discipline van één persoon die een lange handmatige
controlelijst afwerkt.

| Domein | Score | Kern |
|---|---|---|
| Architectuur | 6 | Passend bij de schaal. Het schema bestaat op drie plekken en productie gebruikt niet de migraties |
| Security | 7 | Sterke basis, geen High. Zwak in het ontwerp eromheen: één mailbox als sleutel, geen tweede factor |
| Codekwaliteit | 6 | Consistent en goed toegelicht. Zwakke typen op de databasegrens, zeer grote bestanden, veel gekopieerde code |
| Performance | 7 | Ruim voldoende voor 60 gebruikers. Synchrone database en lange solveraanroepen begrenzen groei |
| DevOps | 5 | Herhaalbare build en een doordachte back-up. Geen CI bij wijzigingen, geen monitoring |
| Testbaarheid | 7 | 4322 tests en ongeveer 970 mutaties. De zwaarste controles draaien alleen met de hand |
| Onderhoudbaarheid | 5 | Busfactor 1, alle zichtbare commits door een AI-assistent geschreven, 13 ongebruikte packages |
| Documentatie | 7 | 4700 regels, actueel. Geen privacydocument, geen licentie, geen draaiboek voor storingen |

**Voorwaarden voor verder gebruik in productie:**

1. Automatische controle bij elke wijziging en een alarm bij uitval (OPS-01, OPS-02).
2. De startprocedure mag niet doorgaan na een mislukte schema-update (OPS-03).
3. Een tweede factor of gelijkwaardige maatregel voor beheerders en de mailbox aantoonbaar beveiligd (SEC-02, SEC-03).
4. Een privacydocument met bewaartermijnen (SEC-11).

**De drie grootste risico's voor een koper of eigenaar:**

1. **Afhankelijkheid van één persoon en één werkwijze (MAINT-01).** Alle 51 zichtbare commits komen van één auteur en dragen de handtekening van een AI-sessie. De kennis zit in `CLAUDE.md`, de tests en `docs/development`. Dat is beter dan kennis in een hoofd, maar er is geen tweede mens die het systeem kent.
2. **Niets bewaakt het systeem (OPS-01, OPS-02, SEC-09).** Een fout in een wijziging, een uitgevallen container of een nieuw bekende kwetsbaarheid wordt alleen gezien als iemand kijkt.
3. **Onduidelijke juridische status (DOC-03).** Een openbare repository zonder licentiebestand, met de tekst "alleen voor intern gebruik". De rechten op door AI geschreven code en de verhouding tot de werkgever van de maker zijn niet vastgelegd.

**De drie grootste sterke punten:**

1. **Tests die regels bewijzen.** 270 testbestanden, 52.800 regels testcode op 76.200 regels broncode, een echte SQLite in plaats van mocks en een mutatiecontrole die elke bewaakte regel met opzet breekt.
2. **Beveiliging in de structuur.** Sweeptests laten de build falen als een nieuwe route de toegangscontrole, de wijzigingsgeschiedenis of de invoercontrole vergeet. Geen injectie gevonden.
3. **Doordacht beheer voor een kleine installatie.** Eén composebestand, versleutelde back-up buiten de server, terugzetten in de app met een veiligheidskopie en een waarschuwing aan de beheerder als de back-up niet uitgaat.

## 2. Scope, methode en beperkingen

**Onderzocht:** de volledige repository op commit `6493fce`: de Next.js-app
(`app`, `components`, `lib`, `db`), de twee Python-solvers, de scripts, de
containerconfiguratie, de workflows en de documentatie.

**Gemeten (commando's gedraaid op 10-11-2026):**

| Meting | Uitkomst |
|---|---|
| `npx tsc --noEmit -p .` | Geslaagd, geen fouten |
| `npx eslint .` | Geslaagd, geen fouten of waarschuwingen |
| `npx vitest run` | 270 bestanden, 4322 tests geslaagd, 2 overgeslagen, 287 seconden |
| `npm audit --omit=dev` | 0 kwetsbaarheden |
| `npm audit` | 8 moderate, alle in ontwikkelafhankelijkheden |
| `npm outdated` | 16 packages achter, waarvan 9 een hele hoofdversie of meer |
| Zoeken naar imports per package | 13 van 25 productieafhankelijkheden worden nergens geïmporteerd |

**Niet gedaan en dus niet beoordeeld op meting:**

- De solvertests (`pytest`) konden niet draaien: OR-Tools 9.8 heeft geen
  installatiepakket voor Python 3.13, de versie in de auditomgeving. Dat is
  zelf een bevinding (DEP-02).
- De browsertests (Playwright), `full-check`, `ui-check`, `scenario-check` en
  de mutatiecontrole zijn niet gedraaid. Ze vragen een draaiende app met
  beide solvers. Ze zijn op code beoordeeld.
- De Caddy-controle in `deployConfig.test.ts` slaat zichzelf over zonder een
  Caddy op het pad. Dat was hier zo.
- Geen belastingtest, geen penetratietest, geen dekkingsmeting (het pakket
  daarvoor ontbreekt, TEST-01).
- De productieomgeving, de `.env`, de Gmail-instellingen en de Power
  Automate-stromen zijn niet gezien.
- De kloon is ondiep: 51 commits vanaf 30-10-2026. Uitspraken over de
  geschiedenis gelden voor die 51.

**Context waartegen beoordeeld is:** een intern netwerk van een
zorginstelling, één server (een NAS), 20 tot 60 deelnemers per rooster, een
handvol planners en beheerders. Waar een score bij een grotere schaal anders
zou zijn, staat dat erbij.

## 3. Feitenblad

| | |
|---|---|
| Doel | Dienstroosters maken voor twee groepen (achterwacht en AIOS), met voorkeuren, een solver, publicatie en ruilen |
| Stack | Next.js 16.4.3, React 19, TypeScript 5.9 strict, SQLite via better-sqlite3 9.6, twee Python 3.11-diensten met FastAPI en OR-Tools 9.8, Caddy 2, Docker Compose |
| Omvang broncode | 76.231 regels TypeScript buiten de tests, 8.878 regels Python, 12.349 regels scripts |
| Omvang tests | 52.784 regels in 270 unit- en integratiebestanden en 40 browsertests, 13 Python-testbestanden |
| Routes en pagina's | 173 API-routes, 13 pagina's, 75 clientcomponenten |
| Database | 41 tabellen, 48 migraties, 33 indexen |
| Grootste bestanden | `scripts/mutation-check.mjs` 7195, `scripts/seed.ts` 1761, `components/SetupWizard.tsx` 1749, `components/PlannerDashboard.tsx` 1639, `components/RosterGenerationDialog.tsx` 1340, `app/api/planner/period/[id]/generate-roster/route.ts` 1053 |
| Releases | 75 versietags van v0.71.0 tot v1.4.0. In de zichtbare 11 dagen: 51 commits en 19 versienummers, waarvan er twee niet zijn gebouwd |
| Auteurs | 1 in de zichtbare geschiedenis. Alle 51 commits dragen een `Claude-Session`-regel |
| Uitrol | Handmatig: "Bouwen (test)" en "Vrijgeven (productie)" op GitHub, daarna `docker compose pull` op de server |

## 4. Scorekaart

Gewichten volgens het playbook, hoofdstuk 12.

| Domein | Gewicht | Score | Bepalende bevindingen |
|---|---|---|---|
| Architectuur | 15% | 6 | ARCH-01 (High), ARCH-02, ARCH-03 |
| Security | 20% | 7 | SEC-01, SEC-02, SEC-03, SEC-09, SEC-11 (alle Medium) |
| Codekwaliteit | 10% | 6 | CODE-01, CODE-02, ARCH-04 |
| Performance | 10% | 7 | PERF-01, PERF-02 |
| DevOps | 15% | 5 | OPS-01 (High), OPS-02 (High), OPS-03 |
| Testbaarheid | 10% | 7 | TEST-01, TEST-02, OPS-01 |
| Onderhoudbaarheid | 15% | 5 | MAINT-01 (High), ARCH-03, DEP-01 |
| Documentatie | 5% | 7 | DOC-03 (High), DOC-01, DOC-02 |
| **Totaal** | 100% | **6,2** | |

Aantal bevindingen per klasse (64 in totaal, alle domeinen, security inbegrepen,
verwijzingen naar een andere bevinding niet dubbel geteld):

| Critical | High | Medium | Low | Informational |
|---|---|---|---|---|
| 0 | 5 | 26 | 29 | 4 |

Bij een schaal van honderden gelijktijdige gebruikers of meerdere
instellingen op één installatie zouden Architectuur en Performance op 4
uitkomen: het ontwerp gaat uit van één proces en één bestand als database.

## 5. Architectuur

**Beeld.** Een Next.js-monoliet met route handlers die rechtstreeks SQL
uitvoeren op een SQLite-bestand, twee losse rekendiensten in Python en een
Caddy ervoor. Geen servicelaag, geen ORM in gebruik, geen wachtrij. Voor het
probleem en de schaal is dat een verdedigbare, zelfs verstandige keuze: weinig
bewegende delen, één bestand om te bewaren. De zwakte zit in de manier waarop
het schema wordt beheerd en in de bewuste verdubbeling van code.

### ARCH-01: het databaseschema bestaat op drie plekken en productie gebruikt niet de migraties

| Veld | Inhoud |
|---|---|
| Beschrijving | Het schema staat in `db/schema.ts` (Drizzle), in 48 migraties en als handgeschreven SQL in `scripts/seed.ts` met een lijst `LATER_COLUMNS` voor latere kolommen. Productie start bij elke start met `seed.ts --alleen-planner` en bouwt en wijzigt het schema dus via het seedscript. De migraties draaien alleen op databases die uit de migraties komen. `db/schema.ts` wordt door geen enkel bestand in `app` of `lib` geïmporteerd. Er is geen `drizzle-kit` en geen Drizzle-configuratie: de migraties zijn met de hand geschreven |
| Impact | Elke schemawijziging moet op drie plekken gelijk gebeuren. Een vergeten plek geeft een installatie die op een ander schema draait dan de tests. Het project documenteert dat dit meermaals een dag kostte. De typen bij elke query zijn met de hand geschreven en worden niet uit het schema afgeleid, dus een hernoemde kolom wordt niet door de compiler gevangen |
| Risico | **High.** Waarschijnlijkheid: waarschijnlijk (elke schemawijziging). Impact: midden (verkeerd schema in productie, dataverlies bij een fout in een `ALTER`). Verzacht door twee controlescripts, die alleen met de hand draaien |
| Bewijs | 133 bestanden gebruiken `db.prepare`, 2 importeren `drizzle-orm` (`db/client.ts` voor de migrator). Zoeken naar een import van `db/schema` buiten commentaar geeft niets. De stacktabel noemt Drizzle als ORM |
| Bestandslocatie | `db/schema.ts` (1054 regels), `db/migrations/` (48 bestanden), `scripts/seed.ts:730` (`LATER_COLUMNS`) en `793` (`LATER_COLUMN_BACKFILL`), `docker-entrypoint.sh:30`, `scripts/schema-drift.mjs`, `scripts/upgrade-drift.mjs` |
| Aanbevolen oplossing | Kies één bron. De goedkoopste weg: laat productie de migraties draaien (de code daarvoor staat al in `db/client.ts`) en beperk het seedscript tot data. Zet voor bestaande databases eenmalig het migratieregister. Verwijder daarna `LATER_COLUMNS`. Zet tot die tijd beide driftcontroles in de pipeline. Leid daarna de rijtypen af uit `db/schema.ts`. Inspanning: L |
| Prioriteit | P1 (driftcontroles in CI), P2 (één bron) |

### ARCH-02: het ontwerp gaat uit van één proces en dat staat nergens als eis

| Veld | Inhoud |
|---|---|
| Beschrijving | Lopende roostergeneraties van de achterwacht, de tellers tegen raden, de vergrendeling tegen dubbele verzending en de wachtrij voor ruilmails in uitvoering staan in het geheugen van het webproces. De geplande taken (herinneringen, back-up, wachtrijen) draaien op een `setInterval` in datzelfde proces |
| Impact | Een herstart tijdens een generatie van 5 tot 30 minuten gooit de uitkomst weg zonder melding. Een tweede instantie van de app zou dubbele herinneringen sturen en tellers en vergrendelingen niet delen. Horizontaal schalen kan niet |
| Risico | **Medium.** Bij de huidige schaal treedt alleen het verlies bij een herstart op |
| Bewijs | De `Map` op `globalThis`, de `Map` in de rate limiter, de timers in de instrumentatie. De AIOS-generatie heeft wel een eigen tabel (`aios_generatie`) |
| Bestandslocatie | `lib/rosterGenerationJobs.ts:110-113`, `lib/rateLimit.ts:27`, `lib/inFlight.ts:16`, `lib/aiosInFlight.ts:15`, `instrumentation-node.ts:280-281` |
| Aanbevolen oplossing | Leg de eis "precies één webproces" vast in de documentatie en in compose. Bewaar de staat van een achterwachtgeneratie in de database zoals de AIOS dat doet, zodat een herstart een nette melding geeft. Inspanning: M |
| Prioriteit | P2 |

### ARCH-03: verdubbeling als beleid, met regels op drie plekken

| Veld | Inhoud |
|---|---|
| Beschrijving | De regel van de eigenaar is dat code van de achterwacht niet wordt aangepast voor de AIOS: wat de AIOS nodig heeft, wordt gekopieerd. Het resultaat is 67 `lib/aios*`-bestanden, 24 `Aios*`-componenten en 54 eigen routes naast de originelen. De harde regels van de AIOS staan daarnaast in de solver, in zijn controle en in de app |
| Impact | Een fout in gekopieerde logica moet twee keer gevonden en hersteld worden. Niets dwingt af dat een herstel in het origineel ook in de kopie komt. Bij de harde regels bewaakt een gedeelde fixture de drie plekken, bij de overige kopieën niets |
| Risico | **Medium.** De keuze beschermt de dienst die in productie is en is vastgelegd. De prijs loopt op met elke wijziging |
| Bewijs | De tellingen hierboven. `docs/development/diensten.md`, "Copied, not changed". `tests/fixtures/aios-regels.json` |
| Bestandslocatie | `lib/aios*.ts`, `components/Aios*.tsx`, `app/api/aios/`, `aios-solver/model.py`, `aios-solver/controle.py`, `lib/aiosRegels.ts` |
| Aanbevolen oplossing | Houd de scheiding in routes en schermen, maar haal bewezen gelijke hulpcode (mailwachtrij, vergrendeling, linkuitgifte, herinneringen) naar een gedeelde, geteste kern. Begin met een lijst van kopieën en hun verschillen. Inspanning: L |
| Prioriteit | P3 |

### ARCH-04: domeinlogica in routes en zeer grote componenten

| Veld | Inhoud |
|---|---|
| Beschrijving | De route die het rooster genereert, is 1053 regels met een functie `runGeneration` van ruim 540 regels waarin toegang, validatie, het lezen van data, het opbouwen van de solverinvoer, het wegschrijven en de foutafhandeling samenkomen. Drie componenten zijn groter dan 1300 regels. `lib/` is één platte map met 308 bestanden |
| Impact | De kern van het product is het moeilijkst te lezen en te testen los van HTTP. Een nieuwe ontwikkelaar vindt geen modulegrenzen |
| Risico | **Medium** |
| Bewijs | Regeltellingen. De functie loopt van regel 342 tot 884 |
| Bestandslocatie | `app/api/planner/period/[id]/generate-roster/route.ts:99`, `342`, `884`, `961`. `components/SetupWizard.tsx`, `components/PlannerDashboard.tsx`, `components/RosterGenerationDialog.tsx` |
| Aanbevolen oplossing | Verplaats het opbouwen van de solverinvoer en het verwerken van de uitvoer naar `lib/` als pure functies met eigen tests. Deel `lib/` in mappen per domein. Inspanning: L |
| Prioriteit | P3 |

### ARCH-05: het seedscript doet vier dingen en draait bij elke start in productie

| Veld | Inhoud |
|---|---|
| Beschrijving | `scripts/seed.ts` bouwt het schema, werkt een bestaand schema bij, maakt accounts aan en vult demodata. Het draait in de productiecontainer bij elke start, als TypeScript via `tsx`. Daarom staan `tsx` en `typescript` bij de productieafhankelijkheden |
| Impact | Het bestand met de meeste verantwoordelijkheid voor productiedata is ook het bestand met voorbeelddata. Een fout in het demodeel kan het schemadeel raken |
| Risico | **Medium** |
| Bewijs | 1761 regels, vier vlaggen (`--alleen-planner`, `--schema-only`, `--reset`, zonder vlag) |
| Bestandslocatie | `scripts/seed.ts`, `docker-entrypoint.sh:25-40`, `package.json` (`tsx`, `typescript` onder `dependencies`) |
| Aanbevolen oplossing | Splits in een schemadeel dat in productie draait en een demodeel dat alleen in ontwikkeling bestaat. Volgt vanzelf uit ARCH-01. Inspanning: M |
| Prioriteit | P2 |

### ARCH-06: SQLite op één server (Informational)

Eén bestand als database op één machine is voor 60 gebruikers een goede
keuze: geen databaseserver te beheren, een back-up is een kopie. Het sluit
hoge beschikbaarheid en horizontale groei uit. Dat is geen gebrek zolang het
een vastgelegde keuze is. Leg hem vast (zie DOC-02).

## 6. Security

De zestien bevindingen staan in volledige vorm in `SECURITY_FINDINGS.md`. Dat
bestand staat bewust niet in de repository: de eigenaar bewaart het apart.

| Nr | Bevinding | Klasse | Prioriteit |
|---|---|---|---|
| SEC-01 | "Link kwijt?" maakt zonder inloggen geldige links voor iedereen | Medium | P1 |
| SEC-02 | Beheerders loggen in met alleen een wachtwoord | Medium | P1 |
| SEC-03 | Eén mailbox is de sleutel tot alle accounts | Medium | P1 |
| SEC-04 | Het beheerdersaccount begint met een openbaar wachtwoord | Medium | P1 |
| SEC-09 | Geen controle op de toeleveringsketen | Medium | P1 |
| SEC-11 | Privacy en bewaartermijnen zijn nergens vastgelegd | Medium | P1 |
| SEC-05 | Gedeelde tellers maken uitsluiten van anderen mogelijk | Low | P2 |
| SEC-12 | Mislukte inlogpogingen worden niet gelogd | Low | P2 |
| SEC-06, 07, 08, 10, 13, 14 | CSP, statusroute, één geheim, container, Host-header, linksessie | Low | P3 |
| SEC-15, 16 | Solvers zonder authenticatie, kwetsbaarheden in ontwikkelpakketten | Informational | P4 |

## 7. Codekwaliteit

**Beeld.** De code is consistent, strikt getypeerd waar het de compiler
betreft en uitzonderlijk goed toegelicht: het commentaar legt het waarom uit
en verwijst naar de versie waarin iets misging. Geen `@ts-ignore`, geen
`eslint-disable`, één TODO in de hele codebase. De zwakte zit op de grens met
de database en in de omvang van enkele bestanden.

### CODE-01: rijen uit de database zijn met de hand getypeerd of `any`

| Veld | Inhoud |
|---|---|
| Beschrijving | 79 keer `any` in de broncode, waarvan 67 in route handlers, vrijwel altijd op het resultaat van een query. Waar wel een type staat, is het een handgeschreven `as { ... }` bij de query |
| Impact | Een kolom die hernoemd of verwijderd wordt, geeft geen compilerfout maar `undefined` tijdens het draaien. De strikte modus beschermt niet waar de data binnenkomt |
| Risico | **Medium** |
| Bewijs | `const link = linkStmt.get(tokenHash) as any` in de route die een link controleert, `as any[]` op lijsten |
| Bestandslocatie | `app/api/auth/verify-link/route.ts` (resultaat van `linkStmt.get`), `app/api/planner/period/[id]/assignments/route.ts:105` en `123`, `app/api/person/[id]/swap-requests/route.ts:86` |
| Aanbevolen oplossing | Rijtypen afleiden uit `db/schema.ts` (`InferSelectModel`) en een lintregel tegen `any` in `app/api`. Hangt samen met ARCH-01. Inspanning: M |
| Prioriteit | P2 |

### CODE-02: twee React-lintregels staan uit

| Veld | Inhoud |
|---|---|
| Beschrijving | `react-hooks/exhaustive-deps` en `react-hooks/set-state-in-effect` zijn uitgeschakeld voor de hele codebase, zonder toelichting |
| Impact | Verouderde waarden in effecten en onnodige renders worden niet gemeld. Met 75 clientcomponenten en 235 `fetch`-aanroepen is dat de plek waar zulke fouten ontstaan |
| Risico | **Medium** |
| Bewijs | De regels in de lintconfiguratie |
| Bestandslocatie | `eslint.config.mjs:10-11` |
| Aanbevolen oplossing | Zet `exhaustive-deps` op waarschuwing, loop de meldingen na en zet hem daarna op fout. Inspanning: M |
| Prioriteit | P3 |

### CODE-03: geen componenttests en geen gedeelde datalaag in de client

| Veld | Inhoud |
|---|---|
| Beschrijving | 22.600 regels React worden alleen geraakt door browsertests die niet in de pipeline draaien. De twaalf tests onder `components/` lezen de broncode als tekst. Elke component doet zijn eigen `fetch` met eigen foutafhandeling |
| Impact | Gedrag van schermen is alleen met een draaiende app te controleren. Laad- en foutgedrag verschilt per component |
| Risico | **Medium** |
| Bewijs | 0 bestanden `*.test.tsx`. Testomgeving `node`. 235 `fetch`-aanroepen in `app` en `components` |
| Bestandslocatie | `vitest.config.ts` (`environment: 'node'`), `components/wizardLabels.test.ts` als voorbeeld |
| Aanbevolen oplossing | Een kleine `apiFetch`-hulpfunctie met vaste foutafhandeling en rendertests voor de vijf grootste componenten. Inspanning: M tot L |
| Prioriteit | P3 |

### CODE-04: dode code en resten

| Veld | Inhoud |
|---|---|
| Beschrijving | Een tabel die niet meer gebruikt wordt (`holiday_history`), drie pooltypen in een CHECK-constraint die geen code kent (`NEURO`, `KINDER`, `INTERVENTIE`), een uitgeschakeld meldingspad (`NOTIFICATIONS_ENABLED`), een pad-alias naar een map die niet bestaat (`@/server/*`) en een optimalisatie voor een pakket dat niet geïmporteerd wordt (`@radix-ui`) |
| Impact | Ruis voor wie de code leest. Geen functioneel risico |
| Risico | **Low** |
| Bewijs | Zoekopdrachten zonder treffers buiten de definitie |
| Bestandslocatie | `db/schema.ts:362`, `scripts/seed.ts:137`, `lib/notifications.ts:79`, `tsconfig.json:38-39`, `next.config.js:44` |
| Aanbevolen oplossing | Opruimen in één onderhoudsrelease. Inspanning: S |
| Prioriteit | P3 |

### CODE-05: invoercontrole is met de hand geschreven

| Veld | Inhoud |
|---|---|
| Beschrijving | `zod` staat in de afhankelijkheden en in de werkwijze ("validation via Zod"), maar wordt in 8 van de 173 routes gebruikt. De rest controleert velden met eigen hulpfuncties |
| Impact | Meer code per route en meer kans op een vergeten veld. Een sweeptest vangt de ergste gevallen (geen 500 op vreemde invoer) |
| Risico | **Low** |
| Bewijs | Telling van imports |
| Bestandslocatie | `lib/requestFields.ts`, `app/api/routeInput.test.ts` |
| Aanbevolen oplossing | Nieuwe routes met een schema, bestaande bij wijziging. Inspanning: doorlopend |
| Prioriteit | P4 |

### CODE-06: logging is ongestructureerd

| Veld | Inhoud |
|---|---|
| Beschrijving | 60 aanroepen van `console.*`, vrije tekst, geen niveaus buiten `warn` en `error`, geen verzoek-id. Wel een foutcode per interne fout |
| Impact | Zoeken in logs is `grep`. Voldoende voor één server, onvoldoende voor analyse achteraf |
| Risico | **Low** |
| Bewijs | Telling. `internalErrorResponse` |
| Bestandslocatie | `lib/api-errors.ts` |
| Aanbevolen oplossing | Eén logfunctie met JSON-uitvoer en vaste velden. Inspanning: S |
| Prioriteit | P3 |

### CODE-07: kolomnamen dynamisch in een UPDATE

| Veld | Inhoud |
|---|---|
| Beschrijving | Op vier plekken wordt een `UPDATE` opgebouwd uit `Object.keys` van een object. De sleutels komen nu uit vaste toewijzingen en niet uit de invoer, dus er is geen injectie |
| Impact | Eén onbedachte wijziging (het object vullen met de body) maakt er een injectie van |
| Risico | **Low** |
| Bewijs | De lijst `SET kolom = ?` wordt gemaakt uit `Object.keys(updates)` |
| Bestandslocatie | `app/api/person/[id]/absences/[absenceId]/route.ts:131`, `app/api/person/[id]/parttime-patterns/[patternId]/route.ts:160`, `lib/aiosDeeltijd.ts:191` en `312` |
| Aanbevolen oplossing | Een vaste lijst van toegestane kolommen waar de sleutels tegen gecontroleerd worden. Inspanning: S |
| Prioriteit | P3 |

## 8. Performance

**Beeld.** Niet gemeten onder belasting. Op code beoordeeld is er voor de
beoogde schaal ruim marge. De grenzen liggen bij de synchrone database en bij
de solvers.

### PERF-01: de database blokkeert de hele server, ook tijdens wachten op een slot

| Veld | Inhoud |
|---|---|
| Beschrijving | `better-sqlite3` is synchroon: elke query houdt de enige thread van Node vast. Bij een vergrendelde database wacht de code met `Atomics.wait`, wat de thread tot 750 milliseconden per reeks pogingen stillegt, bovenop de time-out van 5 seconden in SQLite zelf |
| Impact | Tijdens een lange schrijfactie (een import, het wegschrijven van een rooster, de dagelijkse kopie) wachten alle andere verzoeken. Bij 60 gebruikers is dat een hapering, bij meer een knelpunt |
| Risico | **Medium** bij groei, Low nu |
| Bewijs | De constructor met `timeout: 5000` en de wachtlus |
| Bestandslocatie | `db/client.ts:44`, `51-63` |
| Aanbevolen oplossing | Geen actie bij de huidige schaal. Bij groei: zware schrijfacties in kleinere transacties of een werkthread voor imports en exports. Inspanning: M |
| Prioriteit | P4 |

### PERF-02: de solver wordt aangeroepen binnen één lang HTTP-verzoek

| Veld | Inhoud |
|---|---|
| Beschrijving | Een generatie is één verzoek van de app naar de solver dat tot 30 minuten (achterwacht) of 60 minuten (AIOS) openstaat. Elke solver doet één rooster tegelijk en mag 2 GB gebruiken |
| Impact | Twee planners die tegelijk genereren, wachten op elkaar. Een onderbroken verbinding betekent opnieuw beginnen. Een model dat buiten het geheugen groeit, doodt de container |
| Risico | **Medium** |
| Bewijs | De eigen HTTP-client die de time-out van 300 seconden van `fetch` omzeilt. De grenzen van de solvers |
| Bestandslocatie | `lib/solverClient.ts:38-110`, `solver/main.py:356`, `aios-solver/main.py:172`, `docker-compose.yml` (`mem_limit`) |
| Aanbevolen oplossing | Een taakmodel: de solver neemt een opdracht aan, geeft een id terug en bewaart de uitkomst tot hij is opgehaald. Inspanning: M tot L |
| Prioriteit | P3 |

### PERF-03: versleutelen en comprimeren van de back-up gebeurt synchroon

| Veld | Inhoud |
|---|---|
| Beschrijving | De nachtelijke back-up leest de hele database in het geheugen, comprimeert met `gzipSync` en leidt de sleutel af met `scryptSync` |
| Impact | De server staat stil voor de duur daarvan en het geheugen groeit met een veelvoud van de databasegrootte, binnen een grens van 1 GB voor de container. Bij een database van enkele megabytes onmerkbaar |
| Risico | **Low** |
| Bewijs | De synchrone aanroepen |
| Bestandslocatie | `lib/dbBackupBestand.ts:60` en `80` |
| Aanbevolen oplossing | Stromen in plaats van buffers zodra de database boven enkele tientallen megabytes komt. Inspanning: S |
| Prioriteit | P4 |

### PERF-04: query's in een lus

| Veld | Inhoud |
|---|---|
| Beschrijving | Op zes plekken wordt binnen een lus een statement voorbereid of uitgevoerd per element |
| Impact | Verwaarloosbaar bij tientallen rijen |
| Risico | **Low** |
| Bewijs | Zoekopdracht naar `prepare` binnen `for ... of` |
| Bestandslocatie | `app/api/planner/period/[id]/ledger-corrections/route.ts:188`, `lib/aiosDeeltijd.ts:53`, `lib/aiosHandmatig.ts:327`, `lib/aiosRuilMail.ts:219`, `lib/aiosRuilen.ts:827`, `lib/meldingMail.ts:344` |
| Aanbevolen oplossing | Statement buiten de lus voorbereiden. Inspanning: S |
| Prioriteit | P4 |

### PERF-05: geen caching en geen belastingtest (Informational)

Er is geen cache en bij deze schaal is die niet nodig. Er is ook geen
belastingtest. Voordat het aantal gebruikers of roosters wezenlijk groeit, is
een eenvoudige meting met het aantal verwachte gelijktijdige deelnemers rond
een deadline de moeite waard.

## 9. Database

**Beeld.** Het datamodel is degelijk: vreemde sleutels staan aan, WAL-modus,
unieke indexen dwingen de domeinregels af, optimistic locking met
`row_version` op de tabellen waar het telt, een saldo als som van regels in
plaats van een opgeslagen waarde. De zwakte is het beheer van het schema
(ARCH-01).

| Nr | Bevinding | Klasse | Bewijs en locatie | Aanbeveling | Prioriteit |
|---|---|---|---|---|---|
| DB-01 | Migraties: zie ARCH-01 | High | `scripts/seed.ts:730`, `db/migrations/` | Eén bron voor het schema | P1, P2 |
| DB-02 | Geen bewaartermijn voor de wijzigingsgeschiedenis, het meldingenlog en de toegangslinks. De tabellen groeien onbegrensd | Low | Geen `DELETE` buiten `lib/periodTrash.ts:148-162` | Periodiek opruimen met een instelbare termijn. Hangt samen met SEC-11. Inspanning: S | P2 |
| DB-03 | Enkele vreemde sleutels hebben geen index, onder andere `absence.person_id` en `ledger_entry.geldt_voor_periode_id` | Low | De 33 `CREATE INDEX`-regels in `scripts/seed.ts` | Toevoegen bij de volgende schemawijziging. Bij deze omvang geen meetbaar effect. Inspanning: S | P4 |
| DB-04 | Relationele gegevens in JSON-kolommen: het bevroren ruleset en het voorlopige rooster | Low | `db/schema.ts:200` (`voorlopig_rooster_json`), `bevroren_ruleset_json` | Aanvaardbaar als momentopname. Leg de vorm vast met een schema bij het lezen. Inspanning: S | P4 |
| DB-05 | Datums als tekst zonder CHECK in de database. De controle zit in de routes | Low | `db/schema.ts`, `lib/requestFields.ts` | Een CHECK op het patroon voor de kernkolommen. Inspanning: S | P4 |
| DB-06 | Vreemde sleutels staan uit tijdens het migreren en gaan daarna weer aan, zonder controle op wezen | Low | `db/client.ts:80` en `173` | `PRAGMA foreign_key_check` na het migreren en een fout als die iets vindt. Inspanning: S | P3 |

## 10. DevOps

**Beeld.** De build is herhaalbaar en zorgvuldig: elke versie wordt één keer
gebouwd, productie krijgt precies de image die getest is, de workflows hebben
minimale rechten en gepinde actions. De back-up is doordacht. Wat ontbreekt
is alles wat automatisch waakt.

### OPS-01: er draait niets automatisch bij een wijziging

| Veld | Inhoud |
|---|---|
| Beschrijving | Beide workflows starten alleen met de hand. Bij een push of pull request draait er geen typecheck, geen lint en geen test. De tests draaien pas als iemand "Bouwen (test)" start. De browsertests, `full-check`, `ui-check`, `scenario-check`, de mutatiecontrole, de twee driftcontroles en `npm audit` draaien nooit in de pipeline: alleen op de machine van de ontwikkelaar, volgens een lijst in `CLAUDE.md` |
| Impact | De releasepoort is een afspraak, geen mechanisme. Een overgeslagen stap wordt door niets opgemerkt. De volledige controle duurt ruim een halfuur per variant en is afhankelijk van de lokale opstelling. Het project documenteert zelf twee builds die faalden op iets wat lokaal slaagde |
| Risico | **High.** Waarschijnlijkheid: waarschijnlijk bij 17 versies in 11 dagen. Impact: midden |
| Bewijs | `on: workflow_dispatch` als enige trigger in beide workflows. Geen stap met `playwright`, `mutation`, `schema-drift` of `npm audit` |
| Bestandslocatie | `.github/workflows/images.yml:32-33` en de jobs `test-app`, `test-solver`, `test-aios-solver`. `CLAUDE.md`, sectie Testing |
| Aanbevolen oplossing | Een workflow op `push` en `pull_request` met typecheck, lint, vitest, beide pytest-suites, `npm audit --omit=dev` en de twee driftcontroles. Een tweede, nachtelijke workflow met de browsertests tegen een compose-opstelling. Inspanning: M |
| Prioriteit | P0 |

### OPS-02: geen monitoring en geen alarm

| Veld | Inhoud |
|---|---|
| Beschrijving | Er is een healthcheck per container, maar Docker herstart een container die "unhealthy" is niet uit zichzelf en niemand krijgt een melding. De health-route van de app geeft altijd `ok` zonder de database te raadplegen. Er zijn geen metrics. De enige actieve waarschuwing is die aan de beheerder in de app als de back-up niet uitgaat |
| Impact | Een vastgelopen app, een volle schijf, een solver zonder geheugen of een gestopte herinneringstaak wordt gemeld door een deelnemer, mogelijk dagen later. Voor een rooster met deadlines is dat het verschil tussen een hapering en een gemiste deadline |
| Risico | **High.** Waarschijnlijkheid: mogelijk. Impact: hoog |
| Bewijs | De health-route van vier regels. `restart: unless-stopped` zonder een dienst die op de healthstatus reageert |
| Bestandslocatie | `app/health/route.ts`, `Dockerfile:81-82`, `docker-compose.yml` (`restart`, `healthcheck`) |
| Aanbevolen oplossing | Laat de health-route een query doen en de leeftijd van de laatste geplande taak melden. Een externe controle (bijvoorbeeld de bewaking van de NAS of een eenvoudige uptime-dienst op het interne netwerk) die bij uitval mailt. Een dagelijkse mail "alles in orde" via het bestaande mailpad is de goedkoopste variant. Inspanning: S tot M |
| Prioriteit | P0 |

### OPS-03: de app start door na een mislukte schema-update

| Veld | Inhoud |
|---|---|
| Beschrijving | Het startscript vangt een fout van het seedscript af met een melding en start de app toch. Dat geldt voor alle drie de paden, ook het pad dat alleen het schema bijwerkt |
| Impact | Na een update met een nieuwe kolom en een mislukte `ALTER` draait nieuwe code op een oud schema. Het gevolg zijn foutmeldingen op willekeurige schermen in plaats van een container die duidelijk niet start |
| Risico | **Medium.** Waarschijnlijkheid: onwaarschijnlijk. Impact: hoog |
| Bewijs | Elk seedcommando wordt gevolgd door een `echo` met "continuing startup" in plaats van een exitcode |
| Bestandslocatie | `docker-entrypoint.sh:30`, `33`, `39` |
| Aanbevolen oplossing | Scheid "al geseed" (geen fout) van "schema bijwerken mislukt" (wel een fout) met een eigen exitcode en stop bij het tweede. Inspanning: S |
| Prioriteit | P1 |

### OPS-04: productie volgt een verplaatsbare tag en terug naar een oudere versie is niet getest

| Veld | Inhoud |
|---|---|
| Beschrijving | De server haalt `stable`. Welke versie draait, hangt af van wanneer er voor het laatst `pull` is gedaan. Teruggaan gebeurt door `stable` op een oudere versie te zetten, terwijl de database al is bijgewerkt door de nieuwere. `upgrade-drift` test omhoog, niets test omlaag |
| Impact | Een terugval na een slechte release kan vastlopen op een schema dat de oude code niet kent. De enige zekere weg terug is dan een back-up terugzetten, met verlies van wat sindsdien is ingevuld |
| Risico | **Medium** |
| Bewijs | De standaardwaarde van `ROOSTER_VERSION`. De README beschrijft teruggaan zonder voorbehoud over het schema |
| Bestandslocatie | `docker-compose.yml:142`, `249`, `281`. README, "Terug naar een eerdere versie" |
| Aanbevolen oplossing | Zet in productie een versienummer in `.env`. Leg vast dat schemawijzigingen alleen toevoegen en test één versie terug in `upgrade-drift`. Inspanning: M |
| Prioriteit | P2 |

### OPS-05: herstel na een ramp hangt aan een keten buiten de repository

| Veld | Inhoud |
|---|---|
| Beschrijving | Op de server staan 14 dagelijkse kopieën, op dezelfde schijf als de data. De kopie buiten de server gaat per mail naar een Gmail-account en wordt door een Power Automate-stroom in OneDrive gezet. Het sessiegeheim zit niet in de back-up. Het herstelpunt is maximaal 24 uur oud. Een hersteltijd is niet vastgelegd |
| Impact | Het herstel werkt als vier dingen werken: Gmail, de stroom, OneDrive en iemand die het back-upwachtwoord heeft. Geen daarvan is vanuit de repository te controleren. Het terugzetten in de app is wel getest (`tests/e2e/back-up.e2e.ts`) |
| Risico | **Medium** |
| Bewijs | README, hoofdstuk Productie, punt 3 en 4. `docs/back-up-power-automate.md` |
| Bestandslocatie | `lib/dbBackup.ts`, `lib/dbBackupMail.ts`, `docs/back-up-power-automate.md` |
| Aanbevolen oplossing | Een halfjaarlijkse hersteloefening op de testinstallatie met een back-up uit OneDrive, met datum vastgelegd. Leg herstelpunt en hersteltijd vast. Inspanning: S |
| Prioriteit | P1 |

### OPS-06 tot OPS-08

| Nr | Bevinding | Klasse | Bewijs en locatie | Aanbeveling | Prioriteit |
|---|---|---|---|---|---|
| OPS-06 | Logs blijven in de container, 30 MB per dienst. Een foutcode is alleen terug te vinden tot de rotatie | Low | `docker-compose.yml:3-7` | Logs naar de syslog van de NAS of ruimere rotatie. Inspanning: S | P3 |
| OPS-07 | Een build kan vanaf elke branch gestart worden en zet de versietag op die commit. Branchbeveiliging is vanuit de repository niet te zien | Low | `.github/workflows/images.yml` (job `tag`) | Weiger te bouwen buiten de hoofdbranch en zet branchbeveiliging aan. Inspanning: S | P2 |
| OPS-08 | De dienst `web` wacht niet tot de solvers gezond zijn en heeft zelf geen `healthcheck` in compose (wel in de image) | Low | `docker-compose.yml` (`depends_on`) | `depends_on` met `condition: service_healthy`. Inspanning: S | P4 |

Kubernetes: niet aanwezig en bij deze schaal niet nodig. Geen bevinding.

## 11. Testen

**Beeld.** Dit is het sterkste onderdeel van het project en tegelijk het
onderdeel dat het meest op vertrouwen draait. De suite is groot, snel genoeg
en test regels in plaats van voorbeelden. Maar de zwaarste lagen draaien
alleen als iemand ze start.

| Laag | Omvang | Draait automatisch? |
|---|---|---|
| Unit en integratie (Vitest, echte SQLite) | 270 bestanden, 4322 tests, 287 seconden | Alleen bij "Bouwen (test)" |
| Eigenschappen (fast-check) | In de unit-suite | Idem |
| Solvers (pytest) | 13 bestanden | Alleen bij "Bouwen (test)" |
| Browser (Playwright) | 40 bestanden | Nee |
| `full-check`, `ui-check`, `scenario-check` | 3 scripts, tot 35 minuten | Nee |
| Mutaties | Ongeveer 970 in `scripts/mutation-check.mjs` | Nee |
| Schema-drift en upgrade-drift | 2 scripts | Nee |

### TEST-01: dekking wordt niet gemeten

| Veld | Inhoud |
|---|---|
| Beschrijving | De Vitest-configuratie heeft een dekkingsblok met provider `v8`, maar het pakket `@vitest/coverage-v8` staat niet in `package.json`. Er is dus nooit een dekkingscijfer |
| Impact | Onbekend welke bestanden geen enkele test raken. De mutatiecontrole dekt alleen wat iemand als mutatie heeft opgeschreven |
| Risico | **Medium** |
| Bewijs | De configuratie en het ontbreken van het pakket |
| Bestandslocatie | `vitest.config.ts:41-51`, `package.json` |
| Aanbevolen oplossing | Het pakket toevoegen en het cijfer per map rapporteren in de pipeline, zonder harde grens in het begin. Inspanning: S |
| Prioriteit | P2 |

### TEST-02: tests die broncode als tekst lezen

| Veld | Inhoud |
|---|---|
| Beschrijving | Minstens 26 testbestanden lezen een bronbestand in en zoeken met een reguliere expressie naar een patroon, bijvoorbeeld of een `<label>` een `htmlFor` heeft |
| Impact | Zo'n test bewijst hoe de code geschreven is, niet wat hij doet. Een herschrijving met hetzelfde gedrag laat hem falen en een fout in gedrag laat hem slagen. Als sweep over alle routes is het patroon waardevol, als vervanging van een componenttest niet |
| Risico | **Medium** |
| Bewijs | Telling van `readFileSync` op bronbestanden in tests |
| Bestandslocatie | `components/wizardLabels.test.ts:11-23`, de overige elf tests in `components/` |
| Aanbevolen oplossing | Houd de sweeps. Vervang de brontests op componenten door rendertests (zie CODE-03). Inspanning: M |
| Prioriteit | P3 |

### TEST-03 tot TEST-05

| Nr | Bevinding | Klasse | Bewijs en locatie | Aanbeveling | Prioriteit |
|---|---|---|---|---|---|
| TEST-03 | De browsertests draaien met één worker, zonder herhaling, tegen een server die al moet draaien. Ze bouwen hun eigen fixtures, wat goed is | Low | `playwright.config.ts` | Een compose-opstelling voor de pipeline (zie OPS-01). Inspanning: M | P1 |
| TEST-04 | De mutatiecontrole is een handgeschreven bestand van 7195 regels dat de bron bewerkt terwijl hij draait. Elke nieuwe regel vraagt een handgeschreven mutatie | Low | `scripts/mutation-check.mjs` | Aanvullen met een standaardtool (Stryker) op de kernbestanden, zodat ook niet-bedachte mutaties getest worden. Inspanning: M | P3 |
| TEST-05 | De unit-suite draait serieel omdat alle tests één databasebestand delen | Low | `vitest.config.ts:40` | Een database per worker. Bij 287 seconden nog geen probleem. Inspanning: M | P4 |

## 12. Afhankelijkheden

### DEP-01: 13 van de 25 productieafhankelijkheden worden niet gebruikt

| Veld | Inhoud |
|---|---|
| Beschrijving | `lodash`, `luxon`, `date-fns`, `react-hook-form`, `@hookform/resolvers`, `class-variance-authority`, `clsx`, `tailwind-merge` en de vijf `@radix-ui`-pakketten worden door geen enkel bestand geïmporteerd. De documentatie noemt shadcn/ui als onderdeel van de stack, maar er is geen `components/ui` en geen component dat het gebruikt |
| Impact | Een groter aanvalsoppervlak en meer onderhoud voor niets. Ze gaan mee in de productie-image. Een kwetsbaarheid in een ongebruikt pakket laat `npm audit` falen en houdt een release tegen |
| Risico | **Medium** |
| Bewijs | `git grep` naar elk pakket buiten `package.json`, het lockbestand en de documentatie: 0 treffers, behalve `@radix-ui` in `next.config.js:44` |
| Bestandslocatie | `package.json:17-32` |
| Aanbevolen oplossing | Verwijderen en de stacktabellen in `CLAUDE.md` en de README bijwerken. Inspanning: S |
| Prioriteit | P1 |

### DEP-02: OR-Tools staat vast op een versie uit 2023

| Veld | Inhoud |
|---|---|
| Beschrijving | Beide solvers pinnen `ortools==9.8.3296`. De documentatie zegt waarom: een andere versie zoekt anders en geeft andere roosters en schijnfouten in de tests. De versie heeft geen installatiepakket voor Python 3.13 |
| Impact | De solvers zitten vast aan Python 3.12 of lager. Python 3.11 krijgt beveiligingsupdates tot oktober 2027. Daarna is er een gedwongen upgrade van de kern van het product, waarbij de uitkomsten veranderen en opnieuw beoordeeld moeten worden door de planners |
| Risico | **Medium.** Zeker, met een datum |
| Bewijs | `pip install` van de vereisten op Python 3.13 faalt met "No matching distribution found for ortools==9.8.3296" (gemeten in deze audit) |
| Bestandslocatie | `solver/requirements.txt`, `aios-solver/requirements.txt`, `solver/Dockerfile:1` |
| Aanbevolen oplossing | Plan de upgrade nu, niet in 2027. Maak de tests onafhankelijk van de zoekvolgorde waar dat kan (toets op regels en op een bandbreedte van de kwaliteit, niet op een exact rooster) en draai beide versies een kwartaal naast elkaar. Inspanning: L |
| Prioriteit | P2 |

### DEP-03 tot DEP-06

| Nr | Bevinding | Klasse | Bewijs en locatie | Aanbeveling | Prioriteit |
|---|---|---|---|---|---|
| DEP-03 | Hoofdversies achter: `better-sqlite3` 9 tegen 13, `tailwindcss` 3 tegen 4, `eslint` 9 tegen 10, `typescript` 5 tegen 7, `vitest` 4 tegen 5. Next.js staat drie patchversies achter | Low | `npm outdated` van 10-11-2026 | Next.js en `nodemailer` direct, de rest gepland. `better-sqlite3` eerst: het is de database. Inspanning: M | P2 |
| DEP-04 | Geen automatische bewaking van updates | Medium | Geen `.github/dependabot.yml` | Zie SEC-09 | P1 |
| DEP-05 | `legacy-peer-deps=true` verbergt conflicten tussen pakketten | Low | `.npmrc` | Opnieuw proberen zonder na het opruimen van DEP-01. Inspanning: S | P3 |
| DEP-06 | `typescript` en `tsx` zijn productieafhankelijkheden omdat de container bij elke start TypeScript uitvoert | Low | `package.json`, `docker-entrypoint.sh:30` | Het seedscript meecompileren bij de build. Volgt uit ARCH-05. Inspanning: M | P3 |

## 13. Documentatie

**Beeld.** Ruim 4700 regels documentatie buiten de README, in twee talen met
een duidelijke verdeling: Nederlands voor wie de app beheert, Engels voor wie
eraan bouwt. De ontwikkeldocumentatie legt per onderdeel uit waarom een regel
bestaat en wat er eerder misging. Dat is zeldzaam en waardevol.

### DOC-01: de README is voor de helft een wijzigingslog en beschrijft een stack die er niet is

| Veld | Inhoud |
|---|---|
| Beschrijving | De README telt ruim 1300 regels, waarvan ongeveer 670 notities per versie zijn, niet in volgorde. De installatie-uitleg staat daaronder. De stacktabellen in de README en in `CLAUDE.md` noemen shadcn/ui en Drizzle als ORM. De code gebruikt geen van beide zo (DEP-01, ARCH-01) |
| Impact | Een nieuwe beheerder vindt de installatie niet. Een beoordelaar die de stacktabel vertrouwt, schat het systeem verkeerd in |
| Risico | **Medium** |
| Bewijs | Regeltelling. De volgorde van de versies (0.902.0 tussen 0.75.0 en 0.76.0). De app verwijst naar "README, bij versie 0.904.0" |
| Bestandslocatie | `README.md`, `CLAUDE.md` (tabel Stack), `lib/terugzetAntwoord.ts:12` |
| Aanbevolen oplossing | Een `CHANGELOG.md`, nieuwste eerst. De stacktabellen corrigeren. Inspanning: S |
| Prioriteit | P2 |

### DOC-02: geen vastgelegde architectuurbeslissingen

| Veld | Inhoud |
|---|---|
| Beschrijving | De grote keuzes (SQLite, geen ORM in gebruik, twee solvers, kopiëren in plaats van delen, mail via een externe stroom, tweestapsverificatie weg) staan verspreid over `CLAUDE.md`, `docs/development`, commentaar en de versienotities, vaak als "the user's choice" zonder de afweging |
| Impact | Een opvolger weet wat er gekozen is, maar niet welke alternatieven zijn afgewogen en onder welke omstandigheden de keuze herzien moet worden |
| Risico | **Medium** |
| Bewijs | Geen map `docs/adr` of vergelijkbaar. Zoeken naar "the user's choice" en "planner's choice" geeft de plekken |
| Bestandslocatie | `CLAUDE.md`, `docs/development/` |
| Aanbevolen oplossing | Tien korte beslisdocumenten voor de keuzes hierboven: context, keuze, gevolgen, wanneer herzien. Inspanning: S |
| Prioriteit | P2 |

### DOC-03: geen licentie en onduidelijke rechten

| Veld | Inhoud |
|---|---|
| Beschrijving | De repository is openbaar en heeft geen licentiebestand. De README zegt "alleen voor intern gebruik". Alle zichtbare commits zijn geschreven met een AI-assistent. De verhouding tussen de maker, de instelling waar het systeem draait en de rechten op de code is niet vastgelegd in de repository |
| Impact | Voor een koper of investeerder is dit de eerste vraag: wie is eigenaar, mag de instelling het blijven gebruiken, mag een derde het overnemen? Zonder licentie heeft niemand buiten de rechthebbende gebruiksrechten, terwijl de code voor iedereen leesbaar is. Bij code van een werknemer kan de werkgever rechthebbende zijn |
| Risico | **High** in een due diligence. Voor het dagelijks gebruik geen risico |
| Bewijs | Geen `LICENSE`. De tekst in de README. De regels `Co-Authored-By` en `Claude-Session` in alle 51 commits |
| Bestandslocatie | `README.md` (Licentie), hoofdmap |
| Aanbevolen oplossing | Leg het eigendom schriftelijk vast met de instelling. Kies daarna: de repository besloten maken of een licentie toevoegen. Dit is een juridische vraag, geen technische. Inspanning: S |
| Prioriteit | P0 bij een transactie, anders P1 |

### DOC-04 tot DOC-06

| Nr | Bevinding | Klasse | Bewijs en locatie | Aanbeveling | Prioriteit |
|---|---|---|---|---|---|
| DOC-04 | Geen draaiboek voor storingen. Wat te doen bij een app die niet start, een volle schijf, een solver die stopt of een mail die niet uitgaat, staat verspreid in de versienotities | Medium | README bij versie 0.87.1 is het enige stuk in die vorm | Eén `docs/storingen.md` met symptoom, oorzaak en handeling. Inspanning: S | P1 |
| DOC-05 | Het contract van de AIOS-solver is beschreven. Dat van de achterwachtsolver staat alleen in de Pydantic-modellen | Low | `docs/development/aios-solver.md`, `solver/main.py` | Het OpenAPI-schema uit FastAPI exporteren en bewaren, met een test die verschil meldt. Inspanning: S | P3 |
| DOC-06 | Geen privacydocument | Medium | Zie SEC-11 | Zie SEC-11 | P1 |

## 14. Onderhoudbaarheid

### MAINT-01: één persoon, één werkwijze

| Veld | Inhoud |
|---|---|
| Beschrijving | De zichtbare geschiedenis heeft één auteur. Alle 51 commits dragen de regels van een AI-assistent en `CLAUDE.md` is feitelijk het besturingsdocument van het project: het bevat de regels, de releaseprocedure en de valkuilen. In 11 dagen zijn 17 versies gebouwd. Er is geen codereview door een tweede persoon zichtbaar: de workflows hebben geen pull-requeststap en de versies volgen elkaar binnen uren op |
| Impact | Valt de ene persoon weg, dan is er niemand die het systeem kent. De werkwijze is overdraagbaar omdat hij is opgeschreven, maar alleen aan iemand die op dezelfde manier wil werken. De hoeveelheid code (76.000 regels plus 53.000 regels tests) is groter dan één mens zonder dat hulpmiddel in redelijke tijd overziet. Het tempo is hoger dan een handmatige controle van een halfuur per release geloofwaardig maakt |
| Risico | **High.** Waarschijnlijkheid: mogelijk. Impact: hoog (continuïteit) |
| Bewijs | `git log --format=%an` over de zichtbare commits: één naam. 51 van 51 commits met `Claude-Session`. Versies 1.1.0 tot en met 1.1.5 op 5 en 6 november |
| Bestandslocatie | `CLAUDE.md`, git-geschiedenis |
| Aanbevolen oplossing | Een tweede persoon die het systeem kan installeren, bijwerken en herstellen, aantoonbaar door het één keer te doen. Een vastgelegde afspraak met de instelling over beheer. Review door een tweede paar ogen op wijzigingen aan de solvers, het schema en de toegangscontrole. De pipeline van OPS-01 vervangt een deel van het vertrouwen door mechanisme. Inspanning: M, vooral organisatorisch |
| Prioriteit | P0 |

### MAINT-02: het releasetempo is hoger dan de poort kan dragen

| Veld | Inhoud |
|---|---|
| Beschrijving | De regel in `CLAUDE.md` is dat een versie na de bump zonder te vragen wordt gebouwd en vrijgegeven voor productie. De volledige controle vooraf is handmatig en duurt ruim een halfuur per variant. De versienotities noemen meerdere versies die niet zijn uitgebracht omdat de build faalde en audits die na een release punten vonden |
| Impact | Fouten bereiken productie en worden in een volgende versie hersteld. De README telt vijf "audits" in drie weken die elk een lijst herstelpunten opleverden |
| Risico | **Medium** |
| Bewijs | README bij versie 0.905.0 en 0.905.1 (twee builds mislukt), bij 0.805.0, 0.111.0, 0.112.0 en 1.3.0 (audits met herstel) |
| Bestandslocatie | `CLAUDE.md` (Standing instructions, Version), README |
| Aanbevolen oplossing | Een vaste wachttijd op de testinstallatie voor wijzigingen aan gedrag en vrijgeven als aparte, bewuste handeling van een mens. Inspanning: S |
| Prioriteit | P1 |

## 15. Conclusie

Dit is een systeem dat doet wat het belooft, met een zorg voor
domeinregels en beveiliging die boven de maat van intern maatwerk ligt. De
auditor vond geen kritieke fout en geen plek waar een buitenstaander zonder
meer binnenkomt.

Het risico zit niet in wat er gebouwd is maar in hoe het in stand gehouden
wordt: één persoon, een handmatige poort, geen bewaking en een schema dat op
drie plekken gelijk moet blijven. Die vier punten zijn alle vier met
overzichtelijk werk te verhelpen. `IMPROVEMENT_ROADMAP.md` zet dat werk in
volgorde. Na de eerste 30 dagen uit die roadmap komt de totaalscore op
ongeveer 7.

Voor een investeerder: de waarde zit in de vastgelegde domeinkennis (de
regels voor twee soorten roosters, getoetst aan echte roosters) en in de
testsuite, niet in de technologie. Die waarde is alleen over te dragen als de
vragen over eigendom (DOC-03) en continuïteit (MAINT-01) eerst beantwoord
zijn.
