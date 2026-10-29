import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import zlib from 'zlib';
import { BACKUP_MAGIC, BackupBestandFout, backupBestandsnaam, leesBackupKop, maakBackupBestand, openBackupBestand } from './dbBackupBestand';

/**
 * The rules: a backup opens with its password and gives back exactly the
 * database that went in; it does not open with another password; a single
 * changed byte anywhere (header included) makes it refuse; and nothing in it
 * is readable without the password.
 */

const META = { app_versie: '0.900.0', gemaakt_op: '2027-03-01T03:00:00.000Z' };
const WACHTWOORD = 'correct paard batterij';

function fout(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(BackupBestandFout);
    return (e as Error).message;
  }
  throw new Error('geen fout');
}

describe('backup file', () => {
  it('gives back exactly the database that went in, with its header', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4000 }), fc.string({ minLength: 1, maxLength: 40 }), (bytes, wachtwoord) => {
        const database = Buffer.from(bytes);
        const bestand = maakBackupBestand(database, wachtwoord, META);
        const open = openBackupBestand(bestand, wachtwoord);
        expect(open.database.equals(database)).toBe(true);
        expect(open.kop.app_versie).toBe('0.900.0');
        expect(open.kop.gemaakt_op).toBe(META.gemaakt_op);
      }),
      { numRuns: 8 }
    );
  }, 30_000);

  it('does not open with another password', () => {
    const bestand = maakBackupBestand(Buffer.from('database'), WACHTWOORD, META);
    expect(fout(() => openBackupBestand(bestand, 'correct paard batterij!'))).toBe('Het wachtwoord klopt niet of het bestand is beschadigd.');
    expect(fout(() => openBackupBestand(bestand, ''))).toBe('Het wachtwoord klopt niet of het bestand is beschadigd.');
  });

  it('refuses a file with any one byte changed, in the header as well as in the data', () => {
    const bestand = maakBackupBestand(Buffer.from('SQLite format 3\0'.repeat(50)), WACHTWOORD, META);
    const kopEinde = leesBackupKop(bestand).voorwerk.length;
    // Every fourth byte of the header (past the magic, which says "not a backup" instead) and a spread over the rest:
    // each try costs a key derivation, which is slow on purpose.
    const plekken = [
      ...Array.from({ length: Math.ceil((kopEinde - BACKUP_MAGIC.length) / 4) }, (_, i) => BACKUP_MAGIC.length + 4 * i),
      ...Array.from({ length: 40 }, (_, i) => kopEinde + Math.floor(((bestand.length - kopEinde) * i) / 40)),
      bestand.length - 1,
    ];
    for (const plek of plekken) {
      const kapot = Buffer.from(bestand);
      kapot[plek] ^= 0x01;
      expect(() => openBackupBestand(kapot, WACHTWOORD), `byte ${plek}`).toThrow(BackupBestandFout);
    }
  }, 60_000);

  it('holds nothing readable: the database is neither in it as it is nor as plain gzip', () => {
    const database = Buffer.from('staf01 staf02 aios01 geheim-rooster '.repeat(100));
    const bestand = maakBackupBestand(database, WACHTWOORD, META);
    expect(bestand.includes(Buffer.from('staf01'))).toBe(false);
    expect(bestand.includes(zlib.gzipSync(database).subarray(10, 40))).toBe(false);
    // Two backups of the same database differ entirely (fresh salt and iv each time).
    expect(maakBackupBestand(database, WACHTWOORD, META).equals(bestand)).toBe(false);
  });

  it('says what is wrong with a file that is not a backup at all', () => {
    expect(fout(() => openBackupBestand(Buffer.from('SQLite format 3\0'), WACHTWOORD))).toBe('Dit is geen back-upbestand van Dienstrooster.');
    expect(fout(() => openBackupBestand(Buffer.alloc(0), WACHTWOORD))).toBe('Dit is geen back-upbestand van Dienstrooster.');
    // Cut off: the header says more than there is.
    const bestand = maakBackupBestand(Buffer.from('x'), WACHTWOORD, META);
    expect(fout(() => openBackupBestand(bestand.subarray(0, BACKUP_MAGIC.length + 10), WACHTWOORD))).toBe('Dit is geen back-upbestand van Dienstrooster.');
  });

  it('refuses a header that asks for an unreasonable amount of work before checking the password', () => {
    const bestand = maakBackupBestand(Buffer.from('x'), WACHTWOORD, META);
    const { kop, voorwerk } = leesBackupKop(bestand);
    const zwaar = Buffer.from(JSON.stringify({ ...kop, kdf: { ...kop.kdf, N: 1 << 20 } }));
    const lengte = Buffer.alloc(4);
    lengte.writeUInt32BE(zwaar.length);
    const nagemaakt = Buffer.concat([BACKUP_MAGIC, lengte, zwaar, bestand.subarray(voorwerk.length)]);
    const start = Date.now();
    expect(fout(() => openBackupBestand(nagemaakt, WACHTWOORD))).toBe('Dit is geen back-upbestand van Dienstrooster.');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('says a file from a newer format needs a newer app', () => {
    const bestand = maakBackupBestand(Buffer.from('x'), WACHTWOORD, META);
    const { kop, voorwerk } = leesBackupKop(bestand);
    const nieuw = Buffer.from(JSON.stringify({ ...kop, formaat: 2 }));
    const lengte = Buffer.alloc(4);
    lengte.writeUInt32BE(nieuw.length);
    expect(fout(() => openBackupBestand(Buffer.concat([BACKUP_MAGIC, lengte, nieuw, bestand.subarray(voorwerk.length)]), WACHTWOORD))).toBe(
      'Dit back-upbestand is gemaakt door een nieuwere versie van Dienstrooster. Werk de app eerst bij.'
    );
  });

  it('names a file by the time on the ward, so sorting by name sorts by time', () => {
    // 23:30 UTC on 31 December is already 00:30 on 1 January in Amsterdam (winter time).
    expect(backupBestandsnaam(new Date('2026-12-31T23:30:00Z'))).toBe('dienstrooster-backup-2027-01-01-0030.drbackup');
    expect(backupBestandsnaam(new Date('2027-07-01T02:05:00Z'))).toBe('dienstrooster-backup-2027-07-01-0405.drbackup');
  });
});
