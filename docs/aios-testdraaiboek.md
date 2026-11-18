# Draaiboek: een kwartaal van de AIOS testen

Met dit draaiboek (versie 2.1.0) loop je op de testinstallatie een heel kwartaal van de AIOS
door: van het account voor de planner tot een definitief rooster met een ruil.
Per stap staat erbij wat je moet zien. Klopt iets niet, noteer dan de stap en
wat je zag. Dat is genoeg om het terug te vinden.

Reken op ongeveer een uur. Het rooster maken duurt zelf een paar minuten.

## Voorbereiding

1. **Testinstallatie bijwerken.** In de map van de testinstallatie:
   `docker compose pull` en daarna `docker compose up -d`.
   - Je ziet: rechts in de blauwe balk staat versie 2.1.0 of hoger.
   - Controleer met `docker compose ps` dat ook de container `aios-solver`
     draait. Zonder die container kan het rooster niet gemaakt worden.
2. **Mail staat uit op test** (`MAIL_UITGESCHAKELD=true`, zie de README). Er
   gaat dus geen enkele mail. Links voor de AIOS haal je in stap 9 bij
   *Exporteren & communicatie*, met *Uitnodigingen en herinneringen* en dan
   *Uitnodigingen downloaden*.
3. Houd twee browsers bij de hand of een gewoon en een privévenster. Een AIOS
   en de planner kunnen niet tegelijk in hetzelfde venster ingelogd zijn, en
   voor het ruilen heb je twee AIOS tegelijk nodig.

## Deel 1: de planner van de AIOS

4. **Account aanmaken.** Log in als beheerder en ga naar *Accounts beheren*.
   Vul bij *Nieuw account* een codenaam in (bijvoorbeeld `aiosplanner`), kies
   rol *Planner* en dienst *AIOS*. Klik op *Maak er een* voor een tijdelijk
   wachtwoord en daarna op *Toevoegen*.
   - Je ziet: "… is toegevoegd als planner voor de AIOS." en in de lijst staat
     bij dat account de dienst AIOS.
5. **Inloggen als die planner** (in het andere venster) met het tijdelijke
   wachtwoord.
   - Je ziet: *Kies een nieuw wachtwoord*. Kies er een en klik op
     *Wachtwoord opslaan en verder*.
   - Bij *+ Nieuwe periode* staat alleen de pool AIOS. Van de achterwacht zie
     je niets.
6. **AIOS toevoegen.** Ga bij de pool AIOS naar *Personeel beheren* en voeg
   bij *Nieuw personeelslid toevoegen* vier AIOS toe: `aios01` tot en met
   `aios04`, met Geldig vanaf en Geldig tot rond het kwartaal. Sneller gaat het
   met *Een reeks toevoegen* (van `aios01` tot en met `aios04`). Een codenaam
   van de achterwacht, bijvoorbeeld `staf01`, wordt geweigerd.
   - Je ziet: de vier AIOS in de lijst. Bij *Deelnamefactor* staat *nog
     onbekend*, want die volgt uit hun parttimedagen. Je typt er niets in.

## Deel 2: het kwartaal openen

7. **Kwartaal maken.** Klik op *+ Nieuwe periode*, kies het kwartaal (bij
   voorkeur Q1 2027, daar vallen Pasen en Tweede Paasdag in) en klik op
   *Aanmaken en instellen*.
   - Je ziet: links de lijst met onderdelen van het kwartaal, onder de blauwe
     balk. Bovenaan staat *Periode*, daaronder de groepjes *Voorbereiden*,
     *Deelnemers*, *Communicatie* en *Rooster*. In de blauwe balk staan de naam
     van het kwartaal en de status. Een onderdeel kies je met een klik in de
     lijst. Rechts staat dan alleen dat onderdeel. Op een telefoon zit de lijst
     achter de knop met drie streepjes links in de blauwe balk. Zo werkt het in
     de rest van dit draaiboek steeds. Er is geen knop om naar een andere
     indeling te wisselen.
   - Kies *Dienstrooster (nog niet gegenereerd)*: onderin staan de diensten per
     week in de kalender, een avond- of nachtblok als één vak met een dikke
     rand, met bovenaan de tabel *Diensten (toelichting)* als legenda. Kies
     *Punten in dit kwartaal*: het aantal fte dat de AIOS samen nodig hebben om
     onder 25% te blijven.
