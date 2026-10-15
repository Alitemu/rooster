# Ontwerp: het rooster voor de AIOS

Status: ontwerp, nog niet gebouwd. Afgesproken met de planner in oktober 2026.
Drie punten staan nog open, onderaan. De scheiding tussen de planner van de
achterwacht en die van de AIOS bestaat al (CLAUDE.md, "Diensten: the
achterwacht and the AIOS"): dit rooster komt daarachter.

Codenamen: aios01, aios02 enzovoort.

## Periode

- Een kwartaal van woensdag tot en met dinsdag, zodat de blokken precies in de
  periode passen.
- Q1 begint op de eerste woensdag na 1 januari. Q2 en Q3 beginnen telkens 13
  weken later. Q4 loopt tot de dag vóór het volgende Q1, dus 13 of 14 weken.
  (Het oude Excelformulier liet Q4 en Q1 een week overlappen in jaren waarin 1
  januari op een dinsdag valt, zoals 2030.)
- Een deadline voor de verzoeken, herinneringen en publiceren zoals bij de
  achterwacht.

## Diensten

Per dienst precies één AIOS.

| Dienst | Tijd | Werkdag | Zaterdag en zondag | Feestdag |
|---|---|---|---|---|
| Uitloopdienst (UD) | 10:15-20:00 | ja, 0,2 punt | nee | nee |
| Dagdienst (DD) | 08:30-18:00 | nee | ja, 1 punt | ja, 1 punt |
| Avonddienst (AD) | 13:30-23:00 | ja, 0,6 punt | ja, 1 punt | ja, 1 punt |
| Nachtdienst (ND) | 22:30-08:30 | ja, 1 punt | ja, 1 punt | ja, 1 punt |

- Feestdagen zijn die van lib/holidays.ts. Een feestdag telt als weekenddag.
- Kerstavond en oudjaarsdag zijn gewone werkdagen: daar mag ook geblokkeerd.

## Blokken

- Avonden en nachten gaan in blokken: zondag tot en met dinsdag en woensdag tot
  en met vrijdag. Zaterdag is een losse dienst. Eén AIOS doet het hele blok, ook
  als er een feestdag in valt.
- Blok van vier: wie "4 avonden" aangeeft, kan woensdag tot en met zaterdag
  krijgen. Hetzelfde geldt apart voor "4 nachten". Voor ieder ander gaan het
  blok woensdag tot en met vrijdag en de zaterdag naar twee verschillende AIOS.
- Dagdienst in het weekend: zaterdag en zondag naar twee verschillende AIOS,
  behalve bij wie "twee dagdiensten" aangeeft.
- Per weekend hoogstens één losse weekenddienst per AIOS, behalve de twee
  dagdiensten bij wie dat aangeeft.

## Verzoeken van de AIOS

| Oud formulier | In de app |
|---|---|
| a (antiverzoek) | geblokkeerd, niet op een feestdag |
| (nieuw) | liever niet, ook op een feestdag |
| p (proverzoek) | voorkeur |
| v (verlof) | afwezigheid; op een feestdag wordt dat liever niet |
| n (niet dienstklaar, uit dienst) | Geldig vanaf/tot van het lidmaatschap |

- Een avond- of nachtblok markeer je als één geheel. Geblokkeerd op één avond is
  het hele blok.
- 50%-regel, alleen als waarschuwing en nooit als weigering: per groep een
  teller met het maximum.
  - Dagdiensten in het weekend en op feestdagen: dagen met geblokkeerd, gedeeld
    door alle weekend- en feestdagen van het kwartaal.
  - Losse diensten op zaterdag (avond en nacht): gedeeld door twee keer het
    aantal zaterdagen.
  - Avondblokken met minstens één geblokkeerde avond, gedeeld door alle
    avondblokken.
  - Nachtblokken op dezelfde manier.
  - Uitloopdiensten tellen niet mee, verlof en niet dienstklaar ook niet.
- Bovenaan het scherm: de parttimedagen (deeltijdpatronen, zoals bij de staf),
  "4 avonden", "4 nachten", "twee dagdiensten", "Inwerken" en algemene
  verzoeken (vrije tekst, hoogstens 120 tekens).
- Geen reden per dag: die werd niet gebruikt bij het maken van het rooster.

## Inwerken

- De AIOS vinkt "Inwerken" zelf aan in het voorkeurenscherm en vult een begin-
  en een einddatum in. Niets is vooraf ingevuld. De app controleert dat beide
  data binnen het kwartaal vallen.
- Tijdens de inwerkperiode krijgt de AIOS alleen uitloopdiensten en de
  dagdienst op zaterdag. Na de einddatum kan de AIOS voor alles worden
  ingepland.
- Bij het aanvinken staat in beeld wat dat betekent.
- Dit is iets anders dan niet dienstklaar (n): dan heeft iemand helemaal geen
  diensten.

## Harde regels

De solver breekt deze nooit. Handmatig indelen kan wel, met een waarschuwing,
zoals nu bij een geblokkeerde dag.

1. Geen dienst op een geblokkeerde dag, tijdens verlof of buiten Geldig
   vanaf/tot.
2. Blokken altijd heel. Elke dienst precies één AIOS.
3. Nooit twee diensten op één dag voor dezelfde AIOS.
4. Op de parttimedag geen uitloopdienst en geen avondblok waar die dag in valt.
   Een nachtblok mag wel.
5. Fulltimers (1,0 fte) nooit in het nachtblok zondag tot en met dinsdag (de
   arbeidstijdenwet).
6. Inwerken: zie hierboven.
7. Geen dienst op een compensatiedag. De compensatie zelf regelt het
   roosterbureau na de publicatie. De app blokkeert die dagen automatisch voor
   de AIOS die de dienst heeft.

   | Dienst | Geen andere dienst op |
   |---|---|
   | Nachtblok zo t/m di | woensdag en donderdag |
   | Avondblok zo t/m di | woensdag |
   | Blok wo t/m vr (avond of nacht) | zaterdag en zondag |
   | Avondblok wo t/m za | zondag |
   | Nachtblok wo t/m za | zondag en maandag |
   | Dag- of avonddienst op zaterdag en dagdienst op zondag (één ervan of allebei) | de vrijdag ervoor en de maandag erna |
   | Losse nacht op zaterdag | de vrijdag ervoor, de zondag en de maandag erna |

8. Valt een compensatiedag op een werkdag die een feestdag is, dan schuift die
   een dag op: een compensatiedag vóór de dienst een dag eerder, een
   compensatiedag na de dienst een dag later. Is dat ook een feestdag, dan nog
   een dag. Voorbeelden: de vrijdag vóór een zaterdagse dagdienst is Koningsdag,
   dan wordt het donderdag. De maandag na een zondagse dagdienst is Tweede
   Paasdag, dan wordt het dinsdag. De donderdag na een nachtblok zo t/m di is
   Hemelvaartsdag, dan wordt het vrijdag.

Er is verder geen algemene rustregel en geen minimale tijd tussen twee blokken.

## Eerlijkheid

- Dienstpercentage = punten / (werkdagen in de periode x fte). Eén avond-,
  nacht- of dagdienst per week is dan 20% bij 1,0 fte en 25% bij 0,8 fte.
  Verlof telt als gewone werkdag. Uitloopdiensten tellen mee (0,2).
- FTE volgt uit de parttimedagen die de AIOS zelf opgeeft: elke week één dag is
  0,8, om de week één dag is 0,9, geen parttimedag is 1,0. Een patroon dat maar
  een deel van het kwartaal geldt, telt naar rato. Een parttimedag heeft altijd
  een vaste weekdag: een variabele parttimedag komt niet voor.
- Het doel is voor iedereen hetzelfde percentage, over de periodes heen: de app
  telt de punten van alle gepubliceerde roosters bij elkaar (zoals de
  feestdagdiensten over de jaren), zodat een tekort of overschot vanzelf wordt
  ingehaald.
- Hoogstens 25% over de periodes heen. In één kwartaal mag het erboven als er
  anders geen kloppend rooster is. De planner ziet dat vóór het genereren:
  Q3 2026 heeft 195 punten (nachten 91, avonden 65, dagdiensten 26,
  uitloopdiensten 13), dus de AIOS hebben samen minstens 12 fte nodig voor
  gemiddeld 25%.
- Avonden, nachten en dagdiensten in het weekend en op feestdagen worden elk
  apart eerlijk naar fte verdeeld, met een streefbereik per soort. Voor wie
  inwerkt, telt het streefbereik voor avonden en nachten naar rato van het deel
  van het kwartaal na de inwerkperiode.
- Geschiedenis van vóór de app: bij de eerste AIOS-periode een import per AIOS,
  zoals de beginsaldi bij de achterwacht.

## In de app

- Een pool van het type AIOS, met eigen diensttypes (UD, DD, AD, ND) en een
  dienst per type per dag. `shift_slot.shift_block_id` bestaat al in het
  datamodel voor de blokken.
- De periode van een AIOS-pool rondt af op woensdag tot dinsdag, niet op een
  ISO-week.
- Een eigen model in de solver: één beslissing per blok in plaats van per dag.
  Dat raakt het contract met de solver.
- Het voorkeurenscherm toont per dag de diensten die er die dag zijn, met de
  blokken als één vak. Leesbaar op 375 pixels breed.

## Bouwvolgorde

Elke stap wordt een eigen versie. Het rooster van de achterwacht blijft
ongewijzigd.

1. AIOS-pool, het kwartaal van woensdag tot dinsdag, de vier diensten met
   blokken en punten.
2. Het voorkeurenscherm voor de AIOS.
3. Het AIOS-model in de solver, met een test en een mutatie per harde regel.
4. Voor de planner: genereren, het rooster per blok, handmatig aanpassen en
   publiceren. Ruilen (blok tegen blok) daarna.
5. AIOS-accounts aanzetten: eerst op de testinstallatie, dan in productie.

## Nog open

1. De avonddienst op zondag hoort bij het avondblok zo t/m di, dus de maandag
   erna is zelf een avond van dat blok. Geldt de regel van de vrijdag ervoor en
   de maandag erna daar niet, zodat alleen de woensdag van het blok telt? Of
   blokkeert de zondagavond wel de vrijdag ervoor?
2. Een dagdienst op een feestdag door de week (bijvoorbeeld Tweede Paasdag):
   geldt daar dezelfde regel als voor een losse weekenddienst (geen dienst op de
   dag ervoor en de werkdag erna)?
3. Een compensatiedag op een feestdag: klopt de richting in regel 8 (vóór de
   dienst een dag eerder, na de dienst een dag later)?
