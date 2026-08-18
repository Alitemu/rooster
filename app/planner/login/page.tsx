/**
 * Staff Login Page
 *
 * Password (+TOTP if enrolled) login for ADMIN/PLANNER accounts.
 */

'use client';

import { Suspense, useState, useEffect, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function PlannerLoginPage() {
  return (
    <Suspense fallback={null}>
      <PlannerLoginGate />
    </Suspense>
  );
}

/**
 * Checks whether the seeded ADMIN/PLANNER accounts still need their first
 * password before showing the normal login form - see
 * app/api/auth/first-run-setup/route.ts. `pending === null` is "still
 * checking"; an empty array (including the fallback on a failed check) goes
 * straight to the login form, since that's always safe - a password that
 * hasn't been set yet just can't log in either way.
 */
function PlannerLoginGate() {
  const [pending, setPending] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/first-run-status')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setPending(data.data?.pending ?? []);
      })
      .catch(() => {
        if (!cancelled) setPending([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (pending === null) return null;
  if (pending.length > 0) {
    return <FirstRunSetupForm pending={pending} onDone={() => setPending([])} />;
  }
  return <PlannerLoginForm />;
}

function FirstRunSetupForm({ pending, onDone }: { pending: string[]; onDone: () => void }) {
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [confirms, setConfirms] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    for (const codenaam of pending) {
      if ((passwords[codenaam] || '') !== (confirms[codenaam] || '')) {
        setError(`Wachtwoorden voor ${codenaam} komen niet overeen`);
        return;
      }
    }

    setLoading(true);
    try {
      for (const codenaam of pending) {
        const res = await fetch('/api/auth/first-run-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codenaam, password: passwords[codenaam] || '' }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(`${codenaam}: ${data.error?.message || 'Instellen mislukt'}`);
          setLoading(false);
          return;
        }
      }
      onDone();
    } catch {
      setError('Instellen mislukt. Probeer het opnieuw.');
      setLoading(false);
    }
  };

  return (
    <div className="container-main">
      <div className="max-w-sm mx-auto">
        <div className="card card-padding">
          <h1 className="text-xl font-bold text-neutral-900 mb-2">Wachtwoord instellen</h1>
          <p className="text-sm text-neutral-600 mb-6">
            Dit is de eerste keer dat deze omgeving wordt geopend. Stel hieronder een wachtwoord
            in voor elk account voordat je verder kunt.
          </p>

          <form onSubmit={handleSubmit}>
            {pending.map((codenaam) => (
              <fieldset key={codenaam} className="mb-4">
                <legend className="label mb-2">{codenaam}</legend>
                <div className="form-group">
                  <label className="label" htmlFor={`password-${codenaam}`}>
                    Wachtwoord
                  </label>
                  <input
                    id={`password-${codenaam}`}
                    className="input w-full"
                    type="password"
                    autoComplete="new-password"
                    value={passwords[codenaam] || ''}
                    onChange={(e) => setPasswords((p) => ({ ...p, [codenaam]: e.target.value }))}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="label" htmlFor={`confirm-${codenaam}`}>
                    Bevestig wachtwoord
                  </label>
                  <input
                    id={`confirm-${codenaam}`}
                    className="input w-full"
                    type="password"
                    autoComplete="new-password"
                    value={confirms[codenaam] || ''}
                    onChange={(e) => setConfirms((c) => ({ ...c, [codenaam]: e.target.value }))}
                    required
                  />
                </div>
              </fieldset>
            ))}

            <p className="text-xs text-neutral-500 mb-4">
              Minimaal 12 tekens, met kleine letters, hoofdletters, cijfers en een speciaal teken.
            </p>

            {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? 'Bezig...' : 'Wachtwoord instellen'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function PlannerLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get('redirect') || '/planner';

  const [codenaam, setCodenaam] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/staff-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codenaam, password, totpCode: totpCode || undefined }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.error?.code === 'TOTP_REQUIRED') {
          setTotpRequired(true);
          setError('Enter your authentication code');
        } else {
          setError(data.error?.message || 'Login failed');
        }
        setLoading(false);
        return;
      }

      router.push(redirectTo);
      router.refresh();
    } catch {
      setError('Login failed. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="container-main">
      <div className="max-w-sm mx-auto">
        <div className="card card-padding">
          <h1 className="text-xl font-bold text-neutral-900 mb-6">Roosteraar inloggen</h1>

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="label" htmlFor="codenaam">
                Codenaam
              </label>
              <input
                id="codenaam"
                className="input w-full"
                type="text"
                autoComplete="username"
                value={codenaam}
                onChange={(e) => setCodenaam(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="label" htmlFor="password">
                Wachtwoord
              </label>
              <input
                id="password"
                className="input w-full"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {totpRequired && (
              <div className="form-group">
                <label className="label" htmlFor="totp">
                  Authenticatiecode
                </label>
                <input
                  id="totp"
                  className="input w-full"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  required
                />
              </div>
            )}

            {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? 'Bezig...' : 'Inloggen'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