8. **Voortgangstoets.** Vink bij *Voortgangstoets* aan dat er een toets is,
   kies een woensdag in het kwartaal en klik op *Opslaan*.
   - Je ziet: de tekst noemt de toets en de nacht ervoor. In het weekoverzicht
     staat op die dinsdagnacht *Fellow*. De zondag- en maandagnacht staan
     nog in hun blok.
9. **Openen.** Laat de deadline staan en klik bij *Voorkeuren van de AIOS* op
   *Periode openen*. Kies daarna het onderdeel *Exporteren & communicatie*, klik
   op *Uitnodigingen en herinneringen* en kies *Uitnodigingen downloaden*.
   - Je ziet: een bestand met per AIOS een persoonlijke link.
   - *Uitnodigingen versturen* en *Herinneringen versturen* staan uit, omdat de
     mail voor de AIOS niet is ingesteld. Dat klopt op test.

## Deel 3: de AIOS geven hun voorkeuren op

10. **aios01** (open de link in het tweede venster). Vul bij *Deeltijd* een
    parttimedag in: maandag, elke week.
    - Je ziet bij de voorkeuren op elke maandag: de uitloopdienst vast op
      *PT✕*. De avond van die maandag staat op liever niet (*PT~*), dus ook
      het avondblok zondag tot en met dinsdag. De nacht van die maandag heeft
      geen markering.
    - Tik op zo'n avondblok. Je kunt kiezen uit voorkeur, geblokkeerd en
      terug naar liever niet. Kies geblokkeerd.
    - Je ziet bij *Hoeveel je hebt geblokkeerd*: dat avondblok telt mee.
    - Bij *Je voorkeuren per dienst* staat dat de voortgangstoets er is en dat
      de nacht ervoor daarom niet in het blok staat.
11. **aios02.** Geef bij *Afwezigheid opgeven* een week vakantie op.
    Blokkeer daarna meer dan de helft van de nachtblokken.
    - Je ziet: de vakantiedagen staan op *AF* en tellen niet mee bij de
      blokkades. Bij de nachtblokken staat een waarschuwing dat het rooster
      het deel boven de helft alsnog bij jou kan inplannen.
12. **aios03.** Vink *4 nachten* aan. Het wordt meteen opgeslagen.
    **aios04** laat je leeg.
13. Klik per AIOS op *Bevestigen en indienen*.
    - Je ziet bij de planner onder *Status voorkeuren*: wie heeft ingediend en
      wie meer dan de helft heeft geblokkeerd.
    - Probeer bij *Exporteren & communicatie* het *Voorkeurenoverzicht
      downloaden (Excel)* en het *Statusrapport downloaden*.
    - Open *Personeel beheren*: bij aios01 staat nu 80% (een parttimedag per
      week) en bij de andere drie *Voltijd*. Voor wie nog niet heeft
      ingediend staat er *nog onbekend*.

## Deel 4: het rooster maken

14. **Sluiten.** Kies het onderdeel *Periode*, klik op *Periode sluiten* en daarna op
    *Zeker weten? Nogmaals klikken*. Staat er een waarschuwing over te weinig AIOS
    in deeltijd voor de nachtblokken van zondag tot en met dinsdag, dan klopt dat
    bij vier AIOS waarvan er één in deeltijd werkt (aios01).
15. **Blokken rond feestdagen.** In de lijst staat het onderdeel *Blokken rond de
    feestdagen* met *nog te beantwoorden*. In *Periode* is *Rooster maken* nu
    uit. De melding heeft een knop *Naar Blokken rond de feestdagen*. Kies
    per blok *Heel laten: één AIOS doet het hele blok* of *Opknippen: elke dag
    een losse dienst* (rond Pasen een van elk) en klik op *Keuzes bewaren*.
