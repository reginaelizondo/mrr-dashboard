import { NextRequest, NextResponse } from 'next/server';
import { format, subMonths, subDays } from 'date-fns';
import { syncKineduDB } from '@/lib/sync/kinedu-db';
import { computeMonthlySnapshot } from '@/lib/sync/snapshots';
import { createServerClient } from '@/lib/supabase/server';

export const maxDuration = 300; // 5 minutes — SSH tunnel + large queries need time

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerClient();
  const now = new Date();
  const today = format(now, 'yyyy-MM-dd');
  const yesterday = format(subDays(now, 1), 'yyyy-MM-dd');

  // Sync last 7 days to stay within Vercel function timeout
  // For full historical re-syncs, use the manual /api/sync/kinedu-db endpoint or local script
  const fromDate = format(subDays(now, 7), 'yyyy-MM-dd');
  const toDate = format(now, 'yyyy-MM-dd');

  // Create sync log entry
  const { data: syncLog } = await supabase
    .from('sync_log')
    .insert({
      source: 'all',
      sync_type: 'daily',
      status: 'running',
      date_range_start: fromDate,
      date_range_end: toDate,
    })
    .select()
    .single();

  try {
    const details: Record<string, unknown> = {};

    // Sync from Kinedu backend DB (same source of truth as Tableau)
    const result = await syncKineduDB(fromDate, toDate);
    details.kineduDb = {
      status: 'success',
      fetched: result.fetched,
      synced: result.synced,
      fromDate,
      toDate,
    };

    // Compute monthly MRR snapshot for the current month
    await computeMonthlySnapshot(today);

    // Also recompute previous month if we're in the first few days (late-arriving data)
    if (now.getDate() <= 3) {
      await computeMonthlySnapshot(yesterday);
    }

    details.snapshots = { current: format(now, 'yyyy-MM'), recomputedPrevious: now.getDate() <= 3 };

    // Update sync log with success
    if (syncLog) {
      await supabase
        .from('sync_log')
        .update({
          status: 'success',
          completed_at: new Date().toISOString(),
          records_synced: result.synced,
          details,
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json({
      success: true,
      records: result.synced,
      details,
    });
  } catch (err) {
    if (syncLog) {
      await supabase
        .from('sync_log')
        .update({
          status: 'error',
          completed_at: new Date().toISOString(),
          error_message: (err as Error).message,
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
