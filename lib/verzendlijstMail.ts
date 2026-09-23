/**
 * Sends the verzendlijst (lib/verzendlijst.ts) to the planner's own
 * mailbox over SMTP, so the Power Automate flow starts without the
 * planner having to download a file and attach it by hand.
 *
 * Configured through the environment only (see .env.example). Gmail is the
 * intended provider (smtp.gmail.com with an app password), but any SMTP
 * server works:
 *   SMTP_HOST, SMTP_PORT   default smtp.gmail.com:465 (TLS from the start)
 *   SMTP_USER, SMTP_PASS   the sending account and its app password
 *   SMTP_FROM              optional, defaults to SMTP_USER
 *   VERZENDLIJST_AAN       the mailbox the flow watches
 *
 * The recipient is fixed by the operator, never taken from a request: this
 * can only ever mail the planner's own flow mailbox, not arbitrary people.
 */

import nodemailer from 'nodemailer';
import { VERZENDLIJST_SUBJECT, verzendlijstFilename, verzendlijstJson, type Verzendlijst } from './verzendlijst';

interface MailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
}

function readConfig(): MailConfig | null {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const to = process.env.VERZENDLIJST_AAN?.trim();
  if (!user || !pass || !to) return null;
  const port = parseInt(process.env.SMTP_PORT ?? '', 10);
  return {
    host: process.env.SMTP_HOST?.trim() || 'smtp.gmail.com',
    port: Number.isFinite(port) ? port : 465,
    user,
    // Google shows an app password as four groups of four ("abcd efgh ...");
    // pasted as shown, the spaces would make the login fail.
    pass: pass.replace(/\s+/g, ''),
    from: process.env.SMTP_FROM?.trim() || user,
    to,
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

/** One mail to VERZENDLIJST_AAN with a single JSON attachment. */
async function sendJsonMail(mail: {
  subject: string;
  text: string;
  filename: string;
  json: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const config = readConfig();
  if (!config) {
    return { ok: false, message: 'Automatisch versturen is niet ingesteld op de server.' };
  }

  const transport = nodemailer.createTransport({
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
  return result.ok ? { ok: true, aantal: lijst.aantal } : result;
}
