# Persoonlijke links automatisch mailen via Gmail en Power Automate

Dienstrooster kent geen e-mailadressen, alleen codenamen (Persoon-01,
Persoon-02 ...). Het koppelen van codenaam aan e-mailadres gebeurt daarom
buiten de app, in een Excel-lijst die alleen jij beheert. Zo gaat het:

1. In Dienstrooster kies je bij **Exporteren & communicatie** voor
   *Uitnodigingen versturen* of *Herinneringen versturen*. Herinneringen kun
   je aan iedereen tegelijk sturen of per persoon.
2. De server maakt voor iedereen een nieuwe persoonlijke link aan en mailt
   één e-mail via Gmail naar jouw mailbox. Het onderwerp is altijd
   `DIENSTROOSTER-VERZENDLIJST`. De bijlage is een JSON-bestand met bovenaan
   een samenvatting (wat voor verzending het is, voor welke periode en hoeveel
   berichten) en daaronder in `berichten` per persoon de codenaam, het
   onderwerp en de tekst (met de eigen link erin). Het veld `personen` noemt
   elke codenaam die in onderwerp of tekst staat. Dat heb je alleen nodig als
   je echte namen wilt gebruiken (stap 5).
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
- Trekt de aanvrager een verzoek in, dan krijgt de collega een mail dat het
  verzoek is ingetrokken en dat er niets meer hoeft te gebeuren.

**Anoniem tot de ruil doorgaat.** Zolang een ruil niet is goedgekeurd, noemt
geen enkele mail de ander. De collega leest "Er is een ruilverzoek voor je
ingediend met het volgende voorstel", de aanvrager krijgt de bevestiging en
een afwijzing zonder naam. Zo kan de collega nee zeggen zonder te weten
tegen wie. In de app zien beide wel elkaars codenaam: dat is een
pseudoniem. In `personen` staat dan alleen de lezer zelf, dus de stroom kan
er ook geen echte naam van maken.

Gaat de ruil door, dan noemt de mail aan de aanvrager de collega. De
planner en de afdeling roostering krijgen dan een bevestiging met beide
dienstdoenden: "Persoon-03 neemt de avonddienst op woensdag 3 maart 2027
over van Persoon-07." Met stap 5 staan daar de volledige namen. Die
bevestiging gaat naar twee vaste codenamen, `Planner` en `Afdeling
roostering` (soort `RUIL_DOORGEVEN`). Zet die twee als rij in je
Excel-lijst, met het adres van de planner en van de afdeling roostering
(stap 3). Dienstrooster zet zelf nooit een e-mailadres in de verzendlijst.
Zo kan een nagemaakte verzendlijst alleen mensen uit jouw lijst bereiken.
De stroom hoeft hiervoor niet te veranderen.

**Eén dienst aan meerdere collega's aanbieden.** Een deelnemer mag dezelfde
dienst tegelijk aan meerdere collega's aanbieden, om de kans op een ruil zo
groot mogelijk te maken. Wie het eerst goedkeurt, ruilt:

- De aanvrager krijgt de bevestiging van de ruil. Daarin staat ook hoeveel
  andere verzoeken voor die dienst zijn ingetrokken.
- De andere verzoeken van de aanvrager worden vanzelf ingetrokken. Die
  collega's krijgen een mail dat het verzoek is ingetrokken, met de reden "De
  dienst is al met een andere collega geruild." De aanvrager krijgt daar
  geen losse mails over. Vroeg de aanvrager dezelfde collega ook in een
  ander verzoek, dan staat er dat ze die dienst al met elkaar geruild hebben.
- Had de collega die goedkeurt die dienst zelf ook aan iemand aangeboden,
  dan wordt dat verzoek op dezelfde manier ingetrokken. Alleen de collega
  aan wie het gericht was, krijgt een mail. Wie goedkeurt, ziet het meteen
  op het scherm.
- Had iemand anders ook een verzoek lopen voor een van de twee geruilde
  diensten, dan vervalt dat verzoek. De aanvrager en de collega van dat
  verzoek krijgen er allebei bericht van.

Dezelfde collega twee keer vragen voor dezelfde dienst kan niet. In het
venster voor een ruilverzoek staat wie al gevraagd is. Die collega is niet
nog eens te kiezen.

