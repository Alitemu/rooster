/**
 * Password reset for the beheerder, the one way back in without the server.
 *
 * The beheerder types the Gmail address of Mailinstellingen in "Link kwijt?"
 * on the start page. That is no participant's address: the app mails that
 * Gmail account itself a link per active beheerder account to choose a new
 * password. Only a backup (scripts/reset-password.ts stays the other way).
 *
 * - The link holds a signed token (lib/session.ts signPayload), no table: the
 *   account, a short life (30 minutes) and a fingerprint of the password it
 *   was made for. A new password changes the fingerprint, so a link works
 *   once; asking again makes a new one and the older one stays valid until
 *   it is used or has run out.
 * - The token travels after the # in the link, which a browser never sends to
 *   a server: it stays out of the logs.
 * - The address in the link is never taken from the request (anyone can put
 *   any Host header in one): BASE_URL, or the address of a period's
 *   invitations, or the address the beheerder last logged in on.
 * - Whoever asks gets the same answer whether it was that address or not.
 */

import crypto from 'crypto';
import { db } from '@/db/client';
import { hashPassword, validatePasswordStrength } from '@/lib/auth';
import { DEFAULT_TEST_PASSWORD } from '@/lib/seedPassword';
import { signPayload, verifyPayload } from '@/lib/session';
import { revokeAllSessions } from '@/lib/sessionVersion';
import { writeAuditLog } from '@/lib/auditLog';
import { getStoredMailSettings } from '@/lib/appSettings';
import { sendDirectMail, verzendlijstMailConfigured } from '@/lib/verzendlijstMail';

export const HERSTEL_GELDIG_SECONDEN = 30 * 60;
const BASIS_URL_SLEUTEL = 'herstel.basis_url';
const SOORT = 'wachtwoordherstel';

interface HerstelToken {
  kind: typeof SOORT;
  personId: string;
  vingerafdruk: string;
}

interface Beheerder {
  id: string;
  codenaam: string;
  wachtwoord_hash: string;
}

const vingerafdruk = (hash: string) => crypto.createHash('sha256').update(hash).digest('hex').slice(0, 24);

function actieveBeheerders(): Beheerder[] {
  return db
    .prepare(
      `SELECT id, codenaam, wachtwoord_hash FROM dienstrooster_person
       WHERE rol = 'ADMIN' AND actief = 1 AND wachtwoord_hash IS NOT NULL ORDER BY codenaam`
    )
    .all() as Beheerder[];
}

export function maakHerstelToken(beheerder: Pick<Beheerder, 'id' | 'wachtwoord_hash'>): string {
  const payload: HerstelToken = { kind: SOORT, personId: beheerder.id, vingerafdruk: vingerafdruk(beheerder.wachtwoord_hash) };
  return signPayload(payload, HERSTEL_GELDIG_SECONDEN);
}

/** The beheerder a token is good for right now, or null (unknown, run out, used, account gone). */
export function leesHerstelToken(token: unknown): Beheerder | null {
  if (typeof token !== 'string') return null;
  const payload = verifyPayload<HerstelToken>(token);
  if (!payload || payload.kind !== SOORT || typeof payload.personId !== 'string') return null;
  const beheerder = db
    .prepare(
      `SELECT id, codenaam, wachtwoord_hash FROM dienstrooster_person
       WHERE id = ? AND rol = 'ADMIN' AND actief = 1 AND wachtwoord_hash IS NOT NULL`
    )
    .get(payload.personId) as Beheerder | undefined;
  if (!beheerder || vingerafdruk(beheerder.wachtwoord_hash) !== payload.vingerafdruk) return null;
  return beheerder;
}

export type HerstelUitkomst =
  | { ok: true; codenaam: string }
  | { ok: false; code: 'INVALID_TOKEN' | 'WEAK_PASSWORD' | 'PASSWORD_PUBLIC'; message: string };

