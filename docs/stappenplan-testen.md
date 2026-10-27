# Stappenplan: de applicatie zelf testen

Een lijst om af te vinken, zodat je niets vergeet. Doe de blokken in
volgorde. Per regel staat wat je doet en wat je moet zien. Klopt iets niet,
noteer dan het nummer van de regel en wat je zag.

Voor een heel AIOS-kwartaal stap voor stap staat er ook
`docs/aios-testdraaiboek.md`. Welke geautomatiseerde tests je wanneer draait,
staat in `docs/teststrategie.md`.

Reken op ongeveer drie uur. Gebruik de testinstallatie, nooit productie. Mail
staat daar uit (`MAIL_UITGESCHAKELD=true`), dus er gaat niets echt weg.

## Blok A. Installeren en bijwerken

- [ ] **A1.** Nieuwe, lege map met alleen `docker-compose.yml`. Voer uit:
  `docker compose up -d`. Je ziet: vier containers (`caddy`, `web`, `solver`,
  `aios-solver`) bij `docker compose ps`, na een minuut allemaal gezond.
- [ ] **A2.** Open `https://<server>`. Je ziet: de inlogpagina. Bij het
  interne certificaat hoort een certificaatwaarschuwing.
- [ ] **A3.** Open `http://<server>`. Je ziet: je gaat vanzelf naar `https://`.
- [ ] **A4.** Rechts van de titel staat het juiste versienummer.
- [ ] **A5.** Bestaande installatie: `docker compose pull`, dan
  `docker compose up -d`. Je ziet: nieuwe versie, en je gegevens, accounts en
  mailinstellingen zijn er nog.
- [ ] **A6.** Draait de server op een andere poort (`APP_PORT` in `.env`)?
  Open dan het adres met die poort en controleer ook daar stap A3.

## Blok B. Inloggen en accounts

- [ ] **B1.** Log in als beheerder met het startwachtwoord. Je moet direct een
  nieuw wachtwoord kiezen en kunt daarvoor niets anders doen.
- [ ] **B2.** Een fout wachtwoord geeft een Nederlandse melding. Na een paar
  keer volgt een tijdelijke blokkade.
- [ ] **B3.** *Accounts beheren*: maak een planner voor de achterwacht en een
  planner voor de AIOS. Je ziet: elk met het tijdelijke wachtwoord en de
  juiste dienst.
- [ ] **B4.** Log in als elke planner. De planner van de achterwacht ziet niets
  van de AIOS, en andersom.
- [ ] **B5.** Wachtwoord wijzigen werkt. Uitloggen werkt, ook in een tweede
  browser (die is dan ook uitgelogd).
- [ ] **B6.** Noodweg voor de beheerder (de mail moet ingesteld zijn): vul op de
  startpagina bij *Link kwijt* het Gmail-adres van de Mailinstellingen in. Je
  ziet dezelfde melding als bij elk adres. In dat Gmail-account komt een mail
  met een link. Kies daarmee een nieuw wachtwoord. Daarna werkt de link niet
  meer, je bent overal uitgelogd en je logt in met het nieuwe wachtwoord.

## Blok C. Achterwacht: een periode van begin tot eind

- [ ] **C1.** Maak een nieuwe periode met de wizard. De bereiken
  (streefaantallen) staan in woorden, nooit als `[7,8]` of `-1`.
- [ ] **C2.** Personeel toevoegen en een geldigheidsperiode aanpassen. Een
  collega die halverwege start, verschijnt in de keuzelijst bij handmatig
  toewijzen.
- [ ] **C3.** Vooraf invullen en eerdere toewijzingen: vul een paar in en kijk
  of ze in het rooster terugkomen.
- [ ] **C3a.** Oud saldo (wizard, stap *Saldi*) en *Eerdere toewijzingen*:
  klik op *Sjabloon downloaden (Excel)*, vul het in en upload het weer. Je ziet:
  een samenvatting van wat er geïmporteerd wordt. Een CSV of een Excel-bestand
  met andere kolommen wordt geweigerd met een Nederlandse melding die de goede
  kolommen noemt. Het gedownloade rooster (Excel) kan bij *Eerdere toewijzingen*
  terug.
