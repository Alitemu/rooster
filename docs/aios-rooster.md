# Ontwerp: het rooster voor de AIOS

Status: stap 1 (versie 0.70.0) en stap 2 (versie 0.72.0, aangevuld in 0.73.0) zijn gebouwd, de rest is ontwerp. Afgesproken met de planner in oktober 2026,
daarna aangevuld met de ingevulde vragenlijst (de nummers tussen haakjes, zoals
F1, verwijzen ernaar). Getoetst aan oude roosters rond Koningsdag, Pasen,
Pinksteren, kerst en oud en nieuw (2025-2026). De scheiding tussen de planner
van de achterwacht en die van de AIOS bestaat al (docs/development/diensten.md):
dit rooster komt daarachter. Wat nog open staat, staat onderaan.

Codenamen: aios01, aios02 enzovoort.

## Wie

- De planner is een van de AIOS, met een eigen account voor de AIOS (A1, A2).
  De twee planners zien elkaars rooster en voorkeuren niet, de beheerder ziet
  en wijzigt beide (A3, A4).
- Geen leesaccounts voor anderen: opleider en afdeling krijgen het definitieve
  rooster als Excelbestand (A5).
- 20 tot 60 AIOS, vaak 0,8 fte. Er komt minstens eens per maand iemand bij of
  gaat iemand weg (B1, B2, B5). Alleen AIOS die langer dan 14 maanden in
  opleiding zijn doen mee. AIOS uit een ander ziekenhuis doen mee na hun
  inwerkperiode (B3). Niemand zit in beide roosters (B8).

## Periode

- Een kwartaal van woensdag tot en met dinsdag, zodat de blokken precies in de
  periode passen (E5).
- Q1 begint op de eerste woensdag na 1 januari; valt 1 januari zelf op een
  woensdag, dan op 8 januari (zoals het oude Excelformulier). Q2 en Q3 beginnen
  telkens 13 weken later. Q4 loopt tot de dag vóór het volgende Q1, dus 13 of 14
  weken. (Het oude Excelformulier liet Q4 en Q1 een week overlappen in jaren
  waarin 1 januari op een dinsdag valt, zoals 2030.)
- Het eerste kwartaal uit de app begint op woensdag 6 januari 2027 (O1). Er is
  geen proefperiode naast het oude rooster (O5). De planner en een AIOS testen
  vooraf (O6).
- De voorkeuren moeten 8 weken voor de start binnen zijn (I8), het rooster is
  een maand voor de start gepubliceerd (K2). Voor 6 januari 2027 is dat 11
  november en 6 december 2026.
- Herinneringen, voorlopig publiceren en daarna definitief maken zoals bij de
  achterwacht (K5). Het rooster gaat als Excel naar het roosterbureau (K6), dat
  ook het werkrooster overdag maakt, de compensatiedagen inplant en de uren
  bijhoudt (C7, K7).

## Diensten

De tijden van de vragenlijst (C1), die vorig jaar zijn gewijzigd (C9):

| Code | Dienst | Tijd | Op een werkdag | Op zaterdag, zondag en een feestdag |
|---|---|---|---|---|
| UD | Uitloopdienst | 17:36-20:00 | ja, 0,2 punt | nee |
| DD | Dagdienst | 08:30-18:12 | nee | ja, 1 punt |
| AD | Avonddienst | 17:36-23:12 | ja, 0,6 punt | nee |
| ADW | Avonddienst weekend | 13:30-23:12 | nee | ja, 1 punt |
| ND | Nachtdienst | 22:30-08:30 | ja, 1 punt | ja, 1 punt |

- AD en ADW zijn samen de avonddiensten: één avondblok kan beide bevatten (de
  zondag van het blok zo t/m di is een ADW).
- Feestdagen zijn die van lib/holidays.ts, dezelfde als bij de achterwacht en
  in het oude formulier (J1). Een feestdag telt als weekenddag.
- Kerstavond en oudjaarsdag zijn gewone werkdagen: daar mag ook geblokkeerd
  (J4).
- Per dienst precies één AIOS, met één uitzondering: de nacht van oudjaarsdag op
  nieuwjaarsdag heeft twee AIOS (D7, J5). Valt 31 december in de periode, dan
  vraagt de melding bij het genereren (zie "Blokken rond feestdagen") of het er
  deze keer twee zijn; twee staat al ingevuld. Bij twee plant de solver ze
  allebei. De nacht blijft dan in het blok van de ene AIOS, de tweede doet een
  losse nacht. Beide tellen voor 1 punt.
