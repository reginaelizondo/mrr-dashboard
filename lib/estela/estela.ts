/**
 * Estela · corrida semanal.
 *
 * 1. Arma la hoja de hechos (facts.ts).
 * 2. Pide a Claude tres propuestas (writer.ts).
 * 3. Guarda las propuestas en Supabase (estela_proposals) para dar seguimiento.
 * 4. Publica en #bizops-finanzas-agentes con botones Acepto / No por propuesta.
 *
 * Si Claude falla, publica solo los hechos y lo dice: el lunes nunca se queda sin mensaje.
 */
import { buildEstelaFacts, type EstelaFacts } from './facts';
import { writeEstela, type EstelaNarrative, type Proposal } from './writer';
import { createServerClient } from '@/lib/supabase/server';
import { postChatMessage, type SlackMessage } from '@/lib/slack/post';
import { todayMx, mondayOf } from '@/lib/kpi/period';

type SlackBlock = NonNullable<SlackMessage['blocks']>[number];

export const ESTELA_CHANNEL = () => process.env.ESTELA_SLACK_CHANNEL ?? 'C0CAJT405R7';

export interface EstelaResult {
  facts: EstelaFacts;
  narrative: EstelaNarrative | null;
  saved: Array<{ id: number | null; titulo: string }>;
  message: SlackMessage;
  text: string;
}

const TIPO_ICON: Record<Proposal['tipo'], string> = { ahorro: '💸', ingreso: '📈', cobranza: '🧾', riesgo: '🛡️', pricing: '🏷️', otro: '📌' };

function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function proposalBlocks(p: Proposal, id: number | null, n: number): SlackBlock[] {
  const head = `*${n}. ${TIPO_ICON[p.tipo]} ${p.titulo}*  ·  *${p.impactoCash}*  ·  se ve en ${p.cuandoSeVe}  ·  dueño: ${p.dueno}`;
  const body = `${p.que}\n_Cómo se calculó:_ ${p.comoSeCalculo}\n_Riesgo:_ ${p.riesgo}`;
  const blocks: SlackBlock[] = [section(head), section(body)];
  if (id !== null) {
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', action_id: 'estela_accept', value: String(id), text: { type: 'plain_text', text: '✅ Acepto' } },
        { type: 'button', action_id: 'estela_reject', value: String(id), text: { type: 'plain_text', text: '✖ No por ahora' } },
      ],
    });
  }
  return blocks;
}

function factsBlocks(f: EstelaFacts): SlackBlock[] {
  const k = f.kpisSemanales;
  const pick = ['Spend', 'New Subs', 'CAC', 'New Subs Sales', 'Net Sales', 'Total Contribution', 'Refunds'];
  const kpiLine = pick.map((l) => `${l} *${k.ultima.kpis[l] ?? 'n/a'}* (ant. ${k.anterior.kpis[l] ?? 'n/a'})`).join('  ·  ');
  const out: SlackBlock[] = [section(`*Semana ${k.ultima.rango}*  ${kpiLine}`)];
  if (f.mrr) out.push(section(`*MRR neto* ${f.mrr.mrrNeto} al ${f.mrr.fecha}  ·  hace 30 d ${f.mrr.hace30d}  ·  Apple ${f.mrr.porTienda.Apple} · Google ${f.mrr.porTienda.Google} · Stripe ${f.mrr.porTienda.Stripe}`));
  if (f.pnl) {
    const ebitda = f.pnl.lineas.find((l) => l.linea === 'EBITDA');
    const opex = f.pnl.lineas.find((l) => l.linea === 'Total Operating Expenses');
    out.push(section(`*P&L ${f.pnl.mes}*  EBITDA ${ebitda?.ultimoMes ?? 'n/a'} (budget ${ebitda?.budgetMes ?? 'n/a'})  ·  Opex ${opex?.ultimoMes ?? 'n/a'} (budget ${opex?.budgetMes ?? 'n/a'})`));
  }
  return out;
}

