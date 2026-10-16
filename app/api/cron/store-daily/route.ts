import { NextRequest, NextResponse } from 'next/server';
import { runStoreDailySync, syncStoreDaily } from '@/lib/sync/store-daily';
import { todayMx } from '@/lib/kpi/period';

export const maxDuration = 300;

/**
 * Ventas por tienda (store_daily) + recalibración del Corregido. Ver lib/sync/store-daily.ts.
 *  - cada hora `?days=10`: Stripe y el reporte diario de Google cambian durante el día.
 *  - diario `?days=75`: recoge el earnings mensual de Google (≈ día 5) y los días que Apple publica tarde.
 *  - `?from=YYYY-MM-DD&to=YYYY-MM-DD`: rango manual.
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  try {
    const from = sp.get('from'); const to = sp.get('to');
    const result = from && to ? await syncStoreDaily(from, to) : await runStoreDailySync(todayMx(), Math.min(120, Number(sp.get('days') ?? 10)));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[store-daily] failed:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
