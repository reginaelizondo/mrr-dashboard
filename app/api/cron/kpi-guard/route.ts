import { NextRequest, NextResponse } from 'next/server';
import { runKpiGuard, recordAndAlert } from '@/lib/audit/kpi-guard';

export const maxDuration = 120;

/**
 * Guardia de KPIs (auditor automático) — cada hora. Guarda la corrida en kpi_guard_runs y avisa a Slack
 * solo cuando un chequeo empeora o se recupera. `?dry=1` corre sin guardar ni avisar.
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dry = request.nextUrl.searchParams.get('dry') === '1';
  try {
    const run = await runKpiGuard();
    const alert = dry ? { alerted: false, changes: [] } : await recordAndAlert(run);
    return NextResponse.json({ ok: true, ...run, ...alert });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
