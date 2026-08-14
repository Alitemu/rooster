/**
 * Staff Login Page
 *
 * Password (+TOTP if enrolled) login for ADMIN/PLANNER accounts.
 */

'use client';

import { Suspense, useState, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function PlannerLoginPage() {
  return (
    <Suspense fallback={null}>
      <PlannerLoginForm />
    </Suspense>
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
