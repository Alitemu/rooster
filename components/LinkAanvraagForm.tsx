'use client';

import { useState } from 'react';
import { withBasePath } from '@/lib/basePath';

/**
 * "Link kwijt?" on the start page (POST /api/link-aanvragen). The answer
 * after sending is the same whether the address is known or not: the app
 * can't tell, the Power Automate flow decides (lib/linkAanvraag.ts).
 */
export function LinkAanvraagForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ kind: 'sending' });
    try {
      const res = await fetch(withBasePath('/api/link-aanvragen'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setState({ kind: 'sent' });
        return;
      }
      const data = await res.json().catch(() => null);
      setState({ kind: 'error', message: data?.error?.message || 'Het aanvragen is niet gelukt. Probeer het later opnieuw.' });
    } catch {
      setState({ kind: 'error', message: 'Het aanvragen is niet gelukt. Controleer je verbinding en probeer het opnieuw.' });
    }
  };

  if (state.kind === 'sent') {
    return (
      <div className="mt-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900" role="status">
        <p className="font-medium">Aanvraag ontvangen.</p>
        <p className="mt-1">
          Als dit e-mailadres bij ons bekend is, krijg je binnen een paar minuten een e-mail met je persoonlijke link.
        </p>
        <p className="mt-1">
          Geen e-mail ontvangen? Controleer of je het goede adres hebt ingevuld en of het je werk-e-mailadres is. Kijk
          ook in je map met ongewenste e-mail.
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
      {state.kind === 'error' && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
