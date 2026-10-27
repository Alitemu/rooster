# Persoonlijke links automatisch mailen via Gmail en Power Automate

Dienstrooster kent geen e-mailadressen, alleen codenamen (staf01, staf02
... voor de achterwacht en aios01, aios02 ... voor de AIOS). Het koppelen van codenaam aan e-mailadres gebeurt daarom
buiten de app, in een Excel-lijst die alleen jij beheert. **Eén stroom bedient beide
diensten, elk met een eigen Excel-bestand.** Elke bijlage zegt in het veld
`dienst` van wie ze is (`ACHTERWACHT` of `AIOS`), en de stroom leest dan het
bestand van die dienst. Zo gaat het:

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
extra link aan. Alle links van een medewerker openen dezelfde pagina met
dezelfde gegevens. Is een link bij de verkeerde persoon terechtgekomen, dan
trekt de beheerder hem in bij *Persoonlijke links* op de periodepagina.

### Ruilverzoeken

Is automatisch versturen ingesteld (stap 2), dan gaan ook ruilverzoeken per
mail. Daar hoef je niets voor te doen, want het gaat via dezelfde stroom:

- Bij een nieuw ruilverzoek krijgt de collega een mail met het verzoek. De
  aanvrager krijgt een bevestiging.
- Bij goedkeuren krijgen de aanvrager en de collega die goedkeurde allebei
  een bevestiging. Bij afwijzen krijgt de aanvrager de uitkomst, met de
  reden als die is ingevuld.
- Trekt de aanvrager een verzoek in, dan krijgt de collega een mail dat het
  verzoek is ingetrokken en dat er niets meer hoeft te gebeuren.
- Ruilen kan alleen bij een definitief rooster. Bij een voorlopig rooster
  gaat er dus geen ruilmail uit.
- Een verzoek dat na 6 tot 7 dagen nog openstaat, krijgt vanzelf een
  herinnering, om 09:00 afgerond naar beneden. Een verzoek op vrijdagmiddag
  wordt dus de vrijdag erna herinnerd, nooit op zaterdag. De aanvrager of de
  planner kan ook zelf een herinnering sturen, na een bevestiging en niet
  vaker dan eens per 24 uur. De collega krijgt de herinnering (soort
  `RUIL_HERINNERING`, zonder naam van de aanvrager). De aanvrager krijgt een
  bericht dat er een herinnering is gestuurd (soort
  `RUIL_HERINNERING_BEVESTIGING`). Je stroom hoeft hiervoor niets te weten:
  de mail gaat naar de codenaam, net als de andere ruilmails.

**Anoniem tot de ruil doorgaat.** Zolang een ruil niet is goedgekeurd, noemt
geen enkele mail de ander. De collega leest "Er is een ruilverzoek voor je
ingediend met het volgende voorstel", de aanvrager krijgt de bevestiging en
een afwijzing zonder naam. Zo kan de collega nee zeggen zonder te weten
tegen wie. In de app zien beide wel elkaars codenaam: dat is een
pseudoniem. In `personen` staat dan alleen de lezer zelf, dus de stroom kan
er ook geen echte naam van maken.

Gaat de ruil door, dan noemt de mail aan de aanvrager de collega, en de mail
aan de collega de aanvrager. Het roosterbureau krijgt dan een bevestiging
met beide dienstdoenden: "staf03 neemt de avonddienst op woensdag 3 maart
2027 over van staf07." Met stap 5 staan daar de volledige namen. Dat is één
bericht aan de vaste codenaam `Roosterbureau` (soort `RUIL_DOORGEVEN`). Zet
`Planner` en `Roosterbureau` als rij in je Excel-lijst, met het adres van de
planner en van het roosterbureau (stap 3). Dienstrooster zet zelf nooit een
e-mailadres in de verzendlijst. Zo kan een nagemaakte verzendlijst alleen
mensen uit jouw lijst bereiken.

**Eén wijziging in de stroom: de CC.** Bij `RUIL_DOORGEVEN` staat in het
bericht een veld `cc` met drie codenamen: de twee die geruild hebben en
`Planner`. Laat de stroom die in jouw lijst opzoeken, zoals de `codenaam`, en
in de CC van de mail aan het Roosterbureau zetten. Zo weten beide
collega's en de planner dat het Roosterbureau de ruil heeft gekregen. Dat
betekent ook dat zij elkaars adres zien in die mail. Kent je stroom het veld
niet, dan werkt alles gewoon door en gaat de mail zonder CC naar het
Roosterbureau.

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
  diensten, dan wordt dat verzoek ook ingetrokken. De aanvrager en de collega
  van dat verzoek krijgen er allebei bericht van. Bij de achterwacht stond dat
  eerst als afgewezen, nu als ingetrokken.
