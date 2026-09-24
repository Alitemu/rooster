'use client';

/**
 * At the top of the period page whenever mail is not going out: sending
 * is not set up at all, the saved password can no longer be read, or the
 * last send failed (lib/appSettings.ts MailFailure). Automatic reminders
 * and swap mails fail where nobody watches, so without this a planner
 * only found out from someone who never got their mail. Disappears once
 * a send succeeds again. Renders nothing while all is well.
 */

import { useEffect, useState } from 'react';

interface Status {
  ingesteld: boolean;
  wachtwoord_onleesbaar: boolean;
  laatste_fout: { op: string; melding: string; soort: string; automatisch: boolean } | null;
  wachtrij: number;
}

const WAT: Record<string, string> = {
  UITNODIGING: 'de uitnodigingen',
  HERINNERING: 'een herinnering',
  LAATSTE_HERINNERING: 'een laatste herinnering',
  RUILVERZOEK: 'een mail over een ruilverzoek',
  RUIL_BEVESTIGING: 'een mail over een ruilverzoek',
  RUIL_UITKOMST: 'een mail over een ruilverzoek',
  RUIL_INGETROKKEN: 'een mail over een ruilverzoek',
};

/** "24 september om 09:00". */
function wanneer(iso: string): string {
  const d = new Date(iso);
  const dag = d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
  const tijd = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return `${dag} om ${tijd}`;
}

/** refreshKey: changes after the settings changed or the export dialog closed (something may have been sent). */
export function MailWarning({ refreshKey, onOpenSettings }: { refreshKey: string; onOpenSettings: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let current = true;
    fetch('/api/planner/mail-settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (current && data?.success) setStatus(data.data);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [refreshKey]);

  if (!status) return null;

  let titel: string;
  let tekst: string;
  if (!status.ingesteld) {
    titel = 'Er wordt geen mail verstuurd';
    tekst = status.wachtwoord_onleesbaar
      ? 'Het opgeslagen app-wachtwoord kan niet meer gelezen worden. Uitnodigingen, herinneringen en ruilmails staan stil tot je het opnieuw invult.'
      : 'Uitnodigingen, herinneringen en ruilmails staan stil. Stel het Gmail-account in bij Mailinstellingen.';
  } else if (status.laatste_fout) {
    const fout = status.laatste_fout;
    const wat = fout.soort.includes('HERINNERING') && fout.automatisch ? 'een automatische herinnering' : WAT[fout.soort] ?? 'een mail';
    titel = 'Versturen is mislukt';
    tekst = `Op ${wanneer(fout.op)} kon ${wat} niet verstuurd worden: ${fout.melding} Deze melding verdwijnt zodra er weer iets verstuurd is.`;
  } else {
    return null;
  }
  if (status.wachtrij > 0) {
    tekst += ` ${status.wachtrij === 1 ? 'Er wacht 1 ruilmail' : `Er wachten ${status.wachtrij} ruilmails`} op verzending. ${status.wachtrij === 1 ? 'Die gaat' : 'Die gaan'} alsnog zodra het versturen weer werkt.`;
  }

  return (
    <div role="alert" className="card p-4 bg-red-50 border border-red-300 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-bold text-red-900">⚠️ {titel}</p>
        <p className="text-sm text-red-900 mt-1">{tekst}</p>
      </div>
      <button
        onClick={onOpenSettings}
        className="shrink-0 px-4 py-2 rounded font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
      >
        Mailinstellingen openen
      </button>
    </div>
  );
}
