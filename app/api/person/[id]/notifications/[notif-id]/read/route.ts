/**
 * POST /api/person/[id]/notifications/[notif-id]/read
 *
 * Mark a notification as read.
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

    // Verify notification belongs to person
    const notification = db
      .prepare('SELECT * FROM dienstrooster_notification WHERE id = ? AND person_id = ?')
      .get(notifId, personId) as any;

    if (!notification) {
      return NextResponse.json(
        { success: false, error: 'Notification not found' },
        { status: 404 }
      );
    }

    // Mark as read
    db.prepare(
      'UPDATE dienstrooster_notification SET gelezen = 1 WHERE id = ?'
    ).run(notifId);

    return NextResponse.json({
      success: true,
      data: { notification_id: notifId },
    });
  } catch (error) {
    return internalErrorResponse('notification-mark-read', error);
  }
}
