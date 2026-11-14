# Teststrategie

Wat je wanneer test, van snel naar zwaar. De uitleg per controle staat in
`docs/development/checks.md`. Het handmatige draaiboek voor de AIOS staat in
`docs/aios-testdraaiboek.md`.

Zelf testen met een lijst om af te vinken: `docs/stappenplan-testen.md`.

## Welke lagen bij welke wijziging

| Wijziging | Lagen |
|---|---|
| Kleine fix of een woord in een tekst | 1 |
| Nieuwe functie of ander gedrag | 1 tot 4 |
| Release van een 0.x.0 | 1 tot 4, daarna 5 op de testinstallatie en 6 vóór productie |

## 1. Bij elke wijziging (minuten)

- `npx tsc --noEmit -p .`, `npx eslint .` en `npx vitest run`.
- Vitest gebruikt een echte SQLite en test de regels, de routes en de
  scheiding tussen achterwacht en AIOS. Sweeps falen als een nieuwe route de
  toegangscontrole, het logboek of de prullenbakcontrole vergeet.
- `npm audit --omit=dev` moet 0 blijven. Dat kan veranderen zonder dat jij
  code wijzigt, dus draai het vóór elke release.

## 2. De solvers (circa 4 minuten)

- `python -m pytest -q` in `./solver` en in `./aios-solver`, op OR-Tools 9.8.
  Een andere versie zoekt anders en geeft schijnfouten.

## 3. Mutatietests, bij elke 0.x.0 (circa 40 minuten)

- `node scripts/mutation-check.mjs --sinds v<vorige 0.x.0>`. Zet
  `SOLVER_PYTHON` voor de solvermutaties en `CADDY_BIN` of een `caddy` op het
  pad voor de test van de Caddyfile.
- De runner breekt bewust een regel en eist dat een test faalt. Pas de code
  niet aan terwijl hij draait.

## 4. Browserketens op een gezaaide database (circa 1 uur)

- Beide solvers en de app draaien, met `ALLOW_SEED_PASSWORD=true`.
- `node scripts/full-check.mjs`, `node scripts/ui-check.mjs`,
  `npx playwright test` en `node scripts/scenario-check.mjs`.
- Doe het op de root en in een submap-build (`/achterwacht`). De submap vangt
  kapotte links en fetches op.
- Het volledige scenario (circa 35 minuten) alleen als de solver of de code
  van de achterwacht veranderd is. Anders `--kort`.

## 5. Handmatig op de testinstallatie (circa 1 uur)

- Het AIOS-draaiboek voor een heel kwartaal.
- Voor de achterwacht een ronde met een echte planner: periode openen,
  uitnodigen, voorkeuren, rooster maken, publiceren, ruilen en intrekken.
- Een telefoon (375 px) en een afdruk in zwart-wit.
- De sectie *Persoonlijke links*: lijst bekijken, één link intrekken en
  proberen, dan *Alles intrekken*.

## 6. Vóór de echte server (circa 20 minuten)

- Alleen `docker-compose.yml` in een lege map en `docker compose up -d`:
  https op poort 443 en `http://` die doorverwijst.
- Een bestaande installatie bijwerken met `docker compose pull` en `up -d`:
  data, links en mailinstellingen blijven.

## Bekende zwakke plekken

- Het scenario "lexicographic venster 2" laat bij OR-Tools 9.8 soms 1 of 2
  diensten leeg. Bekend, geen nieuwe fout.
- De Caddy-controle in de deploytests draait alleen met een Caddy op de
  machine.
- Op test gaat nooit mail echt weg (`MAIL_UITGESCHAKELD`). De verzendlijst en
  de Power Automate-stroom test je dus alleen handmatig met een echte stroom.
- Docker zelf starten kan niet in elke omgeving. De installatie met alleen het
  compose-bestand is daarom laag 6, met de hand.
