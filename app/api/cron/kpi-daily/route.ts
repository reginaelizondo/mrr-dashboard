import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { runDailyKpiSync, syncKpiDaily, fetchBigQueryModified, KPI_DAILY_WINDOW_DAYS } from '@/lib/sync/kpi-daily';
import { createServerClient } from '@/lib/supabase/server';
import { todayMx, addDays } from '@/lib/kpi/period';

export const maxDuration = 300;

/**
 * Replica kpi_daily + kpi_rollup.
 *  - 15:10 UTC (full): runDailyKpiSync — last 95 days, one older month in rotation, then compares
 *    the whole history against BigQuery (day × OS) and re-syncs the days that drifted.
 *  - every 30 min `?mode=if-changed`: if dbt rebuilt an_operational_dash since the last sync, re-sync
 *    the last 95 days (dbt rebuilds several times a day; without this the dashboard lagged hours).
 *  - `?from=YYYY-MM-DD&to=YYYY-MM-DD`: re-sync just that range.
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const from = sp.get('from'); const to = sp.get('to');
  const ifChanged = sp.get('mode') === 'if-changed';
  const supabase = createServerClient();

  if (ifChanged) {
    const bqModified = await fetchBigQueryModified();
    const { data: last } = await supabase.from('sync_log').select('details').eq('source', 'kpi_daily').eq('status', 'success')
      .order('started_at', { ascending: false }).limit(1);
    const lastBq = ((last ?? [])[0]?.details as { bqModified?: string } | null)?.bqModified ?? null;
    if (bqModified && lastBq && bqModified <= lastBq) return NextResponse.json({ ok: true, skipped: true, bqModified, lastBq });
  }

  const { data: log, error: logErr } = await supabase.from('sync_log').insert({ source: 'kpi_daily', sync_type: from || ifChanged ? 'manual' : 'daily', status: 'running' }).select().single();
  if (logErr) console.error('[kpi-daily] sync_log insert failed:', logErr.message);
  try {
    let result: Record<string, unknown> & { rows?: number };
    if (from && to) result = await syncKpiDaily(from, to);
    else if (ifChanged) {
      const bqModified = await fetchBigQueryModified();
      const today = todayMx();
      const r = await syncKpiDaily(addDays(today, -KPI_DAILY_WINDOW_DAYS), today);
      result = { mode: 'if-changed', bqModified, ...r };
    } else {
      const r = await runDailyKpiSync(todayMx());
      result = { ...r, rows: r.window.rows };
    }
    if (log) await supabase.from('sync_log').update({ status: 'success', completed_at: new Date().toISOString(), records_synced: result.rows ?? 0, details: result }).eq('id', log.id);
    // La réplica cambió: invalida la caché del dashboard Operativo (expira ya, no "stale-while-revalidate").
    revalidateTag('operativo', { expire: 0 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (log) await supabase.from('sync_log').update({ status: 'error', completed_at: new Date().toISOString(), details: { error: msg } }).eq('id', log.id);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
