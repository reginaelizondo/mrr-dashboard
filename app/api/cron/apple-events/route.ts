import { NextRequest, NextResponse } from 'next/server';
import { format, subDays } from 'date-fns';
import { syncAppleEventsRange } from '@/lib/sync/apple-events';
import { createServerClient } from '@/lib/supabase/server';

export const maxDuration = 300;

/**
 * Daily cron: pulls yesterday and the prior 2 days of Apple SUBSCRIPTION_EVENT
 * data (Apple may revise recent days). Idempotent — uses delete-then-insert.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerClient();
  const now = new Date();
  // Apple publishes daily reports the next day; sync yesterday + 2 days back
  const start = format(subDays(now, 3), 'yyyy-MM-dd');
  const end = format(subDays(now, 1), 'yyyy-MM-dd');

  const { data: syncLog } = await supabase
    .from('sync_log')
    .insert({
      source: 'apple',
      sync_type: 'daily',
      status: 'running',
      date_range_start: start,
      date_range_end: end,
    })
    .select()
    .single();

  try {
    const result = await syncAppleEventsRange(start, end);

    // Refresh the refund breakdown materialized views so /dashboard/refunds
    // reflects fresh data without waiting a full day. Failure here is
    // non-fatal — the sync itself already succeeded and the MVs just stay on
    // their previous refresh until the next run.
    let mvRefresh: 'ok' | 'skipped' | 'error' = 'skipped';
    const { error: mvErr } = await supabase.rpc('refresh_apple_refund_mvs');
    if (mvErr) {
      console.error('[cron/apple-events] MV refresh failed:', mvErr);
      mvRefresh = 'error';
    } else {
      mvRefresh = 'ok';
    }

    if (syncLog) {
      await supabase
        .from('sync_log')
        .update({
          status: 'success',
          completed_at: new Date().toISOString(),
          records_synced: result.totalRows,
          details: { ...result, source: 'apple-events', mvRefresh },
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json({ success: true, ...result, mvRefresh });
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
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
