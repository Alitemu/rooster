# Dienstrooster

Een dienstroosterapplicatie voor verpleegafdelingen (20-40 medewerkers) met
automatische roostergeneratie, verdeling van diensten en
voorkeursbeheer.

Alle fasen uit het implementatieplan zijn gebouwd en getest: authenticatie,
datamodel, feestdagberekening, capaciteitscontrole, voorkeuren, de CP-SAT-
solver voor roostergeneratie, publicatie, ruilverzoeken en correcties.

## Stack

- **Frontend/Backend:** Next.js 16 + TypeScript (App Router, strict mode)
- **Styling:** Tailwind CSS + shadcn/ui
- **Database:** SQLite (WAL-mode) + Drizzle ORM
- **Auth:** eigen implementatie (persoonlijke links, bcrypt-wachtwoorden)
- **Solver:** Python + FastAPI + OR-Tools CP-SAT
- **Testen:** Vitest + fast-check (unit/integratie), Playwright (e2e)
- **Container:** Docker Compose (4 services: caddy, web, solver, aios-solver)

## Snel starten

### Vereisten

- Node.js 20+
- Python 3.11+ (alleen nodig als je de solver buiten Docker draait)
- Docker & Docker Compose
- npm

### Installatie

```bash
# Dependencies installeren
npm install

# Database aanmaken en vullen met voorbeelddata
npm run seed

# Ontwikkelomgeving starten (Docker Compose: caddy + web + solver)
npm run dev

# Tests draaien
npm run test
```

### Toegang

- **Web:** https://localhost (via Caddy op poort 443, interne TLS-certificaten;
  de poort is `APP_PORT` in `.env`, bijvoorbeeld `APP_PORT=8010` als 443 bezet
  is, en het adres wordt dan https://localhost:8010)
- **Health check:** https://localhost/health
- **Solver:** http://localhost:8000 (alleen intern netwerk, geen publieke poort)

### Testgebruikers

Na `npm run seed`:

- **Planner en beheerder:** codenamen `planner` en `admin` (hoofdletters
  maken bij het inloggen niet uit), wachtwoord zoals gezet in `DEFAULT_TEST_PASSWORD`
  (`lib/seedPassword.ts`) - wijzig dit voordat de app voor een echte
  afdeling gebruikt wordt. De server waarschuwt bij elke start zolang een
  account dit standaardwachtwoord nog heeft.
- **Medewerkers:** Persoon-01 t/m Persoon-31 (persoonlijke toegangslinks,
  geen echte namen of e-mailadressen)

## Ontwikkeling

### Projectstructuur

```
├── app/                     # Next.js App Router (routes, pagina's, API)
│   ├── api/                 # API-routes (planner + deelnemer)
│   ├── planner/             # Schermen voor planner/beheerder
│   └── person/[token]/      # Persoonlijke pagina per medewerker
├── components/              # React-componenten
├── lib/                     # Logica: holidays, auth, capaciteit, solver-client, ...
├── db/                      # Drizzle-schema & migraties
├── types/                   # TypeScript-types
├── scripts/                 # seed.ts, claim-password.ts, full-check.mjs, ui-check.mjs, schema-drift.mjs
├── solver/                  # Python-solverservice (CP-SAT) van de achterwacht
├── aios-solver/             # De eigen solver van de AIOS (vanaf 0.74.0)
├── tests/                   # Testfixtures en de Playwright e2e-suite
├── CLAUDE.md                # Ontwerpregels & conventies (verplichte leesstof)
└── docker-compose.yml       # Services: caddy, web, solver, aios-solver
```

### Codeconventies

**Belangrijk: lees CLAUDE.md voordat je code schrijft.**

Kernpunten:
- **Geen echte namen/e-mailadressen** - uitsluitend pseudonieme codenamen
- **Tekenconventie:** delta < 0 = minder diensten, delta > 0 = meer diensten
  (nooit een los getal tonen aan de gebruiker, altijd in woorden)
- **Taal van de interface:** alles wat een deelnemer of planner ziet is
  Nederlands; Engels blijft beperkt tot code, databasevelden en logs
- **Tests:** één test per harde regel, die bewijst dat de regel niet
  doorbroken kan worden
- **Geen mockdata:** alleen via `scripts/seed.ts` en `/tests/fixtures/`

### Tests draaien

```bash
# Unit- en integratietests (Vitest)
npm run test

# Watch-modus
npm run test -- --watch

# UI-modus
npm run test:ui

# Type-check
npx tsc --noEmit

# Lint
npm run lint
```

De browser-/livechecks hebben een gestarte solver, een geseede database en
een gestarte app nodig (niets hiervan start zichzelf op):

```bash
# Solver starten (in ./solver)
uvicorn main:app --host 127.0.0.1 --port 8000

# Database seeden
npm run seed

# App starten
ALLOW_SEED_PASSWORD=true SESSION_SECRET=... SOLVER_URL=http://localhost:8000 npm start
```

Daarna:

```bash
# Volledige API-levenscyclus tegen echte data, inclusief de eigen harde
# regels van de solver op zijn onbewerkte output (geen ABSOLUUT-overtreding,
# niemand twee keer in dezelfde ISO-week, niemand's vensterregel geschonden,
# niemand voorbij zijn streefbereik)
node scripts/full-check.mjs

# De twee meest gebruikte schermen, in een echte browser
node scripts/ui-check.mjs

# Playwright e2e-suite (bouwt zijn eigen periode/toewijzingen-fixture per
# testbestand, leest dus niet de geseede periode)
npm run test:e2e

# Vergelijkt het schema dat de seed bouwt met het schema dat de migraties
# bouwen, kolom voor kolom, index voor index, foreign key voor foreign key
# - nodig omdat scripts/seed.ts (niet db/migrations) in productie het
# schema bouwt zodra SEED_ON_START=planner of true staat (de standaard)
node scripts/schema-drift.mjs
```

### Database

De migraties in `db/migrations` voert de app bij het starten zelf uit
(`db/client.ts`). Een geseede database krijgt nieuwe tabellen en kolommen
via `scripts/seed.ts` (zie Bijwerken). Er is geen apart migratiecommando.

```bash
# Database (opnieuw) seeden
npm run seed
npm run seed -- --reset
```

Let op: een kolom die aan `db/schema.ts` wordt toegevoegd heeft drie
dingen nodig, niet één: het schema, een migratie onder `db/migrations`, en
een vermelding in `scripts/seed.ts` (in de CREATE TABLE, of in
`LATER_COLUMNS` zodat een langer geleden geseede database hem ook
oppikt) - anders draait een verse installatie op een ander schema dan een
gemigreerde. `node scripts/schema-drift.mjs` bewaakt dit.

### Bouwen

```bash
# Next.js production build
npm run build

# Productieserver starten
npm start
```

## Architectuur in het kort

### Databaseschema

Belangrijkste tabellen:
- `person` - medewerkers (codenaam, rol, wachtwoord_hash, sessie_versie)
- `pool` / `pool_membership` - dienstenpool en wie daar wanneer in zit
- `schedule_period` - periodes (CONCEPT, OPEN, CLOSED, GEGENEREERD, GEPUBLICEERD)
- `shift_slot` / `assignment` - te vullen diensten en de uiteindelijke toewijzingen
- `availability` - blokkeringsvoorkeuren (ABSOLUUT, LIEVER_NIET, VOORKEUR)
- `ledger_entry` - saldo-aanpassingen (append-only, nooit overschreven)
- `holiday_history` - welke feestdag iemand in welk jaar had (oude import, wordt niet meer gebruikt)
- `swap_request` - dienstruilverzoeken
- `audit_log` - alle acties van planners/beheerders

### Feestdagberekening

Alle Nederlandse feestdagen berekend met het Meeus-algoritme
(`lib/holidays.ts`; de solver rekent zelf geen feestdagen uit, hij krijgt
ze mee met de diensten):
Nieuwjaarsdag, Pasen (en gerelateerde dagen), Koningsdag (met
zondagcorrectie), Bevrijdingsdag (elke 5 jaar), Hemelvaart, Pinksteren,
Kerst.

Over de jaren heen telt het aantal feestdagdiensten, niet welke feestdag.
De app houdt per persoon bij hoeveel feestdagdiensten iemand in de eerdere
gepubliceerde periodes naar verhouding had moeten krijgen (naar de tijd dat
iemand meedeed) en hoeveel het er werden (`lib/feestdagHistory.ts`). Wie
achterloopt krijgt bij het genereren voorrang, binnen het streefbereik en
nooit op een geblokkeerde dag. Nieuwkomers beginnen gelijk, net als iedereen
bij de eerste periode in de app.

### Authenticatie

**Voor medewerkers (deelnemers):**
- Persoonlijke toegangslinks (lange willekeurige token, SHA256-hash in de
  database)
- Geen e-mailadressen opgeslagen (pseudoniem)
- Alleen-lezen toegang na de deadline

**Voor planner/beheerder:**
- Wachtwoord (bcrypt)
- Geen e-mailadres vereist
- Sessies zijn ondertekende tokens; `person.sessie_versie` maakt het
  mogelijk om alle sessies van een account in één keer ongeldig te maken
  (bijv. bij uitloggen op alle apparaten of een wachtwoordwijziging)

### Capaciteitscontrole

Twee formules, beide live zichtbaar in het instellingenscherm:

1. **Totale capaciteit:** `floor(weken / windowWeeks) * actieve_deelnemers ≥ aantal_diensten`
2. **Aantal unieke mensen per venster:** `actieve_deelnemers ≥ 7 * windowWeeks`

Formule 2 is meestal het beperkendst.

### Roostergeneratie (solver)

De Python-solver (CP-SAT via OR-Tools) genereert een rooster dat nooit een
harde regel schendt (ABSOLUUT-blokkade, de vensterregel, het streefbereik)
en levert bij schaarste een gedeeltelijk
rooster op in plaats van alles-of-niets - de planner vult de resterende
gaten handmatig aan, met duidelijke aanduiding wie een gat wél of niet mag
invullen.

Een venster van N weken betekent: minstens 7 × N dagen tussen twee
diensten van dezelfde persoon (sinds 0.22.0). Bij 2 weken zitten er dus
minstens 14 dagen tussen. Een zondag en de maandag twee weken later liggen
8 dagen uit elkaar en mogen dan niet. Bij 1 week is het minstens 7 dagen,
dus nooit twee diensten in dezelfde ISO-week. Bij 0 geldt geen
vensterregel. Met een apart venster voor avonddiensten en voor weekend- en
feestdagdiensten geldt het kleinste van de twee ook tussen een avonddienst
en een weekend- of feestdagdienst.

