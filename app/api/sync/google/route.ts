import { NextRequest, NextResponse } from 'next/server';
import { syncGoogle } from '@/lib/sync/google';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const { yearMonth } = await request.json();

  if (!yearMonth) {
    return NextResponse.json(
      { error: 'yearMonth is required (YYYYMM format)' },
      { status: 400 }
    );
  }

  try {
    const count = await syncGoogle(yearMonth);
    return NextResponse.json({ success: true, records: count, yearMonth });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
