# Audit-playbook: software due diligence en production readiness

Dit playbook is het referentiekader voor een volledige audit van deze
repository. Het is geschreven voor een beoordelaar die moet adviseren over een
investering, een overname of een besluit om een systeem in productie te nemen
of te houden. Het beschrijft wat er bekeken wordt, hoe bewijs verzameld wordt,
hoe bevindingen geclassificeerd worden en hoe de rapporten eruitzien.

## 0. Uitgangspunten

1. **Bewijs boven indruk.** Elke bevinding verwijst naar een bestand en waar
   mogelijk een regelnummer, een configuratiewaarde of de uitvoer van een
   commando. Een bevinding zonder bewijs is een hypothese en wordt zo
   genoemd.
2. **Gemeten en afgeleid gescheiden.** Het rapport zegt bij elk getal of het
   gemeten is (commando gedraaid) of afgeleid (code gelezen).
3. **Wat niet onderzocht is, staat erbij.** Een audit zonder lijst van
   beperkingen wekt meer vertrouwen dan hij verdient.
4. **Context telt.** Risico wordt beoordeeld tegen het werkelijke gebruik: wie
   zijn de gebruikers, hoeveel zijn het, welk netwerk, welke data. Een
   ontbrekende Kubernetes-opzet is geen bevinding voor een app met 60
   gebruikers op één server. Een enkele beheerder zonder vervanger is dat wel.
5. **Geen wijzigingen.** De audit leest en meet. Hij past geen code,
   configuratie of data aan. Uitzondering: het schrijven van de
   auditdocumenten zelf.
6. **Ook wat goed is.** Een due diligence beoordeelt waarde en risico.
   Sterke punten worden met hetzelfde bewijs onderbouwd als zwakke.
7. **Gevoelige bevindingen.** Een beveiligingsbevinding die direct te
   misbruiken is, wordt niet met een werkend aanvalsrecept in een openbare
   repository gezet. Het rapport beschrijft de zwakte, de plek en de
   oplossing. De beoordelaar meldt het apart als publicatie een risico is.

## 1. Werkwijze

| Fase | Wat | Resultaat |
|---|---|---|
| 1. Inventaris | Omvang, talen, mappen, afhankelijkheden, geschiedenis, wie eraan werkt | Feitenblad |
| 2. Meten | Typecheck, lint, tests, `npm audit`, verouderde packages, zoekopdrachten | Meetresultaten |
| 3. Lezen | Per domein de kernbestanden lezen, steekproef van de rest | Bevindingen met bewijs |
| 4. Toetsen | Elke bevinding tegenlezen: klopt de regel, is er een test of guard die het al afvangt | Bevestigd of geschrapt |
| 5. Classificeren | Risicoklasse, prioriteit, inspanning | Bevindingenlijst |
| 6. Scoren | Score per domein volgens het scoremodel | Scorekaart |
| 7. Rapporteren | Vier documenten (zie hoofdstuk 14) | Rapporten |

Standaardcommando's voor fase 1 en 2 (aanpassen aan de stack):

```bash
git ls-files | wc -l                      # omvang
git log --format=%an | sort | uniq -c     # wie werkt eraan (busfactor)
npx tsc --noEmit -p .                     # typecheck
npx eslint .                              # lint
npx vitest run                            # unit- en integratietests
npm audit --omit=dev                      # bekende kwetsbaarheden in productie
npm outdated                              # verouderde packages
grep -rnE "(password|secret|token|api[_-]?key)\s*[:=]\s*['\"]" .   # secrets
```

## 2. Executive Summary Criteria

De samenvatting beantwoordt per domein één vraag en geeft één oordeel. Ze
bevat nooit meer dan de belangrijkste drie punten per domein.

