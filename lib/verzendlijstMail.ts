/**
 * Sends the verzendlijst (lib/verzendlijst.ts) to the planner's own
 * mailbox over SMTP, so the Power Automate flow starts without the
 * planner having to download a file and attach it by hand.
 *
 * Configured in the app only ("Mailinstellingen" under Exporteren &
 * communicatie, lib/appSettings.ts): a Gmail account, its app password
 * and the mailbox the flow watches. The server is smtp.gmail.com:465;
 * SMTP_HOST/SMTP_PORT exist only so the tests can point it at their own
 * server (tests/smtpSink.ts).
 *
 * The recipient is fixed by the operator, never taken from a request: this
 * can only ever mail the planner's own flow mailbox, not arbitrary people.
 */

import nodemailer from 'nodemailer';
import { db } from '@/db/client';
import { clearMailFailure, getMailFailure, getStoredMailSettings, recordMailFailure, type MailFailure } from './appSettings';
import { VERZENDLIJST_SUBJECT, verzendlijstFilename, verzendlijstJson, type Verzendlijst } from './verzendlijst';

interface MailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
}

/** Gmail, unless SMTP_HOST/SMTP_PORT say otherwise (only the tests do). */
function server(): { host: string; port: number } {
  const port = parseInt(process.env.SMTP_PORT ?? '', 10);
  return { host: process.env.SMTP_HOST?.trim() || 'smtp.gmail.com', port: Number.isFinite(port) ? port : 465 };
}

// Google shows an app password as four groups of four ("abcd efgh ...");
// pasted as shown, the spaces would make the login fail.
const stripSpaces = (pass: string) => pass.replace(/\s+/g, '');

/**
 * MAIL_UITGESCHAKELD=true in .env: nothing is ever sent, whatever
 * Mailinstellingen says. For a test installation that runs on a copy of
 * production's data - mail settings included - which would otherwise send
 * real invitations, reminders and swap mails to real people, the automatic
 * reminders within a minute of starting.
 */
export function mailSwitchedOff(): boolean {
  return process.env.MAIL_UITGESCHAKELD === 'true';
}

/** The settings saved in the app ("Mailinstellingen", lib/appSettings.ts), or null. */
function readConfig(): MailConfig | null {
  if (mailSwitchedOff()) return null;
  const stored = getStoredMailSettings();
  if (!stored?.wachtwoord) return null;
  return {
    ...server(),
    user: stored.gebruiker,
    pass: stripSpaces(stored.wachtwoord),
    from: stored.gebruiker,
    to: stored.verzendlijstAan,
  };
}

/** Whether sending is set up, for the settings dialog and the warning on the period page. */
export function mailConfigStatus(): {
  ingesteld: boolean;
  /** MAIL_UITGESCHAKELD: a test installation that never sends. */
  uitgeschakeld: boolean;
  gebruiker: string | null;
  verzendlijst_aan: string | null;
  /** Saved, but the password can no longer be read (new session secret). */
  wachtwoord_onleesbaar: boolean;
  /** The last failed send, until one succeeds again. */
  laatste_fout: MailFailure | null;
  /** Swap mails waiting to go out (lib/meldingMail.ts flushMailQueue). */
  wachtrij: number;
} {
  // Counted here rather than imported from lib/meldingMail.ts, which
  // imports this module.
  const wachtrij = (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_mail_queue').get() as { n: number }).n;
  const stored = getStoredMailSettings();
  return {
    ingesteld: Boolean(stored?.wachtwoord) && !mailSwitchedOff(),
    uitgeschakeld: mailSwitchedOff(),
    gebruiker: stored?.gebruiker ?? null,
    verzendlijst_aan: stored?.verzendlijstAan ?? null,
    wachtwoord_onleesbaar: Boolean(stored && !stored.wachtwoord),
    laatste_fout: getMailFailure(),
    wachtrij,
  };
}

export function verzendlijstMailConfigured(): boolean {
  return readConfig() !== null;
}

export type VerzendlijstMailResult = { ok: true; aantal: number } | { ok: false; message: string };

/**
 * A Dutch explanation of why sending failed, for the planner. The SMTP
 * server's own reply stays in the server log: it can echo the account name.
 */
function explainSmtpError(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === 'EAUTH') {
    return (
      'Gmail weigerde de inlog. Controleer het Gmail-adres en het app-wachtwoord bij Mailinstellingen. ' +
      'Het moet een app-wachtwoord zijn, niet je gewone wachtwoord.'
    );
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'EDNS') {
    return 'Gmail is niet bereikbaar. Controleer of de server verbinding heeft met internet.';
  }
  if (code === 'ETLS') {
    return 'Er kon geen versleutelde verbinding met de mailserver gemaakt worden, dus het wachtwoord is niet verstuurd.';
  }
  if (code === 'EENVELOPE') {
    return 'Gmail weigerde het adres. Controleer het adres voor de verzendlijst bij Mailinstellingen.';
  }
  return 'Versturen via Gmail is mislukt.';
}