## Conventies

Zie CLAUDE.md voor de bijgehouden conventies en ontwerpbeslissingen.

## Implementatie

Voor deze fase gebouwd:
- Projectopzet en Docker Compose-configuratie
- Datamodel (Drizzle ORM + SQLite)
- Authenticatie (persoonlijke links + wachtwoord)
- Feestdagberekening voor alle Nederlandse feestdagen
- Capaciteitscontrole
- Periodebeheer (venster openen/sluiten, ruleset bevriezen bij openen)
- Voorkeuren en deeltijdpatronen
- Roostergeneratie via de CP-SAT-solver, met diagnostiek bij gaten
- Handmatig gaten vullen, met overrides en waarschuwingen
- Publicatie/depublicatie van een rooster
- Dienstruilverzoeken
- Audit-trail van alle planner-/beheerdersacties

## Implementatiedetails

### Deployment

#### Docker Compose

Drie containers met intern netwerk:

```
caddy:443 ──→ web:3000 ──→ solver:8000
  (TLS)        (Next.js)    (Python/FastAPI)
```

- **Caddy:** TLS-terminatie met interne certificaten
- **Web:** Next.js + SQLite (WAL-mode)
- **Solver:** Python FastAPI (geen publieke poort, alleen bereikbaar vanuit
  `web`)

De database en de back-ups van de voorkeuren-CSV (`lib/preferencesBackup.ts`)
staan in `DATA_DIR` (standaard `./data`, naast `docker-compose.yml`),
bind-mounted in de container - een gewone map in plaats van een door
Docker beheerd volume, zodat deze ook direct met een bestandsbeheerder
(bijv. Synology File Station) te bekijken is. De standaard `./data` bestaat
al bij een verse clone (leeg, via het git-getrackte `data/.gitkeep`) - een
bind mount heeft namelijk een al bestaande hostmap nodig, in tegenstelling
tot een named volume. Bij een eigen `DATA_DIR` moet die map zelf van
tevoren worden aangemaakt.

`SEED_ON_START` staat standaard op `planner`: de eerste keer dat `DATA_DIR`
(zie `.env.example`) leeg is, maakt de app het beheerdersaccount
(codenaam `admin`), de pool, de soorten diensten, de berichtteksten en 30
deelnemers (staf01 tot en met staf30) aan. Die deelnemers hebben
nog niets ingevuld. De beheerder maakt daarna zelf de planners aan. Er
komt geen voorbeeldperiode bij. Veilig om
aan te laten staan bij herstarts en herinstallaties, want het gebeurt maar
één keer, op een echt verse database. Zet `SEED_ON_START=true` in `.env`
voor een testinstallatie met voorbeelddata.

#### Bijwerken naar een nieuwe versie

De images worden kant-en-klaar gebouwd door GitHub. De server hoeft zelf
niets te bouwen. Jij bepaalt wanneer er gebouwd wordt en wanneer productie
een nieuwe versie krijgt. Dat gaat in drie stappen, allemaal op
github.com/Alitemu/rooster onder **Actions**:

1. **Bouwen (test):** kies links *Bouwen (test)* en daarna *Run workflow*.
   GitHub draait eerst alle tests en bouwt pas als die slagen. Daarna
   bouwt het de versie uit `package.json` en noemt die `test`. Dat duurt
   meestal een kwartier of minder. Productie merkt er niets van.
   Elk versienummer wordt maar één keer gebouwd. Bestaat het al, dan stopt
   de build met een melding: verhoog dan eerst het versienummer in
   `package.json`. Zo kan een geteste versie nooit ongemerkt vervangen
   worden door een nieuwere build met hetzelfde nummer.
2. **Testen:** werk de testinstallatie bij (zie hieronder) en probeer de
   nieuwe versie uit.
3. **Vrijgeven (productie):** tevreden? Kies *Vrijgeven (productie)*, dan
   *Run workflow* en vul het versienummer in (bijvoorbeeld 0.2.3). Die
   versie heet dan `stable`. Er wordt niets opnieuw gebouwd: productie
   krijgt precies de versie die je getest hebt. Op GitHub komt er ook een
   release bij (bij *Releases*), met de wijzigingen sinds de vorige. De
   release die als laatste is gemarkeerd, is de versie in productie.

Daarna op de productieserver, in de map met `docker-compose.yml`:

```bash
docker compose pull
docker compose up -d
```

De database in `DATA_DIR` blijft staan. Nieuwe kolommen en tabellen worden
bij het starten automatisch toegevoegd. Maak voor de zekerheid eerst een
kopie van die map.

**Vanaf versie 0.25.0** heten de deelnemers van de achterwacht staf01,
staf02 enzovoort. Die van de AIOS heten aios01, aios02 enzovoort. Bij de
eerste start van 0.25.0 krijgen Persoon-01 tot en met Persoon-30 eenmalig
de codenaam staf01 tot en met staf30. Hun voorkeuren, diensten en saldi
blijven gewoon bij hen. Pas dezelfde codenamen ook aan in de Excel-lijst van
de Power Automate-stroom (zie `docs/verzendlijst-power-automate.md`), anders
vindt de stroom hun e-mailadres niet en krijgen ze geen mail. Doe dat op
hetzelfde moment als het bijwerken.

**Vanaf versie 0.26.0** staat naast de pool van de achterwacht ook de pool
AIOS, zonder deelnemers. Zolang het rooster voor de AIOS niet in productie
is, ziet alleen de beheerder die pool. Een periode van de AIOS is altijd
een kwartaal van woensdag tot en met dinsdag: bij een nieuwe periode in die
pool kies je het kwartaal. De pagina van zo'n periode toont de diensten per
week, de blokken en de punten van het kwartaal. Openen kan nog niet: het
voorkeurenscherm en het maken van het rooster voor de AIOS komen in een
volgende versie.

**Vanaf versie 0.72.0** kan een periode van de AIOS open. De AIOS hebben
daarvoor een eigen deel van de app, los van de achterwacht: alleen de
inlogpagina, de database en het Gmail-account zijn gedeeld. Aan de
achterwacht is niets veranderd. Op de pagina van een AIOS-periode kies je de
deadline en klik je op *Periode openen*. Daarna verstuur je de
uitnodigingen en herinneringen vanaf diezelfde pagina. De AIOS krijgen een
eigen persoonlijke link (die eindigt op /aios/ met een code) naar een eigen
scherm: eerst hun deeltijd en afwezigheid, dan hun verzoeken voor het
kwartaal en per week alle diensten, met een avond- of nachtblok als één
vak. Onder *Status voorkeuren* zie je per AIOS wat er is ingevuld en of
iemand meer dan de helft heeft geblokkeerd. De AIOS hebben een eigen Power
Automate-stroom: de beheerder vult het adres daarvan in op de pagina van
een AIOS-periode, bij *Mail naar de AIOS*. Zolang dat leeg is, gaat er geen
mail naar de AIOS. Zie `docs/verzendlijst-power-automate.md`. Het maken van
het rooster voor de AIOS komt in een volgende versie, met een eigen solver.

**Vanaf versie 0.73.0** krijgen de AIOS vanzelf een herinnering, een week en
een dag voor de deadline, net als bij de achterwacht. Je pauzeert ze per
periode bij *Automatische herinneringen* op de pagina van de AIOS-periode.
Bij *Exporteren & communicatie* download je twee Excel-bestanden: het
*Voorkeurenoverzicht* (per dienst) en het *Statusrapport* (per AIOS), met de blokken van vier, inwerken,
onderbreking, parttimedagen, afwezigheid en de tellers. Blokkeert een AIOS
meer dan de helft van een soort, dan staat er een waarschuwing dat het
rooster het deel boven de helft alsnog kan inplannen. Wat een feestdag
betekent, staat in een eigen kader.

**Vanaf versie 0.74.0** is er een eigen solver voor de AIOS, in een eigen
container `aios-solver`, los van die van de achterwacht. De solver van de
achterwacht is niet veranderd. De app gebruikt de nieuwe solver pas in een
volgende versie, bij het maken van het rooster voor de AIOS. Neem dan ook
het nieuwe `docker-compose.yml` over, met de dienst `aios-solver` erin.
Daarna gaat bijwerken weer met `docker compose pull` en
`docker compose up -d`. Het geheugen van de nieuwe container zet je met
`AIOS_SOLVER_MEM_LIMIT` in `.env` (standaard 2g).

**Vanaf versie 0.75.0** maak je het rooster voor de AIOS in de app. Sluit de
periode van de AIOS, kies op de pagina van die periode bij *Rooster* hoe
lang de solver mag zoeken en klik op *Rooster maken*. Je ziet daarna het
rooster per week, met een blok als één vak, en per AIOS de punten en het
dienstpercentage: groen tot 25%, rood daarboven. Een dienst die leeg bleef,
staat erbij met de reden. *Opnieuw maken* maakt het hele rooster opnieuw.
*Rooster verwijderen* maakt alles weer leeg. Dit heeft de container
`aios-solver` nodig: neem bij deze versie het nieuwe `docker-compose.yml`
over (zie 0.74.0). Met de hand aanpassen en publiceren komen in een
volgende versie.

**Vanaf versie 0.76.0** vraagt de app eerst wat er gebeurt met de blokken
rond feestdagen. Bij *Rooster* staat dan het kader *Blokken rond
feestdagen*. Bij feestdagen achter elkaar (Pasen, Pinksteren, kerst) kies je
per avond- en nachtblok: heel laten (één AIOS doet het hele blok) of
opknippen (elke dag een losse dienst). Daar staat nog niets ingevuld: het
rooster kan pas gemaakt worden als elk blok een keuze heeft. Een blok met één
feestdag erin blijft heel, maar je kunt het ook opknippen. Valt 31 december
in de periode, dan kies je of er op oudjaarsnacht één of twee AIOS zijn. Twee
staat al ingevuld. Klik op *Keuzes bewaren*. De keuzes blijven bij de periode
en gelden bij elke volgende keer dat je het rooster maakt. In het rooster
staat een opgeknipt blok per dag en de tweede AIOS op oudjaarsnacht in de rij
*Nacht 2*.