- Wijzigt de planner een dienst met de hand of trekt hij de publicatie in,
  dan worden de verzoeken die daardoor niet meer kunnen ingetrokken. De
  aanvrager en de collega krijgen een mail met de reden "Het rooster is
  aangepast." Dat geldt voor de achterwacht en de AIOS.

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

Het maakt niet uit of de adressen in de Excel-lijst met hoofdletters zijn
geschreven. De stroom zet bij het zoeken beide kanten om naar kleine letters.

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
  Je stelt dit apart in voor de achterwacht en voor de AIOS. Gebruik voor
  beide hetzelfde adres: je hebt één stroom, en die let op één postvak. De
  bijlage zegt zelf van welke dienst ze is.

Via de app kan alleen een gelijkwaardige ruil: één dienst tegen één dienst
van dezelfde soort. Een andere ruil regelen collega's zelf. Daarna sturen
ze zelf een mail naar het adres bij *Verzendlijst sturen naar* en naar het
roosterbureau. Het venster voor een ruilverzoek zegt dat, met dat adres.

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

## Stap 3. De twee Excel-lijsten

Maak twee Excel-bestanden, op twee verschillende plekken in OneDrive of
SharePoint, elk met een eigen tabel. Zo hebben de twee diensten niets met
elkaar gemeen, ook niet in wie de lijst mag lezen.

1. `Dienstrooster-adressen-achterwacht.xlsx` voor de achterwacht
2. `Dienstrooster-adressen-aios.xlsx` voor de AIOS

Beide bestanden hebben een tabel met de naam `Adressen` en dezelfde kolommen:

| Codenaam      | Voornaam | E-mail                      |
|---------------|----------|-----------------------------|
| staf01        | Anna     | iemand@ziekenhuis.nl        |
| staf02        | Bram     | iemand.anders@ziekenhuis.nl |
| Planner       |          | planner@ziekenhuis.nl       |
| Roosterbureau |          | roosterbureau@ziekenhuis.nl |

In het bestand van de AIOS staan aios01, aios02 enzovoort.

- **Codenaam** is precies zo geschreven als in Dienstrooster.
- **E-mail** is het adres. Hoofdletters maken niet uit. De stroom begrijpt
  ook de kolomnaam `Email`.
- **Voornaam** is alleen nodig als je stap 5 volgt. Laat de cel anders leeg.
- Zet er in elk bestand twee rijen in, precies zo gespeld: `Planner` (adres van
  de planner van die dienst, bijvoorbeeld een gedeeld postvak) en
  `Roosterbureau` (adres van het roosterbureau). Die zijn nodig voor de
  bevestiging van een goedgekeurde ruil. Omdat elke dienst een eigen bestand
  heeft, kan de planner van de AIOS een ander zijn dan die van de
  achterwacht.
- Had je een lijst met Persoon-01, Persoon-02 ...? Vanaf versie 0.25.0 heten
  die deelnemers staf01, staf02 ... Pas de codenamen in de lijst op hetzelfde
  moment aan.

**Twee bestanden, twee beheerders.** Elke planner beheert het bestand van de
eigen dienst. De stroom leest beide bestanden met het account waarmee hij
draait. Dat account moet dus leesrechten hebben op beide plekken. Geeft een
planner de map niet vrij, verplaatst of hernoemt hij het bestand, of
verandert hij de kolomnamen of de naam van de tabel, dan kan de stroom het
niet meer lezen. Je krijgt dan een mail dat het adressenbestand van die dienst
leeg of niet te lezen is. Er gaat voor die dienst niets uit. Kies het
bestand in de stap `Adressen achterwacht` of `Adressen AIOS` dan opnieuw. De
andere dienst merkt hier niets van.

**Contactadres van de planner.** Dat is iets anders dan het adres van de
stroom. Het adres van de stroom is het postvak waar je stroom op let. Het
contactadres is het adres dat deelnemers zien als er iets niet klopt in hun
voorlopige rooster, en dat ze mailen voor een ruil die niet via de app kan. De
beheerder vult het in bij Mailinstellingen, per dienst. Zonder contactadres
staat er "Meld dat bij de planner" en geen adres.

