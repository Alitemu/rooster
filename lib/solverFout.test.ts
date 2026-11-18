import { describe, it, expect } from 'vitest';
import { solverVerbindingsFout, netwerkCode, SOLVER_NIET_BEREIKBAAR, SOLVER_AFGEBROKEN } from './solverFout';

describe('solverVerbindingsFout', () => {
  it('knows a solver that cannot be reached', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']) {
      expect(solverVerbindingsFout(Object.assign(new Error('x'), { code })), code).toEqual({ message: SOLVER_NIET_BEREIKBAAR, status: 503 });
    }
    // Node wraps several refused addresses (IPv4 and IPv6) in one error.
    const meerdere = Object.assign(new Error('x'), { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] });
    expect(netwerkCode(meerdere)).toBe('ECONNREFUSED');
    expect(solverVerbindingsFout(meerdere)?.message).toBe(SOLVER_NIET_BEREIKBAAR);
  });

  it('knows a connection that broke or timed out', () => {
    for (const fout of [Object.assign(new Error('x'), { code: 'ECONNRESET' }), Object.assign(new Error('x'), { code: 'EPIPE' }), new Error('Solver-time-out na 900 s')]) {
      expect(solverVerbindingsFout(fout)).toEqual({ message: SOLVER_AFGEBROKEN, status: 503 });
    }
  });

  it('leaves everything else to the caller', () => {
    expect(solverVerbindingsFout(new Error('iets anders'))).toBeNull();
    expect(solverVerbindingsFout(new TypeError('boem'))).toBeNull();
    expect(solverVerbindingsFout('tekst')).toBeNull();
    expect(solverVerbindingsFout(undefined)).toBeNull();
  });

  it('is Dutch and says nothing of foutcodes', () => {
    for (const t of [SOLVER_NIET_BEREIKBAAR, SOLVER_AFGEBROKEN]) {
      expect(t).toMatch(/^De solver /);
      expect(t).not.toMatch(/foutcode|helpt dan meestal niet/);
    }
  });
});