**Vanaf versie 0.77.0** pas je het rooster van de AIOS met de hand aan. Tik
in *Dienstrooster* op een blok of dienst. Je ziet per AIOS wat het zou
kosten: een harde regel die erbij komt (zoals een compensatiedag of te weinig
rust), wat die AIOS markeerde, of het blok niet meer heel is en het
dienstpercentage daarna. Kies een AIOS. Met een waarschuwing vraagt de app
eerst *Ja, toch indelen*. Een blok geef je heel of alleen één dag ervan.
*Leeg laten* maakt de dienst leeg. *Ongedaan maken* zet je laatste wijziging
terug. Onder het rooster staat welke harde regels het nog breekt. *Opnieuw
maken* maakt het hele rooster opnieuw, ook wat je met de hand veranderde.

**Vanaf versie 0.78.0** publiceer je het rooster van de AIOS. Onder het
rooster staat *Publiceren*. Een lege dienst vul je eerst met de hand.
Waarschuwingen (een harde regel die het rooster breekt, of een
dienstpercentage boven 25%) staan erbij: publiceren kan dan toch, na *Ja,
toch publiceren*. Bij *Voorlopig publiceren* krijgt elke AIOS een mail met de
eigen diensten om na te kijken, via de stroom van de AIOS, en ziet die op de
eigen pagina. Pas daarna aan wat de AIOS melden: met de hand, met een reden.
Met *Definitief maken* krijgt iedereen de definitieve diensten met wat er
veranderde. *Publicatie intrekken* zet het rooster terug, zonder mail. Voor
het roosterbureau, de opleider en de afdeling download je *Rooster per dag*
als Excelbestand.

**Vanaf versie 0.79.0** schuift een tekort of overschot van een AIOS door naar
het volgende kwartaal, zoals bij de achterwacht: wie minder punten deed dan het
doel, krijgt er het volgende kwartaal meer. Hetzelfde geldt voor
feestdagdiensten over de jaren. Voor het eerste kwartaal in de app lees je de
geschiedenis in bij *Geschiedenis van vóór de app* op de pagina van de periode.
Download het sjabloon en vul per AIOS in: nachten, avonden door de week,
avonden in het weekend, dagdiensten, uitloopdiensten, hoeveel daarvan op een
feestdag, de gemiddelde fte en over hoeveel maanden. Klik op *Controleren*: je
ziet per AIOS in woorden wat het betekent, zoals "5 punten minder". Klopt het,
klik dan op *Bewaren*. In *Dienstpercentage en saldo* staat bij het rooster wat elke AIOS
meeneemt.

**Vanaf versie 0.80.0** ruilen de AIOS onderling, zonder de planner. Op hun
eigen pagina kiezen ze bij *Ruilen* een eigen dienst of blok en zien ze welke
collega's een gelijkwaardige dienst hebben waarmee de ruil binnen de regels
blijft. Een blok ruil je tegen een blok van dezelfde soort. Een dagdienst en
een avonddienst in het weekend zijn gelijkwaardig. De collega keurt goed of
wijst af. Gaat een ruil door, dan krijgen de planner en het roosterbureau
bericht via de stroom van de AIOS. Voeg in die stroom daarvoor de rijen
*Planner* en *Roosterbureau* toe, net als bij de achterwacht. Op de pagina van
de periode zie je alle ruilverzoeken.

**Vanaf versie 0.81.0** is het rooster voor de AIOS in gebruik. Probeer het
eerst op de testinstallatie. Zo begin je:

1. De beheerder maakt bij *Accounts beheren* een account voor de planner van
   de AIOS: rol *Planner*, dienst *AIOS*. Geef het tijdelijke wachtwoord
   persoonlijk door.
2. De planner logt in en kiest een eigen wachtwoord. Daarna ziet de planner
   alleen de pool AIOS en niets van de achterwacht.
3. Bij *Personeel beheren* voeg je de AIOS toe: aios01, aios02 enzovoort.
4. Maak bij *+ Nieuwe periode* het kwartaal. De beheerder vult op de pagina
   van die periode bij *Mail naar de AIOS* het adres van de stroom van de
   AIOS in (zie 0.72.0).
5. Kies de deadline, open de periode en verstuur de uitnodigingen.

Een heel kwartaal stap voor stap doorlopen op de testinstallatie, met per stap
wat je moet zien: `docs/aios-testdraaiboek.md`. Welke tests je wanneer draait,
van een kleine fix tot een release, staat in `docs/teststrategie.md`. Zelf testen met een lijst om af te vinken:
`docs/stappenplan-testen.md`.

**Vanaf versie 0.82.0** vul je op de pagina van een AIOS-periode bij
*Voortgangstoets* de datum van de toets in. In de nacht ervoor heeft geen
AIOS dienst: een fellow doet die nacht. In het rooster en in de download
staat daar *Fellow*. Wie het is, regel je buiten de app. De andere nachten
van dat blok doet één AIOS, met de compensatiedagen op de twee dagen na de
laatste van die nachten. Dat kan tot het rooster gepubliceerd is. Verder
staat onder het dienstpercentage van elke AIOS nu ook het percentage over
dit kwartaal en de drie ervoor samen, met de geschiedenis van vóór de app.
Boven 25% waarschuwt de app daarover bij het publiceren. De AIOS zien het
bij hun eigen rooster. En op een parttimedag krijgt een AIOS nog steeds geen
uitloopdienst, maar de avond en de nacht van die dag staan nu op *liever
niet*: het rooster plant ze alleen als het niet anders kan. De AIOS kan er
zelf voorkeur of geblokkeerd van maken. Een eigen blokkade telt mee voor de
50%-regel. Bij ruilen kan een parttimer ook een avond of nacht op de
parttimedag krijgen.

**Vanaf versie 0.83.0** staat alleen de avond van een parttimedag op
*liever niet*. De nacht van die dag heeft weer geen markering: voor het
rooster is het een gewone nacht. Een AIOS ziet op het eigen voorkeurenscherm
wanneer de voortgangstoets is, en dat de nacht ervoor daarom niet in het blok
staat.

**Vanaf versie 0.84.0** werken de achterwacht en de AIOS ook achter de
schermen helemaal los van elkaar. Wie bij de ene dienst hoort, kan niets
opslaan via de onderdelen van de andere. Een AIOS die je aan de pool
toevoegt terwijl een kwartaal open staat, krijgt de eigen parttimedagen en
afwezigheid meteen in dat kwartaal. En de app start ook als de solver van
de AIOS niet start.

**Vanaf versie 0.85.0** toont het voorkeurenscherm van de AIOS bij een
parttimedag of afwezigheid ook de stand: *PT✕* bij de uitloopdienst (vast)
en *PT~* bij de avond (liever niet, aan te passen). Zo is het ook zonder kleur
en op papier duidelijk. Een AIOS kan per weekdag één parttimedag tegelijk
opgeven: twee patronen op dezelfde dag telden voor de fte dubbel. Bij de
geschiedenis van vóór de app weigert de import een rij met meer
feestdagdiensten dan diensten.

**Vanaf versie 0.86.0** verandert er niets meer aan een achterwachtperiode
in de prullenbak. Open je hem via een bladwijzer of een tabblad dat nog
openstond, dan staat bovenaan dat hij in de prullenbak staat. Openen,
genereren of publiceren geeft dan de melding *Deze periode staat in de
prullenbak. Zet hem eerst terug.* Haal je bij de AIOS de voortgangstoets
weg of verschuif je hem nadat het rooster gemaakt is, dan gaat de nacht die
terugkomt naar de AIOS die de rest van dat blok heeft. Kan dat niet, dan
zegt de app waarom en vul je die nacht met de hand in. En *Ongedaan maken*
na *Wisselen* zet een dienst van de achterwacht weer helemaal terug: een
nieuwe generatie mag hem daarna weer verplaatsen.
De pagina van een AIOS-periode klapt nu in en uit zoals die van de
achterwacht. Alle onderdelen staan eerst dicht. Klik op een titel om het
te openen. Een ander onderdeel openen klapt het vorige dicht, tenzij je
het met de punaise vastzet.

**Vanaf versie 0.808.0:** de knop *Per AIOS met compensatiedagen* is weg, en met hem het Excelbestand met een kolom compensatiedagen. Het roosterbureau kiest die dagen zelf, voor of na een dienst, aan de hand van de drukte en wie er die dag nog meer afwezig is. Een lijst met compensatiedagen uit de app paste daar niet bij. *Rooster per dag* blijft. Het aantal diensten, de punten en het dienstpercentage per AIOS staan op de pagina van de planner, in de tabel *Dienstdoende*. De regels voor rust en compensatiedagen in de solver zijn niet veranderd.

**Vanaf versie 0.807.0:** staat er voor iemand al een beginsaldo, dan waarschuwt de wizard (stap *Saldi*) eerst voordat een nieuw bestand het overschrijft. De melding noemt de namen en zegt dat ook een leeg vakje telt (als 0) en dat wie niet in het bestand staat zijn saldo houdt. Pas na *Ja, overschrijven* wordt het bestand meegenomen. De server vraagt hetzelfde als iemand de import buiten de wizard aanroept. Bij de AIOS (*Geschiedenis van vóór de app*) vervangt Bewaren de hele geschiedenis van de pool. Staat er al een geschiedenis, dan vraagt Bewaren eerst om bevestiging en noemt de AIOS die daarna geen geschiedenis meer hebben (wie niet met cijfers in het bestand staat).

**Vanaf versie 0.806.0:** de import van een oud saldo (stap *Saldi* van de wizard) en van *Eerdere toewijzingen* neemt alleen nog een Excel-bestand (.xlsx), in de opmaak van een sjabloon. Naast het bestandsveld staat de knop *Sjabloon downloaden (Excel)*. Het sjabloon van het saldo heeft een rij per medewerker die meedoet, het sjabloon van de eerdere toewijzingen een rij per dag van het overloopvenster met het diensttype erbij. Wat al ingevuld is, staat er al in. Een CSV of een Excel-bestand met andere kolommen wordt geweigerd voordat er een rij gelezen wordt, met een melding die de kolommen noemt. Het gedownloade rooster (Excel) kan nog steeds bij *Eerdere toewijzingen* terug. Voor de AIOS was dit al zo.

