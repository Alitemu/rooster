/**
 * GET /api/person/[id]/notifications
 *
 * List notifications for a person.
 * Query params: period_id, type, unread_only
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const personId = params.id;

    const auth = getAuthContextFromRequest(request);
    if (!requirePersonAccess(auth, personId)) {
      return forbiddenResponse();
    }

    const searchParams = request.nextUrl.searchParams;
    const periodId = searchParams.get('period_id');
    const type = searchParams.get('type');
    const unreadOnly = searchParams.get('unread_only') === 'true';
    const limit = parseInt(searchParams.get('limit') || '50');

    // Verify person exists
    const person = db
      .prepare('SELECT * FROM dienstrooster_person WHERE id = ?')
      .get(personId) as any;

    if (!person) {
      return NextResponse.json(
        { success: false, error: 'Person not found' },
        { status: 404 }
      );
    }

    // Build query
    let query = `
      SELECT id, periode_id, type, onderwerp, inhoud, gelezen, gesloten_op, aangemaakt_op
      FROM dienstrooster_notification
      WHERE person_id = ?
    `;
    const params_list: any[] = [personId];

    if (periodId) {
      query += ' AND periode_id = ?';
      params_list.push(periodId);
    }

    if (type) {
      query += ' AND type = ?';
      params_list.push(type);
    }

    if (unreadOnly) {
      query += ' AND gelezen = 0';
    }

    // Order: unread first, then newest
    query += ' ORDER BY gelezen ASC, aangemaakt_op DESC';
    query += ` LIMIT ?`;
    params_list.push(limit);

    const notifications = db.prepare(query).all(...params_list) as any[];

    // Count unread
    const unreadCount = db
      .prepare('SELECT COUNT(*) as count FROM dienstrooster_notification WHERE person_id = ? AND gelezen = 0')
      .get(personId) as any;

    return NextResponse.json({
      success: true,
      data: {
        notifications,
        unread_count: unreadCount.count,
      },
    });
  } catch (error) {
    return internalErrorResponse('notifications-list', error);
  }
}
