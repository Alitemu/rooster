# Register technische schuld: Dienstrooster 1.4.0

Onderdeel van de audit van 10-11-2026 op commit `6493fce`. Referentiekader:
`.claude/AUDIT_PLAYBOOK.md`. De nummers verwijzen naar de bevindingen in
`AUDIT_REPORT.md` en `SECURITY_FINDINGS.md`.

## 1. Hoe dit register te lezen

Technische schuld is werk dat is uitgesteld en waarover rente wordt betaald:
elke wijziging kost meer zolang de schuld blijft staan. Dit register
onderscheidt drie soorten.

| Soort | Betekenis |
|---|---|
| Bewust | Een vastgelegde keuze van de eigenaar. De schuld is bekend, de prijs is geaccepteerd |
| Gegroeid | Ontstaan door het tempo. Niemand heeft ervoor gekozen |
| Extern | Opgelegd door een afhankelijkheid of het platform |

Inspanning: S is uren, M is dagen, L is weken. De rente is geschat op wat de
schuld per wijziging of per jaar kost, niet gemeten.

## 2. Samenvatting

| | Aantal | Inspanning om af te lossen |
|---|---|---|
| Structurele schuld (hoofdstuk 3) | 6 | 3 × L, 3 × M |
| Schuld in code (hoofdstuk 4) | 8 | 1 × L, 3 × M, 4 × S |
| Schuld in proces en beheer (hoofdstuk 5) | 7 | 3 × M, 4 × S |
| Schuld in afhankelijkheden (hoofdstuk 6) | 5 | 1 × L, 1 × M, 3 × S |
| Schuld in documentatie (hoofdstuk 7) | 5 | 5 × S |

De totale aflossing is geschat op 12 tot 16 weken werk voor één ontwikkelaar
die het systeem kent. De helft daarvan zit in drie posten: het schema naar
één bron (TD-01), de gedeelde kern voor de twee diensten (TD-03) en de
upgrade van OR-Tools (TD-22).

De schuld met de hoogste rente is niet de grootste. Dat zijn TD-15 (geen
automatische controle) en TD-23 (ongebruikte pakketten): samen een paar dagen
werk en ze drukken op elke release.

## 3. Structurele schuld

| Nr | Schuld | Soort | Waar | Waarom het er is | Rente (wat het kost om te laten staan) | Aflossing | Inspanning | Bevinding |
|---|---|---|---|---|---|---|---|---|
| TD-01 | Het schema staat op drie plekken: `db/schema.ts`, 48 migraties en SQL in het seedscript met `LATER_COLUMNS`. Productie gebruikt het seedscript | Gegroeid | `db/schema.ts`, `db/migrations/`, `scripts/seed.ts:730` | Het seedscript bestond eerst. De migraties kwamen erbij en productie bleef op het oude pad | Elke schemawijziging drie keer, twee controlescripts om het gelijk te houden en volgens de eigen documentatie meermaals een dag verlies | Productie op de migraties, seedscript alleen voor data, `LATER_COLUMNS` weg | L | ARCH-01 |
| TD-02 | Drizzle staat als ORM in de stack maar wordt alleen als migratierunner gebruikt. Alle 133 bestanden met databasetoegang schrijven SQL met handgetypeerde resultaten | Gegroeid | `db/schema.ts` (door niets geïmporteerd), 133 bestanden met `db.prepare` | Rauwe SQL was sneller te schrijven en te lezen | Een hernoemde kolom wordt pas tijdens het draaien gemerkt. 67 keer `any` in routes | Rijtypen afleiden uit het schema. De SQL zelf mag blijven | M | CODE-01 |
| TD-03 | Twee diensten als kopie van elkaar: 67 `lib/aios*`-bestanden, 24 componenten, 54 routes | Bewust | `lib/aios*.ts`, `components/Aios*.tsx`, `app/api/aios/` | De achterwacht was in productie en mocht niet geraakt worden door de bouw van de AIOS | Elke fout in gedeelde logica twee keer vinden en herstellen. Geen mechanisme dat een herstel in beide afdwingt | Een gedeelde, geteste kern voor wat aantoonbaar gelijk is: mailwachtrij, vergrendeling, linkuitgifte, herinneringen | L | ARCH-03 |
| TD-04 | De harde regels van de AIOS op drie plekken in twee talen | Bewust | `aios-solver/model.py`, `aios-solver/controle.py`, `lib/aiosRegels.ts` | De app moet waarschuwen bij handmatig wijzigen zonder de solver aan te roepen | Elke regelwijziging drie keer. Een gedeelde fixture bewaakt het | De app laat de controle door de solverdienst doen (`controle.py` achter een eigen route) en houdt geen eigen kopie | M | ARCH-03 |
| TD-05 | Staat in het geheugen van één proces: lopende generaties, tellers, vergrendelingen, geplande taken | Gegroeid | `lib/rosterGenerationJobs.ts:110`, `lib/rateLimit.ts:27`, `instrumentation-node.ts:280` | Eén proces was en is genoeg | Een herstart tijdens een generatie verliest tot 30 minuten rekenwerk zonder melding. Een tweede instantie kan niet | Generatiestaat in de database (de AIOS doet dat al). De eis "één proces" vastleggen | M | ARCH-02 |
| TD-06 | De solver als één lang HTTP-verzoek van maximaal een uur | Gegroeid | `lib/solverClient.ts`, `solver/main.py:356`, `aios-solver/main.py:172` | De zoektijd groeide van 2 naar 30 en 60 minuten binnen hetzelfde ontwerp | Een eigen HTTP-client om time-outs te omzeilen, één rooster tegelijk, alles opnieuw bij een onderbreking | Een taakmodel met een id en een opgehaalde uitkomst | M tot L | PERF-02 |