Selecteer de cellen en kies **Opmaken als tabel**. Geef de tabel de naam
`Adressen`. Power Automate kan alleen rijen uit een tabel lezen, niet uit
losse cellen.

## Stap 4. De stroom in Power Automate

Maak één **Geautomatiseerde cloudstroom**. De namen van de acties kunnen per
versie iets verschillen. Heet een stap bij jou anders, gebruik dan die naam in
de expressies. De stroom leest eerst het bestand van de juiste dienst in een
variabele. Daarna zoekt hij alle adressen in die variabele op, dus de rest van
de stroom is voor beide diensten hetzelfde.

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

3. **Variabele initialiseren**, zes keer, direct onder de trigger en buiten elke
   lus: `adressen`, `rapport` en `teVerplaatsen` (alle drie *Matrix*, leeg)
   en `onderwerp`, `tekst` en `ccadressen` (alle drie *Tekenreeks*, leeg).

4. **Toepassen op elk** over *Bijlagen* uit de trigger. Noem de lus
   `Bijlagen`. Zet onder
   *Instellingen* het **Gelijktijdigheidsbeheer aan** met **Mate van
   parallelle uitvoering 1**, omdat de variabele gedeeld wordt. Daarbinnen:

   a. **JSON parseren**. Inhoud (als expressie):
      `base64ToString(items('Bijlagen')?['contentBytes'])`.
      De bijlage ziet er bijvoorbeeld zo uit:

      ```json
      {
        "dienst": "AIOS",
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
            "codenaam": "aios03",
            "personen": ["aios03"],
            "onderwerp": "Laatste herinnering: geef je voorkeuren voor Voorjaar 2027 door",
            "tekst": "Beste aios03, ...",
            "html": "Beste aios03,<br><br>..."
          }
        ]
      }
      ```

      - `dienst`: `ACHTERWACHT` of `AIOS`. Alle berichten in de bijlage horen
        bij die dienst. Hiermee kiest de stroom het Excel-bestand (stap b).
      - `soort`: `UITNODIGING`, `HERINNERING`, `LAATSTE_HERINNERING`,
        `RUILVERZOEK`, `RUIL_BEVESTIGING`, `RUIL_UITKOMST`,
        `RUIL_INGETROKKEN`, `RUIL_HERINNERING`,
        `RUIL_HERINNERING_BEVESTIGING`, `LINK_AANVRAAG`, `ROOSTER_VOORLOPIG`,
        `ROOSTER_DEFINITIEF` of `RUIL_DOORGEVEN`.
      - `cc` (bij `RUIL_DOORGEVEN`, anders afwezig): de codenamen die in
        de CC horen, de twee die geruild hebben en `Planner`. Zoek ze op
        zoals `codenaam`, in dezelfde lijst. Kent je stroom dit veld niet,
        dan gaat de mail zonder CC naar het Roosterbureau.
      - `aanvraag_email` en `kandidaten` zijn alleen gevuld bij
        `LINK_AANVRAAG` (stap e), anders `null`.
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
          "dienst": { "type": "string" },
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
                "cc": { "type": "array", "items": { "type": "string" } },
                "onderwerp": { "type": "string" },
                "tekst": { "type": "string" },
                "html": { "type": "string" }
              },
              "required": ["codenaam", "onderwerp", "tekst"]
            }
          }
        },
        "required": ["dienst", "soort", "aantal", "berichten"]
      }
      ```

   b. **Het bestand van de juiste dienst lezen.** Zet direct na *JSON
      parseren* een **Variabele instellen** die `adressen` leeg maakt (een
      lege matrix, `[]`). Bij een mail met twee bijlagen blijft de lijst van
      de eerste bijlage zo niet hangen. Zet daarna een **Overschakelen**
      (Switch), noem hem `Bestand van dienst`, met als *Aan* de expressie
      `body('JSON_parseren')?['dienst']`.
      - *Geval* `ACHTERWACHT`: **Rijen weergeven die in een tabel voorkomen**
        (Excel Online (Business)) met het bestand van de achterwacht en de
        tabel `Adressen`, zonder filter. Zet bij *Instellingen* de
        **Paginering** aan met een drempel van 1000. Noem de stap
        `Adressen achterwacht`. Dan **Variabele instellen**: `adressen` =
        `body('Adressen_achterwacht')?['value']`.
      - *Geval* `AIOS`: hetzelfde, met het bestand van de AIOS. Noem de stap
        `Adressen AIOS`. Kies bij het bestand de eigen plek van dat bestand:
        dan kiest de stap ook de bijbehorende schijf en tabel.
      - *Standaard*: een **E-mail verzenden (V2)** aan jezelf ("Onbekende
        dienst in de verzendlijst, niets verstuurd") en daarna
        **Beëindigen** met de status *Mislukt*. Zo gaat er nooit een mail uit
        op basis van de verkeerde lijst.

      Zet daarna een **Voorwaarde**, noem hem `Adressen controle`, die ook
      loopt als het lezen mislukte of is overgeslagen (*Uitvoeren na*:
      geslaagd, mislukt, overgeslagen en time-out van `Bestand van dienst`,
      en geslaagd van het leegmaken van `adressen`). De voorwaarde is
      `length(variables('adressen'))` is gelijk aan `0`. In de *Ja*-tak: een
      **E-mail verzenden (V2)** aan jezelf ("Het adressenbestand van deze
      dienst is leeg of niet te lezen, verzendlijst niet verstuurd") en dan
      **Beëindigen** met de status *Mislukt*. Zo verdwijnt er nooit stil een
      verzendlijst als een bestand niet bereikbaar is, bijvoorbeeld omdat de
      eigenaar het verplaatste of het account van de stroom geen rechten meer
      heeft. Laat de *Nee*-tak leeg. Alle volgende stappen lopen pas na deze
      voorwaarde (*Uitvoeren na*: geslaagd).

      Omdat de lijst nu in één variabele staat, hoeft de rest van de stroom
      niet meer naar Excel te kijken. Dat is sneller en maakt elke stap
      hierna hetzelfde voor beide diensten.

   c. **Toepassen op elk** over *berichten* van *JSON parseren*. Noem de lus
      `Berichten` en zet de **Mate van parallelle uitvoering** op 1. De
      volgende stappen gebruiken de naam van de lus in hun expressies.
      Daarbinnen, in deze volgorde:

      1. **Matrix filteren** (Gegevensbewerking), noem de stap `Adres
         ophalen`. Van: `variables('adressen')`. Voorwaarde in de
         geavanceerde modus:
         `@equals(item()?['Codenaam'], items('Berichten')['codenaam'])`.
      2. **Opstellen**, noem de stap `Adres email`, met de expressie
         `if(empty(body('Adres_ophalen')), '', coalesce(first(body('Adres_ophalen'))?['E-mail'], first(body('Adres_ophalen'))?['Email'], ''))`.
         Staat iemand niet in de lijst, dan is dit een lege tekst. De stroom
         begrijpt zowel de kolomnaam `E-mail` als `Email`.
      3. Twee keer **Variabele instellen**: `onderwerp` = *onderwerp* van het
         bericht, en `tekst` = *html* van het bericht.
      4. **Toepassen op elk** over *personen* van het bericht. Noem de lus
         `Personen` en zet de parallelle uitvoering op 1. Binnenin:
         - **Matrix filteren**, noem de stap `Naam ophalen`. Van:
           `variables('adressen')`. Voorwaarde:
           `@equals(item()?['Codenaam'], items('Personen'))`.
         - **Opstellen**, noem de stap `Naam`, met de expressie
           `if(empty(body('Naam_ophalen')), items('Personen'), if(empty(coalesce(first(body('Naam_ophalen'))?['Voornaam'], '')), items('Personen'), first(body('Naam_ophalen'))?['Voornaam']))`.
           Is er geen voornaam, dan blijft de codenaam staan. Met `coalesce`
           alleen zou een lege cel de codenaam door niets vervangen.
         - **Opstellen** `Nieuw onderwerp` met
           `replace(variables('onderwerp'), items('Personen'), outputs('Naam'))`,
           daarna **Variabele instellen** `onderwerp` = uitvoer daarvan.
         - Hetzelfde voor de tekst: **Opstellen** `Nieuwe tekst` met
           `replace(variables('tekst'), items('Personen'), outputs('Naam'))`,
           daarna **Variabele instellen** `tekst` = uitvoer daarvan.

         Het tussenstuk met *Opstellen* is nodig, omdat Power Automate niet
         toestaat dat een variabele in één stap naar zichzelf verwijst. Zie
         ook stap 5.
      5. **De CC bij een goedgekeurde ruil (`RUIL_DOORGEVEN`).** Het bericht
         aan `Roosterbureau` heeft dan een veld `cc` met drie codenamen:
         de twee die geruild hebben en `Planner`. Doe dit voor elk bericht,
         dan hoef je geen aparte tak te bouwen:
         - **Variabele instellen** `ccadressen` = lege tekst. Dit moet voor
           elk bericht opnieuw, anders neemt het volgende bericht de CC van
           het vorige mee.
         - **Toepassen op elk** over
           `coalesce(items('Berichten')?['cc'], json('[]'))`. Noem de lus
           `Cc adressen`, parallelle uitvoering 1. Binnenin een **Matrix
           filteren** `Cc ophalen` van `variables('adressen')` met voorwaarde
           `@equals(item()?['Codenaam'], items('Cc_adressen'))`, en een
           **Toevoegen aan tekenreeksvariabele** `ccadressen` met
           `if(empty(body('Cc_ophalen')), '', if(contains(string(coalesce(first(body('Cc_ophalen'))?['E-mail'], first(body('Cc_ophalen'))?['Email'], '')), '@'), concat(coalesce(first(body('Cc_ophalen'))?['E-mail'], first(body('Cc_ophalen'))?['Email']), ';'), ''))`.
           Een codenaam die niet in de lijst staat, wordt gewoon overgeslagen.
         Bij alle andere berichten is `ccadressen` leeg.
      6. **Voorwaarde**, zodat een lege of onzinnige cel *E-mail* of een
         ontbrekende codenaam geen mislukte run geeft ("To Field cannot be
         null or empty"). Laat hem lopen na de lus `Cc adressen` met
         *Uitvoeren na* geslaagd en mislukt. Links de expressie
         `and(not(empty(trim(outputs('Adres_email')))), contains(outputs('Adres_email'), '@'))`,
         dan `is gelijk aan`, rechts de expressie `true`.
         - In *Indien ja*: **Een e-mail verzenden (V2)** met Aan =
           `outputs('Adres_email')`, CC = `variables('ccadressen')`,
           Onderwerp = `variables('onderwerp')` en Hoofdtekst =
           `variables('tekst')`. Daarna twee keer **Toevoegen aan
           matrixvariabele**: `rapport` met
           `addProperty(addProperty(addProperty(json('{}'), 'Codenaam', items('Berichten')?['codenaam']), 'Uitkomst', 'Verstuurd'), 'Onderwerp', variables('onderwerp'))`
           en `teVerplaatsen` met
           `concat(variables('onderwerp'), '|', toLower(trim(outputs('Adres_email'))))`.
           Voeg ook een **Toevoegen aan matrixvariabele** `rapport` toe die
           alleen loopt als het versturen *mislukt* (*Uitvoeren na*: is
           mislukt van *Een e-mail verzenden*), met dezelfde expressie maar
           `'Versturen mislukt'` als `Uitkomst`.
         - In *Indien nee*: **Toevoegen aan matrixvariabele** `rapport`
           met dezelfde expressie en `'Niet in de Namenlijst of geen geldig
           e-mailadres'` als `Uitkomst`. Een adres met een typfout dat er
           wel geldig uitziet, gaat gewoon de deur uit. Daarvan krijg je een
           onbestelbaar-bericht van Outlook terug.

      Omdat het filter in een variabele zoekt en niet in Excel zelf, mislukt
      er niets als iemand ontbreekt. Een bericht verdwijnt daarom nooit stil:
      het is verstuurd of het staat met de reden in het rapport (stap e).

   d. **Link opnieuw aanvragen.** Zet ná de lus van c (nog binnen de lus
      over de bijlagen) een **Voorwaarde**, noem hem `Link aanvraag`:
      *soort* van *JSON parseren* `is gelijk aan` `LINK_AANVRAAG`, met
      *Uitvoeren na* geslaagd en mislukt van de lus `Berichten`. In de
      *Ja*-tak, in deze volgorde:

      1. **Matrix filteren** `Aanvrager` op `variables('adressen')` met
         voorwaarde
         `@and(not(empty(trim(string(coalesce(body('JSON_parseren')?['aanvraag_email'], ''))))), equals(toLower(trim(string(coalesce(item()?['E-mail'], item()?['Email'], '')))), toLower(trim(string(body('JSON_parseren')?['aanvraag_email'])))))`.
         Omdat `adressen` het bestand van de eigen dienst is, vindt een adres
         dat alleen bij de andere dienst staat niets. Het eerste deel zorgt
         dat een lege aanvraag nooit een rij met een lege cel vindt.
      2. **Opstellen** `Aanvrager rij`:
         `if(empty(body('Aanvrager')), json('{}'), first(body('Aanvrager')))`.
      3. **Opstellen** `Aanvrager email`:
         `coalesce(outputs('Aanvrager_rij')?['E-mail'], outputs('Aanvrager_rij')?['Email'], '')`.
      4. **Matrix filteren** `Kandidaat` op *kandidaten* van *JSON parseren*
         met voorwaarde
         `@equals(item()?['codenaam'], outputs('Aanvrager_rij')?['Codenaam'])`.
      5. **Voorwaarde**: `length(body('Kandidaat'))` is groter dan `0`. Alleen
         in de *Ja*-tak verder. Staat het adres niet in de lijst, dan gaat er
         niets weg. Dat is de bedoeling. In de *Ja*-tak:
         - **Opstellen** `Link naam`:
           `if(empty(string(coalesce(outputs('Aanvrager_rij')?['Voornaam'], ''))), outputs('Aanvrager_rij')?['Codenaam'], string(outputs('Aanvrager_rij')?['Voornaam']))`.
         - **Opstellen** `Link onderwerp`:
           `replace(first(body('Kandidaat'))?['onderwerp'], first(body('Kandidaat'))?['codenaam'], outputs('Link_naam'))`,
           en **Opstellen** `Link tekst` met hetzelfde voor
           `first(body('Kandidaat'))?['html']`.
         - **Een e-mail verzenden (V2)**: Aan = `outputs('Aanvrager_email')`
           (niet *aanvraag_email*), Onderwerp = `outputs('Link_onderwerp')`,
           Hoofdtekst = `outputs('Link_tekst')`.
         - Twee keer **Toevoegen aan matrixvariabele**: `rapport` (zoals
           hierboven, met `first(body('Kandidaat'))?['codenaam']` als
           `Codenaam`) en `teVerplaatsen` met
           `concat(outputs('Link_onderwerp'), '|', toLower(trim(outputs('Aanvrager_email'))))`.
           Ook hier een `rapport`-rij `Versturen mislukt` als het versturen
           mislukt.
         In *Indien nee*: een `rapport`-rij met `Codenaam` =
         `outputs('Aanvrager_rij')?['Codenaam']`, `Uitkomst` = `Link
         aangevraagd, maar adres onbekend of geen deelnemer in deze periode`
         en `Onderwerp` = `-`.

      Bij een onbekend adres loopt de stap `Aanvrager` niet fout: een filter
      geeft gewoon een lege lijst. In de uitvoergeschiedenis zie je dus geen
      rood blokje.

   e. **Een rapport voor jezelf.** Zet na de voorwaarde van d (*Uitvoeren na*:
      geslaagd en mislukt):
      - **Matrix filteren** `Mislukt` op `variables('rapport')` met voorwaarde
        `@not(equals(item()?['Uitkomst'], 'Verstuurd'))`.
      - **HTML-tabel maken** `HTML-tabel maken` van `variables('rapport')`.
      - **Een e-mail verzenden (V2)** aan jezelf. Onderwerp:
        `concat(if(greater(length(body('Mislukt')), 0), 'Let op: ', ''), 'Dienstrooster ', coalesce(body('JSON_parseren')?['dienst'], '?'), ' ', body('JSON_parseren')?['soort'], ': ', string(length(variables('rapport'))), ' berichten, ', string(length(body('Mislukt'))), ' mislukt')`.
        Hoofdtekst: de periode en daaronder de uitvoer van `HTML-tabel
        maken`. Zo zie je per verzending voor welke dienst het was, hoeveel
        berichten er waren. Bij "Let op" zie je welke codenamen niet zijn
        aangekomen en waarom.

   f. **Verzonden items opruimen (optioneel).** De stroom verstuurt vanuit je
      eigen mailbox, dus elk bericht staat daarna in *Verzonden items*. Met
      deze stap gaan alleen de berichten van Dienstrooster naar een eigen
      map (maak bijvoorbeeld `Dienstrooster verstuurd` aan in Outlook).
      Zet na het rapport, *Uitvoeren na* geslaagd en mislukt:
      - **Uitstellen** (Delay) van 3 minuten, zodat Outlook de berichten
        spoort.
      - **Totdat** (Until) met de voorwaarde
        `length(body('Te_verplaatsen'))` is gelijk aan `0`, met de limiet op
        10 keer en 10 minuten. Binnenin: **E-mails ophalen (V3)** uit *Verzonden
        items* (top 50, zonder bijlagen), een **Matrix filteren** `Te
        verplaatsen` op `body('Verzonden_ophalen')?['value']` met voorwaarde
        `@contains(variables('teVerplaatsen'), concat(item()?['subject'], '|', toLower(trim(string(item()?['toRecipients'])))))`
        en een **Toepassen op elk** over `Te verplaatsen` die elk bericht
        met **E-mail verplaatsen (V2)** naar de map zet. Het rapport voor
        jezelf blijft in *Verzonden items* staan.

      Een bericht dat na die 3 minuten nog niet in *Verzonden items* staat,
      blijft daar staan. Dat is geen verlies, alleen rommel.

