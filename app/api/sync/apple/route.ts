import { NextRequest, NextResponse } from 'next/server';
import { syncApple } from '@/lib/sync/apple';
import { computeDailySnapshot } from '@/lib/sync/snapshots';

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const body = await request.json();
  // Accept either 'month' (YYYY-MM) or 'date' (YYYY-MM-DD, will extract month)
  let month = body.month;
  if (!month && body.date) {
    // Extract YYYY-MM from YYYY-MM-DD
    month = body.date.substring(0, 7);
  }

  if (!month) {
    return NextResponse.json(
      { error: 'month is required (YYYY-MM format)' },
      { status: 400 }
    );
  }

  try {
    const count = await syncApple(month);

    // Compute snapshot for last day of that month
    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    const snapshotDate = `${month}-${String(lastDay).padStart(2, '0')}`;
    await computeDailySnapshot(snapshotDate);

    return NextResponse.json({ success: true, records: count, month, snapshotDate });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