Elk verzoek levert twee mails op. Daarom mag één deelnemer hooguit 20
ruilverzoeken per 24 uur doen, ingetrokken verzoeken meegeteld. Zo kan
niemand de mailbox van een collega volspammen of de daglimiet van het
Gmail-account (ongeveer 500 mails) opmaken. Daarna zouden ook uitnodigingen
en herinneringen niet meer aankomen. Wie de grens haalt, krijgt de melding
dat het morgen weer kan.

In elke mail staat wat de lezer zelf afgeeft en krijgt, met de datum voluit,
en een persoonlijke link om het verzoek te openen. Zo'n verzoek geldt als een
verzendlijst met één bericht. De stroom hoeft er dus niets voor te weten.
Wel moet iedereen die kan ruilen in je Excel-lijst staan.

De melding in de app blijft altijd bestaan. De mail komt er alleen bij. Lukt
het versturen niet, dan gaat het ruilverzoek gewoon door. De mail wacht dan
en gaat alsnog: elk uur probeert Dienstrooster het opnieuw, en meteen nadat
je de Mailinstellingen opslaat. Wie het verzoek doet, ziet dat de mail later
komt. Bovenaan de periodepagina staat hoeveel ruilmails er wachten. Na 7
dagen vervalt zo'n mail. Is het verzoek intussen al beantwoord of
ingetrokken, dan gaat de mail over het verzoek zelf niet meer uit. Het
antwoord wel.

### Automatische herinneringen

Is versturen ingesteld, dan stuurt Dienstrooster zelf herinneringen zolang
een periode open staat:

- 7 dagen en 1 dag voor de deadline, om 09:00. De server kijkt elk uur, dus
  de mail vertrekt tussen 09:00 en 10:00. De laatste staat altijd tussen 24
  en 48 uur voor de deadline gepland.
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

### Het rooster zelf

Publiceer je een rooster, dan is het eerst voorlopig. Iedereen krijgt meteen
een mail met de eigen diensten (`soort` `ROOSTER_VOORLOPIG`) en kan die
controleren. Zie je geen fouten meer, bijvoorbeeld na twee weken, dan klik
je op de periodepagina op *Definitief maken*. Iedereen krijgt dan het
definitieve rooster (`ROOSTER_DEFINITIEF`), met wat er sinds het voorlopige
rooster voor die persoon veranderd is. Dat gebeurt nooit vanzelf. Voor de
stroom zijn het gewone berichten: er hoeft niets aan te veranderen.

### Link opnieuw aanvragen

Op de startpagina kan een deelnemer zijn werk-e-mailadres invullen om de
persoonlijke link opnieuw te krijgen. Dienstrooster kent geen
e-mailadressen, dus de app weet niet van wie dat adres is. De stroom weet
dat wel, via je Excel-lijst. Zo gaat het:

- Dienstrooster stuurt een verzendlijst met `soort` `LINK_AANVRAAG`. Daarin
  staat het ingevulde adres in `aanvraag_email`, in kleine letters. In
  `kandidaten` staat voor iedere deelnemer van de actieve periode een
  kant-en-klaar bericht met een nieuwe link. `berichten` is leeg.
- De actieve periode is de periode waarvan je het laatst de uitnodigingen
  hebt verstuurd. In het periodeoverzicht staat daar **Actief** bij.
  Uitnodigingen voor een andere periode kun je pas versturen als het
  rooster van de actieve periode gepubliceerd is.
- Het bericht zegt wat de link op dat moment doet. Is de periode open,
  dan kan de deelnemer voorkeuren doorgeven tot de deadline. Is de
  deadline voorbij of de periode gesloten, dan staat erin dat wijzigen
  niet meer kan en dat de voorkeuren alleen nog te bekijken zijn. Is het
  rooster gepubliceerd, dan staat erin dat de diensten via de link te
  bekijken en te ruilen zijn.
- De stroom zoekt het adres op in de Excel-lijst, neemt het bericht van die
  codenaam en stuurt het naar het adres uit de Excel-lijst (stap 4d).
  Staat het adres niet in de lijst, dan gaat er niets weg.
- Een link gaat dus nooit naar een adres dat niet in jouw lijst staat, wat
  iemand ook invult. Vult iemand het adres van een collega in, dan krijgt
  die collega alleen de eigen link.
- De deelnemer krijgt altijd hetzelfde antwoord: als het adres bekend is,
  komt er binnen een paar minuten een mail. Zo is niet af te lezen welke
  adressen in de lijst staan.
