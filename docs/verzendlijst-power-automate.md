# Persoonlijke links automatisch mailen via Gmail en Power Automate

Dienstrooster kent geen e-mailadressen, alleen codenamen (Persoon-01,
Persoon-02 ...). Het koppelen van codenaam aan e-mailadres gebeurt daarom
buiten de app, in een Excel-lijst die alleen jij beheert. Zo gaat het:

1. In Dienstrooster kies je bij **Exporteren & communicatie** voor
   *Uitnodigingen versturen* of *Herinneringen versturen*. Herinneringen kun
   je aan iedereen tegelijk sturen of per persoon.
2. De server maakt voor iedereen een nieuwe persoonlijke link aan en mailt
   één e-mail via Gmail naar jouw mailbox. Het onderwerp is altijd
   `DIENSTROOSTER-VERZENDLIJST`. De bijlage is een JSON-bestand met per
   persoon de codenaam, het onderwerp en de tekst (met de eigen link erin).
   Het veld `personen` noemt elke codenaam die in onderwerp of tekst staat.
   Dat heb je alleen nodig als je echte namen wilt gebruiken (stap 5).
3. Die e-mail start je Power Automate-stroom. De stroom verplaatst de mail
   naar een map, zoekt elke codenaam op in je Excel-lijst en stuurt die
   persoon het eigen bericht.

Eerder verstuurde links blijven werken. Elke verzending maakt alleen een
extra link aan.

### Ruilverzoeken

Is automatisch versturen ingesteld (stap 2), dan gaan ook ruilverzoeken per
mail. Daar hoef je niets voor te doen, want het gaat via dezelfde stroom:

- Bij een nieuw ruilverzoek krijgt de collega een mail met het verzoek. De
  aanvrager krijgt een bevestiging.
- Bij goedkeuren of afwijzen krijgt de aanvrager de uitkomst. Bij een
  afwijzing staat de reden erbij.

In elke mail staat wat de lezer zelf afgeeft en krijgt, met de datum voluit,
en een persoonlijke link om het verzoek te openen. Zo'n verzoek geldt als een
verzendlijst met één bericht. De stroom hoeft er dus niets voor te weten.
Wel moet iedereen die kan ruilen in je Excel-lijst staan.

De melding in de app blijft altijd bestaan. De mail komt er alleen bij. Lukt
het versturen niet, dan gaat het ruilverzoek gewoon door.

### Automatische herinneringen

Is versturen ingesteld, dan stuurt Dienstrooster zelf herinneringen zolang
een periode open staat:

- 7 dagen en 1 dag voor de deadline, om 09:00. De laatste valt altijd
  tussen 24 en 48 uur voor de deadline.
- Alleen aan wie nog niet heeft ingediend, in twee groepen met elk een eigen
  tekst: wie nog niets heeft ingevuld en wie wel begonnen is maar nog niet op
  *Bevestigen en indienen* heeft geklikt.
- Wie de afgelopen 24 uur al een herinnering kreeg (ook een die jij met de
  hand verstuurde), wordt overgeslagen.
- Verschuif je de deadline, dan tellen de momenten vanaf de nieuwe deadline.
- Stond de server uit op het moment zelf, dan gaat de herinnering alsnog als
  hij binnen 12 uur weer draait. Anders wordt dat moment overgeslagen.

Op de periodepagina, onder *Exporteren & communicatie*, zie je wanneer de
volgende herinnering gaat en naar hoeveel mensen. Daar kun je ze voor een
periode ook pauzeren. Elk bericht heeft een veld `soort` (bijvoorbeeld
`HERINNERING` of `LAATSTE_HERINNERING`), voor als je de stroom per soort iets
anders wilt laten doen.

De links in een automatische herinnering gebruiken het adres waarmee jij de
uitnodigingen verstuurde. Verstuur dus eerst de uitnodigingen. Wil je een
vast adres, zet dan `BASE_URL` in het `.env`-bestand.

## Stap 1. Gmail klaarzetten

Gebruik bij voorkeur een apart Gmail-account alleen voor Dienstrooster.

1. Zet in dat Google-account **Verificatie in 2 stappen** aan
   (Google-account > Beveiliging).
2. Maak daarna een **app-wachtwoord** aan (Google-account > Beveiliging >
   Verificatie in 2 stappen > App-wachtwoorden). Google toont 16 tekens in
   groepjes van vier. Je mag het met of zonder spaties overnemen.

Gebruik nooit het gewone wachtwoord van het account. Google weigert dat
voor deze manier van versturen en het zou dan in een bestand op de server
staan.

## Stap 2. De server instellen

Zet in het `.env`-bestand naast `docker-compose.yml`:

```
SMTP_USER=dienstrooster.afdeling@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
VERZENDLIJST_AAN=jouw.adres@voorbeeld.nl
```