16. **Rooster maken.** Ga naar *Periode*. Kies bij *Hoe lang zoeken* voor een test
    *Zelf kiezen* en vul 1 minuut in (op echte gegevens kies je minstens
    10 minuten). Klik op *Rooster maken*.
    - Staat er *De solver van de AIOS is niet bereikbaar*? Dan draait de
      container `aios-solver` niet. Controleer dat met `docker compose ps`
      (zie stap 1) en zie de README bij versie 0.87.1.
    - Je ziet na een paar minuten het rooster in het onderdeel *Dienstrooster
      (automatisch ingevuld)* en in *Dienstpercentage* de tabel *Dienstpercentage
      en saldo* met punten en dienstpercentage. Daaronder staat "nog geen eerdere
      kwartalen", want dit is het eerste kwartaal.
    - aios01 heeft geen uitloopdienst op een maandag. Krijgt aios01 een avond
      op een maandag, dan staat er ~ (liever niet) of ✕ (het geblokkeerde
      blok, uit het deel boven de helft) bij.
    - Op de nacht voor de voortgangstoets staat *Fellow*.
    - Verschuif de toets een week en klik op *Opslaan*. De melding zegt dat
      de nacht weer in het rooster staat, bij de AIOS die de rest van dat
      blok heeft. Zet de toets daarna terug op de eerste datum.
17. **Met de hand wijzigen.** Tik op een blok en kies een andere AIOS.
    - Je ziet per AIOS wat het zou kosten (een harde regel, een markering,
      boven 25%). Kiezen kan na *Ja, toch indelen*.
    - Klik daarna op *Ongedaan maken*. Het blok is weer zoals het was.

## Deel 5: publiceren en ruilen

18. **Voorlopig publiceren.** Klik in *Periode* op *Voorlopig publiceren*
    (met waarschuwingen eerst *Ja, toch publiceren*). Staan er nog lege
    diensten, dan kan het niet: vul ze eerst met de hand.
    - Je ziet: "Voorlopig gepubliceerd." en een melding dat er geen mail
      ging.
    - In *Periode* staat de status *Voorlopig gepubliceerd*. De Excel voor het
      roosterbureau staat nog niet klaar: die komt pas bij een definitief
      rooster.
    - Open de link van aios01. Je ziet het eigen rooster met de punten en het
      dienstpercentage. Daaronder staat *Ruilen*. Bij een voorlopig rooster zegt
      die: ruilen kan pas als het rooster definitief is. Klopt er iets niet,
      dan meld je dat bij de planner.
19. **Definitief maken.** Klik bij de planner in *Periode* op *Definitief maken*
    en daarna op *Ja, definitief maken*.
    - Download *Rooster per dag* (met *Fellow* op de nacht voor de toets).
      Er is geen lijst met compensatiedagen: het roosterbureau kiest die zelf.
    - De voortgangstoets ligt nu vast: wijzigen kan niet meer.
20. **Ruilen.** Kies bij aios01 een dienst of blok en klik op *Ruilen*. Kies
    een collega bij *Vraag aan* en geef een toelichting.
    - Je ziet: "Je ruilverzoek is verstuurd." en het verzoek bij *Jouw
      ruilverzoeken*.
    - Open in het andere venster de link van die collega. Bij *Ontvangen
      ruilverzoeken* staat het verzoek met de toelichting. Klik op
      *Goedkeuren*.
    - Je ziet bij beide AIOS het aangepaste rooster. Bij de planner staat de
      ruil onder het tabblad *Ruilverzoeken* van *Dienstrooster* als
      goedgekeurd.

## Afronden

21. Wil je opnieuw beginnen, klik dan in de lijst met periodes bij deze
    periode op *Verwijderen*. Hij gaat naar de prullenbak. Verwijder hem daar
    definitief om alles kwijt te zijn: rooster, ruilen, keuzes en de
    voortgangstoets gaan mee.
22. Wil je het saldo naar het volgende kwartaal testen, lees dan vóór stap 16
    bij *Geschiedenis van vóór de app* een ingevuld sjabloon in. Maak na stap
    19 het volgende kwartaal: bij *Dienstpercentage en saldo* staat dan het saldo uit het
    vorige kwartaal en het percentage over twee kwartalen samen.
