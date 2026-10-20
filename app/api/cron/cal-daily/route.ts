import { NextRequest, NextResponse } from 'next/server';
import { runCal, buildCalMessage, postCal } from '@/lib/cal/cal';

export const maxDuration = 60;

/**
 * Cal · calendario de cumplimiento → #bizops-finanzas-agentes.
 * Diario 14:05 UTC (08:05 MX). Publica solo si hoy cae un umbral de alerta (30/15/5/1/0 días),
 * si algo pasó de fecha en los últimos 14 días, o si es lunes (resumen de 45 días).
 *
 *   dry=1             arma y devuelve, no publica
 *   today=YYYY-MM-DD  simula otra fecha (MX)
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const dry = sp.get('dry') === '1';
  const today = sp.get('today') ?? undefined;
  try {
    const run = await runCal(today);
    const message = buildCalMessage(run);
    if (!message) return NextResponse.json({ ok: true, posted: false, reason: 'nada que avisar hoy', today: run.today });
    if (dry) return NextResponse.json({ ok: true, posted: false, text: message.text, run });
    const r = await postCal(message);
    return NextResponse.json({ ok: r.ok, posted: r.ok, ts: r.ts, error: r.error }, { status: r.ok ? 200 : 500 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