**Vanaf versie 0.805.0:** een audit met 8 invalshoeken, de bevindingen die we samen bespraken zijn opgelost.
- *Tweestapsverificatie weg:* de knop, het scherm, de controle bij het inloggen en de bibliotheken zijn uit de app gehaald, voor planners en beheerders van beide diensten. Inloggen kan met alleen het wachtwoord.
- *Volgorde van periodes:* een periode kan pas een rooster krijgen of gepubliceerd worden als de periode ervoor gepubliceerd is (of in de prullenbak staat). Anders klopt het saldo niet. Genereren kan alleen vanuit gesloten (of opnieuw vanuit gegenereerd).
- *Terug naar open:* haalt de afwezigheid en de parttimedagen bij die in de tussentijd zijn veranderd, wist de vastgezette deelnamefactoren en kan niet meer als de periode al begonnen is.
- *Saldo:* een beginsaldo-import verliest het eerdere saldo van iemand niet meer als er één getal in hun rij fout is. Een tegoed groter dan het bereik geeft doel nul en geen valse waarschuwing bij het publiceren.
- *Periode openen* controleert de naam, het aanmaken het type van de pool.
- *Lidmaatschap:* wijzigen of verwijderen op dagen die in een periode met een rooster (gegenereerd of gepubliceerd) vallen, vraagt eerst om bevestiging. Het rooster verandert er niet mee.
- *Deadline* wijzigen stuurt de versie van de periode mee. Heeft iemand anders hem net gewijzigd, dan krijg je een melding in plaats van dat zijn wijziging overschreven wordt.
- *Dubbele mail:* een verzending tegelijk per periode, ook voor de AIOS en naast de automatische herinnering.
- *Link kwijt:* drie keer per uur per adres in plaats van per kwartier.
- *Links verlopen* na de laatste dag van hun periode.
- *Rooster opnieuw mailen:* een knop bij een gepubliceerd rooster (achterwacht en AIOS) voor als de mail van de publicatie mislukte. Iedereen krijgt de mail dan opnieuw.
- *Wachtwoord van de beheerder:* vul op de startpagina bij Link kwijt het Gmail-adres van de Mailinstellingen in. Dat account krijgt een link om een nieuw wachtwoord te kiezen. Een noodweg: voor elk ander adres verandert er niets.
- *AIOS:* ruilen en wijzigen met de hand kijken ook acht dagen vooruit, als het rooster van het volgende kwartaal al bestaat.
- *Voorkant:* het ruilpaneel houdt zijn lijst bij een mislukte verversing, dubbel klikken op goedkeuren stuurt één verzoek, meldingen blijven gelezen, de filter op codenaam houdt de focus, de AIOS-pagina's Ruilen en Publiceren tonen een laadfout met Opnieuw proberen, en labels horen bij hun veld.

**Vanaf versie 0.804.0:** een nieuwe audit, met nieuwe tests en mutatietests.
- *Toetsenbord in dialogen:* een dialoog neemt de focus bij het openen, Tab en Shift+Tab blijven erin, en met Escape komt de focus terug op de knop die hem opende. Tab liep eerder zo de dialoog uit, de pagina erachter in.
- *Sessiesleutel:* een leeg of afgebroken sleutelbestand naast de database (door een crash tijdens het schrijven) blokkeerde de hele app tot iemand het met de hand verwijderde. Het wordt nu vervangen door een nieuwe sleutel. Iedereen moet dan eenmalig opnieuw inloggen.
- *Herhaalplanner:* een uitkomst zonder lijst van lege diensten telde als perfect en stopte de pogingen. Dat is nu niet meer zo.
- *Adres bij een onbruikbare Host-header:* het terugvaladres is nu `https://localhost` (poort 443), in plaats van een adres met poort 8010.
- *Tests:* de eerste installatie van een account, de sessiesleutel, de oproep naar een solver, de keuze van het beste rooster en het adres uit de Host-header hebben nu eigen tests, elk met mutaties.

**Vanaf versie 0.803.0:** bovenaan de sectie *Persoonlijke links* (achterwacht en AIOS) staat de knop *Alles intrekken*. Die trekt alle werkende links van de periode in, na een vraag die zegt om hoeveel links en medewerkers het gaat. Alle betrokken medewerkers zijn dan overal uitgelogd en komen er pas weer in met een nieuwe link (Link kwijt? of een nieuwe uitnodiging). Links van andere periodes blijven werken. Het staat in het logboek.

**Vanaf versie 0.802.0:** de beheerder kan persoonlijke links intrekken. Op de pagina van een periode (achterwacht en AIOS) staat een nieuwe sectie *Persoonlijke links*, alleen zichtbaar voor de beheerder. Daar staat per link voor wie hij is, wanneer hij gemaakt en voor het laatst gebruikt is, en of hij nog werkt. De link zelf is niet te zien. *Intrekken* vraagt eerst om bevestiging. Daarna werkt die link niet meer en is de medewerker overal uitgelogd. Heeft de medewerker nog een andere werkende link, dan komt hij daar weer mee binnen. Was het de enige, dan staat dat in de vraag en komt de medewerker er pas weer in met een nieuwe link (Link kwijt? of de volgende uitnodiging). Het intrekken staat in het logboek.

**Vanaf versie 0.801.0:** poort 80 staat standaard open en stuurt `http://` door naar `https://`, zonder `.env`. Is poort 80 bezet, zet dan `HTTP_PORT=8080` in `.env`.

**Vanaf versie 0.800.0:** `docker-compose.yml` is de hele installatie. De Caddyfile zit er nu in, dus er hoeft niets naast het bestand te staan behalve `.env` en eventueel de map `certs`. De app luistert standaard op https, poort 443. Draait de NAS zelf al iets op 443, zet dan `APP_PORT=8010` in `.env`, zoals bij een installatie die tot nu toe op de standaardwaarde draaide. Een installatie die `APP_PORT` al in `.env` heeft staan, merkt niets. Ook zijn drie dingen die nog geen eigen test hadden nu gedekt: het stoppen van de AIOS-solver als de aanvrager ophangt, de regelnummers in meldingen van de voorkeurenimport en de grootte van de AIOS-dialogen op een telefoon.

**Vanaf versie 0.112.0:** een tweede audit, nu vanuit andere hoeken: gelijktijdigheid, de solvers onder vijandige invoer, data en tijdzones, beveiliging, import en export, toegankelijkheid en taal, herstel en prestaties, en de kwaliteit van de tests zelf. Wat bleek is hersteld.

- Een Excel-bestand van 59 kB liet de server crashen. De lezer weigert nu meer dan 20 000 rijen of een miljoen celplaatsen. Een melding bij een import noemt de rij zoals Excel hem telt, ook als er lege rijen tussen zitten. De import van de achterwacht laat een deeltijd- of afwezigheidsblokkade staan als het bestand hetzelfde woord herhaalt, meldt een kolom zonder kop die wel gegevens heeft en weigert tijdens een generatie.
- Beveiliging: een verzoek dat iets wijzigt en van een pagina van een andere site komt, wordt geweigerd. Dat gold niet voor een pagina op hetzelfde adres met een andere poort of naam. Een personal link logt alleen in als de pagina hem zelf opent. Een staf-account telt niet als deelnemer voor de personenroutes en een ondertekend token dat geen sessie is, wordt niet als sessie gelezen.
- Gelijktijdigheid: een rooster dat klaar komt nadat de periode in de prullenbak ging, wordt er niet meer in geschreven, en verwijderen kan niet tijdens een generatie. De deelnamefactoren die een generatie vastlegt, gaan terug als hij zonder rooster eindigt. Uitnodigingen en herinneringen gaan niet dubbel bij een dubbelklik. Een beginsaldo-bestand dat twee keer wordt verstuurd telt een keer.
- Op de schermen staat geen Engelse foutmelding van de browser meer ("Failed to fetch"), "1 dienst" en "2 diensten" worden goed geschreven, de dagknoppen van de voorkeurenkalender hebben een naam met datum, de speld bij de onderdelen werkt met het toetsenbord, velden hebben een label en elke pagina een eigen titel.
- De AIOS-solver weigert onzinnige getallen, tijden en perioden. Een grote overloop is een groot verschil en geen onmogelijk model. De solver begint met het lege rooster als eerste oplossing, telt de bouwtijd mee in de tijdslimiet, stopt als de aanvrager weg is en maakt een rooster tegelijk. Een solver die niet bereikbaar is, geeft de planner een duidelijke melding.
- Data en tijd: de AIOS-deadline moet in de notatie van het formulier staan en een echte datum zijn. Vandaag is de datum op de afdelingsklok, niet die van de machine. Dagen zonder tijd worden niet meer een dag te vroeg getoond.
- De checks zijn bestand tegen de kalender: seed, e2e, full-check en ui-check schuiven mee met de echte datum (`scripts/demoKalender.mjs`) en het scenario zoekt zelf het eerstvolgende jaar met ISO-week 53. Zonder dat waren ze vanaf eind 2026 mislukt.
- De container start Next zelf zodat een stopsein aankomt, certificaten komen niet in een image, de back-up slaat over bij te weinig ruimte en ruimt een halve kopie op.

**Vanaf versie 0.111.0:** een audit van het hele systeem, met herstel van wat bleek.

- De regels over rust en compensatiedagen lopen nu door over de grens van een kwartaal. Wie in het vorige kwartaal het laatste nachtblok deed, heeft de eerste dagen van het nieuwe kwartaal vrij en 46 uur rust. De solver, de controle en de waarschuwingen bij handmatig wijzigen en ruilen houden er rekening mee.
- Het saldo en de doelen: een kleine schuld aan feestdagdiensten of weekenddiensten verdwijnt niet meer door afronden. Het opgeslagen doel mag negatief zijn, zodat het volgende kwartaal de schuld ziet. Een rooster met iemand die intussen uit de pool is, geeft geen foutmelding meer maar een waarschuwing. Een kwartaal zonder deelnemers zegt dat in woorden.
- De AIOS kan hoogstens 20 ruilverzoeken per 24 uur doen, zoals de achterwacht. Een planner die meekijkt op de ruilpagina van een AIOS maakt de verzoeken niet meer "gelezen".
- Beveiliging: tweestapsverificatie wordt niet meer stilletjes vervangen, velden die geen tekst zijn geven een melding in plaats van een fout, een deadline moet als datum met tijd zijn geschreven, de datums van deeltijdpatronen zijn beperkt tot 2000 t/m 2199, de AIOS-afwezigheidslijst controleert de periode, en een planner die namens een deelnemer handelt (afwezigheid, deeltijd, ruilen) laat een spoor in het logboek achter.
- Een verwijderde periode laat zijn ruilverzoeken en meldingen niet meer zien en ruimt zijn voorkeurenbestanden op.
- De klapbare onderdelen: afdrukken geeft het rooster, ruilen blijft staan als je een ander onderdeel opent, en de knop om vast te zetten is beter te zien en te lezen.
- Releases: "Vrijgeven" controleert eerst alle drie de images en de tag voordat `stable` verschuift. De workflows hebben minder rechten. De database kreeg drie indexen.

