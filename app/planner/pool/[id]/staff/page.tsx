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
import { codenaamReeks } from '@/lib/codenaamReeks';

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

  // Several at once (0.901.0): the memberships ticked in the list get the same new dates (lib/poolLeden.ts).
  const [selectie, setSelectie] = useState<Set<string>>(new Set());
  const [groepDatums, setGroepDatums] = useState({ geldig_vanaf: '', geldig_tot: '' });
  const [groepBezig, setGroepBezig] = useState(false);
  const [groepFout, setGroepFout] = useState<string | null>(null);
  const [groepVraag, setGroepVraag] = useState<string | null>(null);
  const [groepMelding, setGroepMelding] = useState<string | null>(null);

  // A reeks of codenamen at once (lib/codenaamReeks.ts), with the same dates as one new member.
  const [reeks, setReeks] = useState({ van: '', tot: '' });
  const [reeksBezig, setReeksBezig] = useState(false);
  const [reeksFout, setReeksFout] = useState<string | null>(null);
  const [reeksUitkomst, setReeksUitkomst] = useState<{ toegevoegd: string[]; overgeslagen: Array<{ codenaam: string; reden: string }> } | null>(null);

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

  const handleReeks = async () => {
    setReeksBezig(true);
    setReeksFout(null);
    setReeksUitkomst(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/pool/${poolId}/members/reeks`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...reeks, geldig_vanaf: newMember.geldig_vanaf, geldig_tot: newMember.geldig_tot }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Toevoegen mislukt');
      setReeksUitkomst(data.data);
      if (data.data.toegevoegd.length > 0) setReeks({ van: '', tot: '' });
      await loadStaff({ silent: true });
    } catch (err) {
      setReeksFout(foutTekst(err, 'Toevoegen mislukt'));
    } finally {
      setReeksBezig(false);
    }
  };

  const wisselSelectie = (id: string) =>
    setSelectie((oud) => {
      const nieuw = new Set(oud);
      if (nieuw.has(id)) nieuw.delete(id);
      else nieuw.add(id);
      return nieuw;
    });

  const handleGroep = async (bevestigd = false) => {
    setGroepBezig(true);
    setGroepFout(null);
    setGroepVraag(null);
    setGroepMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/pool/${poolId}/members/selectie`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectie], ...groepDatums, ...(bevestigd ? { bevestigd: true } : {}) }),
      });
      const data = await res.json();
      if (res.status === 409 && data.error?.code === 'LIDMAATSCHAP_RAAKT_ROOSTER') {
        setGroepVraag(data.error.message);
        return;
      }
      if (!res.ok) throw new Error(data.error?.message || 'Opslaan mislukt');
      const n = data.data.gewijzigd as number;
      setGroepMelding(n === 1 ? '1 lidmaatschap gewijzigd.' : `${n} lidmaatschappen gewijzigd.`);
      setSelectie(new Set());
      setGroepDatums({ geldig_vanaf: '', geldig_tot: '' });
      await loadStaff({ silent: true });
    } catch (err) {
      setGroepFout(foutTekst(err, 'Opslaan mislukt'));
    } finally {
      setGroepBezig(false);
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

        {groepMelding && (
          <div role="status" className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-900">{groepMelding}</div>
        )}
        {selectie.size > 0 && (
          <div className="border border-blue-200 bg-blue-50 rounded p-3 space-y-3" data-testid="selectie-balk">
            <p className="text-sm font-medium text-blue-900">
              {selectie.size === 1 ? '1 persoon geselecteerd' : `${selectie.size} personen geselecteerd`}. Vul in wat je voor
              allemaal wilt veranderen. Wat je leeg laat, blijft per persoon zoals het is.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div>
                <label htmlFor="groep-vanaf" className="block text-xs font-medium text-neutral-700 mb-1">Nieuwe Geldig vanaf</label>
                <input
                  id="groep-vanaf"
                  type="date"
                  value={groepDatums.geldig_vanaf}
                  onChange={(e) => setGroepDatums({ ...groepDatums, geldig_vanaf: e.target.value })}
                  className="w-full px-2 py-2 border rounded text-sm"
                />
              </div>
              <div>
                <label htmlFor="groep-tot" className="block text-xs font-medium text-neutral-700 mb-1">Nieuwe Geldig tot</label>
                <input
                  id="groep-tot"
                  type="date"
                  value={groepDatums.geldig_tot}
                  onChange={(e) => setGroepDatums({ ...groepDatums, geldig_tot: e.target.value })}
                  className="w-full px-2 py-2 border rounded text-sm"
                />
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => handleGroep()}
                  disabled={groepBezig || (!groepDatums.geldig_vanaf && !groepDatums.geldig_tot)}
                  className="w-full px-3 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
                >
                  {groepBezig ? 'Bezig…' : 'Toepassen op selectie'}
                </button>
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => {
                    setSelectie(new Set());
                    setGroepFout(null);
                    setGroepVraag(null);
                  }}
                  className="w-full px-3 py-2 rounded text-sm font-medium border border-neutral-300 bg-white hover:bg-neutral-50"
                >
                  Selectie wissen
                </button>
              </div>
            </div>
            {groepVraag && (
              <div role="alert" className="bg-amber-50 border border-amber-300 rounded p-3 text-sm text-amber-900 space-y-2">
                <p>{groepVraag}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => handleGroep(true)} className="px-3 py-1 rounded bg-amber-700 text-white hover:bg-amber-800">
                    Toch doorgaan
                  </button>
                  <button type="button" onClick={() => setGroepVraag(null)} className="px-3 py-1 rounded border border-neutral-300 hover:bg-neutral-50">
                    Annuleren
                  </button>
                </div>
              </div>
            )}
            {groepFout && (
              <div role="alert" className="bg-red-50 border border-red-200 rounded p-2 text-sm text-red-700">{groepFout}</div>
            )}
          </div>
        )}

        {staffLoading ? (
          <div className="border rounded p-4 text-sm text-neutral-600 text-center">Personeel laden...</div>
        ) : (
          <div className="border rounded overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-100">
                <tr>
                  <th className="pl-4 py-2 text-left text-sm font-medium w-8">
                    <input
                      type="checkbox"
                      aria-label="Iedereen selecteren"
                      checked={members.length > 0 && selectie.size === members.length}
                      onChange={(e) => setSelectie(e.target.checked ? new Set(members.map((m) => m.id)) : new Set())}
                      className="h-4 w-4"
                    />
                  </th>
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
                      <tr className={selectie.has(member.id) ? 'bg-blue-50' : 'hover:bg-neutral-50'}>
                        <td className="pl-4 py-2">
                          <input
                            type="checkbox"
                            aria-label={`${member.codenaam} selecteren`}
                            checked={selectie.has(member.id)}
                            onChange={() => wisselSelectie(member.id)}
                            className="h-4 w-4"
                          />
                        </td>
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
                          <td colSpan={7} className="px-4 pb-3">
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
                          <td colSpan={7} className="px-4 pb-3">
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
                    <td colSpan={7} className="px-4 py-6 text-center text-sm text-neutral-500">
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
              ? `Geldig vanaf staat op het begin van de periode ${defaults.periode}. Geldig tot staat op 31 december 2099: deze persoon doet mee tot je een einddatum zet.`
              : 'Geldig vanaf staat op vandaag. Geldig tot staat op 31 december 2099: deze persoon doet mee tot je een einddatum zet.'}
          </p>
          <p className="text-xs text-neutral-500">
            Bestaat de codenaam al (bijv. iemand die eerder in een andere pool zat), dan wordt die
            persoon hergebruikt in plaats van dubbel aangemaakt.
          </p>

          <div className="border-t border-neutral-200 pt-4 space-y-3" data-testid="reeks">
            <p className="text-sm font-medium text-neutral-800">Een reeks toevoegen</p>
            <p className="text-xs text-neutral-600">
              Meerdere mensen tegelijk, met de Geldig vanaf en Geldig tot van hierboven. Wie al in de pool staat, wordt overgeslagen.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="reeks-van" className="block text-xs font-medium text-neutral-600 mb-1">Van codenaam</label>
                <input
                  id="reeks-van"
                  type="text"
                  value={reeks.van}
                  onChange={(e) => setReeks({ ...reeks, van: e.target.value })}
                  placeholder={pool?.type === 'AIOS' ? 'bijv. aios01' : 'bijv. staf31'}
                  className="w-full px-2 py-2 border rounded text-sm"
                />
              </div>
              <div>
                <label htmlFor="reeks-tot" className="block text-xs font-medium text-neutral-600 mb-1">Tot en met codenaam</label>
                <input
                  id="reeks-tot"
                  type="text"
                  value={reeks.tot}
                  onChange={(e) => setReeks({ ...reeks, tot: e.target.value })}
                  placeholder={pool?.type === 'AIOS' ? 'bijv. aios30' : 'bijv. staf40'}
                  className="w-full px-2 py-2 border rounded text-sm"
                />
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleReeks}
                  disabled={reeksBezig || !reeks.van.trim() || !reeks.tot.trim() || !codenaamReeks(reeks.van, reeks.tot).ok}
                  className="w-full px-3 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
                >
                  {reeksBezig ? 'Bezig…' : 'Reeks toevoegen'}
                </button>
              </div>
            </div>
            {reeks.van.trim() && reeks.tot.trim() && (() => {
              const r = codenaamReeks(reeks.van, reeks.tot);
              if (!r.ok) return <p className="text-xs text-red-700" data-testid="reeks-voorbeeld">{r.message}</p>;
              const n = r.codenamen.length;
              const voorbeeld = n <= 4 ? r.codenamen.join(', ') : `${r.codenamen.slice(0, 2).join(', ')} … ${r.codenamen.slice(-2).join(', ')}`;
              return (
                <p className="text-xs text-neutral-700" data-testid="reeks-voorbeeld">
                  {n === 1 ? '1 codenaam' : `${n} codenamen`}: {voorbeeld}, van {newMember.geldig_vanaf} tot {newMember.geldig_tot}.
                </p>
              );
            })()}
            {reeksFout && (
              <div role="alert" className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{reeksFout}</div>
            )}
            {reeksUitkomst && (
              <div role="status" data-testid="reeks-uitkomst" className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-900 space-y-1">
                <p>
                  {reeksUitkomst.toegevoegd.length === 1 ? '1 persoon toegevoegd' : `${reeksUitkomst.toegevoegd.length} personen toegevoegd`}.
                </p>
                {reeksUitkomst.overgeslagen.length > 0 && (
                  <>
                    <p>Overgeslagen:</p>
                    <ul className="list-disc pl-5">
                      {reeksUitkomst.overgeslagen.map((o) => (
                        <li key={o.codenaam}>
                          {o.codenaam}: {o.reden}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
