import { NextRequest, NextResponse } from 'next/server';
import { armarBrief, publicar, guardarTsBrief } from '@/lib/bizops/brief';

export const maxDuration = 60;

/**
 * Brief BizOps → #bizops-finanzas-agentes. Lun–vie 15:15 UTC (09:15 MX), después de Oli (8:15) y Tere (8:45).
 * Un solo mensaje: semáforo, cada pendiente con botones y la salud de los agentes. Publica aunque no haya
 * pendientes ("nada para ti hoy") para que se note si un agente no corrió.
 *   dry=1             arma y devuelve, no publica
 *   today=YYYY-MM-DD  simula otra fecha (MX)
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  try {
    const { message, pendientes } = await armarBrief(sp.get('today') ?? undefined);
    if (sp.get('dry') === '1') return NextResponse.json({ ok: true, posted: false, pendientes, text: message.text, blocks: message.blocks });
    const r = await publicar(message);
    if (r.ok && r.ts) await guardarTsBrief(r.ts);
    return NextResponse.json({ ok: r.ok, posted: r.ok, pendientes, ts: r.ts, error: r.error }, { status: r.ok ? 200 : 500 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