export function renderText(f: EstelaFacts, n: EstelaNarrative | null): string {
  const lines: string[] = [`Estela · ${f.semana}`];
  if (n) {
    lines.push('', n.lectura, '');
    n.propuestas.forEach((p, i) => {
      lines.push(`${i + 1}. ${p.titulo} · ${p.impactoCash} · se ve en ${p.cuandoSeVe} · dueño ${p.dueno}`);
      lines.push(`   ${p.que}`);
      lines.push(`   Cómo se calculó: ${p.comoSeCalculo}`);
      lines.push(`   Riesgo: ${p.riesgo}`);
    });
    if (n.seguimiento.length) { lines.push('', 'Seguimiento'); n.seguimiento.forEach((s) => lines.push(`- ${s}`)); }
  } else {
    lines.push('', 'No pude redactar propuestas esta semana; van los hechos.');
  }
  lines.push('', `Fuentes: ${f.fuentes.join(' · ')}`);
  f.notas.forEach((x) => lines.push(`Nota: ${x}`));
  return lines.join('\n');
}

async function saveProposals(weekStart: string, props: Proposal[]): Promise<Array<{ id: number | null; titulo: string }>> {
  try {
    const sb = createServerClient();
    const rows = props.map((p) => ({
      week_start: weekStart, titulo: p.titulo, que: p.que, impacto_cash: p.impactoCash, como_se_calculo: p.comoSeCalculo,
      riesgo: p.riesgo, cuando_se_ve: p.cuandoSeVe, dueno: p.dueno, tipo: p.tipo, estado: 'propuesta',
    }));
    const { data, error } = await sb.from('estela_proposals').insert(rows).select('id, titulo');
    if (error) { console.error('[estela] save failed:', error.message); return props.map((p) => ({ id: null, titulo: p.titulo })); }
    return (data as Array<{ id: number; titulo: string }>).map((r) => ({ id: r.id, titulo: r.titulo }));
  } catch (e) {
    console.error('[estela] save failed:', e instanceof Error ? e.message : e);
    return props.map((p) => ({ id: null, titulo: p.titulo }));
  }
}

export async function buildEstela(opts: { today?: string; llm?: boolean; save?: boolean } = {}): Promise<EstelaResult> {
  const today = opts.today ?? todayMx();
  const facts = await buildEstelaFacts({ today });
  const narrative = opts.llm === false ? null : await writeEstela(facts);
  const saved = narrative && opts.save !== false ? await saveProposals(mondayOf(today), narrative.propuestas) : (narrative?.propuestas ?? []).map((p) => ({ id: null, titulo: p.titulo }));

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: `Estela · ${facts.semana}` } },
  ];
  if (narrative) {
    blocks.push(section(narrative.lectura));
    blocks.push({ type: 'divider' });
    narrative.propuestas.forEach((p, i) => blocks.push(...proposalBlocks(p, saved[i]?.id ?? null, i + 1)));
    if (narrative.seguimiento.length) {
      blocks.push({ type: 'divider' });
      blocks.push(section(`*Seguimiento*\n${narrative.seguimiento.map((s) => `• ${s}`).join('\n')}`));
    }
  } else {
    blocks.push(section('⚠️ No pude redactar propuestas esta semana. Van los hechos; Pepis decide con ellos.'));
  }
  blocks.push({ type: 'divider' });
  blocks.push(...factsBlocks(facts));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Fuentes: ${facts.fuentes.join(' · ')}${facts.notas.length ? '\n' + facts.notas.join('\n') : ''}\n🤖 Estela · propone, no ejecuta. Pepis decide.` }] });

  const text = renderText(facts, narrative);
  return { facts, narrative, saved, message: { text: text.slice(0, 2900), blocks }, text };
}

export async function postEstela(result: EstelaResult): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: 'SLACK_BOT_TOKEN not set' };
  return postChatMessage(token, ESTELA_CHANNEL(), result.message);
}

/** Cambia el estado de una propuesta (botones de Slack). */
export async function setProposalStatus(id: number, estado: 'aceptada' | 'rechazada', who?: string): Promise<{ ok: boolean; titulo?: string; error?: string }> {
  try {
    const sb = createServerClient();
    const { data, error } = await sb
      .from('estela_proposals')
      .update({ estado, decidido_por: who ?? null, decidido_en: new Date().toISOString() })
      .eq('id', id)
      .select('titulo')
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, titulo: (data as { titulo: string }).titulo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