| Domein | Kernvraag | Wat de samenvatting moet zeggen |
|---|---|---|
| Architectuur | Past de opzet bij het probleem en bij de groei die verwacht wordt? | Structuur in één alinea, de grootste structurele beperking of die nu knelt |
| Codekwaliteit | Kan een nieuwe ontwikkelaar de code lezen en veilig wijzigen? | Consistentie, complexiteit op de drukste plekken, foutafhandeling |
| Security | Kan een buitenstaander of een gewone gebruiker iets wat niet mag? | Aantal bevindingen per klasse, de ernstigste, de staat van authenticatie en autorisatie |
| Performance | Houdt het systeem de verwachte belasting en wat breekt het eerst? | Het eerste knelpunt en bij welke schaal |
| Testbaarheid | Vangt de testsuite een regressie voordat een gebruiker hem ziet? | Aantallen, wat gedekt is, wat niet, hoe betrouwbaar de suite is |
| Onderhoudbaarheid | Wat kost een wijziging over twee jaar en wie kan hem maken? | Busfactor, technische schuld, afhankelijkheid van personen of tools |
| DevOps | Kan het systeem herhaalbaar gebouwd, uitgerold, bewaakt en hersteld worden? | Build, release, monitoring, back-up, herstel |
| Documentatie | Kan iemand anders het systeem installeren, beheren en wijzigen met alleen de documentatie? | Wat er is, wat ontbreekt of het klopt met de code |

De samenvatting sluit af met:
- een totaaloordeel in één zin (geschikt, geschikt onder voorwaarden, niet geschikt),
- de voorwaarden (wat moet er eerst gebeuren),
- de drie grootste risico's voor de koper of eigenaar,
- de drie grootste sterke punten.

## 3. Architectuur Audit

| Onderdeel | Wat controleren | Bewijs verzamelen | Rode vlaggen |
|---|---|---|---|
| Design patterns | Welke patronen worden gebruikt (lagen, repository, service, event) en consequent? | Mapstructuur, een route van begin tot eind volgen | Elk bestand een eigen stijl, patronen half toegepast |
| Separation of concerns | Zit domeinlogica in de UI of in de route? Is datatoegang gescheiden? | Grootste componenten en routes lezen, SQL in componenten zoeken | Routes van honderden regels met SQL, validatie en domeinregels door elkaar |
| Modulariteit | Zijn er duidelijke modules met een eigen verantwoordelijkheid? | Aantal bestanden per map, importgraaf, platte mappen | Eén map met honderden bestanden, geen grenzen |
| Coupling en cohesion | Hoeveel modules raakt een wijziging? Zijn grenzen afgedwongen? | Importregels, tests die grenzen bewaken, gedeelde globale staat | Circulaire imports, alles importeert alles |
| Technical debt | Bewuste en onbewuste schuld en of die is vastgelegd | TODO/FIXME, documentatie over bekende beperkingen, dubbele bronnen van waarheid | Schuld die nergens staat, twee mechanismen voor hetzelfde |
| Anti-patterns | God objects, copy-paste, stringly typed, gedeelde mutabele staat, logica in configuratie | Grootste bestanden, `any`, globale variabelen | Bestanden boven 1000 regels, staat in procesgeheugen die bij herstart verdwijnt |
| Scalability review | Verticaal en horizontaal: wat verhindert een tweede instantie? Wat groeit met data? | Staat in geheugen, bestandsdatabase, geplande taken in het webproces | Aanname van één proces die nergens is vastgelegd |

Extra vragen:
- Is er één bron van waarheid voor het datamodel?
- Welke beslissingen zijn onomkeerbaar duur (database, framework, taal)?
- Hoe zijn achtergrondtaken georganiseerd en wat gebeurt er bij een crash halverwege?
- Welke externe systemen zijn er en wat gebeurt er als ze wegvallen?

## 4. Security Audit

### 4.1 OWASP Top 10 (2021)