- UD en AD overlappen: dan zijn er twee AIOS tegelijk (D1). Geen
  bereikbaarheidsdiensten (C6).
- Een dienst zonder AIOS houdt het publiceren tegen: de planner vult het gat
  eerst met de hand (D2).

## Blokken

- Avonden en nachten gaan in blokken: zondag tot en met dinsdag en woensdag tot
  en met vrijdag. Zaterdag is een losse dienst. Eén AIOS doet het hele blok, ook
  als er een feestdag in valt (E1, E3, E9, E11).
- Blok van vier: wie "4 avonden" aangeeft, kan woensdag tot en met zaterdag
  krijgen. Hetzelfde geldt apart voor "4 nachten". Voor ieder ander gaan het
  blok woensdag tot en met vrijdag en de zaterdag naar twee verschillende AIOS.
- Dagdienst in het weekend: zaterdag en zondag naar twee verschillende AIOS,
  behalve bij wie "twee dagdiensten" aangeeft.
- Per weekend hoogstens één losse weekenddienst per AIOS, behalve de twee
  dagdiensten bij wie dat aangeeft.
- De dagdienst op een feestdag door de week is een losse dienst.
- Nooit twee blokken direct na elkaar, zoals een avondblok gevolgd door een
  nachtblok (E8). Dat volgt al uit de compensatiedagen (harde regel 7).
- Spreiding: zo veel mogelijk tijd tussen twee blokken van dezelfde AIOS. Eens
  per maand een nachtblok is beter dan elke week (E7, H7). Een zachte regel in
  de solver, zoals het venster bij de achterwacht.

## Blokken rond feestdagen

- Standaard blijven de blokken heel, ook met een feestdag erin (zo bleef bij
  Koningsdag op maandag het avond- en het nachtblok zo t/m di bij één AIOS).
- Aaneengesloten feestdagen (twee of meer feestdagen achter elkaar: Pasen,
  Pinksteren, kerst) vragen om een keuze van de planner, want in oude roosters
  ging dat elk jaar anders. Bij het genereren verschijnt daarom een duidelijke
  melding per aaneengesloten feestdagen, met de blokken waar ze in vallen en de
  vraag wat ermee moet gebeuren. Per blok (avond en nacht apart):
  - heel laten: één AIOS doet het hele blok;
  - opknippen: elke dag van het blok is een losse dienst.

  Genereren kan pas als elke vraag beantwoord is. De keuze wordt bij de periode
  bewaard en staat bij een volgende generatie al ingevuld.
- Een losse feestdag in een blok (zoals Koningsdag of Nieuwjaarsdag) blijft heel,
  maar de planner kan dat blok op dezelfde plek ook opknippen.
- Daarna kan de planner een dienst nog met de hand aanpassen, zoals altijd.

## Verzoeken van de AIOS

| Oud formulier | In de app |
|---|---|
| a (antiverzoek) | geblokkeerd, niet op een feestdag |
| (nieuw) | liever niet, ook op een feestdag |
| p (proverzoek) | voorkeur |
| v (verlof) | afwezigheid; op een feestdag wordt dat liever niet |
| n (niet dienstklaar, uit dienst) | Geldig vanaf/tot van het lidmaatschap |

- Per dag en per dienst, zoals in het oude formulier. Een avond- of nachtblok
  geldt als één geheel: wie de maandag blokkeert, blokkeert ook het nachtblok
  zondag tot en met dinsdag (I1). Zo kan iemand ook "liever geen nachten in
  maart" aangeven (I2).
- Vaste dagen zonder dienst (onderwijs, terugkomdag) blokkeert de AIOS zelf
  (I5). Vakantie en verlof geeft de AIOS zelf op voordat het rooster gemaakt
  wordt (I4).
- 50%-regel, als waarschuwing en nooit als weigering (I3): per groep een
  teller met het maximum. Wie in een groep meer dan de helft blokkeert, houdt
  de helft als harde blokkade. Voor het deel erboven mag de solver een
  blokkade negeren als het rooster anders niet rond komt of oneerlijk wordt,
  hoogstens zoveel als die AIOS boven de helft zit: wie 12 van de 20
  blokkeert, met hoogstens 10, kan er 2 kwijtraken. De solver kiest welke.
  Het scherm zegt dat bij de teller, met het aantal, zodat niemand zomaar
  alles blokkeert (de keuze van de planner in oktober 2026). Voor de solver:
  zulke blokkades zwaarder dan liever niet, maar geen harde regel, en per
  groep hoogstens `erboven` (lib/aiosVoorkeur.ts blokkadeTellers).
  - Dagdiensten in het weekend en op feestdagen: dagen met geblokkeerd, gedeeld
    door alle weekend- en feestdagen van het kwartaal.
  - Losse diensten op zaterdag (avond en nacht): gedeeld door twee keer het
    aantal zaterdagen.
  - Avondblokken met minstens één geblokkeerde avond, gedeeld door alle
    avondblokken.
  - Nachtblokken op dezelfde manier.
  - Uitloopdiensten tellen niet mee, verlof en niet dienstklaar ook niet (het
    oude formulier telde alleen de a).