- [ ] **C3b.** Importeer een beginsaldo en kies daarna in stap *Saldi* een tweede
  bestand met dezelfde codenaam. Je ziet: een waarschuwing met de naam, die zegt
  dat de waarden worden overschreven en dat een leeg vakje 0 wordt. *Annuleren*
  neemt niets mee, *Ja, overschrijven* wel.
- [ ] **C4.** *Exporteren & communicatie* en dan *Uitnodigingen en
  herinneringen*: download de uitnodigingen. Je ziet: een bestand met per
  persoon een link.
- [ ] **C5.** Open een link als medewerker (privévenster). Geef voorkeuren op:
  geblokkeerd, liever niet, voorkeur, parttime. De vijf toestanden zijn
  zichtbaar verschillend, ook in zwart-wit.
- [ ] **C6.** Hand de voorkeuren in. *Status voorkeuren* bij de planner telt
  mee.
- [ ] **C7.** *Rooster opnieuw genereren met solver*. Je ziet: geen lege
  diensten, geen dienst op een geblokkeerde dag, niemand twee diensten in één
  week.
- [ ] **C8.** Wijzig een dienst met de hand, klik op *Ongedaan maken* binnen
  twee minuten. Na twee minuten of na verversen is de knop weg.
- [ ] **C9.** Publiceren: de publicatiecontrole noemt wat niet klopt. Publiceer,
  maak definitief, trek de publicatie in en publiceer weer.
- [ ] **C10.** Saldo's: kloppen de aantallen diensten meer en minder met wat je
  verwacht, en staan ze in woorden ("1 avonddienst minder")?
- [ ] **C11.** *Rooster verwijderen* en de periode naar de *Prullenbak*. Je ziet:
  hij is er terug te zetten. Terugzetten werkt.

## Blok D. Ruilen en afwezigheid (achterwacht)

- [ ] **D1.** Als medewerker: *+ Ruilverzoek* indienen voor een dienst in een
  definitief rooster. Bij een voorlopig rooster kan het niet.
- [ ] **D2.** De collega keurt goed. Je ziet: de diensten zijn gewisseld in het
  rooster van beiden.
- [ ] **D3.** Een ruil afwijzen en een ruil laten intrekken door het rooster
  (bijvoorbeeld na een wijziging). De uitkomst is in woorden en "ingetrokken".
- [ ] **D4.** Afwezigheid opgeven en weer weghalen. Parttimedagen kloppen met
  de factor in *Personeel beheren*.

## Blok E. AIOS: een kwartaal

Volg hiervoor `docs/aios-testdraaiboek.md`. Dit zijn de punten die je niet mag
overslaan:

- [ ] **E1.** Geschiedenis van vóór de app inlezen en het kwartaal ervandaan
  laten starten. Lees daarna een tweede bestand in met maar één AIOS. *Bewaren*
  vraagt eerst om bevestiging en noemt wie daarna geen geschiedenis meer heeft.
- [ ] **E2.** Voorkeuren van een AIOS op de eigen pagina (375 px breed), met
  blokken van nachten en een toelichting per dag.
- [ ] **E3.** Voorkeurenoverzicht downloaden, aanpassen en terug importeren
  (alleen de beheerder). Eerst controleren, dan toepassen.
- [ ] **E4.** Rooster maken met de AIOS-solver. Geen lege diensten die er niet
  hoeven te zijn, en de uitleg bij lege diensten klopt.
- [ ] **E5.** Publiceren, definitief maken, ruilen tussen twee AIOS.
- [ ] **E6.** Een AIOS ziet niets van een andere AIOS en niets van de
  achterwacht.

## Blok F. Persoonlijke links (alleen de beheerder)

- [ ] **F1.** Open bij een periode (achterwacht en AIOS) de sectie
  *Persoonlijke links*. Een planner ziet die sectie niet.