## 4. Schuld in code

| Nr | Schuld | Soort | Waar | Rente | Aflossing | Inspanning | Bevinding |
|---|---|---|---|---|---|---|---|
| TD-07 | Een route van 1053 regels met een functie van 540 regels voor de kern van het product | Gegroeid | `app/api/planner/period/[id]/generate-roster/route.ts:342-884` | De belangrijkste logica is het moeilijkst te lezen en alleen via HTTP te testen | Invoer opbouwen en uitvoer verwerken als pure functies in `lib/` | M | ARCH-04 |
| TD-08 | Drie componenten boven 1300 regels | Gegroeid | `components/SetupWizard.tsx`, `PlannerDashboard.tsx`, `RosterGenerationDialog.tsx` | Elke wijziging raakt een bestand dat niemand in één keer overziet | Opdelen per stap of sectie | M | ARCH-04 |
| TD-09 | `lib/` als platte map met 308 bestanden | Gegroeid | `lib/` | Geen zichtbare modulegrenzen. De enige afgedwongen grens is die tussen de diensten | Mappen per domein (auth, mail, periode, rooster, aios) | S, mechanisch | ARCH-04 |
| TD-10 | Geen rendertests voor 22.600 regels React. Brontests als vervanging | Gegroeid | `components/*.test.ts`, 26 tests die bron als tekst lezen | Gedrag van schermen alleen te controleren met een draaiende app | Een gedeelde `apiFetch` en rendertests voor de grootste vijf | L | CODE-03, TEST-02 |
| TD-11 | Twee React-lintregels uit | Gegroeid | `eslint.config.mjs:10-11` | Verouderde waarden in effecten worden niet gemeld | Aanzetten als waarschuwing, nalopen, dan als fout | M | CODE-02 |
| TD-12 | Dode resten: tabel `holiday_history`, drie pooltypen zonder code, een uitgeschakeld meldingspad, een alias naar een map die niet bestaat | Gegroeid | `db/schema.ts:362`, `scripts/seed.ts:137`, `lib/notifications.ts:79`, `tsconfig.json:38` | Ruis | Eén opruimrelease | S | CODE-04 |
| TD-13 | Dynamische kolomnamen in vier `UPDATE`-statements | Gegroeid | `app/api/person/[id]/absences/[absenceId]/route.ts:131` en drie andere | Geen, tot iemand het object uit de invoer vult | Vaste lijst van kolommen | S | CODE-07 |
| TD-14 | Ongestructureerde logging en invoercontrole met de hand in 165 van 173 routes | Gegroeid | `lib/api-errors.ts`, `lib/requestFields.ts` | Meer code per route, zoeken in logs met `grep` | Eén logfunctie. Schema's bij nieuwe en gewijzigde routes | S, doorlopend | CODE-05, CODE-06 |

## 5. Schuld in proces en beheer

| Nr | Schuld | Soort | Waar | Rente | Aflossing | Inspanning | Bevinding |
|---|---|---|---|---|---|---|---|
| TD-15 | Geen automatische controle bij een wijziging. De releasepoort is een lijst in `CLAUDE.md` | Gegroeid | `.github/workflows/images.yml:33` | Ruim een halfuur handwerk per release en fouten die pas op GitHub of in productie blijken | Een workflow op push en pull request, een nachtelijke met de browsertests | M | OPS-01 |
| TD-16 | Geen monitoring, een health-route die niets controleert | Gegroeid | `app/health/route.ts` | Uitval wordt gemeld door gebruikers | Een echte healthcheck en een externe controle die mailt | S tot M | OPS-02 |
| TD-17 | Het startscript gaat door na een mislukte schema-update | Gegroeid | `docker-entrypoint.sh:30`, `33`, `39` | Een mislukte update toont zich als willekeurige fouten | Stoppen bij een mislukte schema-update | S | OPS-03 |
| TD-18 | Productie volgt `stable`, teruggaan is niet getest | Bewust | `docker-compose.yml:142` | Onzeker welke versie draait, onzekere weg terug | Versienummer in `.env`, één versie terug testen | M | OPS-04 |
| TD-19 | Geen dekkingsmeting, hoewel de configuratie er staat | Gegroeid | `vitest.config.ts:41` | Onbekend wat ongetest is | Het ontbrekende pakket toevoegen | S | TEST-01 |
| TD-20 | Een mutatiecontrole van 7195 regels die met de hand wordt bijgehouden | Bewust | `scripts/mutation-check.mjs` | Elke nieuwe regel vraagt een handgeschreven mutatie. Het bestand is het grootste van de repository | Aanvullen met een standaardtool op de kernbestanden | M | TEST-04 |
| TD-21 | Geen bewaartermijn voor de wijzigingsgeschiedenis, meldingen en links | Gegroeid | `lib/periodTrash.ts:148-162` is de enige opruiming | Tabellen groeien onbegrensd. Een open vraag bij de AVG | Een instelbare termijn en een geplande opruiming | S | DB-02, SEC-11 |

