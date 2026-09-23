/**
 * A real SMTP server on localhost for tests that send mail (CLAUDE.md: no
 * mocks). It accepts one account, SMTP_SINK_USER / SMTP_SINK_PASSWORD, and
 * keeps every message it receives.
 */

import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'net';
import type { Verzendlijst, VerzendlijstBerichtUit } from '@/lib/verzendlijst';

export const SMTP_SINK_USER = 'rooster@example.test';
export const SMTP_SINK_PASSWORD = 'app-wachtwoord';

export interface ReceivedMail {
  from: string;
  to: string[];
  raw: string;
}

export interface SmtpSink {
  port: number;
  received: ReceivedMail[];
  /** Every login attempt, so a test can see that none happened. */
  logins: string[];
  close(): Promise<void>;
}

/**
 * `starttls: false` makes a server that never offers encryption: the app
 * must then refuse to log in at all (lib/verzendlijstMail.ts requireTLS).
 * With STARTTLS the server uses smtp-server's own self-signed certificate,
 * which configureSmtp tells Node to accept for the test.
 */
export async function startSmtpSink(opts: { starttls?: boolean } = {}): Promise<SmtpSink> {
  const received: ReceivedMail[] = [];
  const logins: string[] = [];
  const server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: opts.starttls === false,
    disabledCommands: opts.starttls === false ? ['STARTTLS'] : [],
    logger: false,
    onAuth(auth, _session, callback) {
      logins.push(auth.username ?? '');
      if (auth.username === SMTP_SINK_USER && auth.password === SMTP_SINK_PASSWORD) {
        callback(null, { user: auth.username });
      } else {
        callback(new Error('Invalid login'));
      }
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.server.address() as AddressInfo).port,
    received,
    logins,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'VERZENDLIJST_AAN'] as const;

/** Points lib/verzendlijstMail.ts at the sink. */
export function configureSmtp(sink: SmtpSink, overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  // The sink's certificate is self-signed; checking certificates is not
  // what these tests are about. Undone by clearSmtpConfig.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(sink.port),
    SMTP_USER: SMTP_SINK_USER,
    // Pasted the way Google shows an app password: in groups with spaces.
    SMTP_PASS: 'app-wacht woord',
    VERZENDLIJST_AAN: 'stroom@example.test',
    ...overrides,
  });
}

export function clearSmtpConfig() {
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

/** The whole verzendlijst (summary fields and berichten), decoded from a raw MIME message. */
export function verzendlijstPayload(raw: string): Verzendlijst {
  const part = raw.split(/\r?\n--/).find((p) => /Content-Type: application\/json/i.test(p));
  if (!part) throw new Error('no JSON attachment');
  const [headers, ...rest] = part.split(/\r?\n\r?\n/);
  const body = rest.join('\n\n').trim();
  const text = /Content-Transfer-Encoding: base64/i.test(headers)
    ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
    : body;
  return JSON.parse(text);
}

/** Just the berichten of a verzendlijst. */
export function verzendlijstAttachment(raw: string): VerzendlijstBerichtUit[] {
  return verzendlijstPayload(raw).berichten;
}

/** Waits until the sink holds `count` mails (mail sent in the background). */
export async function waitForMails(sink: SmtpSink, count: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (sink.received.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`expected ${count} mails, got ${sink.received.length}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
