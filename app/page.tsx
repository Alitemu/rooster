import Link from 'next/link';

export default function Home() {
  return (
    <div className="container-main">
      <div className="card card-padding">
        <h2 className="text-2xl font-bold text-neutral-900 mb-4">
          Welkom bij Dienstrooster
        </h2>
        <p className="text-neutral-600 mb-4">
          Dit systeem helpt bij eerlijke verdeling van diensten voor medische achterwachten.
        </p>
        <ul className="space-y-2 text-neutral-600">
          <li>✓ Automatische roosterplanning op basis van voorkeuren</li>
          <li>✓ Eerlijke verdeling van diensten</li>
          <li>✓ Feestdagrotatie</li>
          <li>✓ Parttime ondersteuning</li>
        </ul>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
        <div className="card card-padding">
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">
            Voor deelnemers
          </h3>
          <p className="text-neutral-600 text-sm">
            Voer je voorkeuren in, blokkeer je dagen en bekijk je toegewezen diensten via je
            persoonlijke link, ontvangen van de roosteraar.
          </p>
        </div>

        <div className="card card-padding">
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">
            Voor roosteraar
          </h3>
          <p className="text-neutral-600 text-sm mb-4">
            Beheer periodes, genereer roosters en publiceer diensten.
          </p>
          <Link href="/planner/login" className="btn-primary inline-block">Naar beheer</Link>
        </div>
      </div>
    </div>
  );
}