| Nr | Categorie | Wat controleren |
|---|---|---|
| A01 | Broken Access Control | Elke route: wie mag dit en wordt dat op de server gecontroleerd? IDOR op id's in het pad. Horizontale scheiding tussen tenants of groepen |
| A02 | Cryptographic Failures | Wachtwoordhashing (algoritme, kosten), versleuteling van opgeslagen geheimen, sleutelbeheer, TLS, willekeur van tokens |
| A03 | Injection | SQL met stringinterpolatie, shell-aanroepen, HTML-injectie (XSS), formule-injectie in exports, header-injectie in mail |
| A04 | Insecure Design | Ontbrekende limieten, misbruikbare flows (reset, uitnodiging), vertrouwen op de client |
| A05 | Security Misconfiguration | Standaardwachtwoorden, debugstanden, ontbrekende securityheaders, open poorten, te ruime CORS |
| A06 | Vulnerable Components | `npm audit`, vastgepinde versies, leeftijd van packages en basisimages |
| A07 | Identification and Authentication Failures | Brute force, wachtwoordregels, sessieduur, MFA, enumeratie van accounts |
| A08 | Software and Data Integrity Failures | Ondertekening van builds, integriteit van updates, deserialisatie, onbetrouwbare uploads |
| A09 | Logging and Monitoring Failures | Wordt inloggen, falen en beheer gelogd? Kan iemand het log lezen? Is er alarmering? |
| A10 | SSRF | Door de gebruiker of beheerder ingevoerde URL's die de server ophaalt |

### 4.2 Overige onderdelen

| Onderdeel | Wat controleren | Rode vlaggen |
|---|---|---|
| Secrets detection | Zoeken in de werkmap en in de git-geschiedenis naar sleutels, wachtwoorden, tokens, certificaten | Een geheim in de geschiedenis, ook als het later verwijderd is |
| Hardcoded credentials | Standaardaccounts, seedwachtwoorden, testgeheimen die productie kunnen bereiken | Een bekend wachtwoord dat op een productiesysteem kan werken |
| JWT implementatie | Als er JWT of eigen ondertekende tokens zijn: algoritme vast, `alg: none` onmogelijk, vergelijking in constante tijd, verloop, intrekbaarheid, scheiding van tokensoorten, sleutellengte en rotatie | Zelfgebouwde crypto zonder tests, tokens die niet in te trekken zijn |
| Autorisatie | Rollenmodel, controle per route, controle per object, afdwinging met tests | Controle alleen in de UI, één vergeten route |
| Authenticatie | Inlogflow, wachtwoordopslag, reset, eerste installatie, magic links | Token in URL zonder verloop, reset zonder bewijs van identiteit |
| Session management | Cookievlaggen (HttpOnly, Secure, SameSite), duur, vernieuwing, uitloggen overal, fixatie | Sessies die een wachtwoordwijziging overleven |
| API security | Invoervalidatie, groottegrenzen, rate limiting, CSRF, foutmeldingen zonder interne details | 500 op vreemde invoer, stacktraces naar de client |
| Dependency vulnerabilities | `npm audit`, Python-packages, basisimages | Bekende kritieke CVE in productie |
| Container security | Niet als root, minimale image, geen geheimen in lagen, alleen nodige poorten, resourcegrenzen, read-only waar het kan | Root in de container, `latest`-tags, geheimen in de image |
| Supply chain risico's | Lockfiles, vastgepinde actions en images (op digest), rechten van CI-tokens, herkomst van builds, aantal directe en transitieve packages | Actions op een verplaatsbare tag met schrijfrechten, geen lockfile |

### 4.3 Privacy

Bij persoonsgegevens: welke gegevens, waar opgeslagen, wie kan erbij, hoe lang
bewaard, staan ze in logs of back-ups en is pseudonimisering echt (kan de
koppeling elders hersteld worden)?

## 5. Code Quality Audit