5. Zet bij de eerste stap ná de lus over de berichten onder **Uitvoeren na**
   zowel *is geslaagd* als *is mislukt* aan. Weigert Outlook een enkele mail,
   dan lopen het rapport en het opruimen dan nog steeds.

Test de stroom eerst met twee lijsten waarin alleen jouw eigen adres staat,
bij één of twee codenamen van elke dienst.

## Stap 5. Echte voornamen in plaats van codenamen

De stap om codenamen door voornamen te vervangen zit in de stroom van stap 4
(onder c, punt 4). Zonder voornamen in het Excel-bestand staat er in de mail
bijvoorbeeld "Beste staf07, staf07 neemt de avonddienst op 3 maart over van
staf03." Met voornamen: "Beste Anna, Anna neemt de avonddienst op 3 maart
over van Bram." Dienstrooster zelf kent die namen nooit.

1. Vul de kolom `Voornaam` van de tabel `Adressen` (stap 3) in, in beide
   bestanden. Laat een cel leeg als je voor iemand de codenaam wilt houden.
2. Er is verder niets in te stellen. Voor `Planner` en `Roosterbureau` mag
   je ook een voornaam invullen, bijvoorbeeld de naam van het bureau. In de
   tekst van de bevestiging van een goedgekeurde ruil staat die dan in
   plaats van de codenaam.