- [ ] **F2.** De lijst toont per link voor wie, gemaakt, voor het laatst
  gebruikt en of hij werkt. De link zelf staat er nergens.
- [ ] **F3.** *Intrekken* vraagt eerst om bevestiging. Annuleren verandert
  niets. Bevestigen: de link werkt niet meer, de medewerker is uitgelogd.
- [ ] **F4.** Is het de enige werkende link, dan zegt de vraag dat.
- [ ] **F5.** *Alles intrekken* zegt hoeveel links en medewerkers. Daarna werkt
  geen enkele link van de periode meer en de knop verdwijnt.
- [ ] **F6.** Medewerker via *Link kwijt?* een nieuwe link laten aanvragen.
  Je ziet: weer toegang.
- [ ] **F7.** Links van een andere periode blijven werken na *Alles
  intrekken*.
- [ ] **F8.** Een link werkt tot en met de laatste dag van zijn periode. De dag
  erna krijg je de melding dat de link verlopen is. Vraag dan een nieuwe aan.
- [ ] **F9.** *Link kwijt?* drie keer achter elkaar met hetzelfde adres werkt.
  De vierde keer binnen een uur geeft de melding dat je een uur moet wachten.

## Blok G. Mail en verzendlijst

- [ ] **G1.** *Mailinstellingen* (alleen de beheerder): een Gmail-adres met een
  app-wachtwoord opslaan. Geef het wachtwoord alleen in de app in. Een
  verkeerd wachtwoord wordt geweigerd met een duidelijke melding.
- [ ] **G2.** Zonder instellingen staat bij de knoppen die versturen waarom
  het niet kan.
- [ ] **G4.** Bij een gepubliceerd rooster (achterwacht en AIOS) staat de knop
  *Rooster opnieuw mailen*. Hij vraagt eerst om bevestiging. Daarna gaat de
  mail van de publicatie (voorlopig of definitief) nog een keer naar iedereen.
- [ ] **G5.** Twee keer snel achter elkaar op *Herinneringen versturen*
  klikken stuurt één verzendlijst. De tweede klik krijgt de melding dat er al
  verstuurd wordt.
- [ ] **G3.** Op de echte stroom (niet op test): één uitnodiging, één
  herinnering en één ruilmail komen binnen met de juiste tekst en link.

## Blok H. Op elk scherm

- [ ] **H1.** Telefoon of venster van 375 px: geen zijwaarts scrollen op de
  periodepagina, de voorkeurenkalender, *Personeel beheren* en de dialogen.
- [ ] **H2.** Afdrukken in zwart-wit: het rooster is leesbaar.
- [ ] **H3.** Alles is Nederlands: geen "Failed to fetch", geen "1 diensten".
- [ ] **H4.** Weken tonen het ISO-weeknummer. Zaterdag en zondag zijn aparte
  vakjes.
- [ ] **H5.** Toetsenbord: je kunt de secties openen en de dialogen sluiten met
  Escape.

## Blok I. Grenzen en fouten

- [ ] **I1.** Een Excel-import met een kapot of enorm bestand geeft een
  Nederlandse melding, en de melding noemt de juiste rij.
- [ ] **I2.** Twee tabbladen tegelijk: wijzig in het ene, kijk in het andere.
  Tijdens het maken van een rooster geven wijzigingen een melding in plaats van
  half te gebeuren.
- [ ] **I3.** Start de AIOS-solver niet (stop de container) en maak een rooster.
  Je ziet: een nette melding dat de solver niet bereikbaar is, en de
  achterwacht werkt gewoon door.
- [ ] **I4.** Herstart alle containers. Gegevens en sessies blijven.
- [ ] **I5.** Maak een back-up van de map `data` en zet die terug op een lege
  installatie. Alles is er weer.

## Afronden

- [ ] Noteer per blok wat niet klopte, met het regelnummer.
- [ ] Alles groen? Dan de versie vrijgeven en op productie dezelfde blokken A
  en F nog eens kort doen.
