/**
 * Staff Login Page
 *
 * Password (+TOTP if enrolled) login for ADMIN/PLANNER accounts.
 */

'use client';

import { Suspense, useState, useEffect, FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * `redirect` is a URL query param, so it's attacker-controlled - anyone can
 * send a colleague a link like /planner/login?redirect=https://evil.example.
 * router.push() previously treated it as an internal route, harmless by
 * construction; window.location.href (needed below to escape the stale
 * router-cache redirect loop) executes whatever it's given, so this has to
 * reject anything that isn't a same-origin, single-leading-slash path
 * before it's ever used for navigation. A leading "//" is rejected too -
 * browsers treat that as scheme-relative and happily navigate off-site.
 */
function safeRedirectTarget(raw: string | null): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/planner';
}

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
  const [setupToken, setSetupToken] = useState('');
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [confirms, setConfirms] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Accounts already successfully claimed in a previous, partially-failed
  // submit - without tracking this, a retry re-sent every account from the
  // top, including ones already claimed. Since a claim is one-time
  // (wachtwoord_hash IS NULL), that account's account now correctly
  // returns "not available", but the wizard then reported *that* account
  // as the problem instead of the one that actually still needs fixing,
  // and had no way to reach the remaining accounts at all.
  const [succeeded, setSucceeded] = useState<Set<string>>(new Set());

  const remaining = pending.filter((codenaam) => !succeeded.has(codenaam));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    for (const codenaam of remaining) {
      if ((passwords[codenaam] || '') !== (confirms[codenaam] || '')) {
        setError(`Wachtwoorden voor ${codenaam} komen niet overeen`);
        return;
      }
    }

    setLoading(true);
    try {
      for (const codenaam of remaining) {
        const res = await fetch('/api/auth/first-run-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codenaam, password: passwords[codenaam] || '', setup_token: setupToken }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(`${codenaam}: ${data.error?.message || 'Instellen mislukt'}`);
          setLoading(false);
          return;
        }
        setSucceeded((prev) => new Set(prev).add(codenaam));
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
            <div className="form-group mb-4">
              <label className="label" htmlFor="setup-token">
                Setup-token
              </label>
              <input
                id="setup-token"
                className="input w-full"
                type="text"
                autoComplete="off"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                required
              />
              <p className="text-xs text-neutral-500 mt-1">
                Te vinden in de serverlogs (bijv. `docker compose logs web`) bij het aanmaken van de
                database - nooit hierin getypt door iemand anders dan degene met toegang tot de
                server.
              </p>
            </div>

            {remaining.map((codenaam) => (
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
  const searchParams = useSearchParams();
  const redirectTo = safeRedirectTarget(searchParams.get('redirect'));

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
          setError('Vul je authenticatiecode in');
        } else {
          setError(data.error?.message || 'Inloggen mislukt');
        }
        setLoading(false);
        return;
      }

      // Belt and braces: staff-login succeeding doesn't by itself prove the
      // session cookie actually landed in the browser (e.g. a client that
      // blocks third-party/insecure cookies outright) - checked explicitly
      // so a genuine failure here shows a clear message instead of the
      // silent bounce-back described below.
      const meRes = await fetch('/api/auth/me');
      const meData = await meRes.json();
      if (!meData.data?.authenticated) {
        setError('Inloggen is gelukt, maar de sessie kon niet worden opgeslagen. Probeer het opnieuw.');
        setLoading(false);
        return;
      }

      // A hard navigation, not router.push(): /planner is a route Next.js
      // prefetches automatically while still on this page (a shared layout
      // links to it), and that prefetch runs before login - unauthenticated,
      // so it caches proxy.ts's redirect back to this very login page.
      // router.push() served that stale cached redirect even after a
      // genuinely successful login (confirmed valid by the check above),
      // which looked exactly like the login endlessly doing nothing -
      // reported as "inloggen duurt heel lang". window.location.href always
      // issues a fresh request instead of reading the client router cache.
      window.location.href = redirectTo;
    } catch {
      setError('Inloggen mislukt. Probeer het opnieuw.');
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
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
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
