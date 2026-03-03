import { NextRequest, NextResponse } from 'next/server';
import { computeMonthlySnapshot } from '@/lib/sync/snapshots';

export const maxDuration = 300; // 5 minutes

/**
 * Recompute monthly MRR snapshots from existing transaction data.
 * Does NOT re-sync any source data — only recalculates snapshots.
 *
 * POST /api/sync/recompute-snapshots
 * Body: { startMonth: "2024-01", endMonth: "2026-02" }
 */
export async function POST(request: NextRequest) {
  const { startMonth, endMonth } = await request.json();

  if (!startMonth || !endMonth) {
    return NextResponse.json(
      { error: 'startMonth and endMonth are required (YYYY-MM)' },
      { status: 400 }
    );
  }

  const results: { month: string; status: string; error?: string }[] = [];

  // Generate all months in range
  const [startYear, startMo] = startMonth.split('-').map(Number);
  const [endYear, endMo] = endMonth.split('-').map(Number);

  let year = startYear;
  let month = startMo;

  while (year < endYear || (year === endYear && month <= endMo)) {
    const monthStr = `${year}-${String(month).padStart(2, '0')}-01`;

    try {
      await computeMonthlySnapshot(monthStr);
      results.push({ month: monthStr, status: 'success' });
      console.log(`✅ Snapshot computed: ${monthStr}`);
    } catch (err) {
      results.push({ month: monthStr, status: 'error', error: (err as Error).message });
      console.error(`❌ Snapshot error: ${monthStr}:`, err);
    }

    // Advance to next month
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  return NextResponse.json({
    success: true,
    total: results.length,
    successCount,
    errorCount,
    results,
  });
}
