import { NextRequest, NextResponse } from 'next/server';
import { runCal, mensajesCal, postCal } from '@/lib/cal/cal';

export const maxDuration = 60;

/**
 * Cal · calendario de cumplimiento → #bizops-finanzas-agentes (lo de RH → #bizops-rh-agentes).
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
    const mensajes = mensajesCal(run);
    if (!mensajes.length) return NextResponse.json({ ok: true, posted: false, reason: 'nada que avisar hoy', today: run.today });
    if (dry) return NextResponse.json({ ok: true, posted: false, mensajes: mensajes.map((m) => ({ canal: m.canal, text: m.message.text })), run });
    const rs = await Promise.all(mensajes.map((m) => postCal(m.message, m.canal)));
    const ok = rs.every((r) => r.ok);
    return NextResponse.json({ ok, posted: ok, ts: rs.map((r) => r.ts), error: rs.find((r) => !r.ok)?.error }, { status: ok ? 200 : 500 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
