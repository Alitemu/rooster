/**
 * POST /api/person/[id]/notifications/[notif-id]/dismiss
 *
 * Dismiss a notification - hides it from the default list (see
 * gesloten_op filtering in the GET .../notifications route) without
 * deleting the row, distinct from "mark as read" (.../read).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; 'notif-id': string } }
) {
  try {
    const personId = params.id;

    const auth = getAuthContextFromRequest(request);
    if (!requirePersonAccess(auth, personId)) {
      return forbiddenResponse();
    }

    const notifId = params['notif-id'];

    const notification = db
      .prepare('SELECT * FROM dienstrooster_notification WHERE id = ? AND person_id = ?')
      .get(notifId, personId) as any;

    if (!notification) {
      return NextResponse.json(
        { success: false, error: { code: 'NOTIFICATION_NOT_FOUND', message: `Melding ${notifId} niet gevonden` } },
        { status: 404 }
      );
    }

    // Idempotent on repeat calls: only set gesloten_op the first time, so
    // a second dismiss (e.g. a double-click) doesn't overwrite the real
    // original dismiss timestamp with a later one.
    db.prepare(
      'UPDATE dienstrooster_notification SET gesloten_op = ? WHERE id = ? AND gesloten_op IS NULL'
    ).run(new Date().toISOString(), notifId);

    return NextResponse.json({
      success: true,
      data: { notification_id: notifId },
    });
  } catch (error) {
    return internalErrorResponse('notification-dismiss', error);
  }
}
