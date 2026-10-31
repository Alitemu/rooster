import { describe, it, expect } from 'vitest';
import { backupWaarschuwing, type BackupStand } from '@/lib/dbBackupWaarschuwing';

/**
 * The beheerder's warning above the period list (0.905.0): every way the backup by mail stops is said there, not only
 * in the Back-up dialog. After a reinstall and a restore both passwords had to be typed again, and nothing said so.
 */

const nu = new Date('2026-11-10T12:00:00Z');
const goed: BackupStand = { ingesteld: true, wachtwoord_leesbaar: true, mail_ingesteld: true, verstuurd_op: '2026-11-09T19:00:00Z', fout: null };

describe('the warning when no backup goes out', () => {
  it('says nothing while backups go out', () => {
    expect(backupWaarschuwing(goed, nu)).toBeNull();
    // Seven days and a bit: within the week the heartbeat promises.
    expect(backupWaarschuwing({ ...goed, verstuurd_op: '2026-11-03T00:00:00Z' }, nu)).toBeNull();
  });

  it('names what is wrong, the first thing to fix first', () => {
    expect(backupWaarschuwing({ ...goed, ingesteld: false, wachtwoord_leesbaar: null }, nu)).toMatch(/^Er gaan nog geen back-ups buiten de server\./);
    expect(backupWaarschuwing({ ...goed, wachtwoord_leesbaar: false, mail_ingesteld: false }, nu)).toBe(
      'Er gaan geen back-ups uit: vul het back-upwachtwoord opnieuw in bij Back-up.'
    );
    expect(backupWaarschuwing({ ...goed, mail_ingesteld: false }, nu)).toBe(
      'Er gaan geen back-ups uit: het Gmail-account bij Mailinstellingen is niet ingesteld of het wachtwoord moet opnieuw ingevuld worden.'
    );
  });

  it('a failure after the last backup is said; one before it is past', () => {
    const fout = { op: '2026-11-10T01:00:00Z', melding: 'Gmail weigerde het wachtwoord.' };
    expect(backupWaarschuwing({ ...goed, fout }, nu)).toBe('De laatste back-up is mislukt: Gmail weigerde het wachtwoord.');
    expect(backupWaarschuwing({ ...goed, fout, verstuurd_op: null }, nu)).toBe('De laatste back-up is mislukt: Gmail weigerde het wachtwoord.');
    expect(backupWaarschuwing({ ...goed, fout: { ...fout, op: '2026-11-08T01:00:00Z' } }, nu)).toBeNull();
  });

  it('none sent yet, or the last one 8 days ago or more', () => {
    expect(backupWaarschuwing({ ...goed, verstuurd_op: null }, nu)).toMatch(/^Er is nog geen back-up verstuurd\./);
    expect(backupWaarschuwing({ ...goed, verstuurd_op: '2026-11-02T12:00:00Z' }, nu)).toBe(
      'De laatste back-up ging 8 dagen geleden uit. Er hoort er minstens een per week uit te gaan.'
    );
  });
});
