/**
 * What every planner route of an AIOS period does first, after its own
 * requirePlannerAccess and periodDienstDenial: load the period, an AIOS one
 * only. An achterwacht period, one in the prullenbak or an unknown id
 * answers 404: these routes are the AIOS's, the achterwacht's have their own.
 */

import { NextResponse } from 'next/server';
import { aiosUitnodigPeriode, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';

export function aiosFout(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export function laadAiosPeriode(periodId: string): AiosUitnodigPeriode | NextResponse {
  return aiosUitnodigPeriode(periodId) ?? aiosFout(404, 'PERIOD_NOT_FOUND', 'Periode niet gevonden');
}
