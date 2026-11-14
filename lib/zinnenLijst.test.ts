import { describe, expect, it } from 'vitest';
import { zinnenLijst } from './zinnenLijst';

describe('zinnenLijst', () => {
  it('makes every message a sentence and never writes ".;"', () => {
    expect(zinnenLijst(['Eerste zin.', '2 diensten zijn niet ingevuld', ' Derde? '])).toBe(
      'Eerste zin. 2 diensten zijn niet ingevuld. Derde?'
    );
    expect(zinnenLijst(['A.', 'B.'])).not.toContain('.;');
    expect(zinnenLijst([])).toBe('');
  });
});