- Bovenaan het scherm: de parttimedagen (deeltijdpatronen, zoals bij de staf),
  "4 avonden", "4 nachten", "twee dagdiensten", "Inwerken", een onderbreking van
  de opleiding en algemene verzoeken (vrije tekst, hoogstens 120 tekens).
- Geen reden per dag: die werd niet gebruikt bij het maken van het rooster.
- Geen voorkeur voor met wie iemand dienst doet (D6, I7).

## Inwerken

- De AIOS vinkt "Inwerken" zelf aan in het voorkeurenscherm en vult een begin-
  en een einddatum in. Niets is vooraf ingevuld. De app controleert dat beide
  data binnen het kwartaal vallen.
- Tijdens de inwerkperiode krijgt de AIOS alleen uitloopdiensten en de
  dagdiensten op zaterdag en zondag, want dan is er hulp aanwezig (B9, H3; de
  keuze van de planner in oktober 2026). Geen dagdienst op een feestdag door
  de week. Na de einddatum kan de AIOS voor alles worden ingepland.
- Bij het aanvinken staat in beeld wat dat betekent.
- Dit is iets anders dan niet dienstklaar (n): dan heeft iemand helemaal geen
  diensten.

## Onderbreking van de opleiding

- Een wetenschappelijke periode of zwangerschapsverlof schort de opleiding op
  (B10, G5, G10). De AIOS geeft een begin- en een einddatum op. Daarin krijgt de
  AIOS geen diensten en die dagen tellen niet mee voor het dienstpercentage.
- Zwanger en wel aan het werk, maar zonder diensten: de AIOS geeft op vanaf
  wanneer ze geen diensten meer doet (niet dienstklaar). Ziekte op het laatste
  moment regelen de AIOS onderling; de planner past het rooster met de hand aan
  (B10, L6, L7).
- Een AIOS die naar een ander ziekenhuis gaat, krijgt een einddatum in Geldig
  vanaf/tot (B7). Diensten in een ander ziekenhuis tellen niet mee (G11).

## Harde regels

De solver breekt deze nooit. Handmatig indelen kan wel, met een waarschuwing,
zoals nu bij een geblokkeerde dag (F8).

1. Geen dienst op een geblokkeerde dag, tijdens verlof, tijdens een
   onderbreking of buiten Geldig vanaf/tot. Een uitzondering: het deel boven
   de helft bij de 50%-regel (zie "Verzoeken van de AIOS").
2. Blokken altijd heel. Elke dienst precies één AIOS.
3. Nooit twee diensten op één dag voor dezelfde AIOS.
4. Op de parttimedag geen uitloopdienst en geen avondblok waar die dag in valt.
   Een nachtblok mag wel.
5. Fulltimers (1,0 fte) nooit in het nachtblok zondag tot en met dinsdag: dat
   is voor parttimers (F7).
6. Inwerken: zie hierboven.
7. Geen dienst op een compensatiedag (C8, F6, F7). De compensatie zelf regelt
   het roosterbureau na de publicatie. De app blokkeert die dagen automatisch
   voor de AIOS die de dienst heeft.

   | Dienst | Geen andere dienst op |
   |---|---|
   | Nachtblok zo t/m di | woensdag en donderdag |
   | Avondblok zo t/m di | woensdag |
   | Blok wo t/m vr (avond of nacht) | zaterdag en zondag |
   | Avondblok wo t/m za | zondag |
   | Nachtblok wo t/m za | zondag en maandag |
   | Dag- of avonddienst op zaterdag en dagdienst op zondag (één ervan of allebei) | de vrijdag ervoor en de maandag erna |
   | Losse nacht op zaterdag | de vrijdag ervoor, de zondag en de maandag erna |
   | Dagdienst op een feestdag door de week | de dag ervoor en de dag erna |
   | Losse avond of nacht door de week (een opgeknipt blok, de tweede AIOS op oudjaarsnacht) | de dag erna |

   De avonddienst op zondag hoort bij het avondblok zo t/m di. Daarvoor geldt
   alleen de woensdag van dat blok, niet de vrijdag ervoor en de maandag erna.

