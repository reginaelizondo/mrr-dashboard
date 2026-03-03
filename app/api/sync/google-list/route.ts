import { NextResponse } from 'next/server';
import { listGoogleEarningsFiles } from '@/lib/sync/google';

export const maxDuration = 30;

/**
 * GET /api/sync/google-list
 * Lists all available earnings files in the GCS bucket.
 * Helps us know which months have data for Google Play.
 */
export async function GET() {
  try {
    // List ALL earnings files (no yearMonth filter)
    const files = await listGoogleEarningsFiles();

    // Extract yearMonth from filenames like "earnings/earnings_202401_com.kinedu.appkinedu_...csv"
    const months = new Set<string>();
    for (const f of files) {
      const match = f.match(/earnings_(\d{6})/);
      if (match) months.add(match[1]);
    }

    const sortedMonths = Array.from(months).sort();

    return NextResponse.json({
      success: true,
      totalFiles: files.length,
      months: sortedMonths,
      monthCount: sortedMonths.length,
      files: files.slice(0, 50), // Show first 50 filenames
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
