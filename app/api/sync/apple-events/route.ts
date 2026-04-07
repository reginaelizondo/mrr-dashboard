import { NextRequest, NextResponse } from 'next/server';
import { syncAppleEvents, syncAppleEventsRange } from '@/lib/sync/apple-events';

export const maxDuration = 300;

/**
 * POST /api/sync/apple-events
 *   { date: "YYYY-MM-DD" }                       → single day
 *   { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" } → range (backfill)
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));

  try {
    if (body.startDate && body.endDate) {
      const result = await syncAppleEventsRange(body.startDate, body.endDate);
      return NextResponse.json({ success: true, ...result });
    }

    if (body.date) {
      const result = await syncAppleEvents(body.date);
      return NextResponse.json({ success: true, date: body.date, ...result });
    }

    return NextResponse.json(
      { error: 'Provide either { date } or { startDate, endDate }' },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
