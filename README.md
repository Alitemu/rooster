# Dienstrooster - Eerlijke Dienstroostering

Een dienstroosterapplicatie voor verpleegafdelingen (20-40 medewerkers) met
automatische roostergeneratie, eerlijke verdeling van diensten en
voorkeursbeheer.

Alle fasen uit het implementatieplan zijn gebouwd en getest: authenticatie,
datamodel, feestdagberekening, capaciteitscontrole, voorkeuren, de CP-SAT-
solver voor roostergeneratie, publicatie, ruilverzoeken en correcties.

## Stack

- **Frontend/Backend:** Next.js 16 + TypeScript (App Router, strict mode)
- **Styling:** Tailwind CSS + shadcn/ui
- **Database:** SQLite (WAL-mode) + Drizzle ORM
- **Auth:** eigen implementatie (persoonlijke links, bcrypt-wachtwoorden, TOTP)
- **Solver:** Python + FastAPI + OR-Tools CP-SAT
- **Testen:** Vitest + fast-check (unit/integratie), Playwright (e2e)
- **Container:** Docker Compose (3 services: caddy, web, solver)

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

- **Web:** https://localhost (via Caddy, interne TLS-certificaten)
- **Health check:** https://localhost/health
- **Solver:** http://localhost:8000 (alleen intern netwerk, geen publieke poort)

### Testgebruikers

Na `npm run seed`:

- **Planner:** codenaam `planner` (kleine letters - inloggen is
  hoofdlettergevoelig), wachtwoord zoals gezet in `DEFAULT_TEST_PASSWORD`
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
├── solver/                  # Python-solverservice (CP-SAT)
├── tests/                   # Testfixtures en de Playwright e2e-suite
├── CLAUDE.md                # Ontwerpregels & conventies (verplichte leesstof)
└── docker-compose.yml       # Services: caddy, web, solver
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
SESSION_SECRET=... SOLVER_URL=http://localhost:8000 npm start
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
# schema bouwt zodra SEED_ON_START=true staat (de standaardwaarde)
node scripts/schema-drift.mjs
```

### Database

```bash
# Migratie toepassen
npm run db:migrate

# Drizzle Studio openen
npm run db:studio

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
- `person` - medewerkers (codenaam, rol, wachtwoord_hash, totp_secret, sessie_versie)
- `pool` / `pool_membership` - dienstenpool en wie daar wanneer in zit
- `schedule_period` - periodes (CONCEPT, OPEN, CLOSED, GEGENEREERD, GEPUBLICEERD)
- `shift_slot` / `assignment` - te vullen diensten en de uiteindelijke toewijzingen
- `availability` - blokkeringsvoorkeuren (ABSOLUUT, LIEVER_NIET, VOORKEUR)
- `ledger_entry` - saldo-aanpassingen (append-only, nooit overschreven)
- `holiday_history` - feestdagrotatie over de jaren heen
- `swap_request` - dienstruilverzoeken
- `audit_log` - alle acties van planners/beheerders

### Feestdagberekening

Alle Nederlandse feestdagen berekend met het Meeus-algoritme
(`lib/holidays.ts`, gespiegeld in `solver/holidays.py`):
Nieuwjaarsdag, Pasen (en gerelateerde dagen), Koningsdag (met
zondagcorrectie), Bevrijdingsdag (elke 5 jaar), Hemelvaart, Pinksteren,
Kerst.

### Authenticatie

**Voor medewerkers (deelnemers):**
- Persoonlijke toegangslinks (lange willekeurige token, SHA256-hash in de
  database)
- Geen e-mailadressen opgeslagen (pseudoniem)
- Alleen-lezen toegang na de deadline

**Voor planner/beheerder:**
- Wachtwoord (bcrypt) + optionele TOTP-tweestapsverificatie (speakeasy)
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
harde regel schendt (ABSOLUUT-blokkade, twee diensten in dezelfde ISO-week,
de vensterregel, het streefbereik) en levert bij schaarste een gedeeltelijk
rooster op in plaats van alles-of-niets - de planner vult de resterende
gaten handmatig aan, met duidelijke aanduiding wie een gat wél of niet mag
invullen.

## Implementatieplan

Zie `/DIENSTROOSTER_PLAN_v14.md` voor de volledige oorspronkelijke
requirements, en CLAUDE.md voor de bijgehouden conventies en beslissingen
die daaruit zijn voortgekomen.

## Implementatie

Voor deze fase gebouwd:
- Projectopzet en Docker Compose-configuratie
- Datamodel (Drizzle ORM + SQLite)
- Authenticatie (persoonlijke links + wachtwoord + TOTP)
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
caddy:8010 ──→ web:3000 ──→ solver:8000
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

`SEED_ON_START` staat standaard op `true`: de eerste keer dat `DATA_DIR`
(zie `.env.example`) leeg is, wordt automatisch het planneraccount
aangemaakt (codenaam `planner`) plus voorbeelddata. Veilig om aan te laten
staan bij herstarts en herinstallaties, want het gebeurt maar één keer, op
een echt verse database. Zet `SEED_ON_START=false` in `.env` voor een
installatie zonder automatisch aangemaakte voorbeelddeelnemers en
-periode.

#### TLS-certificaat vertrouwen (de browserwaarschuwing oplossen)

Caddy geeft zelf certificaten uit vanuit een eigen, interne CA
(`pki { ca internal ... }` in `Caddyfile`) - bewust, want deze installatie
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
"alleen intern netwerk"-ontwerp. Vervang in dat geval in `Caddyfile` de
regel `https://:{$APP_PORT:8010}` door `https://jouw-domein.voorbeeld.nl`
en verwijder het blok `tls internal { on_demand }`; Caddy vraagt dan zelf
automatisch een Let's Encrypt-certificaat aan en vernieuwt dat ook zelf.
Voordeel: geen enkel apparaat hoeft dan nog iets te installeren.

#### Productie

1. `docker compose up` op eigen hardware (geen cloud/Kubernetes vereist)
2. Automatische back-ups via `VACUUM INTO`
3. Handmatige back-updownload beschikbaar in het plannerdashboard
4. Test een restore vóórdat de installatie echt in gebruik gaat

### Beveiliging

- **Geen inloggegevens in de repository** (`.env` staat in `.gitignore`)
- **TOTP-tweestapsverificatie** voor planner/beheerder, zelf te beheren
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
4. Authenticatie: tokenhashing, sessieversies, TOTP-verificatie
5. Harde solver-regels: ABSOLUUT, vensterregel, streefbereik, geen dubbele
   week

Draai met `npm run test` (unit/integratie) en `npm run test:e2e`
(Playwright, met draaiende app/solver/database).

## Bijdragen

1. Lees eerst CLAUDE.md
2. Volg de codeconventies (TypeScript strict, geen default exports,
   Nederlandse gebruikerstekst, enz.)
3. Schrijf een test voor elke harde regel die je toevoegt
4. Gebruik betekenisvolle commitberichten
5. Verwijs naar het implementatieplan (v14) bij ontwerpvragen

## Licentie

Alleen voor intern gebruik.

## Meer informatie

Zie CLAUDE.md voor:
- Codestructuur en bestandsindeling
- Databaseconventies (tekenconventie, constraints, ledger-regels)
- UI-terminologie (Nederlandse vertalingen van interne termen)
- Bekende valkuilen en hoe ze te voorkomen

Zie `/DIENSTROOSTER_PLAN_v14.md` voor de volledige oorspronkelijke
requirements.