**Vanaf versie 0.110.0:** de pagina van een deelnemer is een harmonica zodra het rooster gepubliceerd is. Bij de AIOS zijn dat drie onderdelen: "Jouw rooster", "Ruilen" en "Voorkeuren". Onder "Voorkeuren" staan de stappen zoals eerder (deeltijd, afwezigheid, voorkeuren en bevestigen). Bij de achterwacht zijn het twee onderdelen: "Jouw rooster" met het saldo en de diensten per week, en "Ruilen". Alle onderdelen staan dicht tot je erop klikt. Een onderdeel openen klapt het vorige dicht, tenzij je het met de punaise vastzet. Zolang het rooster nog niet gepubliceerd is, ziet de deelnemer de pagina zoals eerder, met de stappen onder elkaar. Dit is alleen een andere indeling: er verandert niets aan wat je kunt doen.

**Vanaf versie 0.109.0:** bij "Nieuwe afwezigheid toevoegen" voor de AIOS zijn de begin- en einddatum leeg, in plaats van het hele kwartaal. Kies je een begindatum, dan staat de einddatum op de dag erna. Er is een nieuwe soort afwezigheid bij: onderwijs, naast vakantie, congres/cursus en overig. Onderwijs blokkeert de dagen zoals de andere soorten en staat ook zo in de bestanden. In het raster van het bestand "Voorkeuren per dienst" staat bij een dag die door afwezigheid geblokkeerd is nu de soort erbij, bijvoorbeeld "geblokkeerd (afwezig: vakantie)". Een oud bestand met alleen "(afwezig)" wordt bij het inlezen nog steeds overgeslagen. Een database die de seed eerder maakte, krijgt de nieuwe soort bij de eerstvolgende start. Voor een database uit de migraties doet migratie 0036 dat. Bij de achterwacht verandert niets.

**Vanaf versie 0.108.0:** de dagdiensten en de avonddiensten in het weekend hebben elk een eigen saldo, net als de nachtdiensten. Wie in het vorige kwartaal minder weekenddagdiensten of weekendavonden deed dan eerlijk, krijgt er nu meer, en wie er meer deed, minder. Dat staat bij "Dienstpercentage en saldo" in woorden, bijvoorbeeld "2 dagdiensten extra" of "1 weekendavonddienst minder". Een tekort aan dagdiensten kun je dus niet meer goedmaken met avonden. Voor het eerste kwartaal na deze versie is er nog geen doel van het vorige kwartaal, dus dan is dit saldo nul. De geschiedenis van vóór de app telt de kolommen met dagdiensten en avonden weekend wel mee, het sjabloon blijft gelijk. De AIOS-solver krijgt de saldo's mee en zet ze bij het eerlijke aantal. Een oudere solver-container negeert ze.

**Vanaf versie 0.107.0:** de nachtdiensten tellen mee in het saldo. Wie in het vorige kwartaal minder nachtdiensten deed dan eerlijk, krijgt er nu meer, en wie er meer deed, minder. Dat staat bij "Dienstpercentage en saldo" in woorden, bijvoorbeeld "1 nachtdienst extra". Voor het eerste kwartaal na deze versie is er nog geen nachtdoel van het vorige kwartaal, dus dan is het nachtsaldo nul. De geschiedenis van vóór de app telt de nachten wel mee. De AIOS-solver krijgt het nachtsaldo mee en zet het bij het eerlijke aantal nachten. Een oudere solver-container negeert het.

**Vanaf versie 0.106.0:** "Ongedaan maken" geldt alleen in het directe moment. De server weigert het na twee minuten, ook voor wie het zelf aanroept. De knop is weg na verversen, na uitloggen en na twee minuten, en verschijnt alleen na een wijziging op die pagina. Dat geldt voor de roosterwijzigingen, de ledenlijst en de AIOS. Ook is de scheiding tussen achterwacht en AIOS aangescherpt na een audit. De mailinstellingen van de achterwacht zijn niet meer te lezen door de AIOS-planner. Een persoon hoort bij de dienst waarin die iets heeft, ook na verwijdering uit alle pools. Een deelnemer ziet niets van de periode van de andere dienst. De prullenbak ruimt per dienst op, de uurlijkse taken falen los van elkaar, en de achterwacht-herinneringen en "Link kwijt?" raken nooit een AIOS-periode.

**Vanaf versie 0.105.0:** elke verzendlijst heeft een veld `dienst` (`ACHTERWACHT` of `AIOS`). Eén Power Automate-stroom kan daarmee beide diensten bedienen: hij leest op basis van dat veld het Excel-bestand van de juiste dienst, elk bestand op een eigen plek met een eigen tabel `Adressen`, en let op één postvak. Een stroom die alleen voor de achterwacht is gebouwd, werkt ongewijzigd door. Het draaiboek in docs/verzendlijst-power-automate.md beschrijft de stroom nu voor beide diensten.

**Vanaf versie 0.104.0:** op de AIOS-periodepagina staan rooster maken, publiceren, definitief maken en publicatie intrekken nu bovenaan in één kaart met de status, zoals bij de achterwacht. De vragen over de blokken rond de feestdagen staan eronder in een eigen sectie. Is een periode gesloten, dan kunnen deelnemers ook geen deeltijddagen of afwezigheid meer toevoegen of wijzigen, bij de achterwacht en bij de AIOS. Eerder kon dat nog wel, terwijl voorkeuren en bevestigen al dicht waren. In Dienstpercentage en saldo heet de kolom "Liever niet" nu "Ingedeeld op liever niet dagen".

**Vanaf versie 0.103.0:** de AIOS-solver verdeelt de diensten eerlijker per soort, in de volgorde die de planner koos: nachtdiensten, dagdiensten, avonddiensten in het weekend, avonddiensten doordeweeks en uitloopdiensten. In een meting met 20 AIOS liep het aantal nachtdiensten eerst uiteen van 0 tot 8 en nu van 3 tot 6. Uitloopdiensten compenseren een gemiste nachtdienst minder snel. De achterwacht verandert niet.

**Vanaf versie 0.102.0:**

- *Ruilen alleen bij een definitief rooster* (achterwacht en AIOS). Bij een voorlopig
  rooster staat op de pagina van de deelnemer waarom, met het contactadres van de
  planner. Open verzoeken op een voorlopig rooster zijn bij deze update ingetrokken.
- *Ingetrokken in plaats van vervallen:* wat niet meer kan, is nu ingetrokken. Dat
  geldt ook voor het verzoek van een derde als iemand anders de dienst al geruild
  heeft (bij de achterwacht stond dat als afgewezen). Wijzigt de planner een
  dienst met de hand of trekt hij de publicatie in, dan krijgen de aanvrager en de
  collega een mail dat het verzoek is ingetrokken.
- *Herinneringen:* een verzoek dat na 6 tot 7 dagen nog openstaat, krijgt om 09:00
  vanzelf een herinnering. Bij elk openstaand verzoek staat ook een knop *Herinnering
  sturen*, voor de aanvrager en voor de planner. Die vraagt eerst een bevestiging en
  toont wanneer de vorige herinnering ging. Niet vaker dan eens per 24 uur. De
  aanvrager krijgt een bericht dat er een herinnering is gestuurd.
- *Twee overzichten:* de deelnemer ziet *Jouw ruilverzoeken* en *Ontvangen ruilverzoeken*,
  elk met een keuzelijst op status en het aantal erachter. De planner ziet dezelfde tabel
  bij de AIOS als bij de achterwacht, met *Gelezen* en de laatste herinnering.
- *Gelezen:* bij de achterwacht bleef een verzoek op *Nog niet gelezen* staan, ook als
  de collega al had geantwoord. Dat is opgelost. De AIOS krijgen dezelfde kolom.
- *Mail bij een gelukte ruil:* de aanvrager en de collega krijgen allebei een
  bevestiging. Het Roosterbureau krijgt één mail, met de twee collega's en de planner
  in de CC (de stroom zoekt die op, zie docs/verzendlijst-power-automate.md).
- *Wachtrij voor de AIOS:* ruilmails van de AIOS die niet weg kunnen, wachten en gaan
  later, zoals bij de achterwacht. De beheerder ziet bij Mailinstellingen wat er wacht.
- *Mailinstellingen per dienst:* het Gmail-account blijft voor beide samen. Per dienst
  staan er het adres van de stroom, het contactadres van de planner en de wachtrij.

**Vanaf versie 0.101.0:**
- *Dienstrooster:* de secties *Per week*, *Handmatige correctie gegenereerde
  rooster*, *Diensten (toelichting)* en *Ruilen* van de AIOS-pagina zijn één
  sectie geworden, onderaan de pagina, net als bij de achterwacht. De naam zegt
  tussen haakjes hoe het rooster staat: *nog niet gegenereerd*, *automatisch
  ingevuld*, *handmatig aangepast* (zodra je na het maken een dienst met de hand
  hebt gegeven of leeggemaakt) of *gepubliceerd*. Bovenin staat de tabel van de
  diensten als legenda. Daaronder vier tabbladen: *Lijst* (alle diensten met wie
  ze doet), *Kalender* (de weken, met het ingevulde rooster zodra dat er is),
  *Dienstdoende* (per AIOS het aantal nachten, avonden, dagdiensten en
  uitloopdiensten met een balkje) en *Ruilverzoeken* (leeg tot het rooster
  gepubliceerd is). Wijzigen met de hand kan in de lijst en in de kalender.
- *Dienstpercentage en saldo:* de tabel *Per AIOS* heet nu zo.
- *Volgorde:* *Geschiedenis van vóór de app* is de eerste sectie van de
  periodepagina. *Dienstrooster* is de laatste.

