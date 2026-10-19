import { NextRequest, NextResponse } from 'next/server';
import { buildEstela, postEstela } from '@/lib/estela/estela';

export const maxDuration = 180;

/**
 * Estela · estratega semanal de BizOps → #bizops-finanzas-agentes.
 * Programada los lunes 14:00 UTC (08:00 MX). Ver agents/estela/CLAUDE.md.
 *
 * Query params (opcionales):
 *   dry=1             arma pero no publica ni guarda; devuelve texto, hechos y propuestas
 *   llm=0             sin Claude (solo hechos)
 *   today=YYYY-MM-DD  simula otra fecha (MX)
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const dry = sp.get('dry') === '1';
  const llm = sp.get('llm') !== '0';
  const today = sp.get('today') ?? undefined;
  try {
    const result = await buildEstela({ today, llm, save: !dry });
    if (dry) {
      return NextResponse.json({ ok: true, posted: false, text: result.text, facts: result.facts, narrative: result.narrative });
    }
    const r = await postEstela(result);
    if (!r.ok) return NextResponse.json({ ok: false, posted: false, error: r.error, text: result.text }, { status: 500 });
    return NextResponse.json({ ok: true, posted: true, ts: r.ts, proposals: result.saved });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[estela] failed:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
