# Back-up naar OneDrive met Power Automate

Vanaf versie 0.900.0 stuurt Dienstrooster elke nacht een versleutelde kopie van
de hele database per mail naar een adres dat de beheerder kiest. Dat gebeurt als
er iets veranderd is. Anders gebeurt het minstens één keer per week. Twee stromen in
Power Automate doen de rest:

1. **Dienstrooster back-up naar OneDrive**: zet de bijlage in OneDrive,
   verwijdert de mail en bewaart alleen de nieuwste 90 back-ups.
2. **Dienstrooster back-up controle**: kijkt elke ochtend of de nieuwste back-up
   in OneDrive jonger is dan 8 dagen. Is dat niet zo, dan mailt hij je.

Zonder de tweede stroom merk je pas dat de back-ups ontbreken op de dag dat je er
een nodig hebt.

## Wat er in de back-up zit en wie hem kan lezen

De back-up is de hele database: beide diensten, de roosters, de voorkeuren, de
saldi, het auditlog en de accounts van de planners (hun wachtwoorden alleen als
hash). Het Gmail-app-wachtwoord zit er niet leesbaar in.

Het bestand (`.drbackup`) is versleuteld met AES-256 en een sleutel uit het
**back-upwachtwoord**. Gmail (dat elke verstuurde mail in *Verzonden* bewaart),
Outlook en OneDrive zien alleen onleesbare bytes. Zonder het back-upwachtwoord
kan niemand het bestand openen, ook de beheerder niet en ook wie de app
onderhoudt niet. **Bewaar het wachtwoord apart**, bijvoorbeeld in de kluis van
de afdeling.

## Stap 1. In Dienstrooster

1. Stel eerst het Gmail-account in bij *Mailinstellingen*, als dat nog niet is
   gebeurd.
2. Open als beheerder op de lijst met periodes *Back-up*.
3. Vul bij *Back-up sturen naar* je **eigen** adres in, niet het gedeelde
   postvak: iedereen met toegang tot een gedeeld postvak zou de back-ups kunnen
   verplaatsen of weggooien.
4. Kies een back-upwachtwoord van minstens 12 tekens en kies *Opslaan*.

## Stap 2. De map in OneDrive

Maak in je OneDrive de map `Dienstrooster` en daarin de map `Back-ups`. De
stromen gaan uit van precies dat pad: `/Dienstrooster/Back-ups`. Wil je een
andere map, pas dan in beide stromen het pad aan (bij *Bestand maken* en bij
*Map*).

## Stap 3. De stromen importeren

Je krijgt twee zip-bestanden. Importeer ze een voor een via *Mijn stromen*,
*Importeren*, *Pakket importeren (verouderd)*.

- Kies bij elk onderdeel onder *Gerelateerde resources* een verbinding: bij
  *Office 365 Outlook* je eigen account, bij *OneDrive voor Bedrijven* ook. Heb
  je nog geen verbinding met OneDrive voor Bedrijven, maak die dan aan met
  *Nieuwe maken*.
- Kies bij de stroom zelf *Nieuw maken* (niet *Bijwerken*).

Open daarna elke stroom en kijk na:

**Dienstrooster back-up naar OneDrive**

- De trigger *Wanneer een nieuwe e-mail binnenkomt (V3)*: map `Inbox`,
  *Van* het Gmail-adres van Dienstrooster, onderwerpfilter
  `DIENSTROOSTER-BACKUP`, *Alleen met bijlagen* en *Bijlagen opnemen* op `Ja`.
- *Bestand maken*: map `/Dienstrooster/Back-ups`.

**Dienstrooster back-up controle**

- *Waarschuwen*: bij *Aan* je eigen adres.
- De trigger loopt elke ochtend om 08:17. Een andere tijd mag.

Sla beide stromen op en zet ze aan.

## Stap 4. Testen

1. Kies in Dienstrooster bij *Back-up* de knop *Nu een back-up versturen*.
2. Wacht een paar minuten. In OneDrive staat dan in `Dienstrooster/Back-ups`
   een bestand `dienstrooster-backup-JJJJ-MM-DD-UUMM.drbackup` en de mail is uit
   je Postvak IN verdwenen (hij staat in *Verwijderde items*).
3. Zet de back-up één keer echt terug, op een testinstallatie als je die hebt:
   download het bestand uit OneDrive, kies in Dienstrooster bij *Back-up* het
   bestand, vul het back-upwachtwoord in en typ `TERUGZETTEN`. Een back-up die
   je nooit hebt teruggezet, is een hoop en geen back-up.

## Hoe de stromen werken

**Back-up naar OneDrive**, bij elke mail van het Gmail-adres met
`DIENSTROOSTER-BACKUP` in het onderwerp:

1. Voor elke bijlage die op `.drbackup` eindigt: *Bestand maken* in de map, met
   `base64ToBinary(items('Bijlagen')?['contentBytes'])` als inhoud.
2. Pas als dat gelukt is: de mail verwijderen. Lukt het bestand niet (de map
   bestaat niet, OneDrive is even weg), dan blijft de mail staan en gaat er
   niets verloren. Je ziet dan een mislukte run in Power Automate.
3. De map opzoeken (*Metagegevens van bestand ophalen met behulp van pad*), de
   bestanden erin weergeven, alleen de `.drbackup`-bestanden houden.
4. `skip(reverse(sort(body('Back-ups'), 'Name')), 90)`: de namen beginnen met
   de datum en tijd, dus gesorteerd op naam staan ze op volgorde van maken. Wat
   na de nieuwste 90 komt, wordt verwijderd. Andere bestanden en mappen in de
   map blijven staan.

**Back-up controle**, elke ochtend:

1. De variabele `nieuwste` begint op 1 januari 1970.
2. In een *Bereik* (Scope): de map opzoeken, de back-ups weergeven en, als er
   een is, de datum van de nieuwste in `nieuwste` zetten.
3. Ook als het bereik mislukt (de map is weg of niet te lezen): is `nieuwste`
   ouder dan 8 dagen, dan krijg je een mail met *Hoge prioriteit*.

Waarom 8 dagen: Dienstrooster stuurt ook zonder wijzigingen minstens één keer
per week een back-up. Na 8 dagen zonder back-up is er dus echt iets mis: met
Dienstrooster, met de mail of met de eerste stroom.

## Als het misgaat

- **Dienstrooster** toont bij *Back-up* wanneer de laatste back-up uitging en
  wat er bij de laatste poging misging. Na een mislukte poging probeert de app
  het elk uur opnieuw.
- **De app start niet meer:** open de back-up zonder de app met
  `npx tsx scripts/back-up-openen.ts <bestand.drbackup> <uit.db>` en zet die
  database terug zoals de README beschrijft onder *Terugzetten zonder de app*.
- **Het back-upwachtwoord is kwijt:** de bestaande back-ups zijn dan niet meer
  te openen. Kies bij *Back-up* direct een nieuw wachtwoord, zodat de volgende
  back-ups wel weer te openen zijn. Kies daarna *Nu een back-up versturen*.
