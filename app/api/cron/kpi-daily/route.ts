import { NextRequest, NextResponse } from 'next/server';
import { syncKpiDaily } from '@/lib/sync/kpi-daily';
import { createServerClient } from '@/lib/supabase/server';
import { addDays, todayMx } from '@/lib/kpi/period';

export const maxDuration = 300;

/**
 * Refresh the kpi_daily replica (last 21 days — refunds attributed to the sale
 * date keep landing for ~2 weeks). Scheduled 15:10 UTC, right after the ~15:01
 * UTC dbt rebuild. `?from=YYYY-MM-DD&to=YYYY-MM-DD` overrides the window.
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const today = todayMx();
  const to = sp.get('to') ?? today;
  const from = sp.get('from') ?? addDays(today, -21);
  const supabase = createServerClient();
  const { data: log } = await supabase.from('sync_log').insert({ source: 'kpi_daily', sync_type: 'daily', status: 'running' }).select().single();
  try {
    const result = await syncKpiDaily(from, to);
    if (log) await supabase.from('sync_log').update({ status: 'success', completed_at: new Date().toISOString(), records_synced: result.rows, details: result }).eq('id', log.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (log) await supabase.from('sync_log').update({ status: 'error', completed_at: new Date().toISOString(), details: { error: msg } }).eq('id', log.id);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