Gebruik in de kolom `Voornaam` gewone namen, zonder tekens als `<` of `>`: de
naam komt zo in de HTML-tekst.

De volgorde van `personen` is al goed: Dienstrooster zet langere codenamen
vooraan. Zo wordt "staf10" altijd vervangen voordat "staf1" erin gevonden
zou kunnen worden. Staat iemand niet in de lijst of heeft iemand geen
voornaam, dan blijft de codenaam gewoon staan.

## Had je de stroom al gebouwd?

**Een stroom uit een eerdere versie van deze handleiding of een eigen
stroom.** Stap 4 beschrijft de stroom zoals hij nu is getest. Het verschil met
een oudere stroom:

- Per bericht zoekt de stroom het adres in een lijst die hij één keer per
  bijlage uit het bestand van de dienst leest (stap 4b), in plaats van per
  bericht een rij in Excel op te halen. Dat maakt de stroom veel sneller, en
  dezelfde stappen werken voor beide diensten.
- De kolommen heten `Voornaam` en `E-mail` (ook `Email` wordt begrepen).
- Er is een controle op een lege of onleesbare lijst, op een onbekende
  `dienst` en op een bijlage die geen geldige JSON is.
- De CC bij een goedgekeurde ruil wordt voor elk bericht opnieuw opgebouwd.
- Er komt een rapport per verzending. Het opruimen van *Verzonden items*
  is erbij gekomen.