`SMTP_HOST` en `SMTP_PORT` hoeven niet: standaard is dat `smtp.gmail.com`
op poort 465. Haal eerst de nieuwste versie binnen met `git pull` en herstart
daarna met `docker compose up -d --build`.

In het exportvenster verschijnt nu bij *Uitnodigingen versturen* een groene
knop. Zie je in plaats daarvan "Versturen is nog niet ingesteld", dan mist
een van de drie waarden of is de app niet opnieuw gestart.

De server moet naar buiten kunnen verbinden met `smtp.gmail.com` op poort
465. Een melding "De mailserver is niet bereikbaar" betekent meestal dat een
firewall dat tegenhoudt.

## Stap 3. De Excel-lijst

Maak in OneDrive of SharePoint een Excel-bestand, bijvoorbeeld
`Dienstrooster-adressen.xlsx`, met twee kolommen:

| Codenaam   | Email                   |
|------------|-------------------------|
| Persoon-01 | iemand@ziekenhuis.nl    |
| Persoon-02 | iemand.anders@ziekenhuis.nl |

Selecteer de cellen en kies **Opmaken als tabel**. Geef de tabel de naam
`Adressen`. Power Automate kan alleen rijen uit een tabel lezen, niet uit
losse cellen. De codenaam moet precies zo geschreven zijn als in
Dienstrooster.

## Stap 4. De stroom in Power Automate

Maak een **Geautomatiseerde cloudstroom**. De namen van de acties kunnen per
versie iets verschillen.

1. **Trigger: Wanneer een nieuwe e-mail binnenkomt (V3)** (Office 365
   Outlook). Bij *Geavanceerde opties*:
   - Map: `Postvak IN`
   - Onderwerpfilter: `DIENSTROOSTER-VERZENDLIJST`
   - Van: het Gmail-adres uit stap 1
   - Alleen met bijlagen: `Ja`
   - Bijlagen opnemen: `Ja`

2. **E-mail verplaatsen (V2)**. Bericht-id: *Bericht-id* uit de trigger.
   Map: bijvoorbeeld `Dienstrooster verwerkt` (maak die map eerst aan in
   Outlook).

3. **Toepassen op elk** over *Bijlagen* uit de trigger. Daarbinnen:

   a. **JSON parseren**. Inhoud (als expressie):
      `base64ToString(items('Toepassen_op_elk')?['contentBytes'])`.
      Schema:

      ```json
      {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "soort": { "type": "string" },
            "codenaam": { "type": "string" },
            "personen": { "type": "array", "items": { "type": "string" } },
            "onderwerp": { "type": "string" },
            "tekst": { "type": "string" }
          },
          "required": ["codenaam", "onderwerp", "tekst"]
        }
      }
      ```

   b. **Toepassen op elk** over *Hoofdtekst* van *JSON parseren*. Daarbinnen:

      - **Een rij ophalen** (Excel Online (Business)): het bestand uit stap
        3, tabel `Adressen`, sleutelkolom `Codenaam`, sleutelwaarde
        *codenaam*.
      - **Een e-mail verzenden (V2)**: Aan = *Email* uit *Een rij ophalen*,
        Onderwerp = *onderwerp*, Hoofdtekst als expressie
        `replace(items('Toepassen_op_elk_2')?['tekst'], decodeUriComponent('%0A'), '<br>')`
        zodat de regels van de tekst behouden blijven.

4. Optioneel maar handig: voeg na *Een rij ophalen* een parallelle tak toe
   die alleen draait als die actie **mislukt** (*Uitvoeren na* > *is
   mislukt*) en stuur jezelf dan een mail "Codenaam niet gevonden in de
   lijst" met de *codenaam*. Anders merk je een ontbrekende rij pas als
   iemand zegt geen mail te hebben gehad.

Test de stroom eerst met een Excel-lijst waarin alleen jouw eigen adres
staat, bij één of twee codenamen.

## Stap 5 (optioneel). Echte namen in plaats van codenamen

Zonder deze stap staat er in de mail bijvoorbeeld "Hoi Persoon-07,
Persoon-03 wil een dienst met je ruilen." Met deze stap vervangt de stroom
elke codenaam door de naam uit je Excel-lijst: "Hoi Anna, Bram wil een
dienst met je ruilen." Dienstrooster zelf kent die namen nooit.

1. Geef de tabel `Adressen` een derde kolom `Naam`.

2. Voeg direct onder de trigger (dus niet in een lus) twee keer
   **Variabele initialiseren** toe: `onderwerp` en `tekst`, allebei van
   het type *Tekenreeks* en leeg.