function createTransport(config: Pick<MailConfig, 'host' | 'port' | 'user' | 'pass'>) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 speaks TLS from the first byte; 587/25 start plain and upgrade.
    // That upgrade is required, not optional: a server that doesn't offer
    // STARTTLS would otherwise get the password in plain text.
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

/**
 * Logs in with these credentials without sending anything, so settings
 * that don't work are refused before they are saved.
 */
export async function verifyMailLogin(user: string, pass: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const transport = createTransport({ ...server(), user, pass: stripSpaces(pass) });
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    console.error('[verzendlijst-mail] login check failed', error);
    return { ok: false, message: explainSmtpError(error) };
  } finally {
    transport.close();
  }
}

/** One mail to the flow's mailbox with a single JSON attachment. */
async function sendJsonMail(mail: {
  subject: string;
  text: string;
  filename: string;
  json: string;
}): Promise<{ ok: true } | { ok: false; message: string; notConfigured?: true }> {
  const config = readConfig();
  if (!config) {
    return {
      ok: false,
      message: mailSwitchedOff()
        ? 'Versturen staat uit op deze installatie (MAIL_UITGESCHAKELD).'
        : 'Automatisch versturen is nog niet ingesteld. Dat doe je bij Mailinstellingen.',
      notConfigured: true,
    };
  }

  const transport = createTransport(config);

  try {
    await transport.sendMail({
      from: config.from,
      to: config.to,
      subject: mail.subject,
      text: mail.text,
      attachments: [{ filename: mail.filename, content: mail.json, contentType: 'application/json' }],
    });
    return { ok: true };
  } catch (error) {
    console.error(`[verzendlijst-mail] ${mail.subject} failed`, error);
    return { ok: false, message: explainSmtpError(error) };
  } finally {
    transport.close();
  }
}

export async function sendVerzendlijst(lijst: Verzendlijst): Promise<VerzendlijstMailResult> {
  const result = await sendJsonMail({
    subject: VERZENDLIJST_SUBJECT,
    text:
      `Verzendlijst voor ${lijst.periode}: ${lijst.aantal} berichten in de bijlage.\n` +
      'Deze mail is automatisch verstuurd door Dienstrooster voor de Power Automate-stroom.',
    filename: verzendlijstFilename(lijst.periode),
    json: verzendlijstJson(lijst),
  });
  // Remembered for the warning on the period page (lib/appSettings.ts):
  // automatic reminders and swap mails fail where nobody is watching.
  // "Not set up" is not a failure to remember - the page says that itself.
  if (result.ok) {
    clearMailFailure();
    // Sending works (again): swap mails that waited go now rather than at
    // the next hourly run. Imported when needed: lib/meldingMail.ts
    // imports this module.
    void import('./meldingMail').then((m) => m.flushAfterSend()).catch(() => {});
    return { ok: true, aantal: lijst.aantal };
  }
  if (!result.notConfigured) {
    recordMailFailure({
      op: new Date().toISOString(),
      melding: result.message,
      soort: lijst.soort,
      automatisch: lijst.automatisch,
    });
  }
  return { ok: false, message: result.message };
}