- Per kwartier kan één apparaat drie keer een link aanvragen en de hele
  installatie tien keer.

Zolang je stroom stap 4d niet heeft, gebeurt er bij een aanvraag niets. De
stroom loopt dan over de lege `berichten` en stuurt geen mail. Dat is zo
gemaakt, zodat een stroom die nog niet is aangepast niet iedereen een link
stuurt.

Schrijf de adressen in de Excel-lijst in kleine letters. Dienstrooster
stuurt het ingevulde adres ook in kleine letters, en de stroom zoekt op
precies die tekst.

## Stap 1. Gmail klaarzetten

Gebruik bij voorkeur een apart Gmail-account alleen voor Dienstrooster.

1. Zet in dat Google-account **Verificatie in 2 stappen** aan
   (Google-account > Beveiliging).
2. Maak daarna een **app-wachtwoord** aan (Google-account > Beveiliging >
   Verificatie in 2 stappen > App-wachtwoorden). Google toont 16 tekens in
   groepjes van vier. Je mag het met of zonder spaties overnemen.

Gebruik nooit het gewone wachtwoord van het account. Google weigert dat
voor deze manier van versturen.

## Stap 2. Het account instellen in Dienstrooster

Open een periode en klik onder *Exporteren & communicatie* op
**Mailinstellingen**. Vul in:

- **Gmail-adres**: het account uit stap 1. De app werkt alleen met Gmail.
- **App-wachtwoord**: de 16 letters uit stap 1, met of zonder spaties.
- **Verzendlijst sturen naar**: het adres waar je stroom in stap 4 op let.
- **E-mailadres van de afdeling roostering** (mag leeg blijven).

Via de app kan alleen een gelijkwaardige ruil: één dienst tegen één dienst
van dezelfde soort. Een andere ruil regelen collega's zelf en geven ze
daarna door. Het venster voor een ruilverzoek noemt daarvoor het adres bij
*Verzendlijst sturen naar* en het adres van de afdeling roostering.

Bij **Opslaan** logt Dienstrooster meteen in bij Gmail. Lukt dat niet, dan
wordt er niets opgeslagen en zie je waarom. Het wachtwoord wordt versleuteld
bewaard en daarna nooit meer getoond. Wil je later alleen het adres voor de
verzendlijst aanpassen, laat het wachtwoordveld dan leeg.

Met **Instellingen verwijderen** haal je alles weer weg. Daarna gaat er geen
mail meer uit.

Dit is de enige plek waar je het mailen instelt. Stonden er nog
`SMTP_USER`, `SMTP_PASS` of `VERZENDLIJST_AAN` in het `.env`-bestand op de
server? Die worden niet meer gelezen en mag je weghalen. Vul de gegevens
eenmalig in bij Mailinstellingen.

In het exportvenster verschijnt nu bij *Uitnodigingen versturen* een groene
knop. Zie je in plaats daarvan "Versturen is nog niet ingesteld", dan staat
er nog niets in de Mailinstellingen.

De server moet naar buiten kunnen verbinden met `smtp.gmail.com` op poort
465. Een melding "Gmail is niet bereikbaar" betekent meestal dat een
firewall dat tegenhoudt.

## Stap 3. De Excel-lijst

Maak in OneDrive of SharePoint een Excel-bestand, bijvoorbeeld
`Dienstrooster-adressen.xlsx`, met twee kolommen:

| Codenaam   | Email                   |
|------------|-------------------------|
| Persoon-01 | iemand@ziekenhuis.nl    |
| Persoon-02 | iemand.anders@ziekenhuis.nl |