8. Valt een compensatiedag op een werkdag die een feestdag is, dan schuift die
   een dag op: een compensatiedag vóór de dienst een dag eerder, een
   compensatiedag na de dienst een dag later. Is dat ook een feestdag, dan nog
   een dag. Voorbeelden: de vrijdag vóór een zaterdagse dagdienst is Koningsdag,
   dan wordt het donderdag. De maandag na een zondagse dagdienst is Tweede
   Paasdag, dan wordt het dinsdag. De donderdag na een nachtblok zo t/m di is
   Hemelvaartsdag, dan wordt het vrijdag. De feestdag zelf is dan geen
   compensatiedag meer.
9. Rust (F1, F2, F3): minstens 14 uur tussen het eind van een dienst en het
   begin van de volgende. Na een nachtblok van drie of vier nachten 46 uur.
   Hoogstens 7 nachten achter elkaar. Met de tijden hierboven volgt dat bijna
   altijd al uit regel 7, maar niet als regel 8 een feestdag vrijgeeft: na een
   nachtblok zo t/m di dat op woensdag Koningsdag eindigt, mag er op die
   woensdag toch geen dienst komen. Een ruil mag deze regels ook niet breken
   (L3).

Het gemiddelde van 46 uur per week over een jaar (F5) bewaakt het roosterbureau
met de compensatiedagen; de app kent de uren overdag niet (F9).

## Eerlijkheid

- Dienstpercentage = punten / (werkdagen in de periode x fte). Werkdagen zijn
  maandag tot en met vrijdag zonder de feestdagen. Eén avond-,
  nacht- of dagdienst per week is dan 20% bij 1,0 fte en 25% bij 0,8 fte (C4).
  Verlof en ziekte tellen als gewone werkdag, een onderbreking van de opleiding
  niet (G5). Uitloopdiensten tellen mee (0,2).
- FTE volgt uit de parttimedagen die de AIOS zelf opgeeft: elke week één dag is
  0,8, om de week één dag is 0,9, geen parttimedag is 1,0. Een patroon dat maar
  een deel van het kwartaal geldt, telt naar rato. Een parttimedag heeft altijd
  een vaste weekdag: een variabele parttimedag komt niet voor.
- De grens uit het opleidingsplan (G1): "ten hoogste 20% van de arbeidsduur van
  de totale opleiding, met een maximum van 25% per opleidingsjaar". De app telt
  alleen wat in dit ziekenhuis gedaan is (G11, O3). Boven 25% is een
  waarschuwing, geen weigering (G6). Ook een ruil mag erboven (L4).
- Iedereen doet naar rato evenveel (G8, H3): het doel is voor iedereen hetzelfde
  percentage. Een tekort of overschot schuift door naar de volgende periode,
  zoals bij de achterwacht (H4, H5, G13). Het doel telt alleen de dagen waarop
  iemand diensten kan doen, zodat wie niet dienstklaar was dat later niet
  hoeft in te halen.
- Avonden, nachten en dagdiensten in het weekend en op feestdagen worden elk
  apart eerlijk naar fte verdeeld, met een streefbereik per soort (H1). Nachten
  zijn het zwaarst en wegen het meest (H2). Voor wie inwerkt, telt het
  streefbereik voor avonden en nachten naar rato van het deel van het kwartaal
  na de inwerkperiode.
- Feestdagdiensten eerlijk over de jaren, zoals bij de achterwacht: het aantal,
  niet welke feestdag (J2).
- De planner ziet vóór het genereren hoeveel punten het kwartaal heeft: Q3 2026
  heeft 195 punten (nachten 91, avonden 65, dagdiensten 26, uitloopdiensten 13),
  dus de AIOS hebben samen minstens 12 fte nodig om onder gemiddeld 25% te
  blijven.
- In het overzicht van de planner een kolom met het dienstpercentage per AIOS,
  met een balkje: groen onder 25%, rood daarboven (G13). De AIOS ziet het eigen
  percentage bij de publicatie (G12).
- Geschiedenis van vóór de app: bij de eerste AIOS-periode een import per AIOS
  van het aantal diensten per soort en de feestdagen van de afgelopen jaren, uit
  Excel (G9, O3, O4), zoals de beginsaldi bij de achterwacht.

## Ruilen

- AIOS ruilen onderling, zonder goedkeuring van de planner (L1, L2): een heel
  blok of een losse dienst uit een blok. Alleen een gelijkwaardige ruil.
- Een ruil mag de harde regels niet breken (L3), wel de 25% (L4). Wie inwerkt,
  ruilt alleen wat die mag doen (L5).