Een bestaande stroom ombouwen is meer werk dan hem opnieuw opbouwen met stap
4. Gebruik daarbij de namen van de stappen zoals ze in stap 4 staan, want de
expressies verwijzen ernaar.

**Vanaf versie 0.105.0 staat er een veld `dienst` in de bijlage.** Je hoeft
daarvoor niets te veranderen zolang je stroom alleen voor de achterwacht is: het
extra veld wordt genegeerd. Wil je dezelfde stroom ook voor de AIOS gebruiken,
pas dan het volgende aan:

1. Maak het Excel-bestand voor de AIOS (stap 3), op een eigen plek, met een
   tabel `Adressen` en de rijen `Planner` en `Roosterbureau`.
2. Zet bij JSON parseren het schema uit stap 4a (met `dienst`).
3. Voeg direct onder de trigger **Variabele initialiseren** `adressen`
   (Matrix) toe. Zet in de lus over de bijlagen na *JSON parseren* de
   **Overschakelen** uit stap 4b, met het bestand van de achterwacht in het
   eerste geval en dat van de AIOS in het tweede.
4. Vervang in de lus over de berichten *Een rij ophalen* door **Matrix
   filteren** op `variables('adressen')` en gebruik het adres uit de eerste
   rij (stap 4c). Doe hetzelfde bij de link-aanvraag (stap 4d) en stap 5.
