/**
 * Planner Landing Page
 *
 * Lists existing periods and lets a planner create a new one.
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Period {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  pool_id: string;
}

interface Pool {
  id: string;
  naam: string;
  type: string;
  member_count: number;
}

interface TrashedPeriod {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  status: string;
  pool_id: string;
  verwijderd_op: string;
  dagen_resterend: number;
}

const statusLabels: Record<string, string> = {
  CONCEPT: '⚙️ Concept',
  OPEN: '📖 Open',
  GESLOTEN: '🔒 Gesloten',
  GEGENEREERD: '🤖 Gegenereerd',
  GEPUBLICEERD: '✅ Gepubliceerd',
};

// The stakes of deleting a period differ a lot by status - a CONCEPT
// period nobody has seen yet is low-risk, but deleting an OPEN or
// published one throws away real participant data (submitted preferences,
// or a roster people have already viewed).
function deleteWarningText(status: string): string {
  if (status === 'GEPUBLICEERD') {
    return 'Dit rooster is al gepubliceerd en deelnemers hebben het al kunnen bekijken. Zij verliezen direct toegang tot hun rooster in deze periode.';
  }
  if (status === 'CONCEPT') {
    return 'Deze periode staat nog op concept en is nog niet zichtbaar voor deelnemers.';
  }
  return 'Deelnemers hebben deze periode al kunnen zien en mogelijk al voorkeuren ingevoerd. Die gegevens verdwijnen mee.';
}

export default function PlannerHomePage() {
  const router = useRouter();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    naam: '',
    pool_id: '',
    start_datum: '',
    eind_datum: '',
    deadline: '',
  });

  const [deletingPeriod, setDeletingPeriod] = useState<Period | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [showTrash, setShowTrash] = useState(false);
  const [trash, setTrash] = useState<TrashedPeriod[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashActionBusy, setTrashActionBusy] = useState<string | null>(null);
  const [purgingPeriod, setPurgingPeriod] = useState<TrashedPeriod | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [periodsRes, poolsRes, trashRes] = await Promise.all([
        fetch('/api/periods'),
        fetch('/api/planner/pools'),
        fetch('/api/periods/trash'),
      ]);
      const periodsData = await periodsRes.json();
      const poolsData = await poolsRes.json();
      const trashData = await trashRes.json();
      setPeriods(periodsData.data || []);
      setPools(poolsData.data || []);
      setTrash(trashData.data || []);
      if (poolsData.data?.length && !form.pool_id) {
        setForm((f) => ({ ...f, pool_id: poolsData.data[0].id }));
      }
    } catch {
      setError('Laden van periodes mislukt');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTrash = async () => {
    setTrashLoading(true);
    try {
      const res = await fetch('/api/periods/trash');
      const data = await res.json();
      setTrash(data.data || []);
    } catch {
      // Leave the previous list in place on a failed refresh
    } finally {
      setTrashLoading(false);
    }
  };

  const handleDeleteClick = (period: Period) => {
    setDeleteError(null);
    setDeletingPeriod(period);
  };

  const handleConfirmDelete = async () => {
    if (!deletingPeriod) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/periods/${deletingPeriod.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Verwijderen mislukt');

      setPeriods((prev) => prev.filter((p) => p.id !== deletingPeriod.id));
      setDeletingPeriod(null);
      loadTrash();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Verwijderen mislukt');
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleRestore = async (id: string) => {
    setTrashActionBusy(id);
    try {
      const res = await fetch(`/api/periods/${id}/restore`, { method: 'POST' });
      if (!res.ok) throw new Error();
      await loadData();
    } catch {
      // Leave it in the trash list - the planner can retry
    } finally {
      setTrashActionBusy(null);
    }
  };

  const handleConfirmPurge = async () => {
    if (!purgingPeriod) return;
    setTrashActionBusy(purgingPeriod.id);
    setPurgeError(null);
    try {
      const res = await fetch(`/api/periods/${purgingPeriod.id}/purge`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Definitief verwijderen mislukt');

      setTrash((prev) => prev.filter((p) => p.id !== purgingPeriod.id));
      setPurgingPeriod(null);
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : 'Definitief verwijderen mislukt');
    } finally {
      setTrashActionBusy(null);
    }
  };

  const handleCreate = async () => {
    setError(null);

    if (!form.naam || !form.pool_id || !form.start_datum || !form.eind_datum || !form.deadline) {
      setError('Alle velden zijn verplicht');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/planner/periods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || 'Aanmaken van periode mislukt');
      }

      router.push(`/planner/setup/${data.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aanmaken van periode mislukt');
      setCreating(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
  };

  return (
    <div className="container-main py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-neutral-900">Periodes</h1>
        <div className="flex gap-3">
          <button
            onClick={() => {
              setShowTrash(!showTrash);
              if (!showTrash) loadTrash();
            }}
            className="btn-secondary"
          >
            🗑️ Prullenbak{trash.length > 0 ? ` (${trash.length})` : ''}
          </button>
          <button onClick={() => setShowCreate(!showCreate)} className="btn-primary">
            {showCreate ? 'Annuleren' : '+ Nieuwe periode'}
          </button>
          <button onClick={handleLogout} className="btn-secondary">
            Uitloggen
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="card card-padding space-y-4">
          <h2 className="text-lg font-semibold">Nieuwe periode aanmaken</h2>

          <div className="form-group">
            <label className="label">Naam periode</label>
            <input
              type="text"
              className="input w-full"
              value={form.naam}
              onChange={(e) => setForm({ ...form, naam: e.target.value })}
              placeholder="bijv. 2027-2"
            />
          </div>

          <div className="form-group">
            <label className="label">Pool</label>
            <select
              className="input w-full"
              value={form.pool_id}
              onChange={(e) => setForm({ ...form, pool_id: e.target.value })}
            >
              {pools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.naam} ({p.member_count} leden)
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="form-group">
              <label className="label">Startdatum</label>
              <input
                type="date"
                className="input w-full"
                value={form.start_datum}
                onChange={(e) => setForm({ ...form, start_datum: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="label">Einddatum</label>
              <input
                type="date"
                className="input w-full"
                value={form.eind_datum}
                onChange={(e) => setForm({ ...form, eind_datum: e.target.value })}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="label">Deadline voorkeuren</label>
            {/* datetime-local, net als de deadline-stap in de setup wizard
                verderop - zelfde invoerformaat, zodat deze waarde daar
                automatisch wordt overgenomen in plaats van leeg te lijken en
                opnieuw ingevuld te moeten worden. */}
            <input
              type="datetime-local"
              className="input w-full"
              value={form.deadline}
              onChange={(e) => setForm({ ...form, deadline: e.target.value })}
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button onClick={handleCreate} disabled={creating} className="btn-primary">
            {creating ? 'Bezig met aanmaken...' : 'Aanmaken en instellen'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-neutral-600">Periodes laden...</div>
      ) : periods.length === 0 ? (
        <div className="card p-8 text-center text-neutral-600">
          Nog geen periodes. Maak er een aan om te beginnen.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="bg-neutral-100">
              <tr>
                <th className="px-4 py-2 text-left text-sm font-medium">Naam</th>
                <th className="px-4 py-2 text-left text-sm font-medium">Data</th>
                <th className="px-4 py-2 text-left text-sm font-medium">Status</th>
                <th className="px-4 py-2 text-left text-sm font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {periods.map((p) => (
                <tr key={p.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-2 text-sm font-medium">{p.naam}</td>
                  <td className="px-4 py-2 text-sm text-neutral-600">
                    {p.start_datum} t/m {p.eind_datum}
                  </td>
                  <td className="px-4 py-2 text-sm">{statusLabels[p.status] || p.status}</td>
                  <td className="px-4 py-2 text-sm">
                    <div className="flex items-center gap-4">
                      <Link
                        href={p.status === 'CONCEPT' ? `/planner/setup/${p.id}` : `/planner/period/${p.id}`}
                        className="text-blue-600 hover:text-blue-700 font-medium"
                      >
                        {p.status === 'CONCEPT' ? 'Instellen vervolgen' : 'Openen'} →
                      </Link>
                      <button
                        onClick={() => handleDeleteClick(p)}
                        className="text-red-600 hover:text-red-700 font-medium"
                      >
                        Verwijderen
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showTrash && (
        <div className="card card-padding space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Prullenbak</h2>
            <p className="text-sm text-neutral-600">
              Verwijderde periodes blijven 30 dagen lang herstelbaar voordat ze definitief
              verdwijnen.
            </p>
          </div>

          {trashLoading ? (
            <p className="text-sm text-neutral-600">Prullenbak laden...</p>
          ) : trash.length === 0 ? (
            <p className="text-sm text-neutral-600">De prullenbak is leeg.</p>
          ) : (
            <div className="divide-y">
              {trash.map((p) => (
                <div key={p.id} className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{p.naam}</p>
                    <p className="text-xs text-neutral-600">
                      {p.start_datum} t/m {p.eind_datum} · was {statusLabels[p.status] || p.status} ·{' '}
                      {p.dagen_resterend === 0
                        ? 'wordt binnenkort definitief verwijderd'
                        : `nog ${p.dagen_resterend} dag${p.dagen_resterend === 1 ? '' : 'en'} te herstellen`}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <button
                      onClick={() => handleRestore(p.id)}
                      disabled={trashActionBusy === p.id}
                      className="text-blue-600 hover:text-blue-700 font-medium text-sm disabled:opacity-50"
                    >
                      Herstellen
                    </button>
                    <button
                      onClick={() => {
                        setPurgeError(null);
                        setPurgingPeriod(p);
                      }}
                      disabled={trashActionBusy === p.id}
                      className="text-red-600 hover:text-red-700 font-medium text-sm disabled:opacity-50"
                    >
                      Definitief verwijderen
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation */}
      {deletingPeriod && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Periode verwijderen"
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
        >
          <div className="card p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-bold mb-2">Periode verwijderen?</h2>
            <p className="text-sm text-neutral-700 mb-3">
              &quot;{deletingPeriod.naam}&quot; wordt naar de prullenbak verplaatst.
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded p-3 mb-4">
              <p className="text-sm text-amber-900">{deleteWarningText(deletingPeriod.status)}</p>
              <p className="text-sm text-amber-900 mt-2">
                Je kunt de periode nog 30 dagen lang terughalen via de prullenbak. Daarna wordt hij
                automatisch definitief verwijderd.
              </p>
            </div>

            {deleteError && <p className="text-sm text-red-600 mb-3">{deleteError}</p>}

            <div className="flex gap-3">
              <button
                onClick={() => setDeletingPeriod(null)}
                disabled={deleteBusy}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors disabled:opacity-50"
              >
                Annuleren
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleteBusy}
                className="flex-1 py-2 px-4 rounded font-medium bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {deleteBusy ? 'Bezig...' : 'Verwijderen'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Permanent purge confirmation - a second, stronger warning since this
          one is irreversible and skips the rest of the 30-day window. */}
      {purgingPeriod && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Periode definitief verwijderen"
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
        >
          <div className="card p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-bold mb-2 text-red-700">Definitief verwijderen?</h2>
            <p className="text-sm text-neutral-700 mb-3">
              &quot;{purgingPeriod.naam}&quot; en alle bijbehorende gegevens (voorkeuren,
              toewijzingen, saldi) worden nu meteen en onherroepelijk verwijderd - dit kan niet
              ongedaan gemaakt worden, ook niet via de prullenbak.
            </p>

            {purgeError && <p className="text-sm text-red-600 mb-3">{purgeError}</p>}

            <div className="flex gap-3">
              <button
                onClick={() => setPurgingPeriod(null)}
                disabled={trashActionBusy === purgingPeriod.id}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors disabled:opacity-50"
              >
                Annuleren
              </button>
              <button
                onClick={handleConfirmPurge}
                disabled={trashActionBusy === purgingPeriod.id}
                className="flex-1 py-2 px-4 rounded font-medium bg-red-700 text-white hover:bg-red-800 transition-colors disabled:opacity-50"
              >
                {trashActionBusy === purgingPeriod.id ? 'Bezig...' : 'Ja, definitief verwijderen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