| Onderdeel | Wat controleren | Bewijs | Rode vlaggen |
|---|---|---|---|
| Code smells | Lange functies, lange parameterlijsten, diepe nesting, vlaggen als parameter | Grootste bestanden en functies | Functies boven 150 regels op kritieke paden |
| Dead code | Ongebruikte exports, routes, tabellen, kolommen, afhankelijkheden | Zoeken naar verwijzingen, kolommen die "niet meer gebruikt" heten | Tabellen die blijven bestaan zonder lezer |
| Complexiteit | Vertakkingen per functie, aantal toestanden, impliciete volgordes | Steekproef op de kern van het domein | Regels die alleen in commentaar staan |
| Duplicatie | Gekopieerde logica en of kopieën bewaakt worden | Vergelijken van parallelle modules | Kopieën zonder test die ze gelijk houdt |
| Naming conventions | Eén taal, één stijl, domeintermen consequent | Steekproef | Gemengde talen zonder regel |
| Error handling | Worden fouten gevangen, gelogd en vertaald naar een veilige melding? Lege `catch`? | Zoeken naar `catch`, naar 500-paden | Ingeslikte fouten, interne details naar de gebruiker |
| Logging | Wat wordt gelogd, in welk formaat, met welke gevoeligheid | Zoeken naar `console.`, loggers | Geheimen of persoonsgegevens in logs, geen correlatie |
| Maintainability | Typeveiligheid (`any`, `as`, `@ts-ignore`), lintregels, commentaar dat het waarom uitlegt | Tellingen, lintconfiguratie | Uitgeschakelde regels zonder reden |

## 6. Performance Audit

| Onderdeel | Wat controleren | Rode vlaggen |
|---|---|---|
| Database performance | Soort database en de grenzen ervan, transacties, vergrendeling, schrijfconcurrentie | Lange schrijftransacties, synchrone database-aanroepen op een drukke eventloop |
| Query analyse | N+1-patronen (query in een lus), `SELECT *`, ontbrekende `WHERE`, onbegrensde resultaten | Query per rij in een lijstpagina |
| Caching | Wat wordt gecachet, hoe wordt het ongeldig, kan een cache verkeerde data tonen | Cache zonder invalidatie of juist niets terwijl het nodig is |
| Memory usage | Staat in geheugen, grootte van uploads en exports, grenzen per container | Onbegrensde maps, hele bestanden in geheugen |
| CPU hotspots | Synchrone crypto, grote lussen, parsers, solvers | Blokkerende hashing in het verzoekpad zonder limiet |
| Async processing | Lange taken buiten het verzoek, wachtrijen, herstel na een crash, time-outs | Taak die een herstart niet overleeft zonder dat de gebruiker het merkt |
| Resource management | Verbindingen, bestandshandvatten, time-outs op uitgaande aanroepen, afbreken van werk | Uitgaande aanroep zonder time-out |

Als er geen belastingtest gedraaid kan worden, zegt het rapport dat en
beoordeelt het op code en ontwerp.

## 7. Database Audit

| Onderdeel | Wat controleren | Rode vlaggen |
|---|---|---|
| Datamodel | Normalisatie, typen, JSON-kolommen, benaming, enums, tijd en tijdzones | Datums als vrije tekst zonder controle, JSON voor relationele data |
| Indexering | Indexen op vreemde sleutels en op veelgebruikte filters, unieke indexen voor regels | Vreemde sleutel zonder index op een grote tabel |
| Migraties | Eén mechanisme, omkeerbaar of niet, getest op oude data, wat draait er in productie | Twee mechanismen die hetzelfde schema bouwen |
| Consistentie | Transacties rond samengestelde wijzigingen, optimistic locking, idempotentie | Meerdere schrijfacties zonder transactie |
| Referential integrity | Vreemde sleutels aan, `ON DELETE`-gedrag, wezen | Vreemde sleutels gedeclareerd maar niet afgedwongen |

## 8. DevOps Audit

| Onderdeel | Wat controleren | Rode vlaggen |
|---|---|---|
| Docker | Multi-stage, gebruiker, grootte, vastgepinde basis, healthcheck, signalen | Root, `latest`, geen healthcheck |
| Docker Compose | Netwerken, poorten, volumes, grenzen, herstartbeleid, geheimen | Interne dienst met publieke poort |
| Kubernetes | Alleen als aanwezig: manifests, limieten, probes, secrets | Niet van toepassing als het ontbreekt en dat wordt gezegd |
| CI/CD pipelines | Wat draait bij een wijziging, wat bij een release, wie mag uitrollen, rechten | Geen tests bij een push, release zonder poort |
| Monitoring | Healthcheck, metrics, alarmering, wie krijgt een melding | Uitval die alleen een gebruiker opmerkt |
| Logging | Waar komen logs terecht, rotatie, bewaartermijn, doorzoekbaarheid | Logs alleen in de container |
| Backup strategie | Frequentie, plek, versleuteling, bewaartermijn, sleutelbeheer | Back-up op dezelfde schijf als de data |
| Disaster recovery | Is terugzetten beschreven en getest? RPO en RTO bekend? | Nooit geoefend herstel |

