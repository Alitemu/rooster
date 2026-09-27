'use client';

/**
 * Accounts beheren: the staff accounts, for an ADMIN (lib/staffAccounts.ts).
 * Add a planner or beheerder, give an account a temporary password, turn
 * off two-step verification, switch an account off or change its role.
 * One's own account is shown but managed with "Wachtwoord wijzigen" and
 * "Tweestapsverificatie" on the period list.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { withBasePath } from '@/lib/basePath';

interface Account {
  id: string;
  codenaam: string;
  rol: 'ADMIN' | 'PLANNER';
  actief: boolean;
  tweestapsverificatie: boolean;
  wachtwoord_ingesteld: boolean;
  wachtwoord_moet_wijzigen: boolean;
}

const ROL_LABEL: Record<Account['rol'], string> = { ADMIN: 'Beheerder', PLANNER: 'Planner' };

/** 16 characters that pass validatePasswordStrength, from the browser's own random source. */
function randomPassword(): string {
  const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!#%+=?'];
  const all = sets.join('');
  const pick = (chars: string) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const chars = [...sets.map(pick), ...Array.from({ length: 12 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function send(path: string, method: string, body?: unknown): Promise<string | null> {
  const res = await fetch(withBasePath(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.error?.message || 'Opslaan mislukt';
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nieuw, setNieuw] = useState({ codenaam: '', rol: 'PLANNER' as Account['rol'], wachtwoord: '' });
  // The temporary password just set, shown once so it can be passed on.
  const [getoond, setGetoond] = useState<{ codenaam: string; wachtwoord: string } | null>(null);
  const [resetVoor, setResetVoor] = useState<{ id: string; wachtwoord: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [listRes, meRes] = await Promise.all([
        fetch(withBasePath('/api/admin/accounts')),
        fetch(withBasePath('/api/auth/me')),
      ]);
      const meData = await meRes.json();
      setMe(meData?.data?.person_id ?? null);
      if (!listRes.ok) {
        setError('Alleen een beheerder kan accounts beheren.');
        setAccounts([]);
        return;
      }
      setAccounts((await listRes.json()).data);
    } catch {
      setError('Laden van accounts mislukt');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (action: () => Promise<string | null>, gelukt: string) => {
    setBusy(true);
    setError(null);
    setMelding(null);
    const fout = await action();
    if (fout) setError(fout);
    else setMelding(gelukt);
    await load();
    setBusy(false);
    return !fout;
  };

  const addAccount = async () => {
    const ok = await run(
      () => send('/api/admin/accounts', 'POST', nieuw),
      `${nieuw.codenaam.trim()} is toegevoegd als ${ROL_LABEL[nieuw.rol].toLowerCase()}.`
    );
    if (ok) {
      setGetoond({ codenaam: nieuw.codenaam.trim(), wachtwoord: nieuw.wachtwoord });
      setNieuw({ codenaam: '', rol: 'PLANNER', wachtwoord: '' });
    }
  };

  const resetPassword = async (a: Account) => {
    if (!resetVoor) return;
    const wachtwoord = resetVoor.wachtwoord;
    const ok = await run(
      () => send(`/api/admin/accounts/${a.id}/reset-password`, 'POST', { wachtwoord }),
      `${a.codenaam} heeft een tijdelijk wachtwoord. Overal waar ${a.codenaam} was ingelogd, is dat beëindigd.`
    );
    if (ok) {
      setGetoond({ codenaam: a.codenaam, wachtwoord });
      setResetVoor(null);
    }
  };

  if (!accounts) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center text-neutral-600">Accounts laden...</div>
      </div>
    );
  }

  return (
    <div className="container-main py-8 space-y-6">
      <div className="card p-6">
        <Link href="/planner" className="text-sm text-blue-700 hover:underline">
          ← Periodes
        </Link>
        <h1 className="text-2xl font-bold text-neutral-900 mt-2 mb-1">Accounts beheren</h1>
        <p className="text-sm text-neutral-600">
          Planners en beheerders van Dienstrooster. Een beheerder kan alles wat een planner kan en
          beheert daarnaast deze accounts. Een nieuw account of een gereset wachtwoord krijgt een
          tijdelijk wachtwoord. Bij de eerste keer inloggen kiest die persoon zelf een nieuw
          wachtwoord. Je eigen account beheer je met Wachtwoord wijzigen en Tweestapsverificatie.
        </p>
      </div>

      {error && <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-800">{error}</div>}
      {melding && (
        <div className="card p-4 bg-green-50 border border-green-200 text-sm text-green-800" role="status">
          {melding}
        </div>
      )}
      {getoond && (
        <div className="card p-4 bg-amber-50 border border-amber-300 text-sm text-amber-950" data-testid="tijdelijk-wachtwoord">
          <p>
            Tijdelijk wachtwoord voor <strong>{getoond.codenaam}</strong>:{' '}
            <code className="px-1 bg-white border rounded select-all">{getoond.wachtwoord}</code>
          </p>
          <p className="mt-1">
            Geef het persoonlijk of telefonisch door, niet per gewone mail. Het wordt hierna niet meer getoond.
          </p>
          <button className="btn-secondary mt-2" onClick={() => setGetoond(null)}>
            Verbergen
          </button>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100">
            <tr>
              <th className="px-3 py-2 text-left">Codenaam</th>
              <th className="px-3 py-2 text-left">Rol</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Tweestapsverificatie</th>
              <th className="px-3 py-2 text-left">Acties</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {accounts.map((a) => {
              const eigen = a.id === me;
              return (
                <tr key={a.id} className={a.actief ? '' : 'bg-neutral-50 text-neutral-500'}>
                  <td className="px-3 py-2 font-medium">
                    {a.codenaam}
                    {eigen && <span className="ml-2 text-xs text-neutral-500">(jij)</span>}
                  </td>
                  <td className="px-3 py-2">
                    {eigen ? (
                      ROL_LABEL[a.rol]
                    ) : (
                      <select
                        aria-label={`Rol van ${a.codenaam}`}
                        value={a.rol}
                        disabled={busy}
                        onChange={(e) =>
                          run(
                            () => send(`/api/admin/accounts/${a.id}`, 'PATCH', { rol: e.target.value }),
                            `${a.codenaam} is nu ${ROL_LABEL[e.target.value as Account['rol']].toLowerCase()}.`
                          )
                        }
                        className="px-2 py-1 border rounded text-sm"
                      >
                        <option value="PLANNER">Planner</option>
                        <option value="ADMIN">Beheerder</option>
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {!a.actief
                      ? 'Uitgeschakeld'
                      : !a.wachtwoord_ingesteld
                        ? 'Nog geen wachtwoord'
                        : a.wachtwoord_moet_wijzigen
                          ? 'Tijdelijk wachtwoord'
                          : 'Actief'}
                  </td>
                  <td className="px-3 py-2">{a.tweestapsverificatie ? 'Aan' : 'Uit'}</td>
                  <td className="px-3 py-2">
                    {eigen ? (
                      <span className="text-xs text-neutral-500">Via Wachtwoord wijzigen</span>
                    ) : resetVoor?.id === a.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          aria-label={`Tijdelijk wachtwoord voor ${a.codenaam}`}
                          value={resetVoor.wachtwoord}
                          onChange={(e) => setResetVoor({ id: a.id, wachtwoord: e.target.value })}
                          className="px-2 py-1 border rounded text-sm font-mono w-44"
                        />
                        <button className="btn-primary" disabled={busy} onClick={() => resetPassword(a)}>
                          Instellen
                        </button>
                        <button className="btn-secondary" disabled={busy} onClick={() => setResetVoor(null)}>
                          Annuleren
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-3">
                        <button
                          className="text-xs font-medium text-blue-700 hover:underline"
                          disabled={busy}
                          onClick={() => setResetVoor({ id: a.id, wachtwoord: randomPassword() })}
                        >
                          Wachtwoord resetten
                        </button>
                        {a.tweestapsverificatie && (
                          <button
                            className="text-xs font-medium text-blue-700 hover:underline"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => send(`/api/admin/accounts/${a.id}/totp-disable`, 'POST'),
                                `Tweestapsverificatie van ${a.codenaam} staat uit. ${a.codenaam} logt nu in met alleen het wachtwoord.`
                              )
                            }
                          >
                            Tweestapsverificatie uitzetten
                          </button>
                        )}
                        <button
                          className="text-xs font-medium text-red-700 hover:underline"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => send(`/api/admin/accounts/${a.id}`, 'PATCH', { actief: !a.actief }),
                              a.actief ? `${a.codenaam} is uitgeschakeld en kan niet meer inloggen.` : `${a.codenaam} kan weer inloggen.`
                            )
                          }
                        >
                          {a.actief ? 'Uitschakelen' : 'Inschakelen'}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card p-6 space-y-3">
        <p className="text-sm font-medium text-neutral-800">Nieuw account</p>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-neutral-600 mb-1" htmlFor="nieuw-codenaam">
              Codenaam
            </label>
            <input
              id="nieuw-codenaam"
              type="text"
              value={nieuw.codenaam}
              onChange={(e) => setNieuw({ ...nieuw, codenaam: e.target.value })}
              placeholder="bijv. planner2"
              className="w-full px-2 py-2 border rounded text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-600 mb-1" htmlFor="nieuw-rol">
              Rol
            </label>
            <select
              id="nieuw-rol"
              value={nieuw.rol}
              onChange={(e) => setNieuw({ ...nieuw, rol: e.target.value as Account['rol'] })}
              className="w-full px-2 py-2 border rounded text-sm"
            >
              <option value="PLANNER">Planner</option>
              <option value="ADMIN">Beheerder</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-600 mb-1" htmlFor="nieuw-wachtwoord">
              Tijdelijk wachtwoord
            </label>
            <div className="flex gap-2">
              <input
                id="nieuw-wachtwoord"
                type="text"
                value={nieuw.wachtwoord}
                onChange={(e) => setNieuw({ ...nieuw, wachtwoord: e.target.value })}
                className="w-full px-2 py-2 border rounded text-sm font-mono"
              />
              <button
                type="button"
                className="btn-secondary whitespace-nowrap"
                onClick={() => setNieuw({ ...nieuw, wachtwoord: randomPassword() })}
              >
                Maak er een
              </button>
            </div>
          </div>
          <button
            className="btn-primary"
            disabled={busy || !nieuw.codenaam.trim() || !nieuw.wachtwoord}
            onClick={addAccount}
          >
            Toevoegen
          </button>
        </div>
      </div>
    </div>
  );
}