Zet er ook twee rijen in voor de bevestiging van een goedgekeurde ruil:
codenaam `Planner` met het adres van de planner (bijvoorbeeld het gedeelde
postvak) en codenaam `Afdeling roostering` met het adres van die afdeling.
Precies zo gespeld.

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
      De bijlage ziet er bijvoorbeeld zo uit:

      ```json
      {
        "soort": "LAATSTE_HERINNERING",
        "automatisch": true,
        "periode": "Voorjaar 2027",
        "deadline": "2026-12-20T17:00",
        "deadline_tekst": "zondag 20 december 2026 om 17:00",
        "aantal": 12,
        "nog_niets_ingevuld": 8,
        "nog_niet_ingediend": 4,
        "verstuurd_op": "2026-12-19T08:00:00.000Z",
        "berichten": [
          {
            "soort": "LAATSTE_HERINNERING",
            "codenaam": "Persoon-03",
            "personen": ["Persoon-03"],
            "onderwerp": "Laatste herinnering: geef je voorkeuren voor Voorjaar 2027 door",
            "tekst": "Beste Persoon-03, ...",
            "html": "Beste Persoon-03,<br><br>..."
          }
        ]
      }
      ```

      - `soort`: `UITNODIGING`, `HERINNERING`, `LAATSTE_HERINNERING`,
        `RUILVERZOEK`, `RUIL_BEVESTIGING`, `RUIL_UITKOMST`,
        `RUIL_INGETROKKEN`, `LINK_AANVRAAG`, `ROOSTER_VOORLOPIG`,
        `ROOSTER_DEFINITIEF` of `RUIL_DOORGEVEN`.
      - `aanvraag_email` en `kandidaten` zijn alleen gevuld bij
        `LINK_AANVRAAG` (stap 4d), anders `null`.
      - `html` is dezelfde tekst, klaar om als hoofdtekst van de mail te
        gebruiken: regels als `<br>` en alle tekens veilig gemaakt. Gebruik
        altijd `html` als hoofdtekst en nooit zelf `tekst` met een
        `replace`. In `tekst` kunnen woorden staan die een deelnemer zelf
        typte (de toelichting bij een ruilverzoek). Als HTML zou daar een
        nagemaakte link of knop in kunnen staan, verstuurd vanuit jouw
        mailbox.
      - `automatisch`: `true` als Dienstrooster het zelf verstuurde (een
        geplande herinnering, een ruilverzoek), `false` als jij op een knop
        drukte.
      - `deadline` en `deadline_tekst` zijn leeg (`null`) bij ruilverzoeken.
      - `nog_niets_ingevuld` en `nog_niet_ingediend` zijn alleen gevuld bij
        herinneringen, anders `null`.

      Schema:

      ```json
      {
        "type": "object",
        "properties": {
          "soort": { "type": "string" },
          "automatisch": { "type": "boolean" },
          "periode": { "type": "string" },
          "deadline": { "type": ["string", "null"] },
          "deadline_tekst": { "type": ["string", "null"] },
          "aantal": { "type": "integer" },
          "nog_niets_ingevuld": { "type": ["integer", "null"] },
          "nog_niet_ingediend": { "type": ["integer", "null"] },
          "verstuurd_op": { "type": "string" },
          "aanvraag_email": { "type": ["string", "null"] },
          "kandidaten": { "type": ["array", "null"] },
          "berichten": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "soort": { "type": "string" },
                "codenaam": { "type": "string" },
                "personen": { "type": "array", "items": { "type": "string" } },
                "onderwerp": { "type": "string" },
                "tekst": { "type": "string" },
                "html": { "type": "string" }
              },
              "required": ["codenaam", "onderwerp", "tekst"]
            }
          }
        },
        "required": ["soort", "aantal", "berichten"]
      }
      ```

   b. **Toepassen op elk** over *berichten* van *JSON parseren*. Daarbinnen:

      - **Een rij ophalen** (Excel Online (Business)): het bestand uit stap
        3, tabel `Adressen`, sleutelkolom `Codenaam`, sleutelwaarde
        *codenaam*.
      - **Voorwaarde**, zodat een lege of onzinnige cel *Email* geen
        mislukte run geeft ("To Field cannot be null or empty"). Links de
        expressie
        `and(not(empty(trim(string(coalesce(body('Een_rij_ophalen')?['Email'], ''))))), contains(string(coalesce(body('Een_rij_ophalen')?['Email'], '')), '@'))`,
        dan `is gelijk aan`, rechts de expressie `true`. Gebruik in de
        expressie de naam van je eigen stap en kolom.
      - In *Indien ja*: **Een e-mail verzenden (V2)**: Aan = *Email* uit
        *Een rij ophalen*, Onderwerp = *onderwerp*, Hoofdtekst = *html*.
      - In *Indien nee*: **Een e-mail verzenden (V2)** aan jezelf, met de
        *codenaam* die niet in de lijst staat of waarbij geen geldig adres
        staat. Een adres met een typfout dat er wel geldig uitziet, gaat
        gewoon de deur uit. Daarvan krijg je een onbestelbaar-bericht van
        Outlook terug.
      - Zet bij de stap direct onder *Een rij ophalen* (de *Voorwaarde*, of
        *Variabele instellen* als je stap 5 volgt) onder **Uitvoeren na**
        zowel *is geslaagd* als *is mislukt* aan. Staat een codenaam niet in
        de lijst, dan mislukt *Een rij ophalen*. De stappen eronder lopen dan
        toch, de voorwaarde komt op *Nee* uit en de lus gaat gewoon verder
        met het volgende bericht. Zonder dit vinkje telt Power Automate die
        ronde als mislukt, en daarmee de hele lus. Alles wat na de lus komt
        (een samenvatting, een rapport, het opruimen) wordt dan
        overgeslagen.

   c. Optioneel: **een samenvatting voor jezelf**. Zet ná de lus van stap b
      (dus nog binnen de lus over de bijlagen) een **Voorwaarde**, bijvoorbeeld
      *soort* van *JSON parseren* `bevat` `HERINNERING`. Dat geldt voor gewone
      en laatste herinneringen. Zet in de *Ja*-tak **Een e-mail verzenden
      (V2)** aan jezelf, met als onderwerp
      `@{body('JSON_parseren')?['soort']} verstuurd voor @{body('JSON_parseren')?['periode']}`
      en in de tekst *aantal*, *nog_niets_ingevuld*, *nog_niet_ingediend*,
      *deadline_tekst* en *automatisch*. Wil je voor elke verzending een
      samenvatting, laat de voorwaarde dan weg.

   d. **Link opnieuw aanvragen.** Zet ná de lus van stap b (nog binnen de
      lus over de bijlagen) een **Voorwaarde**: *soort* van *JSON parseren*
      `is gelijk aan` `LINK_AANVRAAG`. In de *Ja*-tak:

      - **Een rij ophalen** (Excel Online (Business)): het bestand uit stap
        3, tabel `Adressen`, sleutelkolom `Email`, sleutelwaarde
        *aanvraag_email*. Staat het adres niet in de lijst, dan mislukt deze
        actie en gaat er niets weg. Dat is de bedoeling.
      - **Matrix filteren** (Gegevensbewerking). Van: *kandidaten* van *JSON
        parseren*. Voorwaarde: `item()?['codenaam']` `is gelijk aan`
        *Codenaam* uit *Een rij ophalen*.
      - **Een e-mail verzenden (V2)**: Aan = *Email* uit *Een rij ophalen*
        (niet *aanvraag_email*), Onderwerp =
        `first(body('Matrix_filteren'))?['onderwerp']`, Hoofdtekst =
        `first(body('Matrix_filteren'))?['html']`.

      Gebruik je echte namen (stap 5)? Vervang de codenaam dan op dezelfde
      manier in dat ene bericht.

      Een mislukte *Een rij ophalen* laat de hele run als mislukt zien in
      Power Automate. Hier is dat onschuldig: er gaat dan niets weg. Een
      parallelle tak met *Uitvoeren na* > *is mislukt* verandert daar
      niets aan. Power Automate kijkt naar de laatste stap van elke tak, en
      de overgeslagen hoofdtak telt als mislukt.

