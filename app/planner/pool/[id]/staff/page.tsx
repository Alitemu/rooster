/**
 * Personeel beheren (pool-wide staff screen)
 *
 * The setup wizard's own "Personeel" step edits the exact same pool
 * membership rows, but only exists once a period exists to attach the
 * wizard to. This page manages a pool's membership directly - add someone,
 * change their geldig_vanaf/geldig_tot, remove them (the deelnamefactor is
 * shown, not typed: it follows from their own part-time days) -
 * with no period in the loop at all, so a planner isn't blocked from
 * onboarding or offboarding staff by "first make a period".
 *
 * "Actief" here means active today (the members endpoint defaults
 * period_start/period_end to today when neither is given) - there's no
 * period whose dates that could otherwise be relative to.
 */

'use client';

import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { withBasePath } from '@/lib/basePath';
import { localIsoDate } from '@/lib/localDate';
import { newMembershipDefaults, type MembershipDefaults, type PeriodForDefaults } from '@/lib/membershipDefaults';
import { foutTekst } from '@/lib/foutTekst';

interface Pool {
  id: string;
  naam: string;
  type: string;
}

interface StaffMember {
  id: string; // pool_membership row id
  person_id: string;
  codenaam: string;
  geldig_vanaf: string;
  geldig_tot: string;
  is_active: boolean;
  /** Worked out from their own part-time days; null until they handed in (lib/deelnamefactor.ts). */
  deelnamefactor: number | null;
  /** The period that factor is about; null when the pool has none. */
  deelnamefactor_periode?: string | null;
}

// Today on a Dutch calendar, not in UTC (lib/localDate.ts, audit 9).
const todayISO = () => localIsoDate();

