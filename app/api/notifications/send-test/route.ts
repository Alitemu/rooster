/**
 * POST /api/notifications/send-test - Preview a notification template
 *
 * Renders a notification_template's onderwerp/body_md with the given
 * placeholder values so a planner can check the wording before it's
 * actually used. Never sends or persists anything.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface SendTestRequest {
  sleutel: string;
  placeholders?: Record<string, string>;
}

function renderTemplate(text: string, placeholders: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    key in placeholders ? placeholders[key] : match
  );
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

    const template = db
      .prepare('SELECT onderwerp, body_md FROM dienstrooster_notification_template WHERE sleutel = ?')
      .get(sleutel) as { onderwerp: string; body_md: string } | undefined;

    if (!template) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'TEMPLATE_NOT_FOUND', message: `No template configured for ${sleutel}` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const response: ApiSuccessResponse<{ subject: string; body: string }> = {
      success: true,
      data: {
        subject: renderTemplate(template.onderwerp, placeholders),
        body: renderTemplate(template.body_md, placeholders),
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('notifications-send-test', error);
  }
}