4. Een ontbrekende codenaam meld je via de *Nee*-tak van stap 4b, niet via
   een aparte parallelle tak die alleen bij **mislukt** draait. Zo'n tak
   doet wel zijn werk, maar de lus mislukt toch: de hoofdtak is
   overgeslagen en Power Automate telt dat als mislukt. Zet daarnaast bij
   de eerste stap ná de lus over de berichten onder **Uitvoeren na** zowel
   *is geslaagd* als *is mislukt* aan. Weigert Outlook een enkele mail,
   dan lopen een samenvatting en het opruimen dan nog steeds.

Test de stroom eerst met een Excel-lijst waarin alleen jouw eigen adres
staat, bij één of twee codenamen.

## Stap 5 (optioneel). Echte namen in plaats van codenamen

Zonder deze stap staat er in de mail bijvoorbeeld "Beste Persoon-07,
Persoon-07 neemt de avonddienst op 3 maart over van Persoon-03." Met deze
stap vervangt de stroom elke codenaam door de naam uit je Excel-lijst:
"Beste Anna, Anna neemt de avonddienst op 3 maart over van Bram."
Dienstrooster zelf kent die namen nooit.

1. Geef de tabel `Adressen` een derde kolom `Naam`.

2. Voeg direct onder de trigger (dus niet in een lus) twee keer
   **Variabele initialiseren** toe: `onderwerp` en `tekst`, allebei van
   het type *Tekenreeks* en leeg.