**Vanaf versie 0.100.0:**
- *Twee diensten op één dag bij het met de hand aanpassen:* kies je voor een dienst
  een AIOS die die dag al een andere dienst heeft, bijvoorbeeld een nachtdienst
  voor wie al een avonddienst doet, dan staat bij die AIOS een eigen waarschuwing
  die de andere dienst en de dag noemt. Kies je die AIOS, dan vraagt het scherm
  nog eens of het echt de bedoeling is, met een eigen knop om te bevestigen.
  Het blijft een waarschuwing, geen blokkade. De andere dienst blijft staan.
- *Toelichting bij het kiezen:* in dat scherm staat de toelichting van de AIOS bij
  een geblokkeerde of liever-niet-dag nu ook nog eens in de vraag of je zeker
  weet dat je die AIOS kiest.

**Vanaf versie 0.99.0:**
- *Parttimedagen in het Voorkeurenoverzicht:* onder de verzoeken staan de regels
  *Parttime 1* en *Parttime 2* (meer als een AIOS er meer heeft) met de
  parttimedagen van de AIOS in dat kwartaal, bijvoorbeeld *maandag* of *dinsdag, even
  weken*. Zo blijft ook dit onderdeel van de back-up compleet. De import voegt ze
  toe bij een AIOS die er nog geen heeft. Heeft de AIOS al andere
  parttimedagen, dan meldt de import dat als probleem en haalt niets weg. Een
  bestand zonder die regels laat de parttimedagen zoals ze zijn. Afwezigheid
  staat nog niet in het bestand: alleen als *(afwezig)* in de cellen.

**Vanaf versie 0.98.0:**
- *Voorkeurenoverzicht:* bovenaan het Excel-bestand staan vijf regels met wat de AIOS
  verder vraagt: *4 avonden*, *4 nachten*, *twee dagdiensten*, *inwerken* en
  *onderbreking van de opleiding*. Het bestand is ook de back-up, dus die
  gegevens horen erin. De import van de beheerder leest die regels weer in. Een
  bestand zonder die regels (van voor deze versie) laat de verzoeken zoals ze zijn.

**Vanaf versie 0.97.0:**
- *Verzoeken van de AIOS:* het tekstvak *Algemene verzoeken* is weg, want de
  solver deed er niets mee. De keuzes bovenaan (4 avonden, 4 nachten, twee
  dagdiensten, inwerken en een onderbreking van de opleiding) worden nu
  meteen opgeslagen, net als de voorkeuren in de kalender. De knop *Verzoeken
  opslaan* bestaat niet meer. De kolom *Opmerking* is ook uit het Excel-bestand
  *Verzoeken per AIOS*. Wat AIOS eerder in dat veld schreven, wordt nergens
  meer getoond.
- *Kalender van de AIOS:* tussen de dagen staat een verticale lijn en rond
  een weekend een dubbele lijn.
- *Mailinstellingen:* de beheerder opent ze ook op het overzicht van de
  periodes, naast *Accounts beheren*. Daar hoef je geen periode voor te
  openen.

**Vanaf versie 0.96.0:**
- *Verwijderde periode:* een persoonlijke link naar een periode in de prullenbak
  toont de melding dat de periode is verwijderd, met een verwijzing naar de
  startpagina om een nieuwe link aan te vragen bij "Link kwijt?". Dat geldt voor
  de achterwacht en de AIOS. Een planner of beheerder die zo'n periode opent,
  ziet dezelfde melding met een verwijzing naar de Prullenbak om hem terug te
  zetten.

**Vanaf versie 0.95.0:**
- *Factoren per periode:* de deelnamefactor (bij de AIOS de fte) wordt vastgelegd
  zodra het rooster van een periode gemaakt wordt. De publicatiecontrole, de
  overloop en het dienstpercentage tellen daarna met die waarde, ook als de
  parttimedagen later veranderen. Het ene kwartaal kan 1,0 zijn en het volgende
  0,8: het dienstpercentage over meerdere kwartalen telt elk kwartaal met zijn
  eigen fte. Maak je het rooster opnieuw, dan geldt de factor van dat moment.
  Verwijder je het rooster, dan volgt de factor weer de parttimedagen.
- *Toelichting:* alleen de beheerder krijgt de toelichtingen in het
  voorkeurenoverzicht (de back-up), bij elke keuze van die dag. Het overzicht
  van de AIOS-planner heeft ze niet. De planner ziet de toelichting alleen bij
  het met de hand aanpassen of aanvullen van het rooster, en de AIOS leest dat
  ook zo. De import leest de toelichting ook achter een voorkeur.
  Importeer daarom het bestand van de beheerder (de back-up): in een bestand
  zonder tekst achter een keuze gaat de toelichting van die dag weg.
- *Voorlopig en definitief:* de statusbalk van de AIOS zegt *Voorlopig
  gepubliceerd* of *Definitief*. De Excel voor het roosterbureau (*Rooster per
  dag*) bestaat pas bij een definitief rooster, en het
  roosterbureau krijgt alleen een bericht over een ruil in een definitief
  rooster. Bij een voorlopig rooster krijgt alleen de planner dat bericht.

**Vanaf versie 0.94.0** is alles van 0.90.0 tot en met 0.93.0 nagelopen en
bijgewerkt waar dat nodig bleek.
- *Parttimedagen:* een tweede parttimedag op dezelfde dag en week wordt
  geweigerd (zoals bij de AIOS al zo was), want de deelnamefactor telt elke
  dag eenmaal. Wat er al dubbel stond telt ook eenmaal. Een parttimedag op
  zaterdag of zondag telt niet mee voor de factor. Bij een lidmaatschap voor
  een deel van de periode telt de factor over de dagen van dat
  lidmaatschap.
- *Personeel beheren:* de lijst zegt voor welke periode de factor geldt. In
  de wizard hoort de factor bij de periode waar je mee bezig bent. Bij de AIOS
  telt de uitnodiging van het kwartaal ook als dat kwartaal al gepubliceerd
  is.
- *AIOS, lege diensten:* de lijst *Nog leeg* komt uit het rooster zelf. Een
  dienst die je met de hand leegmaakt staat er direct bij. Een dienst die er
  niet meer is, staat er niet meer in.
- *AIOS, status:* de melding dat eerst het rooster verwijderd moet worden
  verdwijnt zodra de status verandert. *Terug naar open* wordt geweigerd
  terwijl er een rooster gemaakt wordt. Na *Rooster verwijderen* is ook de
  tweede nacht van oudjaar weg.
- *AIOS, toelichting en import:* het voorkeurenoverzicht zet de toelichting
  alleen bij geblokkeerd of liever niet, zodat het bestand ongewijzigd weer
  ingelezen kan worden. Een oude toelichting komt niet terug bij een nieuwe
  markering. De import wordt geweigerd terwijl er een rooster gemaakt wordt.
  De AIOS leest nu dat de planner de toelichting ook in het
  voorkeurenoverzicht ziet.

**Vanaf versie 0.93.0** typt de planner geen deelnamefactor meer in, bij de
achterwacht niet en bij de AIOS niet. De factor volgt uit de parttimedagen
die de medewerker zelf opgeeft bij *Deeltijd*: een dag per week vrij is 0,8
(80%), een dag om de week 0,9, nooit onder 0,2. Een patroon dat maar een deel
van de periode geldt, telt naar verhouding. Bij *Personeel beheren* staat in
de kolom *Deelnamefactor* eerst *nog onbekend*. Zodra de medewerker de
voorkeuren voor de periode heeft ingediend, staat er de factor (*Voltijd* of
een percentage). De solver gebruikt dezelfde afgeleide waarde, ook als de
medewerker nog niet heeft ingediend (zonder parttimedagen is dat 1,0).
De waarde die vroeger bij een lid is ingetypt, wordt niet meer gebruikt.
Had een parttimer die waarde maar geen parttimedagen bij *Deeltijd*, dan telt
die vanaf nu als voltijd tot de parttimedagen zijn ingevuld.

**Vanaf versie 0.92.0** heeft de pagina van een AIOS-periode een sectie
*Exporteren & communicatie*, op dezelfde plek en met dezelfde knoppen als bij
de achterwacht: *Uitnodigingen en herinneringen* (een venster met
uitnodigingen versturen, herinneringen versturen aan iedereen of per AIOS,
de persoonlijke links als Excel en de wijzigingsgeschiedenis als Excel),
*Deadlineherinnering versturen*, *Mailinstellingen* (alleen de beheerder),
*Statusrapport downloaden*, *Voorkeurenoverzicht downloaden (Excel)* en het
rooster als Excel. De knoppen voor uitnodigingen, herinneringen, links en de
mail staan dus niet meer bij *Voorkeuren van de AIOS*. Alleen de beheerder
heeft er ook *Voorkeuren importeren (test)*: het ingevulde voorkeurenoverzicht
wordt teruggelezen, met de toelichting per dag. *Controleren* verandert niets
en laat zien wat er zou veranderen. Dat kan zolang het rooster nog niet
gemaakt is.

**Vanaf versie 0.91.0** kan een AIOS bij een dag die ze op geblokkeerd of
liever niet zetten een toelichting geven. Die is niet verplicht en hoogstens
120 tekens. Alleen de planner van de AIOS ziet de toelichting: bij het met
de hand aanpassen van het rooster, bij elke AIOS die de dienst kan krijgen,
en in het voorkeurenoverzicht (Excel) achter de keuze, bijvoorbeeld
*geblokkeerd: ziek kind*. De toelichting staat nooit in een ruilverzoek en
niet op het scherm van een andere AIOS. Dit vraagt een databasewijziging
(migratie 0031), die bij het opstarten vanzelf gebeurt.

**Vanaf versie 0.90.0** staat bovenaan de pagina van een AIOS-periode de
status, met de knoppen *Periode sluiten* en *Terug naar open*, zoals bij de
achterwacht. Terug naar open kan alleen vanuit gesloten. Is het rooster al
gemaakt, dan zegt de pagina dat je eerst het rooster moet verwijderen
(bij *Rooster*), en bij een gepubliceerd rooster ook dat je eerst de
publicatie intrekt. Wat de app na het maken van het rooster meldt over de
diensten die leeg bleven, blijft nu bewaard: je ziet het ook na verversen of
opnieuw inloggen. Een dienst die je met de hand invult, verdwijnt uit de
lijst *Nog leeg*. De sectie *Diensten* heet nu *Diensten (toelichting)* en
*Het rooster per week* heet *Handmatige correctie gegenereerde rooster*.
Dit vraagt een databasewijziging (migratie 0030), die bij het opstarten
vanzelf gebeurt.