/** Sets the new password, ends every session of the account and writes the audit row. */
export async function stelWachtwoordIn(token: unknown, nieuw: unknown): Promise<HerstelUitkomst> {
  const beheerder = leesHerstelToken(token);
  if (!beheerder) {
    return { ok: false, code: 'INVALID_TOKEN', message: 'Deze link is verlopen of al gebruikt. Vraag op de startpagina een nieuwe aan.' };
  }
  if (typeof nieuw !== 'string') return { ok: false, code: 'WEAK_PASSWORD', message: 'Vul een nieuw wachtwoord in.' };
  const fouten = validatePasswordStrength(nieuw);
  if (fouten.length > 0) return { ok: false, code: 'WEAK_PASSWORD', message: fouten.join(', ') };
  if (nieuw === DEFAULT_TEST_PASSWORD) {
    return { ok: false, code: 'PASSWORD_PUBLIC', message: 'Dit wachtwoord staat openbaar in de broncode. Kies een ander wachtwoord.' };
  }
  const hash = await hashPassword(nieuw);
  const gedaan = db.transaction(() => {
    // Checked again inside: two uses of one link at the same time must not both pass.
    const nu = db.prepare('SELECT wachtwoord_hash FROM dienstrooster_person WHERE id = ?').get(beheerder.id) as { wachtwoord_hash: string } | undefined;
    if (!nu || nu.wachtwoord_hash !== beheerder.wachtwoord_hash) return false;
    db.prepare('UPDATE dienstrooster_person SET wachtwoord_hash = ?, wachtwoord_moet_wijzigen = 0 WHERE id = ?').run(hash, beheerder.id);
    revokeAllSessions(beheerder.id);
    writeAuditLog({
      actorId: beheerder.id,
      entiteit: 'person',
      entiteitId: beheerder.id,
      actie: 'UPDATE',
      nieuw: { wijziging: 'wachtwoord hersteld via de startpagina', sessies_ingetrokken: true },
    });
    return true;
  })();
  if (!gedaan) {
    return { ok: false, code: 'INVALID_TOKEN', message: 'Deze link is verlopen of al gebruikt. Vraag op de startpagina een nieuwe aan.' };
  }
  return { ok: true, codenaam: beheerder.codenaam };
}

/** Remembers the address a beheerder logged in on (called after a correct password). */
export function onthoudBeheerderAdres(basisUrl: string): void {
  db.prepare(
    `INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde, gewijzigd_op = excluded.gewijzigd_op, gewijzigd_door = NULL`
  ).run(BASIS_URL_SLEUTEL, basisUrl, new Date().toISOString());
}

/** Where the link points: BASE_URL, else a period's invitation address, else where a beheerder last logged in. */
export function herstelBasisUrl(): string | null {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const periode = db
    .prepare('SELECT basis_url FROM dienstrooster_schedule_period WHERE basis_url IS NOT NULL ORDER BY aangemaakt_op DESC LIMIT 1')
    .get() as { basis_url: string } | undefined;
  if (periode) return periode.basis_url.replace(/\/$/, '');
  const login = db.prepare('SELECT waarde FROM dienstrooster_app_setting WHERE sleutel = ?').get(BASIS_URL_SLEUTEL) as { waarde: string } | undefined;
  return login?.waarde.replace(/\/$/, '') ?? null;
}

/** True when this is the Gmail account of Mailinstellingen (the one address that starts a reset). */
export function isHerstelAdres(adres: string): boolean {
  const gebruiker = getStoredMailSettings()?.gebruiker;
  return Boolean(gebruiker) && gebruiker!.trim().toLowerCase() === adres.trim().toLowerCase();
}

/**
 * Mails the Gmail account a link per active beheerder. Never throws and says
 * nothing about the outcome to the caller: a failure goes to the log.
 */
export async function stuurHerstelMail(): Promise<void> {
  try {
    if (!verzendlijstMailConfigured()) return;
    const gebruiker = getStoredMailSettings()?.gebruiker;
    const basis = herstelBasisUrl();
    if (!gebruiker || !basis) {
      console.warn('[wachtwoord-herstel] geen adres voor de link bekend: stel BASE_URL in of log eenmaal in als beheerder');
      return;
    }
    const beheerders = actieveBeheerders();
    if (beheerders.length === 0) return;
    const regels = beheerders.map((b) => `${b.codenaam}:\n${basis}/wachtwoord-herstel#token=${maakHerstelToken(b)}`);
    const resultaat = await sendDirectMail({
      to: gebruiker,
      subject: 'Dienstrooster: nieuw wachtwoord instellen',
      text:
        `Er is een nieuw wachtwoord aangevraagd voor ${beheerders.length === 1 ? 'het beheerdersaccount' : 'een beheerdersaccount'} van Dienstrooster.\n\n` +
        `Kies hieronder het account en stel een nieuw wachtwoord in. De link werkt ${HERSTEL_GELDIG_SECONDEN / 60} minuten en maar één keer.\n\n` +
        `${regels.join('\n\n')}\n\n` +
        'Heb je dit niet zelf aangevraagd? Dan hoef je niets te doen. Het wachtwoord blijft zoals het was.',
    });
    if (!resultaat.ok) console.error(`[wachtwoord-herstel] mail niet verstuurd: ${resultaat.message}`);
  } catch (error) {
    console.error('[wachtwoord-herstel] mail niet verstuurd', error);
  }
}