5. Zet bij Mailinstellingen hetzelfde postvak voor de achterwacht en voor de
   AIOS.

Hieronder staat wat je nodig had bij versies vóór oktober 2026.


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
- Een extra geheim woord in de bijlage is overwogen en niet gebouwd. Het
  beschermt alleen tegen een vervalste afzender. Een vervalste mail met het
  adres van de Dienstrooster-Gmail hoort bij een goed ingerichte
  mailomgeving in de ongewenste mail terecht te komen. De stroom kijkt
  alleen naar *Postvak IN*. Laat de IT-afdeling dat controleren. Een
  geheim woord helpt niet als het Gmail-account zelf wordt overgenomen,
  omdat de bijlagen in de verzonden items van dat account staan.
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

## De AIOS in dezelfde stroom

De AIOS gebruiken dezelfde stroom en hetzelfde postvak als de achterwacht, maar
een eigen Excel-bestand op een eigen plek. Een tweede stroom is niet nodig. De
app houdt de twee diensten wel uit elkaar: het veld `dienst` in elke bijlage
zegt van wie ze is, en de stroom leest dan alleen het bestand van die dienst.

**Instellen, in vier stappen.**

1. Gmail is al klaar (stap 1 en 2) en is voor beide diensten hetzelfde.
2. Vul bij Mailinstellingen onder het kopje **AIOS** hetzelfde adres in als
   bij de achterwacht: het postvak waar je ene stroom op let. Vul het
   contactadres van de AIOS-planner in. Dat staat in de melding "Meld dat bij
   de planner" en in de ruilmeldingen.
