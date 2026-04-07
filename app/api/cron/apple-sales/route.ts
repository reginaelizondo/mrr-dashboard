import { NextRequest, NextResponse } from 'next/server';
import { syncAppleSalesRecent } from '@/lib/sync/apple-sales';
import { createServerClient } from '@/lib/supabase/server';

export const maxDuration = 300;

/**
 * Daily cron: pulls yesterday and the prior 4 days of Apple SALES (DAILY)
 * report. Apple sometimes revises recent days. Idempotent — uses
 * delete-then-insert per begin_date.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data: syncLog } = await supabase
    .from('sync_log')
    .insert({
      source: 'apple',
      sync_type: 'daily',
      status: 'running',
    })
    .select()
    .single();

  try {
    const result = await syncAppleSalesRecent(5);

    if (syncLog) {
      await supabase
        .from('sync_log')
        .update({
          status: result.errors.length > 0 ? 'error' : 'success',
          completed_at: new Date().toISOString(),
          records_synced: result.rows,
          error_message: result.errors.join('\n') || null,
          details: { ...result, source: 'apple-sales' },
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json({ success: true, ...result });
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