3. Zet in de binnenste lus (over de berichten), vóór *Een e-mail verzenden*:

   a. **Variabele instellen**: `onderwerp` = *onderwerp* van het bericht.
      Nog een keer: `tekst` = *html* van het bericht.

   b. **Toepassen op elk** over *personen* van het bericht. Daarbinnen:

      - **Rijen weergeven die in een tabel voorkomen** (Excel Online
        (Business)): tabel `Adressen`, filterquery
        `Codenaam eq '@{replace(items('Toepassen_op_elk_3'), '''', '''''')}'`.
        Anders dan *Een rij ophalen* mislukt dit niet als iemand ontbreekt.
        Het geeft dan gewoon niets terug. Het `replace`-deel verdubbelt elke
        apostrof in de codenaam, zoals het filter dat verwacht. Zonder dat
        breekt een codenaam als `Persoon-O'Brien` het filter, en kan een
        slim gekozen codenaam zelfs een verkeerde rij opleveren.
      - **Opstellen**, met als expressie de naam, of de codenaam als er geen
        naam is:
        `if(empty(first(outputs('Rijen_weergeven_die_in_een_tabel_voorkomen')?['body/value'])?['Naam']), items('Toepassen_op_elk_3'), first(outputs('Rijen_weergeven_die_in_een_tabel_voorkomen')?['body/value'])?['Naam'])`
        Excel geeft bij een lege naamcel een lege tekst terug. Met
        `coalesce` zou de codenaam dan door niets vervangen worden.
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
      Onderwerp = `variables('onderwerp')`, Hoofdtekst = `variables('tekst')`.

   Gebruik in de kolom `Naam` gewone namen, zonder tekens als `<` of `>`: de
   naam komt zo in de HTML-tekst.

4. Zet bij beide *Toepassen op elk*-lussen die berichten en personen
   verwerken onder *Instellingen* het **Gelijktijdigheidsbeheer aan** en de
   **Mate van parallelle uitvoering** op **1**. De variabelen worden
   gedeeld, dus de lussen moeten één voor één lopen. Staat
   gelijktijdigheidsbeheer uit, dan lopen ze juist parallel.

De volgorde van `personen` is al goed: Dienstrooster zet langere codenamen
vooraan. Zo wordt "Persoon-10" altijd vervangen voordat "Persoon-1" erin
gevonden zou kunnen worden. Staat iemand niet in de lijst of heeft iemand
geen naam, dan blijft de codenaam gewoon staan.

## Had je de stroom al gebouwd?

Tot en met september 2026 was de bijlage een losse lijst berichten. Nu staat
die lijst in `berichten`, met de samenvatting eromheen. Pas in een bestaande
stroom de volgende dingen aan, op hetzelfde moment dat je de nieuwe versie van
Dienstrooster installeert:

1. Vervang bij **JSON parseren** het schema door het schema uit stap 4.
2. Laat de lus van stap 4b lopen over *berichten* van *JSON parseren* in
   plaats van over *Hoofdtekst*.
3. Zet bij **Een e-mail verzenden (V2)** als hoofdtekst het veld *html*, in
   plaats van de expressie met `replace(... 'tekst' ...)`. Gebruik je echte
   namen (stap 5), zet de variabele `tekst` dan op *html* en gebruik als
   hoofdtekst `variables('tekst')` zonder `replace`. Dit is belangrijk voor
   de veiligheid, zie stap 4.
4. Gebruik je echte namen (stap 5)? Vervang dan de filterquery bij *Rijen
   weergeven die in een tabel voorkomen* door de nieuwe uit stap 5, met het
   `replace`-deel voor apostroffen.

De stappen binnen de lus (rij ophalen, mail versturen, echte namen) blijven
gewoon werken.

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
- Het app-wachtwoord staat versleuteld in de database. De sleutel staat in
  het bestand `.session_secret` in dezelfde datamap, tenzij je
  `SESSION_SECRET` in het `.env`-bestand hebt gezet. Een kopie van alleen de
  database geeft het wachtwoord dus niet prijs, een kopie van de hele
  datamap wel. Bewaar back-ups van die map net zo zorgvuldig als het
  wachtwoord zelf. Denk je dat iemand anders het wachtwoord heeft? Trek het
  dan in bij Google en maak een nieuw aan.