**Vanaf versie 0.87.1** zegt de app bij het maken van het rooster van de
AIOS wat er misging. *De solver van de AIOS is niet bereikbaar* betekent
dat er niets antwoordt op het adres van de solver: de container
`aios-solver` draait niet, of staat niet in je `docker-compose.yml`.
Controleer met `docker compose ps` dat hij draait. Neem anders het
nieuwe `docker-compose.yml` over en draai `docker compose pull` en
`docker compose up -d`. *De solver van de AIOS stopte tijdens het maken*
betekent dat de verbinding wegviel terwijl hij rekende, bijvoorbeeld omdat
de container geen geheugen meer had. Kijk met
`docker compose logs aios-solver --tail 50` en zet zo nodig meer geheugen
bij `AIOS_SOLVER_MEM_LIMIT` in `.env`. Staat er een *foutcode*, dan zit de
fout in de app zelf. Zoek die code op met
`docker compose logs web | grep <foutcode>`.

**Vanaf versie 0.87.0** stelt alleen de beheerder de mail in, bij de
achterwacht net als bij de AIOS. Een planner ziet onder *Exporteren &
communicatie* geen knop *Mailinstellingen* meer, maar wel hoe de mail
ervoor staat. Zolang de mail niet is ingesteld, staan alle knoppen die iets
versturen zichtbaar uit, met de reden erbij. Bij de AIOS zijn dat
*Uitnodigingen versturen* en *Herinnering versturen*. Bij de achterwacht
zijn dat *Herinnering sturen* per persoon en aan iedereen,
*Deadlineherinnering versturen* en de keuzes om uitnodigingen of
herinneringen te versturen. Downloaden kan wel. Bij de AIOS kun je de
persoonlijke links dan zelf rondsturen met *Links downloaden*.

Terug naar een eerdere versie gaat op dezelfde manier: geef bij
*Vrijgeven (productie)* het oudere versienummer op. Of zet
`ROOSTER_VERSION=0.2.3` in `.env` om de server op één versie vast te zetten.

##### Op poort 443 met een eigen naam

De app luistert standaard op poort 443. Op een server met een eigen
DNS-naam, bijvoorbeeld `https://rooster.voorbeeld.nl`, is dus niets in
`.env` nodig, behalve dat je `BASE_URL` leeg laat. Het bestand
`docker-compose.yml` is de hele installatie: ook de Caddyfile zit erin en er
hoeft niets naast te staan.

Bezet de NAS poort 443 zelf (een Synology doet dat vaak voor DSM), zet dan
in `.env`:

```bash
APP_PORT=8010
```

Het adres wordt dan `https://<nas>:8010`.

De app bepaalt zelf zijn adres: uit de naam
waarmee de planner de app opent. Caddy maakt een certificaat voor elke naam
waarmee de server wordt aangesproken. Een nieuwe naam vraagt dus geen
aanpassing in `.env` of `docker-compose.yml`. Na een naamswijziging gebruiken
automatische herinneringen en ruilmails het nieuwe adres zodra de planner
via die naam iets verstuurt (uitnodigingen, een herinnering). Links in mails
die al verstuurd zijn, bevatten de oude naam. Laat die oude naam daarom nog
een tijd naar de server wijzen.

Ook `http://rooster.voorbeeld.nl` werkt zonder instelling: Caddy luistert
standaard op poort 80 en stuurt alles door naar https. Is poort 80 op de
server al bezet (op een NAS meestal), zet dan in `.env` een andere poort:

```bash
HTTP_PORT=8080
```

De doorverwijzing werkt dan alleen voor wie `http://<server>:8080` intikt.

Staat er een andere reverse proxy van de organisatie voor, dan moet die de
oorspronkelijke naam (de `Host`-header) ongewijzigd doorgeven. Anders kent
de app zijn eigen adres niet.

##### Draaien in een submap

De app kan onder een submap draaien, bijvoorbeeld
`https://<nas>/achterwacht` in plaats van een adres met poortnummer. Handig als
het adres al door een andere website wordt gebruikt.

- De submap wordt bij het bouwen vastgelegd. Bij **Bouwen (test)** vul je
  hem in bij *basispad*, bijvoorbeeld `/achterwacht`. Standaard is het leeg:
  geen submap.
- Zet in `.env` op de server:
  ```bash
  BASE_PATH=/achterwacht
  BASE_URL=https://<nas>/achterwacht
  ```
  `BASE_PATH` gebruikt Caddy om `https://<nas>/` door te sturen naar de
  submap (en is nodig als je zelf bouwt met `--build`). `BASE_URL` zorgt
  dat de links in mails de submap bevatten.
- **Ongedaan maken:** bouw opnieuw met een leeg *basispad*, haal
  `BASE_PATH` weg uit `.env` en zet `BASE_URL` terug op het adres zonder
  submap. Links in mails die al verstuurd zijn, bevatten nog de submap en
  werken dan niet meer; stuur zo nodig de uitnodigingen opnieuw.
- De poort staat hier los van: 443 werkt alleen als de NAS die poort zelf
  niet al gebruikt (een Synology doet dat vaak voor DSM). Zet anders
  `APP_PORT=8010` in `.env`.

Komt de app later achter de webserver van een andere site, onder een
submap van diens adres, dan moet die server alles onder de submap
ongewijzigd doorsturen naar de NAS, met het IP-adres van de bezoeker erbij.
Let op: de app deelt dan het adres met die andere site, en een zwakke plek
daar raakt ook Dienstrooster. Een eigen (sub)domein is veiliger.

##### Een aparte testinstallatie

Zet op dezelfde NAS een tweede kopie van de app in een eigen map, met in
`.env`:

```bash
ROOSTER_VERSION=test
APP_PORT=8011
DATA_DIR=./data
MAIL_UITGESCHAKELD=true
```