## 6. Schuld in afhankelijkheden

| Nr | Schuld | Soort | Waar | Rente | Aflossing | Inspanning | Bevinding |
|---|---|---|---|---|---|---|---|
| TD-22 | OR-Tools vastgepind op 9.8 (2023). Geen installatiepakket voor Python 3.13. Python 3.11 loopt af in oktober 2027 | Extern, met een bewuste pin | `solver/requirements.txt`, `aios-solver/requirements.txt` | Een gedwongen upgrade van de kern met een einddatum. Hoe later, hoe meer tests op de zoekvolgorde leunen | Tests onafhankelijk maken van de zoekvolgorde, twee versies naast elkaar draaien, dan overstappen | L | DEP-02 |
| TD-23 | 13 van 25 productieafhankelijkheden ongebruikt | Gegroeid | `package.json:17-32` | Groter aanvalsoppervlak, kans dat `npm audit` een release tegenhoudt om een pakket dat niemand gebruikt | Verwijderen | S | DEP-01 |
| TD-24 | Hoofdversies achter: `better-sqlite3` 9 tegen 13, `tailwindcss` 3 tegen 4, `typescript` 5 tegen 7 | Gegroeid | `package.json` | Elke overgeslagen hoofdversie maakt de volgende stap groter | Per kwartaal één hoofdversie, te beginnen met `better-sqlite3` | M | DEP-03 |
| TD-25 | `legacy-peer-deps=true` | Extern | `.npmrc` | Conflicten tussen pakketten blijven onzichtbaar | Opnieuw proberen na TD-23 | S | DEP-05 |
| TD-26 | TypeScript wordt in productie bij elke start uitgevoerd via `tsx` | Gegroeid | `docker-entrypoint.sh:30`, `package.json` | Een compiler in de productie-image en een tragere start | Het seedscript meecompileren bij de build | S, na TD-01 | DEP-06, ARCH-05 |

## 7. Schuld in documentatie

| Nr | Schuld | Soort | Waar | Rente | Aflossing | Inspanning | Bevinding |
|---|---|---|---|---|---|---|---|
| TD-27 | De README als wijzigingslog van 670 regels, niet in volgorde | Gegroeid | `README.md` | De installatie-uitleg is onvindbaar | Een `CHANGELOG.md` | S | DOC-01 |
| TD-28 | De stacktabellen noemen shadcn/ui en Drizzle als ORM | Gegroeid | `CLAUDE.md`, `README.md` | Een verkeerd beeld voor wie de code niet leest | Corrigeren | S | DOC-01 |
| TD-29 | Beslissingen zonder afweging: "the user's choice" | Gegroeid | `CLAUDE.md`, `docs/development/` | Een opvolger weet niet wanneer een keuze herzien mag worden | Tien korte beslisdocumenten | S | DOC-02 |
| TD-30 | Geen draaiboek voor storingen | Gegroeid | Verspreid in de versienotities | Bij een storing eerst zoeken | `docs/storingen.md` | S | DOC-04 |
| TD-31 | Geen licentie, geen privacydocument | Gegroeid | Hoofdmap, `docs/` | Een blokkade bij elke overdracht of toetsing | Eigendom vastleggen, privacydocument schrijven | S | DOC-03, SEC-11 |

## 8. Schuld die geen schuld is

Deze keuzes zien eruit als schuld maar zijn bij deze schaal de juiste. De
audit raadt af ze "op te lossen".

| Keuze | Waarom het geen schuld is |
|---|---|
| SQLite in plaats van een databaseserver | Eén bestand, geen beheer, een back-up is een kopie. Pas herzien bij meerdere instellingen op één installatie |
| Een monoliet zonder servicelaag | Bij 173 routes en één ontwikkelaar is een extra laag vooral meer bestanden |
| Geen cache | Er is niets traag genoeg om te cachen |
| Geen Kubernetes | Eén server met Docker Compose past bij 60 gebruikers |
| Mail via een externe stroom in plaats van zelf versturen | De app hoeft daardoor geen adressen van deelnemers te bewaren. De prijs staat bij SEC-03 |
| Uitgebreid commentaar met versienummers | Het commentaar is hier de geschiedenis van het ontwerp en bespaart een opvolger weken |

## 9. Volgorde van aflossen

De volgorde staat in `IMPROVEMENT_ROADMAP.md`. De regel daarbij: eerst de
schuld met de hoogste rente per uur werk (TD-15, TD-16, TD-17, TD-23), dan de
schuld met een einddatum (TD-22), dan de structurele (TD-01 en verder).
