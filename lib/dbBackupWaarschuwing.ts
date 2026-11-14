/**
 * The warning above the period list when the backup by mail does not work (0.905.0), for the beheerder only.
 *
 * Until then it showed only inside the Back-up dialog: after a clean reinstall plus a restore, the Gmail password
 * and the backup password had to be typed again (both are encrypted with the old installation's key), and nothing
 * outside that dialog said that no backup was going out. The IT department makes none of this app, so this copy is
 * the only one off the server.
 *
 * No database here: app/planner/page.tsx calls it in the browser with what /api/admin/back-up answers.
 */

/** As lib/dbBackupMail.ts backupMailOverzicht answers it. */
export interface BackupStand {
  ingesteld: boolean;
  wachtwoord_leesbaar: boolean | null;
  mail_ingesteld: boolean;
  verstuurd_op: string | null;
  fout: { op: string; melding: string } | null;
}

/** One goes out at least once a week (lib/dbBackupMail.ts HARTSLAG_DAGEN); a day's slack for a missed night. */
export const WAARSCHUW_NA_DAGEN = 8;

export function backupWaarschuwing(stand: BackupStand, nu: Date): string | null {
  if (!stand.ingesteld) {
    return 'Er gaan nog geen back-ups buiten de server. Stel de back-up per mail in: zonder kopie elders ben je bij een kapotte server alles kwijt.';
  }
  if (stand.wachtwoord_leesbaar === false) {
    return 'Er gaan geen back-ups uit: vul het back-upwachtwoord opnieuw in bij Back-up.';
  }
  if (!stand.mail_ingesteld) {
    return 'Er gaan geen back-ups uit: het Gmail-account bij Mailinstellingen is niet ingesteld of het wachtwoord moet opnieuw ingevuld worden.';
  }
  if (stand.fout && (stand.verstuurd_op === null || stand.fout.op > stand.verstuurd_op)) {
    return `De laatste back-up is mislukt: ${stand.fout.melding}`;
  }
  if (stand.verstuurd_op === null) {
    return 'Er is nog geen back-up verstuurd. Kies bij Back-up "Nu een back-up versturen" en kijk of hij aankomt.';
  }
  const dagen = Math.floor((nu.getTime() - Date.parse(stand.verstuurd_op)) / 86_400_000);
  if (dagen >= WAARSCHUW_NA_DAGEN) {
    return `De laatste back-up ging ${dagen} dagen geleden uit. Er hoort er minstens een per week uit te gaan.`;
  }
  return null;
}