## In de app

- Een pool van het type AIOS, met eigen diensttypes (UD, DD, AD, ADW, ND) die
  elk een code, tijden en punten hebben. Per dag de diensten die er die dag
  zijn. De tweede AIOS op oudjaarsnacht wordt een tweede dienst op die nacht,
  zodat elke dienst één AIOS houdt.
- Een blok is een eigen rij (shift_block): avond of nacht, zo t/m di, wo t/m vr
  of de losse zaterdag. Elke avond- en nachtdienst hoort bij een blok
  (`shift_slot.shift_block_id`).
- De periode van een AIOS-pool is een kwartaal van woensdag tot dinsdag, geen
  ISO-weken.
- Eigen code (de keuze van de planner in oktober 2026): na de inlogpagina heeft
  de AIOS eigen pagina's, routes en code. Wat de AIOS van de achterwacht nodig
  heeft, wordt gekopieerd en niet aangepast, zodat code die bij de achterwacht
  werkt niet ineens breekt. Gedeeld zijn alleen de inlog, de database en het
  Gmail-account (docs/development/diensten.md, "Copied, not changed").
- Een eigen solver voor de AIOS, in een eigen container, los van die van de
  achterwacht. De solver van de achterwacht blijft ongewijzigd. Eén beslissing
  per blok in plaats van per dag.
- Het voorkeurenscherm toont per dag de diensten die er die dag zijn, met de
  blokken als één vak. Leesbaar op 375 pixels breed. Wat een feestdag
  betekent (niet blokkeren, ook geen blok met een feestdag erin, afwezigheid
  wordt liever niet) staat in een eigen kader, bij de diensten en bij de
  afwezigheid (0.73.0).
- De planner en de beheerder downloaden twee overzichten (0.73.0):
  voorkeuren per dienst (een rij per dienst, een kolom per AIOS) en
  verzoeken per AIOS (4 avonden, 4 nachten, twee dagdiensten, inwerken,
  onderbreking, opmerking, parttimedagen, afwezigheid en de tellers).
- Mail: één mailaccount voor beide roosters, hoogstens 100 tot 150 mails per dag
  als beide tegelijk uitnodigen (N5). De AIOS hebben een eigen stroom (N1, de
  keuze van de planner in oktober 2026): de verzendlijst van de AIOS gaat naar
  een eigen stroomadres. Dat stelt de beheerder in op de pagina van een periode
  van de AIOS. Het komt later ook in het ruilscherm van de AIOS. De lijst met adressen van de AIOS staat bij de
  roosteraar (N2). Geen kopie voor de opleider (N4). Herinneringen gaan ook
  vanzelf, een week en een dag voor de deadline, net als bij de achterwacht
  (0.73.0). De planner kan ze per periode pauzeren.
- Het AIOS-rooster houdt geen rekening met de achterwacht en andersom (M1 tot en
  met M5). Fellows doen bij de AIOS alleen de ondersteuning op zaterdag en de
  nacht voor de voortgangstoets (M4).

## Bouwvolgorde

Elke stap wordt een eigen versie. Het rooster van de achterwacht blijft
ongewijzigd. Voor het eerste kwartaal (6 januari 2027) moeten stap 2 en de
accounts uit stap 5 eind oktober klaar zijn, zodat de AIOS hun voorkeuren voor
11 november kunnen opgeven. Stap 3 en 4 moeten half november klaar zijn.

1. AIOS-pool, het kwartaal van woensdag tot dinsdag, de vijf diensten met
   blokken en punten.
2. Het voorkeurenscherm voor de AIOS.
3. Het AIOS-model in de solver, met een test en een mutatie per harde regel.
4. Voor de planner: genereren, het rooster per blok, handmatig aanpassen en
   publiceren. Ruilen daarna.
5. AIOS-accounts aanzetten: eerst op de testinstallatie, dan in productie.

## Nog open

1. Voortgangstoets (I6): twee keer per jaar heeft geen AIOS de nacht ervoor
   dienst. De planner vinkt bij het kwartaal aan dat er een voortgangstoets is,
   met de datum. Die nacht vult de planner met de hand in met een fellow. Een fellow
   zit niet in de AIOS-pool (B8). Komt de fellow als naam of codenaam in dat
   ene vak? En wat gebeurt er met de rest van het nachtblok waar die nacht in
   valt?
2. Het opleidingsjaar (G1): de app weet niet wanneer iemands opleidingsjaar
   begint. Voorstel: de waarschuwing boven 25% over het kwartaal en over de
   laatste vier kwartalen samen.
