# Dienstrooster installeren op een server (voor de IT-afdeling)

Dit document is genoeg om Dienstrooster op een eigen server te zetten met het
certificaat van de organisatie. Er hoeft niets gebouwd te worden en er is geen
code nodig: alles komt als kant-en-klare images van GitHub.

## Wat er draait

Vier containers, beheerd met Docker Compose:

| Container | Taak | Poort |
|---|---|---|
| `caddy` | https, het certificaat | 443 en 80 (naar buiten) |
| `web` | de app en de database | alleen intern |
| `solver` | maakt het rooster van de achterwacht | alleen intern |
| `aios-solver` | maakt het rooster van de AIOS | alleen intern |

Alleen `caddy` is van buiten bereikbaar.

## Wat de server nodig heeft

- Linux met Docker en de Compose-plugin (`docker compose version`).
- Een processor van het type amd64 (Intel of AMD). Op ARM draaien de images niet.
- Minstens 6 GB geheugen vrij. De solvers gebruiken er tot 2 GB elk, de app 1 GB.
- Poort 80 en 443 vrij en een DNS-naam die naar de server wijst, bijvoorbeeld `rooster.voorbeeld.nl`.
- Uitgaand verkeer naar `ghcr.io` (de images) en naar Docker Hub (`caddy:2-alpine`). Wordt het versturen van uitnodigingen via Gmail gebruikt, dan ook naar Gmail.
- Binnenkomend verkeer vanaf internet is niet nodig. De app is bedoeld voor het interne netwerk.

## Installeren

**1. Maak een map**, bijvoorbeeld `/opt/dienstrooster`. Zet daar drie dingen in.

Haal `docker-compose.yml` en `Caddyfile` op bij de versie die je installeert
(vervang `0.88.0` door de versie van de laatste release op GitHub):

```bash
cd /opt/dienstrooster
V=0.88.0
curl -fsSLO https://raw.githubusercontent.com/alitemu/rooster/v$V/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/alitemu/rooster/v$V/Caddyfile
```

**2. Zet het certificaat klaar** in een map `certs` naast `docker-compose.yml`:

- `certs/rooster.pem`: het certificaat van de server gevolgd door de tussenliggende certificaten (geen root).
- `certs/rooster.key`: de bijbehorende sleutel, zonder wachtwoord, in PEM-formaat.

Het certificaat moet de DNS-naam van de server bevatten (als SAN). Heb je een
`.pfx`, zet het dan eerst om naar twee PEM-bestanden.

**3. Maak `.env`** naast `docker-compose.yml` met deze drie regels:

```bash
APP_PORT=443
HTTP_PORT=80
TLS_MODUS=bestand
```

Meer is niet nodig. `HTTP_PORT=80` stuurt `http://` door naar `https://`. Laat
`BASE_URL` leeg: de app bepaalt zijn adres dan zelf uit de naam waarmee hij
wordt geopend.

**4. Start:**

```bash
docker compose pull
docker compose up -d
```

**5. Controleer:**

```bash
docker compose ps
```

Er horen vier containers te staan, `caddy`, `web`, `solver` en `aios-solver`,
allemaal op `Up ... (healthy)`. De eerste start kan een minuut duren. Open dan
`https://rooster.voorbeeld.nl`. Er mag geen certificaatwaarschuwing komen.

De eerste beheerder heet `admin`. Bij de eerste keer inloggen kiest die zelf
een wachtwoord. Wie de applicatie gaat beheren, doet dat meteen.

## Wat bewaard moet worden

Alles wat de app bewaart staat in de map `data/` naast `docker-compose.yml`.
Neem die map mee in de back-up van de server. De app maakt elke dag zelf een
volledige kopie van de database in `data/backups/database/` (de laatste 14).

Bewaar ook het bestand `data/.session_secret` op een veilige plek, niet in
dezelfde map als de back-ups. Het begint met een punt, dus een back-up slaat
het soms over. Dit is de sleutel waarmee het Gmail-wachtwoord en de
geheimen voor tweestapsverificatie in de database zijn versleuteld.

