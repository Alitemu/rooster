/**
 * Sends the verzendlijst (lib/verzendlijst.ts) to the planner's own
 * mailbox over SMTP, so the Power Automate flow starts without the
 * planner having to download a file and attach it by hand.
 *
 * Configured in the app ("Mailinstellingen" under Exporteren &
 * communicatie, lib/appSettings.ts): a Gmail account, its app password
 * and the mailbox the flow watches. The environment is the fallback for an
 * installation set up before that screen existed (see .env.example):
 *   SMTP_USER, SMTP_PASS   the sending account and its app password
 *   SMTP_FROM              optional, defaults to SMTP_USER
 *   VERZENDLIJST_AAN       the mailbox the flow watches
 *   SMTP_HOST, SMTP_PORT   default smtp.gmail.com:465; also apply to the
 *                          app's settings (the tests use their own server)
 *
 * The recipient is fixed by the operator, never taken from a request: this
 * can only ever mail the planner's own flow mailbox, not arbitrary people.
 */

import nodemailer from 'nodemailer';
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

/** Host and port: Gmail unless SMTP_HOST/SMTP_PORT say otherwise (tests use their own server). */
function server(): { host: string; port: number } {
  const port = parseInt(process.env.SMTP_PORT ?? '', 10);
  return { host: process.env.SMTP_HOST?.trim() || 'smtp.gmail.com', port: Number.isFinite(port) ? port : 465 };
}

// Google shows an app password as four groups of four ("abcd efgh ...");
// pasted as shown, the spaces would make the login fail.
const stripSpaces = (pass: string) => pass.replace(/\s+/g, '');

function configFromEnv(): MailConfig | null {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const to = process.env.VERZENDLIJST_AAN?.trim();
  if (!user || !pass || !to) return null;
  return { ...server(), user, pass: stripSpaces(pass), from: process.env.SMTP_FROM?.trim() || user, to };
}

/**
 * The settings saved in the app ("Mailinstellingen", lib/appSettings.ts)
 * win over .env, so the operator can set this up without access to the
 * server. .env stays as the fallback for an installation that already
 * uses it.
 */
function readConfig(): MailConfig | null {
  const stored = getStoredMailSettings();
  if (stored?.wachtwoord) {
    return {
      ...server(),
      user: stored.gebruiker,
      pass: stripSpaces(stored.wachtwoord),
      from: stored.gebruiker,
      to: stored.verzendlijstAan,
    };
  }
  return configFromEnv();
}

export type MailConfigSource = 'APP' | 'ENV' | null;

/** Where sending is set up, for the settings dialog. */
export function mailConfigStatus(): {
  bron: MailConfigSource;
  gebruiker: string | null;
  verzendlijst_aan: string | null;
  /** Saved in the app, but the password can no longer be read (new session secret). */
  wachtwoord_onleesbaar: boolean;
  /** The last failed send, until one succeeds again. */
  laatste_fout: MailFailure | null;
} {
  const laatste_fout = getMailFailure();
  const stored = getStoredMailSettings();
  if (stored?.wachtwoord) {
    return {
      bron: 'APP',
      gebruiker: stored.gebruiker,
      verzendlijst_aan: stored.verzendlijstAan,
      wachtwoord_onleesbaar: false,
      laatste_fout,
    };
  }
  const env = configFromEnv();
  return {
    bron: env ? 'ENV' : null,
    gebruiker: stored?.gebruiker ?? env?.user ?? null,
    verzendlijst_aan: stored?.verzendlijstAan ?? env?.to ?? null,
    wachtwoord_onleesbaar: Boolean(stored && !stored.wachtwoord),
    laatste_fout,
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
      'De mailserver weigerde de inlog. Controleer SMTP_USER en SMTP_PASS. ' +
      'Bij Gmail is dat een app-wachtwoord, niet je gewone wachtwoord.'
    );
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'EDNS') {
    return 'De mailserver is niet bereikbaar. Controleer SMTP_HOST en SMTP_PORT en of de server internet heeft.';
  }
  if (code === 'ETLS') {
    return (
      'De mailserver biedt geen versleutelde verbinding aan, dus het wachtwoord is niet verstuurd. ' +
      'Controleer SMTP_HOST en SMTP_PORT. Bij Gmail is dat smtp.gmail.com met poort 465.'
    );
  }
  if (code === 'EENVELOPE') {
    return 'De mailserver weigerde het adres. Controleer VERZENDLIJST_AAN en SMTP_FROM.';
  }
  return 'Versturen via de mailserver is mislukt.';
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
      message: 'Automatisch versturen is nog niet ingesteld. Dat doe je bij Mailinstellingen.',
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
