import { NextRequest, NextResponse } from 'next/server';
import { runDailyKpiSync, syncKpiDaily } from '@/lib/sync/kpi-daily';
import { createServerClient } from '@/lib/supabase/server';
import { todayMx } from '@/lib/kpi/period';

export const maxDuration = 300;

/**
 * Daily refresh of the kpi_daily replica + kpi_rollup. Scheduled 15:10 UTC, right after the
 * ~15:01 UTC dbt rebuild. Runs runDailyKpiSync: last 95 days, one older month in rotation,
 * then compares the whole history against BigQuery and re-syncs the days that drifted.
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` re-syncs just that range instead.
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const from = sp.get('from'); const to = sp.get('to');
  const supabase = createServerClient();
  const { data: log, error: logErr } = await supabase.from('sync_log').insert({ source: 'kpi_daily', sync_type: from ? 'manual' : 'daily', status: 'running' }).select().single();
  if (logErr) console.error('[kpi-daily] sync_log insert failed (¿falta la migración 034?):', logErr.message);
  try {
    const result = from && to ? await syncKpiDaily(from, to) : await runDailyKpiSync(todayMx());
    const rows = 'rows' in result ? result.rows : result.window.rows;
    if (log) await supabase.from('sync_log').update({ status: 'success', completed_at: new Date().toISOString(), records_synced: rows, details: result }).eq('id', log.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (log) await supabase.from('sync_log').update({ status: 'error', completed_at: new Date().toISOString(), details: { error: msg } }).eq('id', log.id);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
