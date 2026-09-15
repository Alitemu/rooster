/**
 * Personeel beheren (pool-wide staff screen)
 *
 * The setup wizard's own "Personeel" step edits the exact same pool
 * membership rows, but only exists once a period exists to attach the
 * wizard to. This page manages a pool's membership directly - add someone,
 * change their geldig_vanaf/geldig_tot or deelnamefactor, remove them -
 * with no period in the loop at all, so a planner isn't blocked from
 * onboarding or offboarding staff by "first make a period".
 *
 * "Actief" here means active today (the members endpoint defaults
 * period_start/period_end to today when neither is given) - there's no
 * period whose dates that could otherwise be relative to.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface Pool {
  id: string;
  naam: string;
}

interface StaffMember {
  id: string; // pool_membership row id
  person_id: string;
  codenaam: string;
  geldig_vanaf: string;
  geldig_tot: string;
  is_active: boolean;
  deelnamefactor: number;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function PoolStaffPage() {
  const params = useParams();
  const poolId = params.id as string;

  const [pool, setPool] = useState<Pool | null>(null);
  const [poolLoading, setPoolLoading] = useState(true);
  const [poolError, setPoolError] = useState<string | null>(null);

  const [members, setMembers] = useState<StaffMember[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [staffError, setStaffError] = useState<string | null>(null);

  const [newMember, setNewMember] = useState({
    codenaam: '',
    geldig_vanaf: todayISO(),
    geldig_tot: '',
    deelnamefactor: 1,
  });
  const [addingMember, setAddingMember] = useState(false);

  const [editingMembershipId, setEditingMembershipId] = useState<string | null>(null);
  const [editDates, setEditDates] = useState({ geldig_vanaf: '', geldig_tot: '', deelnamefactor: 1 });
  const [savingMembership, setSavingMembership] = useState(false);
  const [removingMembershipId, setRemovingMembershipId] = useState<string | null>(null);

  // No GET /api/planner/pools/[id] exists (only PATCH) - the list endpoint
  // already carries naam for every pool, so find this one in it rather
  // than adding a single-pool route for one field.
  useEffect(() => {
    fetch('/api/planner/pools?include_inactive=true')
      .then((res) => res.json())
      .then((data) => {
        const found = (data.data || []).find((p: Pool) => p.id === poolId);
        if (!found) throw new Error('Pool niet gevonden');
        setPool(found);
        setPoolLoading(false);
      })
      .catch((err) => {
        setPoolError(err instanceof Error ? err.message : 'Laden van pool mislukt');
        setPoolLoading(false);
      });
  }, [poolId]);

  const loadStaff = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setStaffLoading(true);
    setStaffError(null);
    try {
      const res = await fetch(`/api/planner/pool/${poolId}/members`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Laden van personeel mislukt');
      setMembers(data.data || []);
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : 'Laden van personeel mislukt');
    } finally {
      if (!options?.silent) setStaffLoading(false);
    }
  }, [poolId]);

  useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  const handleAddMember = async () => {
    if (!newMember.codenaam.trim() || !newMember.geldig_vanaf || !newMember.geldig_tot) {
      setStaffError('Codenaam, geldig vanaf en geldig tot zijn verplicht');
      return;
    }
    if (Number.isNaN(newMember.deelnamefactor)) {
      setStaffError('Deelnamefactor is verplicht');
      return;
    }
    setAddingMember(true);
    setStaffError(null);
    try {
      const res = await fetch(`/api/planner/pool/${poolId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newMember),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Toevoegen mislukt');

      setNewMember({ codenaam: '', geldig_vanaf: todayISO(), geldig_tot: '', deelnamefactor: 1 });
      await loadStaff({ silent: true });
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : 'Toevoegen mislukt');
    } finally {
      setAddingMember(false);
    }
  };

  const startEditMembership = (member: StaffMember) => {
    setStaffError(null);
    setEditingMembershipId(member.id);
    setEditDates({ geldig_vanaf: member.geldig_vanaf, geldig_tot: member.geldig_tot, deelnamefactor: member.deelnamefactor });
  };

  const handleSaveMembership = async (membershipId: string) => {
    if (Number.isNaN(editDates.deelnamefactor)) {
      setStaffError('Deelnamefactor is verplicht');
      return;
    }
    setSavingMembership(true);
    setStaffError(null);
    try {
      const res = await fetch(`/api/planner/pool/${poolId}/members/${membershipId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editDates),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Opslaan mislukt');

      setEditingMembershipId(null);
      await loadStaff({ silent: true });
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : 'Opslaan mislukt');
    } finally {
      setSavingMembership(false);
    }
  };

  const handleRemoveMembership = async (membershipId: string) => {
    if (removingMembershipId !== membershipId) {
      // First click arms the confirmation instead of deleting immediately.
      setRemovingMembershipId(membershipId);
      return;
    }
    setStaffError(null);
    try {
      const res = await fetch(`/api/planner/pool/${poolId}/members/${membershipId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Verwijderen mislukt');

      await loadStaff({ silent: true });
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : 'Verwijderen mislukt');
    } finally {
      setRemovingMembershipId(null);
    }
  };

  if (poolLoading) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center text-neutral-600">Pool laden...</div>
      </div>
    );
  }

  if (poolError || !pool) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 bg-red-50 border border-red-200">
          <p className="text-red-700">{poolError || 'Pool niet gevonden'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container-main py-8 space-y-6">
      <div className="card p-6 bg-gradient-to-r from-blue-50 to-neutral-50">
        <Link href="/planner" className="text-sm text-blue-700 hover:underline">
          ← Terug naar periodes
        </Link>
        <h1 className="text-2xl font-bold text-neutral-900 mt-2 mb-1">Personeel beheren</h1>
        <p className="text-neutral-600">{pool.naam}</p>
      </div>

      <div className="card card-padding space-y-4">
        <p className="text-sm text-neutral-600">
          Wijzigingen hier gelden voor de hele pool en direct voor elke nieuwe periode die je
          opent - los van welke periode nog loopt. &quot;Actief&quot; betekent actief vandaag.
        </p>

        {staffError && (
          <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{staffError}</div>
        )}

        {staffLoading ? (
          <div className="border rounded p-4 text-sm text-neutral-600 text-center">Personeel laden...</div>
        ) : (
          <div className="border rounded overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-100">
                <tr>
                  <th className="px-4 py-2 text-left text-sm font-medium">Naam</th>
                  <th className="px-4 py-2 text-left text-sm font-medium">Actief</th>
                  <th className="px-4 py-2 text-left text-sm font-medium">Geldig vanaf</th>
                  <th className="px-4 py-2 text-left text-sm font-medium">Geldig tot</th>
                  <th className="px-4 py-2 text-left text-sm font-medium">Deelnamefactor</th>
                  <th className="px-4 py-2 text-left text-sm font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((member) => {
                  const isEditing = editingMembershipId === member.id;
                  return (
                    <tr key={member.id} className="hover:bg-neutral-50">
                      <td className="px-4 py-2 text-sm font-medium">{member.codenaam}</td>
                      <td className="px-4 py-2 text-sm">
                        <span className={member.is_active ? 'text-green-600 font-medium' : 'text-neutral-500'}>
                          {member.is_active ? 'Actief' : 'Niet actief'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-sm">
                        {isEditing ? (
                          <input
                            type="date"
                            value={editDates.geldig_vanaf}
                            onChange={(e) => setEditDates({ ...editDates, geldig_vanaf: e.target.value })}
                            className="px-2 py-1 border rounded text-sm w-36"
                          />
                        ) : (
                          member.geldig_vanaf
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm">
                        {isEditing ? (
                          <input
                            type="date"
                            value={editDates.geldig_tot}
                            onChange={(e) => setEditDates({ ...editDates, geldig_tot: e.target.value })}
                            className="px-2 py-1 border rounded text-sm w-36"
                          />
                        ) : (
                          member.geldig_tot
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm">
                        {isEditing ? (
                          <input
                            type="number"
                            min="0.1"
                            max="1"
                            step="0.1"
                            value={editDates.deelnamefactor}
                            onChange={(e) =>
                              setEditDates({ ...editDates, deelnamefactor: parseFloat(e.target.value) })
                            }
                            className="px-2 py-1 border rounded text-sm w-20"
                          />
                        ) : member.deelnamefactor < 1 ? (
                          `${Math.round(member.deelnamefactor * 100)}%`
                        ) : (
                          'Voltijd'
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm whitespace-nowrap">
                        {isEditing ? (
                          <div className="flex gap-3">
                            <button
                              onClick={() => handleSaveMembership(member.id)}
                              disabled={savingMembership}
                              className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                            >
                              {savingMembership ? 'Bezig…' : 'Opslaan'}
                            </button>
                            <button
                              onClick={() => setEditingMembershipId(null)}
                              className="text-xs font-medium text-neutral-600 hover:text-neutral-800"
                            >
                              Annuleren
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-3">
                            <button
                              onClick={() => startEditMembership(member)}
                              className="text-xs font-medium text-blue-600 hover:text-blue-800"
                            >
                              Bewerken
                            </button>
                            <button
                              onClick={() => handleRemoveMembership(member.id)}
                              className="text-xs font-medium text-red-600 hover:text-red-800"
                            >
                              {removingMembershipId === member.id ? 'Zeker weten?' : 'Verwijderen'}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {members.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-sm text-neutral-500">
                      Nog niemand in deze pool. Voeg hieronder iemand toe.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="border-t border-neutral-200 pt-4 space-y-3">
          <p className="text-sm font-medium text-neutral-800">Nieuw personeelslid toevoegen</p>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Codenaam</label>
              <input
                type="text"
                value={newMember.codenaam}
                onChange={(e) => setNewMember({ ...newMember, codenaam: e.target.value })}
                placeholder="bijv. Persoon-32"
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Geldig vanaf</label>
              <input
                type="date"
                value={newMember.geldig_vanaf}
                onChange={(e) => setNewMember({ ...newMember, geldig_vanaf: e.target.value })}
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Geldig tot</label>
              <input
                type="date"
                value={newMember.geldig_tot}
                onChange={(e) => setNewMember({ ...newMember, geldig_tot: e.target.value })}
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Deelnamefactor</label>
              <input
                type="number"
                min="0.1"
                max="1"
                step="0.1"
                value={newMember.deelnamefactor}
                onChange={(e) => setNewMember({ ...newMember, deelnamefactor: parseFloat(e.target.value) })}
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={handleAddMember}
                disabled={addingMember}
                className="w-full px-3 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
              >
                {addingMember ? 'Bezig…' : 'Toevoegen'}
              </button>
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            Bestaat de codenaam al (bijv. iemand die eerder in een andere pool zat), dan wordt die
            persoon hergebruikt in plaats van dubbel aangemaakt.
          </p>
        </div>
      </div>
    </div>
  );
}