## Het certificaat vervangen

Caddy vernieuwt dit certificaat niet zelf. Verloopt het, dan geeft iedere
browser een waarschuwing. Zet de einddatum in een agenda. Vervangen gaat zo:

1. Zet de nieuwe `certs/rooster.pem` en `certs/rooster.key` neer.
2. Voer uit: `docker compose restart caddy`.

De app zelf hoeft niet te stoppen en er gaan geen gegevens verloren.

## Bijwerken naar een nieuwe versie

`docker compose pull` haalt alleen de images op, niet `docker-compose.yml` en
`Caddyfile`. Die twee bestanden kunnen met een versie meeveranderen (een
nieuwe container, een nieuwe instelling). Doe daarom bij elke nieuwe versie:

```bash
cd /opt/dienstrooster
V=0.89.0                       # de nieuwe versie
cp docker-compose.yml docker-compose.yml.oud
cp Caddyfile Caddyfile.oud
curl -fsSL https://raw.githubusercontent.com/alitemu/rooster/v$V/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/alitemu/rooster/v$V/Caddyfile -o Caddyfile
diff docker-compose.yml.oud docker-compose.yml
diff Caddyfile.oud Caddyfile
docker compose pull
docker compose up -d
docker compose ps
```

Bekijk de `diff`. Staat er iets in dat jullie zelf hadden aangepast, neem dat
dan over. `.env`, `certs/` en `data/` blijven staan en worden nooit
overschreven.

Welke versie draait, staat in de koptekst van de app, rechts van de titel. Zonder
`ROOSTER_VERSION` in `.env` volgt de server de versie die voor productie is
vrijgegeven (`stable`). Wil je een versie vastzetten, zet dan
`ROOSTER_VERSION=0.88.0` in `.env`.

## Als er iets misgaat

| Symptoom | Oorzaak en oplossing |
|---|---|
| `docker compose up` meldt dat poort 443 of 80 bezet is | Een andere dienst gebruikt de poort. Controleer met `ss -tlnp \| grep ':443 '`. |
| De browser geeft een certificaatwaarschuwing | `TLS_MODUS=bestand` ontbreekt in `.env` (dan gebruikt Caddy zijn eigen CA). Of het certificaat bevat de DNS-naam niet of is verlopen. Zie `docker compose logs caddy --tail 50`. |
| `caddy` start niet en `docker compose logs caddy` zegt `loading certificates: open /certs/rooster.pem: no such file or directory` | Met `TLS_MODUS=bestand` moeten `certs/rooster.pem` en `certs/rooster.key` bestaan en leesbaar zijn. De sleutel mag geen wachtwoord hebben. Zolang `caddy` niet start, is de hele site onbereikbaar. |
| `caddy` start niet en het log zegt `File to import not found: tls_...` | De waarde van `TLS_MODUS` in `.env` is fout gespeld. Alleen `bestand` en `intern` bestaan, in kleine letters (`Bestand` of `file` werkt niet). Verbeter `.env` en voer `docker compose up -d` uit. |
| De pagina laadt niet | Kijk of `web` op `healthy` staat: `docker compose logs web --tail 50`. |
| *De solver van de AIOS is niet bereikbaar* bij het maken van een rooster | De dienst `aios-solver` ontbreekt in `docker-compose.yml` (een oud bestand) of draait niet. De app waarschuwt hier ook voor in `docker compose logs web` bij het opstarten. Haal het nieuwste `docker-compose.yml` op en start opnieuw. |
| Iets met geheugen of een solver die stopt tijdens het rekenen | Zet meer geheugen vrij: `SOLVER_MEM_LIMIT` en `AIOS_SOLVER_MEM_LIMIT` in `.env`, daarna `docker compose up -d`. |

Meer achtergrond (alle instellingen, back-ups terugzetten, een submap) staat in
het README, onder *Installatie* en *Productie*.
