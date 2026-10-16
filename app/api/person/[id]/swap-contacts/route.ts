/**
 * GET /api/person/[id]/swap-contacts - where to pass on a swap the app
 * can't make, for the swap dialog (lib/appSettings.ts getSwapContacts):
 * the mailbox of the flow of the person's own dienst, from
 * Mailinstellingen (the AIOS have their own). Only for the person
 * themselves.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { internalErrorResponse } from '@/lib/api-errors';
import { getSwapContacts } from '@/lib/appSettings';
import { dienstVanPersoon } from '@/lib/aiosPeriod';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const denied = personAccessDenial(getAuthContextFromRequest(req), id);
    if (denied) return denied;
    return NextResponse.json({ success: true, data: getSwapContacts(dienstVanPersoon(id)) });
  } catch (error) {
    return internalErrorResponse('person-swap-contacts', error);
  }
}
