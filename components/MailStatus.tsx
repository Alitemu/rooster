'use client';

/**
 * What a planner sees of the mail under Exporteren & communicatie: whether
 * it goes out and where the verzendlijst goes. Only the beheerder sets it
 * up (components/MailSettingsDialog.tsx; the planner's choice in 0.87.0,
 * as on the AIOS's page): it is the Gmail account both diensten send from.
 */

import { useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';

interface Status {
  ingesteld: boolean;
  uitgeschakeld: boolean;
  gebruiker: string | null;
  verzendlijst_aan: string | null;
}

export function MailStatus({ refreshKey }: { refreshKey: string }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let current = true;
    fetch(withBasePath('/api/planner/mail-settings'))
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
  return (
    <div className="rounded border border-neutral-200 p-3 text-sm space-y-1" data-testid="mail-status">
      <p className="font-medium text-neutral-900">Mail</p>
      {status.uitgeschakeld ? (
        <p className="text-red-800">Versturen staat uit op deze installatie (MAIL_UITGESCHAKELD).</p>
      ) : status.ingesteld ? (
        <p className="text-neutral-700">
          De verzendlijst gaat naar <strong>{status.verzendlijst_aan}</strong>, verstuurd vanaf {status.gebruiker}.
        </p>
      ) : (
        <p className="text-amber-900">De mail is nog niet ingesteld. Er gaan geen uitnodigingen, herinneringen of ruilmails uit.</p>
      )}
      <p className="text-neutral-600">Alleen de beheerder stelt de mail in.</p>
    </div>
  );
}
