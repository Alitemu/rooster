/**
 * "Exporteren & communicatie" on the AIOS period page: the same buttons, in
 * the same order and at the same place on the page (after "Status
 * voorkeuren", before the roster) as the achterwacht's section of that name
 * (components/PlannerDashboard.tsx), on the AIOS's own routes. A copy, not
 * shared with it (docs/development/diensten.md, "Copied, not changed").
 *
 * The beheerder alone sets the mail up and imports; everyone who plans sees
 * how the mail stands.
 */

'use client';

import { useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { AiosSectie } from '@/components/AiosSectie';
import { AiosAutoHerinneringen } from '@/components/AiosAutoHerinneringen';
import { AiosExportDialog, type AiosExportType } from '@/components/AiosExportDialog';
import { AiosMailPaneel } from '@/components/AiosMailPaneel';
import { AiosVoorkeurenImportButton } from '@/components/AiosVoorkeurenImport';

interface Props {
  period: { id: string; naam: string; deadline: string; status: string };
  stand: { uitgenodigd_op: string | null; mail_ingesteld: boolean; aantal_deelnemers: number } | null;
  onChanged: () => void;
}

const GEEN_MAIL = 'De mail voor de AIOS is nog niet ingesteld. Dat doet de beheerder. Downloaden kan wel.';
const KNOP = 'px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors';

export function AiosExporteren({ period, stand, onChanged }: Props) {
  const [beheerder, setBeheerder] = useState(false);
  const [dialoog, setDialoog] = useState<{ open: boolean; type: AiosExportType }>({ open: false, type: null });
  const [mailOpen, setMailOpen] = useState(false);
  // Counted from the mail panel's changes and a closing dialog: the buttons below follow them.
  const [sleutel, setSleutel] = useState(0);

  useEffect(() => {
    fetch(withBasePath('/api/auth/me'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setBeheerder(data?.data?.role === 'ADMIN'))
      .catch(() => setBeheerder(false));
  }, []);

  const mailIngesteld = stand?.mail_ingesteld;
  const heeftRooster = period.status === 'GEGENEREERD' || period.status === 'GEPUBLICEERD';
  const link = (pad: string) => withBasePath(`/api/aios/periode/${period.id}/${pad}`);

  return (
    <AiosSectie
      sleutel="export"
      titel="Exporteren & communicatie"
      hint={`uitnodigingen, herinneringen, statusrapport, voorkeurenoverzicht, ${beheerder ? 'mailinstellingen' : 'mail'}`}
      testId="aios-exporteren"
    >
      <div className="flex gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setDialoog({ open: true, type: null })}
          className="px-4 py-2 rounded font-medium bg-green-700 text-white hover:bg-green-800 transition-colors"
        >
          📧 Uitnodigingen en herinneringen
        </button>
        {/* A reminder only makes sense while the period is open for hand-in. */}
        {period.status === 'OPEN' && (
          <button
            type="button"
            onClick={() => setDialoog({ open: true, type: 'reminders' })}
            disabled={mailIngesteld === false}
            title={mailIngesteld === false ? GEEN_MAIL : undefined}
            className={`${KNOP} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            📧 Deadlineherinnering versturen
          </button>
        )}
        {beheerder && (
          <button type="button" onClick={() => setMailOpen((o) => !o)} aria-expanded={mailOpen} className={KNOP}>
            ⚙️ Mailinstellingen
          </button>
        )}
        <a href={link('download-verzoeken')} className={KNOP}>
          📋 Statusrapport downloaden
        </a>
        <a href={link('download-voorkeuren')} className={KNOP}>
          🗓️ Voorkeurenoverzicht downloaden (Excel)
        </a>
        <AiosVoorkeurenImportButton periodId={period.id} periodStatus={period.status} onImported={() => { setSleutel((k) => k + 1); onChanged(); }} />
        {/* Only meaningful once there is a roster. */}
        {heeftRooster && (
          <a href={link('download-rooster')} className={KNOP}>
            📅 Rooster downloaden (Excel)
          </a>
        )}
      </div>
      {stand && !stand.mail_ingesteld && (
        <p className="text-sm text-amber-900" data-testid="aios-mail-nog-niet">
          Uitnodigingen en herinneringen versturen kan pas als de mail voor de AIOS is ingesteld. Dat doet de beheerder. Tot die tijd
          kun je met Uitnodigingen downloaden de persoonlijke links zelf rondsturen.
        </p>
      )}
      {/* The beheerder opens the settings; a planner sees how the mail stands. */}
      {(mailOpen || !beheerder) && <AiosMailPaneel beheerder={beheerder} onChanged={onChanged} />}
      <AiosAutoHerinneringen
        periodId={period.id}
        refreshKey={`${period.deadline}|${period.status}|${stand?.uitgenodigd_op}|${stand?.mail_ingesteld}|${sleutel}`}
      />
      <AiosExportDialog
        periodId={period.id}
        periodName={period.naam}
        deadline={period.deadline}
        periodStatus={period.status}
        isOpen={dialoog.open}
        initialType={dialoog.type}
        onClose={() => {
          setDialoog({ open: false, type: null });
          setSleutel((k) => k + 1);
          onChanged();
        }}
        onDeadlineChanged={onChanged}
      />
    </AiosSectie>
  );
}
