import { NextRequest, NextResponse } from 'next/server';
import { syncAppleSalesDay, syncAppleSalesRecent } from '@/lib/sync/apple-sales';

export const maxDuration = 300;

/**
 * POST /api/sync/apple-sales
 * Body: { date?: "YYYY-MM-DD", daysBack?: number }
 *   - date          → sync that specific day
 *   - daysBack (n)  → re-sync the last n days (default 5)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.date) {
      const rows = await syncAppleSalesDay(body.date);
      return NextResponse.json({ success: true, date: body.date, rows });
    }
    const result = await syncAppleSalesRecent(body.daysBack ?? 5);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
