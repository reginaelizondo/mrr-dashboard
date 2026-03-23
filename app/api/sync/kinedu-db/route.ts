import { NextRequest, NextResponse } from 'next/server';
import { format, subMonths } from 'date-fns';
import { syncKineduDB } from '@/lib/sync/kinedu-db';
import { computeMonthlySnapshot } from '@/lib/sync/snapshots';
import { createServerClient } from '@/lib/supabase/server';

export const maxDuration = 120; // Allow longer for manual syncs

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));

  // Default: sync last 2 months
  const now = new Date();
  const defaultFrom = format(subMonths(now, 2), 'yyyy-MM-01');
  const defaultTo = format(now, 'yyyy-MM-dd');

  const fromDate = body.fromDate || defaultFrom;
  const toDate = body.toDate || defaultTo;

  const supabase = createServerClient();

  // Create sync log entry
  const { data: syncLog } = await supabase
    .from('sync_log')
    .insert({
      source: 'all',
      sync_type: 'manual',
      status: 'running',
      date_range_start: fromDate,
      date_range_end: toDate,
    })
    .select()
    .single();

  try {
    // 1. Sync transactions from Kinedu DB
    const result = await syncKineduDB(fromDate, toDate);

    // 2. Recompute snapshots for affected months
    const startMonth = new Date(fromDate + 'T00:00:00Z');
    const endMonth = new Date(toDate + 'T00:00:00Z');
    const snapshotsComputed: string[] = [];

    const current = new Date(startMonth.getUTCFullYear(), startMonth.getUTCMonth(), 1);
    while (current <= endMonth) {
      const monthStr = format(current, 'yyyy-MM-dd');
      await computeMonthlySnapshot(monthStr);
      snapshotsComputed.push(format(current, 'yyyy-MM'));
      current.setMonth(current.getMonth() + 1);
    }

    // 3. Update sync log with success
    if (syncLog) {
      await supabase
        .from('sync_log')
        .update({
          status: 'success',
          completed_at: new Date().toISOString(),
          records_synced: result.synced,
          details: {
            source: 'kinedu-db',
            fetched: result.fetched,
            synced: result.synced,
            fromDate,
            toDate,
            snapshotsComputed,
          },
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json({
      success: true,
      records: result.synced,
      fetched: result.fetched,
      fromDate,
      toDate,
      snapshotsComputed,
    });
  } catch (err) {
    // Update sync log with error
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