## 9. Testing Audit

| Onderdeel | Wat controleren | Rode vlaggen |
|---|---|---|
| Unit tests | Aantal, snelheid, wat ze testen (regels of implementatie) | Tests die de implementatie naspelen |
| Integratietests | Echte database of mocks, routes van begin tot eind | Alles gemockt |
| E2E tests | Dekken ze de hoofdstromen, draaien ze automatisch | Alleen handmatig te draaien |
| Test coverage | Gemeten dekking en welke delen buiten de meting vallen | Geen meting of een getal zonder betekenis |
| Test quality | Mutatietests, flakiness, tests die altijd slagen, fixtures | Asserties die niets kunnen laten falen |

Extra: draait de volledige suite in CI en wat is de poort voor een release?

## 10. Dependency Audit

| Onderdeel | Wat controleren | Bewijs |
|---|---|---|
| Verouderde packages | Afstand tot de laatste versie, vooral bij grote versies | `npm outdated`, `pip list --outdated` |
| Security risico's | Bekende kwetsbaarheden, ook in dev-afhankelijkheden die in de build draaien | `npm audit`, `npm audit --omit=dev` |
| Onderhoudsstatus | Laatste release, aantal beheerders, verlaten packages | Registry-gegevens |
| Ongebruikte dependencies | Packages zonder import | Zoeken naar imports per package |

Ook: zijn versies vastgepind of bereiken (`^`), is er een lockfile, klopt die
met `package.json` en hoe worden updates bijgehouden (Dependabot, Renovate,
handmatig)?

## 11. Documentation Audit

| Onderdeel | Wat controleren | Rode vlaggen |
|---|---|---|
| README kwaliteit | Wat is het, hoe start je het, klopt het met de code, lengte en vindbaarheid | README als changelog |
| Deployment instructies | Kan een derde installeren en bijwerken met alleen de documentatie | Stappen die alleen de maker kent |
| Runbooks | Wat te doen bij uitval, vol geheugen, verloren wachtwoord, herstel | Geen draaiboek voor storingen |
| ADR's | Zijn beslissingen vastgelegd met reden en datum | Beslissingen verspreid over commentaar |
| API documentatie | Contracten tussen diensten, schema's, voorbeelden | Contract alleen in code |

## 12. Scoring Framework

Elk domein krijgt een score van 1 tot 10. De score volgt uit de bevindingen,
niet andersom.

| Score | Betekenis |
|---|---|
| 9 tot 10 | Uitstekend. Voorbeeld voor vergelijkbare systemen, geen bevindingen boven Low |
| 7 tot 8 | Goed. Past bij productie, enkele Medium-bevindingen met een duidelijke oplossing |
| 5 tot 6 | Voldoende. Werkt, maar met High-bevindingen of structurele beperkingen die aandacht vragen |
| 3 tot 4 | Onvoldoende. Meerdere High-bevindingen of één Critical, productie is een risico |
| 1 tot 2 | Slecht. Fundamentele gebreken, niet geschikt zonder herbouw |

Domeinen en gewichten voor het totaal:

| Domein | Gewicht |
|---|---|
| Architectuur | 15% |
| Security | 20% |
| Codekwaliteit | 10% |
| Performance | 10% |
| DevOps | 15% |
| Testbaarheid | 10% |
| Onderhoudbaarheid | 15% |
| Documentatie | 5% |

Regels:
- Eén open Critical in een domein begrenst de score van dat domein op 4.
- Eén open High begrenst de score op 7.
- De score wordt beoordeeld tegen het beoogde gebruik. Het rapport noemt dat
  gebruik expliciet en zegt wat de score zou zijn bij een grotere schaal als
  dat wezenlijk verschilt.
