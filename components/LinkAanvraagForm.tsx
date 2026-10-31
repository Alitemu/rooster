'use client';

import { useState } from 'react';
import { withBasePath } from '@/lib/basePath';

/**
 * "Link kwijt?" on the start page, shared by the achterwacht and the AIOS
 * like the rest of the login page: POST /api/link-aanvragen (the
 * achterwacht's flow, lib/linkAanvraag.ts) and /api/aios/link-aanvragen
 * (the AIOS's flow). The answer after sending is the same whether the
 * address is known or not: the app can't tell, the flows decide.
 */
export function LinkAanvraagForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ kind: 'sending' });
    // The achterwacht and the AIOS each have their own flow and their own
    // route for it (app/api/aios/link-aanvragen); whoever the address
    // belongs to, one of them sends the link. Received by either is enough.
    const vraag = (url: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }).catch(() => null);
    const [achterwacht, aios] = await Promise.all([
      vraag(withBasePath('/api/link-aanvragen')),
      vraag(withBasePath('/api/aios/link-aanvragen')),
    ]);
    // The achterwacht's answer counts first, as before the AIOS had a
    // route: a malformed address or too many requests is told as it was.
    // Only when the achterwacht's flow could not take it does the AIOS's
    // having taken it count as received.
    const zegtNee = achterwacht && (achterwacht.status === 400 || achterwacht.status === 429);
    if (achterwacht?.ok || (!zegtNee && aios?.ok)) {
      setState({ kind: 'sent' });
      return;
    }
    if (!achterwacht && !aios) {
      setState({ kind: 'error', message: 'Het aanvragen is niet gelukt. Controleer je verbinding en probeer het opnieuw.' });
      return;
    }
    const data = await (achterwacht ?? aios)!.json().catch(() => null);
    setState({ kind: 'error', message: data?.error?.message || 'Het aanvragen is niet gelukt. Probeer het later opnieuw.' });
  };

  if (state.kind === 'sent') {
    return (
      <div className="mt-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900" role="status">
        <p className="font-medium">Aanvraag ontvangen.</p>
        <p className="mt-1">
          Als dit e-mailadres bij ons bekend is, krijg je een e-mail met je persoonlijke link. Dat kan tot een kwartier
          duren. Vraag hem in die tijd niet opnieuw aan, want dan krijg je meerdere e-mails.
        </p>
        <p className="mt-1">
          Na een kwartier nog geen e-mail? Controleer of je het goede adres hebt ingevuld en of het je werk-e-mailadres
          is. Kijk ook in je map met ongewenste e-mail.
        </p>
        <button
          type="button"
          onClick={() => setState({ kind: 'idle' })}
          className="mt-2 text-green-900 underline hover:no-underline"
        >
          Opnieuw aanvragen
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4">
      <label htmlFor="link-aanvraag-email" className="block text-sm font-medium text-neutral-900">
        Link kwijt? Vraag hem opnieuw aan met je werk-e-mailadres
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="link-aanvraag-email"
          type="email"
          required
          autoComplete="email"
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="naam@werk.nl"
          className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
        />
        <button type="submit" disabled={state.kind === 'sending'} className="btn-primary whitespace-nowrap disabled:opacity-60">
          {state.kind === 'sending' ? 'Bezig...' : 'Link aanvragen'}
        </button>
      </div>
      <p className="mt-2 text-xs text-neutral-600">De e-mail kan tot een kwartier onderweg zijn. Vraag de link één keer aan.</p>
      {state.kind === 'error' && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