3. Zet in de binnenste lus (over de berichten), vóór *Een e-mail verzenden*:

   a. **Variabele instellen**: `onderwerp` = *onderwerp* van het bericht.
      Nog een keer: `tekst` = *tekst* van het bericht.

   b. **Toepassen op elk** over *personen* van het bericht. Daarbinnen:

      - **Rijen weergeven die in een tabel voorkomen** (Excel Online
        (Business)): tabel `Adressen`, filterquery
        `Codenaam eq '@{items('Toepassen_op_elk_3')}'`.
        Anders dan *Een rij ophalen* mislukt dit niet als iemand ontbreekt.
        Het geeft dan gewoon niets terug.
      - **Opstellen**, met als expressie de naam, of de codenaam als er geen
        naam is:
        `coalesce(first(outputs('Rijen_weergeven_die_in_een_tabel_voorkomen')?['body/value'])?['Naam'], items('Toepassen_op_elk_3'))`
      - **Opstellen** (tweede), expressie
        `replace(variables('onderwerp'), items('Toepassen_op_elk_3'), outputs('Opstellen'))`
        en daarna **Variabele instellen** `onderwerp` = uitvoer van die
        stap.
      - Hetzelfde voor `tekst`: een **Opstellen** met
        `replace(variables('tekst'), items('Toepassen_op_elk_3'), outputs('Opstellen'))`
        en **Variabele instellen** `tekst` = uitvoer daarvan.

      Het tussenstuk met *Opstellen* is nodig, omdat Power Automate niet
      toestaat dat een variabele in één stap naar zichzelf verwijst.

   c. Gebruik in **Een e-mail verzenden (V2)** voortaan de variabelen:
      Onderwerp = `variables('onderwerp')`, Hoofdtekst =
      `replace(variables('tekst'), decodeUriComponent('%0A'), '<br>')`.

4. Zet bij beide *Toepassen op elk*-lussen die berichten en personen
   verwerken onder *Instellingen* het **Gelijktijdigheidsbeheer uit**. De
   variabelen worden gedeeld, dus de lussen moeten één voor één lopen.

De volgorde van `personen` is al goed: Dienstrooster zet langere codenamen
vooraan. Zo wordt "Persoon-10" altijd vervangen voordat "Persoon-1" erin
gevonden zou kunnen worden. Staat iemand niet in de lijst of heeft iemand
geen naam, dan blijft de codenaam gewoon staan.

## Stap 6 (optioneel). Een samenvatting voor jezelf

Na elke automatische herinnering stuurt Dienstrooster ook een mail met
onderwerp `DIENSTROOSTER-SAMENVATTING` naar dezelfde mailbox. De bijlage
`dienstrooster-samenvatting.json` ziet er zo uit:

```json
{
  "soort": "LAATSTE_HERINNERING",
  "automatisch": true,
  "periode": "Voorjaar 2027",
  "deadline": "2026-12-20T17:00",
  "deadline_tekst": "zondag 20 december 2026 om 17:00",
  "dagen_voor_deadline": 1,
  "aantal": 12,
  "nog_niets_ingevuld": 8,
  "nog_niet_ingediend": 4,
  "ontvangers": {
    "nog_niets_ingevuld": ["Persoon-03", "..."],
    "nog_niet_ingediend": ["Persoon-11", "..."]
  },
  "verstuurd_op": "2026-12-19T08:00:00.000Z"
}
```

Je bestaande stroom doet hier niets mee, want het onderwerp is anders. Maak
er een tweede, kleine stroom voor:

1. **Wanneer een nieuwe e-mail binnenkomt (V3)**, met onderwerpfilter
   `DIENSTROOSTER-SAMENVATTING`, Van = je Dienstrooster-Gmail en bijlagen
   opnemen.
2. **E-mail verplaatsen (V2)** naar dezelfde map als de verzendlijsten.
3. **JSON parseren** met als inhoud
   `base64ToString(first(triggerOutputs()?['body/attachments'])?['contentBytes'])`.
   Klik op *Voorbeeldpayload gebruiken om schema te genereren* en plak het
   voorbeeld hierboven.
4. **Een e-mail verzenden (V2)** aan jezelf, bijvoorbeeld met onderwerp
   `Herinnering verstuurd: @{body('JSON_parseren')?['periode']}` en in de
   tekst *aantal*, *nog_niets_ingevuld*, *nog_niet_ingediend* en
   *deadline_tekst*.

## Veiligheid

- Het Van-filter in de trigger zorgt dat alleen mail van jouw
  Dienstrooster-Gmail de stroom start. Een afzender is wel te vervalsen.
  Wil je extra zekerheid, zet dan in de lus een **Voorwaarde** dat *tekst*
  het adres van jouw Dienstrooster bevat (bijvoorbeeld
  `https://rooster.local:8010/person/`) en verstuur anders niets.
- De persoonlijke links gaan via Gmail en jouw mailbox. Dat is hetzelfde
  pad als elke mail die je met de hand zou sturen. Een link werkt alleen
  voor de eigen periode.
- De Excel-lijst is de enige plek waar codenaam en e-mailadres samenkomen.
  Deel dat bestand met niemand die het niet nodig heeft.
