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

  // Sync last 3 days to stay within Vercel function timeout (~300s)
  // For full historical re-syncs, use the manual /api/sync/kinedu-db endpoint or local script
  const fromDate = format(subDays(now, 3), 'yyyy-MM-dd');
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

    // Recompute the last 3 monthly snapshots every day. Snapshots were
    // previously only touching the current month (plus previous month on days
    // 1-3), which left prior months permanently frozen once that 3-day window
    // passed — causing the "stale Feb" problem. Always recomputing the last 3
    // is cheap (3 upserts of aggregate rows) and catches any late-arriving
    // transactions that land after month end.
    const monthsToRecompute = [
      today,                                           // current month
      format(subMonths(now, 1), 'yyyy-MM-01'),         // previous month
      format(subMonths(now, 2), 'yyyy-MM-01'),         // two months ago
    ];
    for (const m of monthsToRecompute) {
      await computeMonthlySnapshot(m);
    }

    details.snapshots = { recomputed: monthsToRecompute };

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
