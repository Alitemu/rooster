# Voor later

Wensen die bewust zijn uitgesteld. Niets hiervan is toegezegd. Staat er iets
bij dat toch niet hoeft, haal het dan weg.

| Wens | Voor wie | Waarom uitgesteld | Sinds |
|---|---|---|---|
| Diensten in de eigen agenda zetten (een agendabestand of een abonnement) | Deelnemers van de achterwacht en de AIOS | De eigen agenda is de verantwoordelijkheid van de deelnemer zelf. Een fout in een agenda-uitnodiging zou dan bij de app liggen, en dat is voorlopig niet gewenst | 1.5.0 |
| Het rooster afdrukken vanaf de periodepagina van de planner | Planner van de achterwacht | Nu geen prioriteit. Afdrukken geeft alle knoppen mee en alleen de eerste pagina van de lijst. De rest van het rooster ontbreekt dan zonder waarschuwing. Wie het op papier wil, gebruikt de Excel-download van het rooster | 1.6.1 |
| De browsertests door de nieuwe indeling laten gaan | Ontwikkeling | Sinds 2.0.0 is de nieuwe indeling de standaard, maar de meeste browsertests openen nog de inklapbare onderdelen, via een verborgen vlag (playwright.config.ts, scripts/ui-check.mjs). Ze bewaken dus vooral de verborgen indeling. De nieuwe indeling heeft eigen tests (indeling-nieuw, aios-indeling) en is bij 2.0.0 per onderdeel vergeleken met de oude. Omzetten raakt zo'n 20 testbestanden | 2.0.0 |
| De oude indeling uit de code halen | Planner van de achterwacht | Bewust nog niet (de wens van de planner bij 2.0.0: verbergen, zodat er niet per ongeluk iets belangrijks verdwijnt). Kan pas als de browsertests door de nieuwe indeling gaan | 2.0.0 |
| De naam van de periode ook in de blauwe balk op de pagina's achter de periode (een persoon, lege diensten aanvullen, eerdere toewijzingen) | Planner van de achterwacht | In 1.12.0 staat de naam alleen op de periodepagina zelf in de balk. De andere pagina's hebben hun eigen kop | 1.12.0 |
| Nieuwe indeling: het eerste onderdeel verspringt even bij een rooster met lege diensten | Planner van de achterwacht | Het aantal lege diensten komt 50 ms na de rest binnen. Zo kort dat het niet stoort. Oplossen kost een wachtmoment voor iedereen | 1.10.0 |

Wat er voor het rooster van de AIOS nog openstaat, staat onderaan
`docs/aios-rooster.md`.
