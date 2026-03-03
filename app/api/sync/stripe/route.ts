import { NextRequest, NextResponse } from 'next/server';
import { syncStripe } from '@/lib/sync/stripe';
import { computeDailySnapshot } from '@/lib/sync/snapshots';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const { date } = await request.json();

  if (!date) {
    return NextResponse.json({ error: 'date is required' }, { status: 400 });
  }

  try {
    const count = await syncStripe(date);
    await computeDailySnapshot(date);
    return NextResponse.json({ success: true, records: count, date });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
