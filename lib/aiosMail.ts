/**
 * The AIOS's mail: the verzendlijst (lib/verzendlijst.ts, the contract
 * with the flow, used as it is) to the AIOS's own Power Automate flow
 * (docs/aios-rooster.md, "Mail").
 *
 * A copy of the sending in lib/verzendlijstMail.ts, not a change to it:
 * the achterwacht's mail code stays as it is (docs/development/diensten.md,
 * "Copied, not changed"). Shared with the achterwacht is only the Gmail
 * account the beheerder set in Mailinstellingen (read with
 * getStoredMailSettings, unchanged); the AIOS's flow mailbox, and the last
 * failure, are kept under keys of their own. The swap queue and
 * MAIL_UITGESCHAKELD work as for the achterwacht: MAIL_UITGESCHAKELD stops
 * this too.
 */

import nodemailer from 'nodemailer';
import { db } from '@/db/client';
import { getStoredMailSettings } from './appSettings';
import { VERZENDLIJST_SUBJECT, verzendlijstFilename, verzendlijstJson, type Verzendlijst } from './aiosVerzendlijst';

const AAN = 'aios.mail.verzendlijst_aan';
const LAATSTE_FOUT = 'aios.mail.laatste_fout';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function get(sleutel: string): string | undefined {
  return (
    db.prepare('SELECT waarde FROM dienstrooster_app_setting WHERE sleutel = ?').get(sleutel) as
      | { waarde: string }
      | undefined
  )?.waarde;
}

function zet(sleutel: string, waarde: string, actorId: string | null): void {
  db.prepare(
    `INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde, gewijzigd_op = excluded.gewijzigd_op,
       gewijzigd_door = excluded.gewijzigd_door`
  ).run(sleutel, waarde, new Date().toISOString(), actorId);
}

/** The mailbox the AIOS's flow watches, or null. Also the address in the AIOS's swap dialog later on. */
export function aiosStroomAdres(): string | null {
  return get(AAN) ?? null;
}

export type AdresUitkomst = { ok: true } | { ok: false; message: string };

/** Saves (or with an empty value removes) the AIOS's flow mailbox. */
export function bewaarAiosStroomAdres(adres: string, actorId: string): AdresUitkomst {
  const schoon = adres.trim();
  if (schoon === '') {
    db.prepare('DELETE FROM dienstrooster_app_setting WHERE sleutel IN (?, ?)').run(AAN, LAATSTE_FOUT);
    return { ok: true };
  }
  if (schoon.length > 254 || !EMAIL.test(schoon)) {
    return { ok: false, message: 'Het adres voor de verzendlijst van de AIOS is geen geldig e-mailadres.' };
  }
  db.transaction(() => {
    zet(AAN, schoon, actorId);
    // A new address: an earlier failure says nothing about it any more.
    db.prepare('DELETE FROM dienstrooster_app_setting WHERE sleutel = ?').run(LAATSTE_FOUT);
  })();
  return { ok: true };
}

export interface AiosMailFout {
  op: string;
  melding: string;
  soort: string;
}

export function aiosMailFout(): AiosMailFout | null {
  const raw = get(LAATSTE_FOUT);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AiosMailFout;
  } catch {
    return null;
  }
}

const uitgeschakeld = () => process.env.MAIL_UITGESCHAKELD === 'true';

interface MailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  to: string;
}

/** Gmail, unless SMTP_HOST/SMTP_PORT say otherwise (only the tests do). */
function server(): { host: string; port: number } {
  const port = parseInt(process.env.SMTP_PORT ?? '', 10);
  return { host: process.env.SMTP_HOST?.trim() || 'smtp.gmail.com', port: Number.isFinite(port) ? port : 465 };
}

/** The shared account and the AIOS's own flow mailbox, or null when either is missing. */
function readConfig(): MailConfig | null {
  if (uitgeschakeld()) return null;
  const account = getStoredMailSettings();
  const to = aiosStroomAdres();
  if (!account?.wachtwoord || !to) return null;
  return { ...server(), user: account.gebruiker, pass: account.wachtwoord.replace(/\s+/g, ''), to };
}

/** What the AIOS's page shows about their mail. */
export function aiosMailStatus(): {
  ingesteld: boolean;
  /** The Gmail account of Mailinstellingen is there. */
  account: boolean;
  uitgeschakeld: boolean;
  verzendlijst_aan: string | null;
  laatste_fout: AiosMailFout | null;
} {
  const account = getStoredMailSettings();
  return {
    ingesteld: readConfig() !== null,
    account: Boolean(account?.wachtwoord),
    uitgeschakeld: uitgeschakeld(),
    verzendlijst_aan: aiosStroomAdres(),
    laatste_fout: aiosMailFout(),
  };
}

export function aiosMailIngesteld(): boolean {
  return readConfig() !== null;
}

function uitleg(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === 'EAUTH') {
    return 'Gmail weigerde de inlog. Controleer het Gmail-account bij Mailinstellingen. Dat doet de beheerder.';
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'EDNS') {
    return 'Gmail is niet bereikbaar. Controleer of de server verbinding heeft met internet.';
  }
  if (code === 'ETLS') {
    return 'Er kon geen versleutelde verbinding met de mailserver gemaakt worden, dus het wachtwoord is niet verstuurd.';
  }
  if (code === 'EENVELOPE') {
    return 'Gmail weigerde het adres van de stroom voor de AIOS. Controleer het bij de mailinstellingen van de AIOS.';
  }
  return 'Versturen via Gmail is mislukt.';
}

export type AiosMailUitkomst = { ok: true; aantal: number } | { ok: false; message: string; nietIngesteld?: true };

/** Sends one verzendlijst to the AIOS's flow. */
export async function verstuurAiosVerzendlijst(lijst: Verzendlijst): Promise<AiosMailUitkomst> {
  const config = readConfig();
  if (!config) {
    return {
      ok: false,
      nietIngesteld: true,
      message: uitgeschakeld()
        ? 'Versturen staat uit op deze installatie (MAIL_UITGESCHAKELD).'
        : 'De mail voor de AIOS is nog niet ingesteld. Daarvoor zijn het Gmail-account bij Mailinstellingen en het adres van de stroom voor de AIOS nodig.',
    };
  }
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 speaks TLS from the first byte; 587/25 must upgrade, never plain.
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({
      from: config.user,
      to: config.to,
      subject: VERZENDLIJST_SUBJECT,
      text:
        (lijst.soort === 'LINK_AANVRAAG'
          ? 'Iemand vroeg op de startpagina een persoonlijke link aan. Adres en berichten staan in de bijlage.\n'
          : `Verzendlijst voor ${lijst.periode}: ${lijst.aantal} berichten in de bijlage.\n`) +
        'Deze mail is automatisch verstuurd door Dienstrooster voor de Power Automate-stroom van de AIOS.',
      attachments: [
        { filename: verzendlijstFilename(lijst.periode), content: verzendlijstJson(lijst), contentType: 'application/json' },
      ],
    });
    db.prepare('DELETE FROM dienstrooster_app_setting WHERE sleutel = ?').run(LAATSTE_FOUT);
    return { ok: true, aantal: lijst.aantal };
  } catch (error) {
    console.error(`[aios-mail] ${lijst.soort} failed`, error);
    const message = uitleg(error);
    zet(LAATSTE_FOUT, JSON.stringify({ op: new Date().toISOString(), melding: message, soort: lijst.soort }), null);
    return { ok: false, message };
  } finally {
    transport.close();
  }
}
