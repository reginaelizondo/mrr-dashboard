import { NextRequest, NextResponse } from 'next/server';
import { guardarCorrida, decisiones, publicar, mensajeInmediato, canalDe, SEMAFOROS, type ItemIn, type Semaforo } from '@/lib/bizops/brief';

export const maxDuration = 30;

/**
 * Brief BizOps · puerta de entrada de los agentes del correo (repo bandeja-pepis, scripts/brief.py).
 * Auth: Authorization: Bearer BIZOPS_BRIEF_SECRET.
 *
 * POST { agente, semaforo, resumen, items: [{ref, texto, emoji?, prioridad?, link?, estado?}], publicar?, nota? }
 *      nota (markdown de Slack, máx. 2,500 caracteres) se publica tal cual como mensaje propio en el canal del agente
 *      (ej. Nora: los 5 bullets del P&L para Luis cuando Arrowpoint ya quedó aprobado).
 *      guarda la corrida y sus pendientes; publicar=true los manda a Slack al momento (VOBO del mismo día).
 * GET  ?agente=Oli&dias=7   lo que Pepis decidió en Slack (hecho · manana · no) para que el agente actúe.
 */
const AGENTES = new Set(['Oli', 'Tere', 'Marco', 'Quina', 'Sol', 'Ciro', 'Dalia', 'Mila', 'Rosa', 'Coco', 'Nora', 'Paco', 'Flor', 'Cobra', 'Leo']);
const auth = (r: NextRequest) => !!process.env.BIZOPS_BRIEF_SECRET && r.headers.get('authorization') === `Bearer ${process.env.BIZOPS_BRIEF_SECRET}`;

export async function POST(request: NextRequest) {
  if (!auth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const b = await request.json();
    const agente = String(b.agente ?? '');
    if (!AGENTES.has(agente)) return NextResponse.json({ error: `agente desconocido: ${agente}` }, { status: 400 });
    const semaforo = (SEMAFOROS as readonly string[]).includes(b.semaforo) ? (b.semaforo as Semaforo) : '🟡';
    const items: ItemIn[] = Array.isArray(b.items) ? b.items.filter((i: ItemIn) => i && i.ref && i.texto).slice(0, 30) : [];
    const guardados = await guardarCorrida(agente, semaforo, String(b.resumen ?? ''), items);
    let posted: { ok: boolean; ts?: string; error?: string } | null = null;
    const nota = typeof b.nota === 'string' ? b.nota.trim().slice(0, 2500) : '';
    if (nota) {
      const titulo = `${semaforo} ${agente} · ${String(b.resumen ?? '')}`.slice(0, 150);
      posted = await publicar({ text: `${titulo}\n${nota}`.slice(0, 2900), blocks: [
        { type: 'header', text: { type: 'plain_text', text: titulo } },
        { type: 'section', text: { type: 'mrkdwn', text: nota } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `🤖 ${agente} · propone, no envía. Pepis decide.` }] },
      ] }, canalDe(agente));
    } else if (b.publicar && guardados.some((i) => i.estado === 'pendiente')) {
      posted = await publicar(mensajeInmediato(agente, semaforo, String(b.resumen ?? ''), guardados), canalDe(agente));
    }
    return NextResponse.json({ ok: true, guardados: guardados.length, posted });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  if (!auth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const agente = sp.get('agente') ?? '';
  if (!AGENTES.has(agente)) return NextResponse.json({ error: 'agente requerido' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, decisiones: await decisiones(agente, Math.min(60, Number(sp.get('dias') ?? 7) || 7)) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
