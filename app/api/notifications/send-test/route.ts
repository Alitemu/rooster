/**
 * POST /api/notifications/send-test - Preview a notification template
 *
 * Renders a notification_template's onderwerp/body_md with the given
 * placeholder values so a planner can check the wording before it's
 * actually used. Never sends or persists anything.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { renderNotificationTemplate } from '@/lib/notifications';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface SendTestRequest {
  sleutel: string;
  placeholders?: Record<string, string>;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const body = (await parseJsonBody(req)) as SendTestRequest;
    const { sleutel, placeholders = {} } = body;

    if (!sleutel) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'MISSING_SLEUTEL', message: 'sleutel is verplicht' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const rendered = renderNotificationTemplate(sleutel, placeholders);

    if (!rendered) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'TEMPLATE_NOT_FOUND', message: `No template configured for ${sleutel}` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const response: ApiSuccessResponse<{ subject: string; body: string }> = {
      success: true,
      data: { subject: rendered.onderwerp, body: rendered.inhoud },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('notifications-send-test', error);
  }
}