3. Maak `Dienstrooster-adressen-aios.xlsx` (stap 3) met een tabel `Adressen`:
   elke AIOS (aios01, aios02 ...) met het adres, plus `Planner` en
   `Roosterbureau` met de adressen die voor de AIOS gelden.
4. Zet in de stroom de **Overschakelen** uit stap 4b met voor `AIOS` dat
   bestand. Verder is er niets aan de stroom te veranderen.

**Wat de AIOS krijgen, en wanneer.**

- Uitnodigingen en herinneringen voor de voorkeuren. Vanzelf een week en een
  dag voor de deadline, om 09:00 (`"automatisch": true`).
- Voorlopig publiceren: elke AIOS krijgt de eigen diensten
  (`ROOSTER_VOORLOPIG`). Definitief maken: de definitieve diensten met wat er
  voor hen veranderde (`ROOSTER_DEFINITIEF`). Dat gebeurt nooit vanzelf.
- Ruilen kan alleen bij een definitief rooster. Verzoek, bevestiging,
  uitkomst, intrekken en herinneringen werken zoals bij de achterwacht
  (zie Ruilverzoeken hierboven). De herinnering gaat automatisch na 6 tot 7
  dagen om 09:00. De AIOS of de planner kan er zelf een sturen, niet vaker dan
  eens per 24 uur.
- Een goedgekeurde ruil gaat als één bericht aan de codenaam `Roosterbureau`
  (soort `RUIL_DOORGEVEN`), met in `cc` de twee AIOS en `Planner`.
- Op de startpagina van de AIOS kan iemand de link opnieuw aanvragen
  (`LINK_AANVRAAG`). De stroom zoekt het adres in het bestand van de AIOS,
  zoals bij stap 4e. Een adres dat alleen bij de achterwacht staat, krijgt dan
  niets.
- Lukt versturen niet, dan wacht de mail in de wachtrij van de AIOS. Elk uur
  wordt het opnieuw geprobeerd, en meteen na het opslaan van de
  Mailinstellingen. Na 7 dagen vervalt een wachtende mail.

**Testen.** Zet in elk bestand eerst alleen jouw eigen adres bij twee
codenamen en verstuur een uitnodiging voor een periode van elke dienst.
Controleer dan dat (a) elke mail aankomt, (b) een codenaam die niet in het
bestand staat in de Nee-tak belandt, (c) een goedgekeurde testruil één mail aan
het Roosterbureau van die dienst geeft, met de CC erbij, (d) een link-aanvraag
met jouw adres alleen jouw eigen bericht oplevert, en alleen van de dienst
waar je de aanvraag deed, en (e) een bijlage met een onbekende `dienst` niets
verstuurt.