Een eigen map betekent eigen containers, een eigen database en een eigen
poort (hier https://<nas>:8011). Productie blijft onaangeroerd. Bijwerken
gaat met dezelfde twee commando's in die map.

Open de testinstallatie in de browser via een ander adres dan productie,
bijvoorbeeld de naam van de NAS voor test en het IP-adres voor productie.
Browsers houden cookies per adres bij, maar niet per poort: met hetzelfde
adres zouden beide installaties elkaars inlogcookie overschrijven, en met
een gekopieerde datamap zou een sessie van productie ook op test gelden.

`MAIL_UITGESCHAKELD=true` zorgt dat de testinstallatie nooit mail
verstuurt, wat er ook bij Mailinstellingen staat. Bovenaan de periodepagina
staat dan een melding dat versturen uit staat. Dat is belangrijk als je test
met echte gegevens: kopieer je de map `data` van productie naar de testmap,
dan gaan de mailinstellingen mee. Zonder deze regel zou de testinstallatie
echte uitnodigingen, herinneringen en ruilmails naar echte deelnemers
sturen, de automatische herinneringen al binnen een minuut na het starten.

Zelf bouwen vanuit de broncode kan nog steeds, met
`docker compose up -d --build`.

#### TLS-certificaat vertrouwen (de browserwaarschuwing oplossen)

Caddy geeft zelf certificaten uit vanuit een eigen, interne CA
(`pki { ca internal ... }` in de Caddyfile die in `docker-compose.yml` zit) - bewust, want deze installatie
heeft geen vaste domeinnaam en is alleen bedoeld voor het interne
netwerk (alleen `caddy` publiceert een poort, zie `docker-compose.yml`).
Browsers kennen die CA nog niet, vandaar de "niet veilig"-waarschuwing.
Er is niets mis met de verbinding zelf - alleen het vertrouwen ontbreekt.

**Optie 1 - het interne CA-certificaat vertrouwen (past bij dit ontwerp).**
Geen domeinnaam of internetverbinding nodig. Eenmalig per apparaat dat de
app gaat gebruiken:

1. Haal het root-certificaat uit de `caddy_data`-volume:
   ```bash
   docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt > dienstrooster-ca.crt
   ```
2. Installeer dat bestand als vertrouwde basis-CA:
   - **Windows:** dubbelklik → "Certificaat installeren" → "Lokale
     computer" → "Alle certificaten in het volgende archief opslaan" →
     "Vertrouwde basiscertificeringsinstanties"
   - **macOS:** open in Sleutelhangertoegang → sleep naar de
     "Systeem"-sleutelhanger → dubbelklik → "Vertrouwen" → "Altijd
     vertrouwen"
   - **Android:** Instellingen → Beveiliging → Certificaat installeren →
     CA-certificaat
   - **iOS:** installeer het bestand als configuratieprofiel (Instellingen
     → Algemeen → VPN en apparaatbeheer), zet daarna Instellingen →
     Algemeen → Info → Certificaatvertrouwensinstellingen aan voor dit
     certificaat
   - **Linux:** kopieer naar `/usr/local/share/ca-certificates/`, dan
     `sudo update-ca-certificates`

Let op een paar dingen:
- Dit moet op **elk** apparaat (pc, laptop, telefoon) dat de app gaat
  gebruiken, eenmalig gebeuren - elk besturingssysteem houdt zijn eigen
  lijst met vertrouwde CA's bij.
- **Firefox is een uitzondering** op elk platform: die gebruikt niet de
  CA-lijst van het besturingssysteem maar een eigen lijst, dus daar moet
  het certificaat apart geïmporteerd worden (Instellingen → Privacy &
  Beveiliging → Certificaten → Certificaten bekijken → Autoriteiten →
  Importeren).
- De CA blijft hetzelfde zolang de `caddy_data`-volume blijft bestaan
  (dus ook na een herstart van de server) - dit is dus eenmalig per
  apparaat, niet iets dat bij elke herstart opnieuw moet.
- Bij 20-40 medewerkers is het meestal efficiënter om dit certificaat
  centraal uit te rollen via de IT-afdeling (Group Policy/Active
  Directory voor Windows, of een MDM-oplossing zoals Intune/Jamf voor
  telefoons) dan om het per apparaat handmatig te doen.

**Optie 2 - een echt, publiek vertrouwd certificaat (Let's Encrypt).**
Alleen mogelijk met een eigen domeinnaam die vanaf het publieke internet
bereikbaar is op poort 80/443 - wat haaks staat op het huidige
"alleen intern netwerk"-ontwerp. Vervang in dat geval in `docker-compose.yml`, in het stuk Caddyfile van de
service `caddy`, de regel `https://:{$$APP_PORT:443}` door `https://jouw-domein.voorbeeld.nl`
en verwijder het blok `tls internal { on_demand }`; Caddy vraagt dan zelf
automatisch een Let's Encrypt-certificaat aan en vernieuwt dat ook zelf.
Voordeel: geen enkel apparaat hoeft dan nog iets te installeren.

**Optie 3 (een server met een eigen naam binnen het netwerk van de
organisatie): het certificaat van de organisatie.** Zie
`docs/installatie-it.md`. Die handleiding voor de IT-afdeling zit ook in de
image, zodat een installatie niets van GitHub nodig heeft behalve de image.

#### Productie

1. `docker compose up` op eigen hardware (geen cloud/Kubernetes vereist).
2. **Een schone start:** dat is de standaard (`SEED_ON_START=planner`).
   De app maakt het beheerdersaccount `admin`, de pool, de soorten
   diensten, de berichtteksten en 30 deelnemers (staf01 tot en met
   staf30) aan, zonder voorkeuren en zonder periode. Bij de eerste keer
   inloggen kies je een eigen wachtwoord. Planners maak je aan bij
   *Accounts beheren*. Deelnemers pas je aan, voeg je toe of zet je uit via
   de pagina van de pool.
3. **Back-ups:** de app maakt elke dag zelf een kopie van de database in
   `data/backups/database/` (`rooster-JJJJ-MM-DD.db`) en bewaart de laatste
   14. Zo'n kopie is compleet, ook terwijl de app draait. Kopieer
   `rooster.db` niet zelf terwijl de app draait: de laatste wijzigingen
   kunnen dan nog in `rooster.db-wal` staan. Neem de map
   `data/backups/database/` mee in de back-up van de NAS zelf (bijvoorbeeld
   Hyper Backup), zodat er ook een kopie buiten de NAS is.
   **Bewaar ook de sleutel.** Het Gmail-app-wachtwoord staat versleuteld in
   de database. De sleutel
   daarvoor staat in `data/.session_secret` (of in `SESSION_SECRET` in
   `.env`, als je die zelf hebt ingesteld). Dat bestand zit niet in de
   dagelijkse kopie. Omdat de naam met een punt begint, is het in
   bestandsbeheer vaak verborgen en slaat een back-up het soms over. Bewaar
   een kopie op een veilige plek, niet in dezelfde map als de back-ups:
   wie de database en de sleutel samen heeft, kan het app-wachtwoord
   ontsleutelen. Zonder de sleutel werkt een teruggezette database wel,
   maar moet iedereen opnieuw inloggen en moet het app-wachtwoord opnieuw in
   Mailinstellingen.
4. **Terugzetten:** `docker compose down`, verwijder `data/rooster.db`,
   `data/rooster.db-wal` en `data/rooster.db-shm`, kopieer de gewenste
   back-up naar `data/rooster.db` en start weer met `docker compose up -d`.
   Op een nieuwe NAS zet je eerst ook `data/.session_secret` terug.
   Probeer dit één keer uit voordat de installatie echt in gebruik gaat.
5. **Grenzen:** de solver mag hooguit 2 GB geheugen gebruiken, de app 1 GB
   (`SOLVER_MEM_LIMIT`, `WEB_MEM_LIMIT` in `.env`). Logbestanden van elke
   container blijven onder de 30 MB.

### E-mail versturen (Gmail en Power Automate)

Dienstrooster slaat geen e-mailadressen op. Uitnodigingen, herinneringen
(ook de automatische) en meldingen over ruilverzoeken gaan als één
verzendlijst naar je eigen mailbox. Een Power Automate-stroom zoekt daar elke
codenaam op in jouw Excel-lijst en mailt de persoon.

Hoe je Gmail, het `.env`-bestand, de Excel-lijst en de stroom instelt, staat
stap voor stap in
[docs/verzendlijst-power-automate.md](docs/verzendlijst-power-automate.md).
Had je de stroom al gebouwd? Kijk dan onderaan die handleiding bij "Had je
de stroom al gebouwd?".

### Beveiliging

- **Geen inloggegevens in de repository** (`.env` staat in `.gitignore`)
- **Startwachtwoord:** het wachtwoord dat de seed voor `admin` instelt,
  staat openbaar in deze repository. Wie ermee inlogt, moet eerst een eigen
  wachtwoord kiezen en kan daarvoor niets anders.
- **Wachtwoord vergeten:** voor planners is er bewust geen "wachtwoord
  vergeten" op de inlogpagina. De app kent hun e-mailadres niet. Voor de
  beheerder is er een noodweg: vul op de startpagina bij *Link kwijt* het
  Gmail-adres van de Mailinstellingen in. De app mailt dan dat account een
  link om een nieuw wachtwoord te kiezen voor elke beheerder. De link werkt
  30 minuten en één keer. Wie het adres niet kent of de mail niet kan
  lezen, kan niets bereiken: het antwoord op de pagina is voor elk adres
  hetzelfde. Zonder ingestelde mail werkt dit niet. Wie bij de NAS kan, zet
  een nieuw wachtwoord met
  `docker compose exec -u node web npx tsx scripts/reset-password.ts <codenaam>`.
  Het script vraagt het nieuwe wachtwoord twee keer, zonder het te tonen.
  Daarvoor gelden dezelfde regels als in de app. Het account wordt overal
  uitgelogd en de wijziging staat in de wijzigingsgeschiedenis.
  Is er een beheerder, dan kan die dit ook in de app doen (zie hieronder).
- **Beheerder:** een beheerder kan alles wat een planner kan en beheert
  daarnaast de accounts, bij *Accounts beheren* op de lijst met periodes:
  een planner of beheerder toevoegen, iemand een tijdelijk wachtwoord geven,
  een account uitschakelen of de rol wijzigen. Bij een nieuw account kies je ook de dienst: Achterwacht of
  AIOS.
  Een planner ziet alleen de pools, periodes, roosters en voorkeuren van de
  eigen dienst. De planner van de achterwacht en die van de AIOS zien dus
  niets van elkaar. De beheerder ziet beide diensten. Een deelnemer hoort
  bij één dienst: iemand van de achterwacht kan niet ook in de pool van de
  AIOS. De mailinstellingen gelden voor beide diensten samen. Alleen de
  beheerder kan ze wijzigen, een planner ziet ze alleen. Een tijdelijk wachtwoord moet bij de eerste keer inloggen worden
  vervangen, en de sessies van dat account worden beëindigd. Je eigen
  account beheer je met *Wachtwoord wijzigen*.
  Een nieuwe installatie begint met één account: de beheerder `admin`, met
  het startwachtwoord. Log meteen na de eerste start in en kies een eigen
  wachtwoord: tot dan kan iedereen die de inlogpagina bereikt het account
  claimen. Daarna maak je de planners aan, met een naam naar keuze. Een
  bestaande installatie houdt haar `planner` en krijgt `admin` erbij als
  er nog geen beheerder is. Dat gebeurt bij elke start, wat er ook bij
  `SEED_ON_START` staat. `planner` kun je daarna uitschakelen bij
  *Accounts beheren*. Zijn alle wachtwoorden vergeten, dan is er op de server
  `docker compose exec -u node web npx tsx scripts/reset-password.ts admin`,
  en met
  `docker compose exec -u node web npx tsx scripts/create-account.ts <codenaam>`
  maak je daar een nieuwe beheerder aan. Beide scripts vragen het
  wachtwoord twee keer, zonder het te tonen. Met `--planner` maakt
  create-account een planner, met `--beheerder` maakt het van een bestaande
  planner een beheerder.
- **`BASE_URL`** in `.env`: zet dit op het adres waarop deelnemers de app
  openen, bijvoorbeeld `https://192.168.1.10`. Dan wijzen alle links in
  mails daarheen.
- **Grenzen:** een verzoek mag hooguit 1 MB zijn (Caddy en de app zelf),
  tekst die een deelnemer typt hooguit 1000 tekens.
- **Alleen TLS** via Caddy (interne certificaten zijn acceptabel binnen een
  ziekenhuisnetwerk)
- **Persoonlijke links** met SHA256-hashing (alleen de hash staat in de
  database)
- **Audit-trail** van elke planner-/beheerdersactie
- **Pseudoniem:** geen herleidbare persoonsgegevens in de database

### Teststrategie

Uit CLAUDE.md: "Eén regel = één test die bewijst dat hij niet gebroken kan
worden." Voorbeeld: de vensterregel ("iemand met een dienst in week 12
heeft geen dienst in week 11 of 13") heeft een test die bewijst dat de
regel een overtreding tegenhoudt, niet slechts een voorbeeld van correct
gedrag.

Kritieke testgebieden:
1. Feestdagberekening (2024-2035, inclusief schrikkeljaren)
2. ISO-weekafronding en periodegrenzen
3. Capaciteitsformules
4. Authenticatie: tokenhashing, sessieversies
5. Harde solver-regels: ABSOLUUT, vensterregel, streefbereik, geen dubbele
   week

Draai met `npm run test` (unit/integratie) en `npm run test:e2e`
(Playwright, met draaiende app/solver/database).

## Bijdragen

1. Lees eerst CLAUDE.md
2. Volg de codeconventies (TypeScript strict, geen default exports behalve
   waar Next.js die vereist, Nederlandse gebruikerstekst, enz.)
3. Schrijf een test voor elke harde regel die je toevoegt
4. Gebruik betekenisvolle commitberichten
5. Leg ontwerpvragen die CLAUDE.md niet beantwoordt eerst voor

## Licentie

Alleen voor intern gebruik.

## Meer informatie

Zie CLAUDE.md voor:
- Codestructuur en bestandsindeling
- Databaseconventies (tekenconventie, constraints, ledger-regels)
- UI-terminologie (Nederlandse vertalingen van interne termen)
- Bekende valkuilen en hoe ze te voorkomen

Zie [docs/verzendlijst-power-automate.md](docs/verzendlijst-power-automate.md)
voor het instellen van e-mail via Gmail en Power Automate.