export default function PoolStaffPage() {
  const params = useParams();
  const router = useRouter();
  const poolId = params.id as string;

  const [pool, setPool] = useState<Pool | null>(null);
  const [poolLoading, setPoolLoading] = useState(true);
  const [poolError, setPoolError] = useState<string | null>(null);

  const [members, setMembers] = useState<StaffMember[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [staffError, setStaffError] = useState<string | null>(null);

  // Until the periods are in: today until the fallback end, never an empty
  // Geldig tot (lib/membershipDefaults.ts).
  const [defaults, setDefaults] = useState<MembershipDefaults>(() => newMembershipDefaults([], poolId, todayISO()));
  const [newMember, setNewMember] = useState({
    codenaam: '',
    geldig_vanaf: defaults.geldig_vanaf,
    geldig_tot: defaults.geldig_tot,
  });
  const [addingMember, setAddingMember] = useState(false);
  // Each error shows where it was made: under Toevoegen, or under the row
  // being edited or removed. They all showed above the list, out of sight
  // under a long one, at the planner's report.
  const [addError, setAddError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ membershipId: string; message: string } | null>(null);
  const addErrorRef = useRef<HTMLDivElement>(null);
  const rowErrorRef = useRef<HTMLDivElement>(null);
  // A change that reaches a period with a roster asks first (lib/membershipRooster.ts).
  const [bevestigVraag, setBevestigVraag] = useState<{ membershipId: string; message: string; actie: 'opslaan' | 'verwijderen' } | null>(null);
  // Scrolled into sight when it appears: with the button at the bottom of
  // the screen, the line under it is just out of view.
  useEffect(() => {
    if (addError) addErrorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [addError]);
  useEffect(() => {
    if (rowError) rowErrorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [rowError]);

  const [editingMembershipId, setEditingMembershipId] = useState<string | null>(null);
  const [editDates, setEditDates] = useState({ geldig_vanaf: '', geldig_tot: '' });
  const [savingMembership, setSavingMembership] = useState(false);
  const [removingMembershipId, setRemovingMembershipId] = useState<string | null>(null);

  // The single most recently removed membership for this pool, read from
  // the server (lib/pendingUndo.ts) - only removals get this, not date
  // edits: a misclick that removes someone is the one mistake here that
  // isn't just as fast to fix by opening the edit form again and typing the
  // old value back in. Only for the acute moment (0.106.0): what was already
  // there when the page opened stays hidden (undoBasis), and what is shown
  // goes away after two minutes, as the server stops accepting it by then.
  const [pendingUndo, setPendingUndo] = useState<{ id: string; label: string; verloopt_over_seconden: number } | null>(null);
  // undefined: not read yet; null: nothing was there when the page opened.
  const undoBasis = useRef<string | null | undefined>(undefined);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  // No GET /api/planner/pools/[id] exists (only PATCH) - the list endpoint
  // already carries naam for every pool, so find this one in it rather
  // than adding a single-pool route for one field.
  useEffect(() => {
    fetch(withBasePath('/api/planner/pools?include_inactive=true'))
      .then((res) => res.json())
      .then((data) => {
        const found = (data.data || []).find((p: Pool) => p.id === poolId);
        if (!found) throw new Error('Pool niet gevonden');
        setPool(found);
        setPoolLoading(false);
      })
      .catch((err) => {
        setPoolError(foutTekst(err, 'Laden van pool mislukt'));
        setPoolLoading(false);
      });
  }, [poolId]);

  const loadStaff = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setStaffLoading(true);
    setStaffError(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/pool/${poolId}/members`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Laden van personeel mislukt');
      setMembers(data.data || []);
    } catch (err) {
      setStaffError(foutTekst(err, 'Laden van personeel mislukt'));
    } finally {
      if (!options?.silent) setStaffLoading(false);
    }
  }, [poolId]);

  const loadPendingUndo = useCallback(async () => {
    try {
      const res = await fetch(withBasePath(`/api/planner/pool/${poolId}/members/pending-undo`));
      const data = await res.json();
      const gelezen = res.ok ? data.data?.pending ?? null : null;
      if (undoBasis.current === undefined) undoBasis.current = gelezen?.id ?? null;
      setPendingUndo(gelezen && gelezen.id !== undoBasis.current ? gelezen : null);
    } catch {
      setPendingUndo(null);
    }
  }, [poolId]);

  // The button goes away when the two minutes are over.
  useEffect(() => {
    if (!pendingUndo) return;
    const timer = setTimeout(() => setPendingUndo(null), pendingUndo.verloopt_over_seconden * 1000);
    return () => clearTimeout(timer);
  }, [pendingUndo]);

  useEffect(() => {
    undoBasis.current = undefined;
    loadStaff();
    loadPendingUndo();
  }, [loadStaff, loadPendingUndo]);

  // The period being rostered gives the new member's dates; a date the
  // planner already changed stays theirs.
  useEffect(() => {
    fetch(withBasePath('/api/periods'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        const next = newMembershipDefaults((data.data || []) as PeriodForDefaults[], poolId, todayISO());
        setNewMember((prev) => {
          const initial = newMembershipDefaults([], poolId, todayISO());
          return {
            ...prev,
            geldig_vanaf: prev.geldig_vanaf === initial.geldig_vanaf ? next.geldig_vanaf : prev.geldig_vanaf,
            geldig_tot: prev.geldig_tot === initial.geldig_tot ? next.geldig_tot : prev.geldig_tot,
          };
        });
        setDefaults(next);
      })
      .catch(() => {
        // Keep today until the fallback end.
      });
  }, [poolId]);

  const handleUndoLast = async () => {
    setUndoing(true);
    setUndoError(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/pool/${poolId}/members/undo-last`), { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Ongedaan maken mislukt');
      await loadStaff({ silent: true });
      await loadPendingUndo();
    } catch (err) {
      setUndoError(foutTekst(err, 'Ongedaan maken mislukt'));
    } finally {
      setUndoing(false);
    }
  };

  const handleAddMember = async () => {
    if (!newMember.codenaam.trim() || !newMember.geldig_vanaf || !newMember.geldig_tot) {
      setAddError('Codenaam, geldig vanaf en geldig tot zijn verplicht');
      return;
    }
    setAddingMember(true);
    setAddError(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/pool/${poolId}/members`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newMember),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Toevoegen mislukt');

      setNewMember({ codenaam: '', geldig_vanaf: defaults.geldig_vanaf, geldig_tot: defaults.geldig_tot });
      await loadStaff({ silent: true });
    } catch (err) {
      setAddError(foutTekst(err, 'Toevoegen mislukt'));
    } finally {
      setAddingMember(false);
    }
  };

  const startEditMembership = (member: StaffMember) => {
    setRowError(null);
    setEditingMembershipId(member.id);
    setEditDates({ geldig_vanaf: member.geldig_vanaf, geldig_tot: member.geldig_tot });
  };

  const handleSaveMembership = async (membershipId: string, bevestigd = false) => {
    setSavingMembership(true);
    setRowError(null);
    setBevestigVraag(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/pool/${poolId}/members/${membershipId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bevestigd ? { ...editDates, bevestigd: true } : editDates),
      });
      const data = await res.json();
      if (res.status === 409 && data.error?.code === 'LIDMAATSCHAP_RAAKT_ROOSTER') {
        setBevestigVraag({ membershipId, message: data.error.message, actie: 'opslaan' });
        return;
      }
      if (!res.ok) throw new Error(data.error?.message || 'Opslaan mislukt');

      setEditingMembershipId(null);
      await loadStaff({ silent: true });
    } catch (err) {
      setRowError({ membershipId, message: foutTekst(err, 'Opslaan mislukt') });
    } finally {
      setSavingMembership(false);
    }
  };

  const handleRemoveMembership = async (membershipId: string, bevestigd = false) => {
    if (removingMembershipId !== membershipId && !bevestigd) {
      // First click arms the confirmation instead of deleting immediately.
      setRemovingMembershipId(membershipId);
      return;
    }
    setRowError(null);
    setBevestigVraag(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/pool/${poolId}/members/${membershipId}${bevestigd ? '?bevestigd=1' : ''}`), {
        method: 'DELETE',
      });
      const data = await res.json();
      if (res.status === 409 && data.error?.code === 'LIDMAATSCHAP_RAAKT_ROOSTER') {
        setBevestigVraag({ membershipId, message: data.error.message, actie: 'verwijderen' });
        return;
      }
      if (!res.ok) throw new Error(data.error?.message || 'Verwijderen mislukt');

      await loadStaff({ silent: true });
      await loadPendingUndo();
    } catch (err) {
      setRowError({ membershipId, message: foutTekst(err, 'Verwijderen mislukt') });
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
        {/* Browser-history back, not a fixed destination - this page is
            reached from several places (the period dashboard's "Personeel
            beheren" section, possibly a direct link), so "terug naar
            periodes" was often simply wrong about where "back" should go. */}
        <button onClick={() => router.back()} className="text-sm text-blue-700 hover:underline">
          ← Vorige
        </button>
        <h1 className="text-2xl font-bold text-neutral-900 mt-2 mb-1">Personeel beheren</h1>
        <p className="text-neutral-600">{pool.naam}</p>
      </div>

      {pendingUndo && (
        <div className="card p-4 bg-blue-50 border border-blue-200 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-blue-900">
            <span className="font-medium">Laatst gewijzigd:</span> {pendingUndo.label}
          </p>
          <button
            onClick={handleUndoLast}
            disabled={undoing}
            className="shrink-0 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {undoing ? 'Bezig…' : '↩️ Ongedaan maken'}
          </button>
        </div>
      )}
      {undoError && (
        <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-800">{undoError}</div>
      )}

      <div className="card card-padding space-y-4">
        <p className="text-sm text-neutral-600">
          Wijzigingen hier gelden voor de hele pool en direct voor elke nieuwe periode die je
          opent, los van welke periode nog loopt. &quot;Actief&quot; betekent actief vandaag.
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
                  <th className="relative px-4 py-2 text-left text-sm font-medium"><span className="sr-only">Acties</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((member) => {
                  const isEditing = editingMembershipId === member.id;
                  const error = rowError?.membershipId === member.id ? rowError.message : null;
                  return (
                    <Fragment key={member.id}>
                      <tr className="hover:bg-neutral-50">
                        <td className="px-4 py-2 text-sm font-medium">{member.codenaam}</td>
                        <td className="px-4 py-2 text-sm">
                          <span className={member.is_active ? 'text-green-600 font-medium' : 'text-neutral-500'}>
                            {member.is_active ? 'Actief' : member.geldig_vanaf > todayISO() ? 'Begint later' : 'Gestopt'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-sm">
                          {isEditing ? (
                            <input
                              type="date"
                              aria-label={`Geldig vanaf voor ${member.codenaam}`}
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
                              aria-label={`Geldig tot voor ${member.codenaam}`}
                              value={editDates.geldig_tot}
                              onChange={(e) => setEditDates({ ...editDates, geldig_tot: e.target.value })}
                              className="px-2 py-1 border rounded text-sm w-36"
                            />
                          ) : (
                            member.geldig_tot
                          )}
                        </td>
                        <td className="px-4 py-2 text-sm" data-testid="deelnamefactor">
                          {/* Worked out from their own part-time days; unknown until they handed in. */}
                          {member.deelnamefactor === null ? (
                            <span className="text-neutral-500">nog onbekend</span>
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
                                onClick={() => {
                                  setEditingMembershipId(null);
                                  setRowError(null);
                                }}
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
                      {bevestigVraag?.membershipId === member.id && (
                        <tr>
                          <td colSpan={6} className="px-4 pb-3">
                            <div role="alert" data-testid="rooster-bevestiging" className="bg-amber-50 border border-amber-300 rounded p-3 text-sm text-amber-900 space-y-2">
                              <p>{bevestigVraag.message}</p>
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    bevestigVraag.actie === 'opslaan'
                                      ? handleSaveMembership(member.id, true)
                                      : handleRemoveMembership(member.id, true)
                                  }
                                  className="px-3 py-1 rounded bg-amber-700 text-white hover:bg-amber-800"
                                >
                                  Toch doorgaan
                                </button>
                                <button type="button" onClick={() => setBevestigVraag(null)} className="px-3 py-1 rounded border border-neutral-300 hover:bg-neutral-50">
                                  Annuleren
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      {error && (
                        <tr>
                          <td colSpan={6} className="px-4 pb-3">
                            <div ref={rowErrorRef} role="alert" data-testid="rij-fout" className="bg-red-50 border border-red-200 rounded p-2 text-sm text-red-700">
                              {error}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
          <p className="text-xs text-neutral-600" data-testid="deelnamefactor-uitleg">
            De deelnamefactor typ je niet in. Die volgt uit de parttimedagen die de medewerker zelf opgeeft. Hij staat in de lijst
            zodra die de voorkeuren heeft ingediend. Tot dan staat er nog onbekend.
            {members.find((m) => m.deelnamefactor_periode)?.deelnamefactor_periode && (
              <span data-testid="deelnamefactor-periode">
                {' '}
                De factor in de lijst hoort bij de periode {members.find((m) => m.deelnamefactor_periode)!.deelnamefactor_periode}.
              </span>
            )}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label htmlFor="nieuw-lid-codenaam" className="block text-xs font-medium text-neutral-600 mb-1">Codenaam</label>
              <input
                id="nieuw-lid-codenaam"
                type="text"
                value={newMember.codenaam}
                onChange={(e) => setNewMember({ ...newMember, codenaam: e.target.value })}
                // The codenamen of the pool's dienst (lib/startParticipants.ts).
                placeholder={pool?.type === 'AIOS' ? 'bijv. aios01' : 'bijv. staf31'}
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
            <div>
              <label htmlFor="nieuw-lid-vanaf" className="block text-xs font-medium text-neutral-600 mb-1">Geldig vanaf</label>
              <input
                id="nieuw-lid-vanaf"
                type="date"
                value={newMember.geldig_vanaf}
                onChange={(e) => setNewMember({ ...newMember, geldig_vanaf: e.target.value })}
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
            <div>
              <label htmlFor="nieuw-lid-tot" className="block text-xs font-medium text-neutral-600 mb-1">Geldig tot</label>
              <input
                id="nieuw-lid-tot"
                type="date"
                value={newMember.geldig_tot}
                onChange={(e) => setNewMember({ ...newMember, geldig_tot: e.target.value })}
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
          {addError && (
            <div ref={addErrorRef} role="alert" data-testid="toevoegen-fout" className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
              {addError}
            </div>
          )}
          <p className="text-xs text-neutral-600" data-testid="geldig-uitleg">
            {defaults.periode
              ? `Geldig vanaf en Geldig tot staan op de periode ${defaults.periode}. Doet deze persoon daarna ook mee? Zet Geldig tot dan later.`
              : 'Geldig vanaf staat op vandaag en Geldig tot op 31 december 2029.'}
          </p>
          <p className="text-xs text-neutral-500">
            Bestaat de codenaam al (bijv. iemand die eerder in een andere pool zat), dan wordt die
            persoon hergebruikt in plaats van dubbel aangemaakt.
          </p>
        </div>
      </div>
    </div>
  );
}