- Bij elke score staan de twee of drie bevindingen die hem het meest bepalen.

## 13. Risk Classification

| Klasse | Definitie | Reactietermijn |
|---|---|---|
| Critical | Direct te misbruiken of direct dataverlies, zonder bijzondere toegang. Of een gebrek dat productie nu onveilig maakt | Onmiddellijk, vóór verder gebruik |
| High | Ernstige schade mogelijk onder realistische omstandigheden of een structureel gebrek dat de continuïteit bedreigt | Binnen 30 dagen |
| Medium | Schade mogelijk onder beperkte omstandigheden of een gebrek dat de kosten van wijziging merkbaar verhoogt | Binnen 90 dagen |
| Low | Kleine zwakte, verdediging in de diepte of een afwijking van goed gebruik zonder directe schade | Bij gelegenheid |
| Informational | Observatie zonder risico of een sterk punt dat het vastleggen waard is | Geen |

Risico = waarschijnlijkheid × impact, beoordeeld in de werkelijke context:

| | Impact laag | Impact midden | Impact hoog |
|---|---|---|---|
| Waarschijnlijk | Medium | High | Critical |
| Mogelijk | Low | Medium | High |
| Onwaarschijnlijk | Low | Low | Medium |

Prioriteit staat los van de klasse: een Medium die een uur kost gaat vóór een
High die een kwartaal kost als ze elkaar niet in de weg zitten.

| Prioriteit | Betekenis |
|---|---|
| P0 | Nu |
| P1 | Volgende release |
| P2 | Dit kwartaal |
| P3 | Op de planning |
| P4 | Alleen als het vanzelf meekomt |

## 14. Audit Output Requirements

### 14.1 Vorm van een bevinding

Elke bevinding heeft een vast nummer (`SEC-01`, `ARCH-01`, `CODE-01`,
`PERF-01`, `DB-01`, `OPS-01`, `TEST-01`, `DEP-01`, `DOC-01`) en deze velden:

| Veld | Inhoud |
|---|---|
| Beschrijving | Wat is er aan de hand, in twee tot vijf zinnen |
| Impact | Wat gebeurt er als het misgaat, voor wie |
| Risico | Klasse (Critical tot Informational) met waarschijnlijkheid en impact |
| Bewijs | Wat is gezien: code, configuratie of uitvoer van een commando |
| Bestandslocatie | Pad en regelnummer(s) |
| Aanbevolen oplossing | Concreet, met een schatting van de inspanning (S: uren, M: dagen, L: weken) |
| Prioriteit | P0 tot P4 |

### 14.2 De vier documenten

| Document | Inhoud |
|---|---|
| `AUDIT_REPORT.md` | Samenvatting, scope en beperkingen, feitenblad, scorekaart, bevindingen per domein, sterke punten, conclusie |
| `SECURITY_FINDINGS.md` | Alle beveiligingsbevindingen in de vorm van 14.1, de OWASP-tabel met een oordeel per categorie, wat gecontroleerd en in orde bevonden is |
| `TECHNICAL_DEBT.md` | Register van technische schuld: wat, waar, waarom het er is, wat het kost om te laten staan, wat het kost om op te lossen |
| `IMPROVEMENT_ROADMAP.md` | Bevindingen geordend in de tijd (nu, 30, 90 dagen, later), met afhankelijkheden, inspanning en het effect op de scores |

### 14.3 Kwaliteitseisen aan het rapport

- Elke bevinding is tegengelezen in de code (fase 4).
- Elk getal noemt zijn bron.
- De beperkingen van de audit staan vooraan.
- Bevindingen die een bewuste, vastgelegde keuze van de eigenaar betreffen,
  worden zo benoemd. Het risico blijft staan, maar de aanbeveling erkent de
  keuze.
- Geen bevinding uit gewoonte: wat voor dit systeem niet van toepassing is,
  staat er als "niet van toepassing" met de reden.
