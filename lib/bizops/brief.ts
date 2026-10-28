/**
 * Brief BizOps · un solo reporte diario en Slack con lo que Pepis tiene que decidir.
 *
 * 1. Los agentes del correo (repo bandeja-pepis) mandan sus "para ti" a POST /api/bizops/items.
 * 2. A las 9:15 MX (lun–vie) el cron /api/cron/bizops-brief publica UN mensaje en #bizops-finanzas-agentes:
 *    semáforo + cada pendiente con botones ✅ Hecho · ⏭️ Mañana · ✖ No aplica + la salud de cada agente.
 * 3. Los botones guardan la decisión (bizops_items.estado); los agentes la leen con GET /api/bizops/items.
 * Lo urgente del mismo día (Marco el martes, Quina antes del VOBO) se publica al momento con publicar=true.
 */
import { createServerClient } from '@/lib/supabase/server';
import { postChatMessage, updateChatMessage, type SlackBlock, type SlackMessage } from '@/lib/slack/post';
import { todayMx } from '@/lib/kpi/period';

export const BRIEF_CHANNEL = () => process.env.BIZOPS_BRIEF_CHANNEL ?? process.env.ESTELA_SLACK_CHANNEL ?? 'C0CAJT405R7';
/** Agentes con canal propio: sus pendientes no van al brief de finanzas sino a su canal (nómina → #bizops-rh-agentes). */
const RH = () => process.env.BIZOPS_RH_CHANNEL ?? 'C0CAGQN5FKL';
const CANAL_POR_AGENTE: Record<string, () => string> = { Quina: RH, Rosa: RH, Coco: RH, Fito: RH, Ruth: RH };
export const canalDe = (agente: string) => (CANAL_POR_AGENTE[agente] ?? BRIEF_CHANNEL)();
/** Un pendiente con ref "rh:…" va a #bizops-rh-agentes aunque lo mande un agente de finanzas (Dalia: todo lo de Coba es de Paola). */
export const esRH = (i: { agente: string; ref: string }) => !!CANAL_POR_AGENTE[i.agente] || i.ref.startsWith('rh:');
export const RH_CHANNEL = RH;
export const SEMAFOROS = ['🟢', '🟡', '🔴'] as const;
export type Semaforo = (typeof SEMAFOROS)[number];
export type Estado = 'pendiente' | 'manana' | 'hecho' | 'no';

export interface ItemIn { ref: string; texto: string; emoji?: string; prioridad?: 'urgente' | 'decide' | 'info'; link?: string; estado?: Estado; propuesta?: string }
export interface Item extends Required<Pick<ItemIn, 'ref' | 'texto'>> {
  id: number; agente: string; emoji: string | null; prioridad: 'urgente' | 'decide' | 'info'; link: string | null;
  estado: Estado; decidido_por: string | null; decidido_en: string | null; primera_vez: string; ultima_vez: string;
  propuesta?: string | null; respuesta?: string | null;
}

/** Agentes que deben correr cada día hábil: si no reportan, el brief lo dice. */
const DIARIOS = ['Oli', 'Tina', 'Celia', 'Ruth'];
/** Pepis habla con 4 jefas (27-oct); los agentes de cada equipo no salen con su nombre en Slack. */
export const JEFAS: Record<string, { area: string; emoji: string; equipo: string[] }> = {
  Oli: { area: 'Bandeja', emoji: '📥', equipo: ['Oli', 'Tere', 'Dalia'] },
  Tina: { area: 'Tesorería', emoji: '💸', equipo: ['Marco', 'Flor', 'Mila', 'Sol', 'Sela', 'Cobra'] },
  Celia: { area: 'Cierre y cumplimiento', emoji: '📚', equipo: ['Ciro', 'Tesa', 'Greta', 'Nora', 'Paco', 'Vera', 'Leo'] },
  Ruth: { area: 'RH', emoji: '👥', equipo: ['Quina', 'Rosa', 'Coco', 'Fito'] },
};
export const jefaDe = (agente: string) => Object.keys(JEFAS).find((j) => j === agente || JEFAS[j].equipo.includes(agente)) ?? agente;
const ORDEN: Record<string, number> = { urgente: 0, decide: 1, info: 2 };
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fechaCorta = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${DIAS[t.getUTCDay()]} ${t.getUTCDate()}-${MESES[t.getUTCMonth()]}`; };
const limpia = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Gmail: "#…?compose=thread-f:123%2Bmsg-a:…" abre un correo nuevo en blanco; "#all/thread-f:123" abre el hilo (con su borrador). */
export function linkHilo(link: string): string {
  const m = link.match(/[?&]compose=(thread-f(?::|%3A)\d+)/i);
  if (!m) return link;
  return `${link.split('#')[0]}#all/${decodeURIComponent(m[1])}`;
}

export async function guardarCorrida(agente: string, semaforo: Semaforo, resumen: string, items: ItemIn[]) {
  const sb = createServerClient();
  const hoy = todayMx();
  const { error: e1 } = await sb.from('bizops_runs').insert({ agente, fecha: hoy, semaforo, resumen: limpia(resumen, 160) });
  if (e1) throw new Error(`bizops_runs: ${e1.message}`);
  if (!items.length) return [] as Item[];
  // Un pendiente que ya existe solo se refresca; si Pepis ya lo decidió, no se reabre salvo que el agente mande estado.
  const { data: previos } = await sb.from('bizops_items').select('ref, estado').eq('agente', agente).in('ref', items.map((i) => i.ref));
  const prev = new Map((previos ?? []).map((p: { ref: string; estado: Estado }) => [p.ref, p.estado]));
  const rows = items.map((i) => ({
    agente, ref: limpia(i.ref, 200), texto: limpia(i.texto, 140), emoji: limpia(i.emoji, 4) || null,
    prioridad: ['urgente', 'decide', 'info'].includes(i.prioridad ?? '') ? i.prioridad : 'decide',
    link: linkHilo(limpia(i.link, 500)) || null, ultima_vez: hoy,
    ...(i.propuesta ? { propuesta: limpia(i.propuesta, 400) } : {}),
    estado: i.estado ?? (prev.get(i.ref) === 'manana' ? 'pendiente' : prev.get(i.ref) ?? 'pendiente'),
  }));
  const { data, error } = await sb.from('bizops_items').upsert(rows, { onConflict: 'agente,ref' }).select('*');
  if (error) throw new Error(`bizops_items: ${error.message}`);
  return (data ?? []) as Item[];
}

export async function decisiones(agente: string, dias: number) {
  const sb = createServerClient();
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const { data, error } = await sb.from('bizops_items').select('ref, texto, estado, decidido_por, decidido_en, propuesta, respuesta')
    .eq('agente', agente).gte('decidido_en', desde).order('decidido_en', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function decidir(id: number, estado: Estado, quien?: string, respuesta?: string) {
  const sb = createServerClient();
  const { data, error } = await sb.from('bizops_items')
    .update({ estado, decidido_por: quien ?? null, decidido_en: new Date().toISOString(), ...(respuesta !== undefined ? { respuesta } : {}) })
    .eq('id', id).select('texto, agente').single();
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const, texto: (data as { texto: string }).texto, agente: (data as { agente: string }).agente };
}

function itemBlocks(it: Item, hoy: string): SlackBlock[] {
  const dias = Math.round((Date.parse(hoy) - Date.parse(it.primera_vez)) / 86400000);
  const edad = dias <= 0 ? 'nuevo' : dias === 1 ? 'desde ayer' : `hace ${dias} días`;
  const abrir = it.link ? ` · <${it.link}|abrir>` : '';
  if (it.propuesta) {
    // Propuesta con destino (Tere): Pepis acepta, escribe otra carpeta o dice que no se guarda
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `${it.emoji ?? '📁'} *${it.texto}*\nPropongo guardar en: \`${it.propuesta}\`\n${jefaDe(it.agente)} · ${edad}${abrir}` } },
      {
        type: 'actions', block_id: `bz_${it.id}`,
        elements: [
          { type: 'button', style: 'primary', action_id: 'bizops_hecho', value: String(it.id), text: { type: 'plain_text', text: '✅ Guardar ahí' } },
          { type: 'button', action_id: 'bizops_otra', value: String(it.id), text: { type: 'plain_text', text: '✏️ Otra carpeta' } },
          { type: 'button', action_id: 'bizops_no', value: String(it.id), text: { type: 'plain_text', text: '✖ No guardar' } },
        ],
      },
    ] as SlackBlock[];
  }
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${it.emoji ?? '•'} *${it.texto}*\n${jefaDe(it.agente)} · ${edad}${abrir}` } },
    {
      type: 'actions', block_id: `bz_${it.id}`,
      elements: [
        { type: 'button', style: 'primary', action_id: 'bizops_hecho', value: String(it.id), text: { type: 'plain_text', text: '✅ Hecho' } },
        { type: 'button', action_id: 'bizops_manana', value: String(it.id), text: { type: 'plain_text', text: '⏭️ Mañana' } },
        { type: 'button', action_id: 'bizops_no', value: String(it.id), text: { type: 'plain_text', text: '✖ No aplica' } },
      ],
    },
  ] as SlackBlock[];
}

export async function armarBrief(hoy = todayMx()): Promise<{ message: SlackMessage; pendientes: number }> {
  const sb = createServerClient();
  const { data: its } = await sb.from('bizops_items').select('*').in('estado', ['pendiente', 'manana']);
  const orden = Object.keys(JEFAS);
  const items = ((its ?? []) as Item[]).filter((i) => !esRH(i)).sort((a, b) => ORDEN[a.prioridad] - ORDEN[b.prioridad] || orden.indexOf(jefaDe(a.agente)) - orden.indexOf(jefaDe(b.agente)) || a.primera_vez.localeCompare(b.primera_vez));
  const { data: runs } = await sb.from('bizops_runs').select('agente, semaforo, resumen, created_at').eq('fecha', hoy).order('created_at', { ascending: false });
  const ultima = new Map<string, { semaforo: string; resumen: string | null }>();
  for (const r of (runs ?? []) as { agente: string; semaforo: string; resumen: string | null }[]) if (!ultima.has(r.agente)) ultima.set(r.agente, r);
  const dow = new Date(`${hoy}T12:00:00Z`).getUTCDay();
  const salud: string[] = [];
  // A las 9:15 un agente puede seguir pendiente (Mac dormida): no es falla todavía. Cuando corra, contesta en el hilo de este mensaje.
  ultima.delete('__brief__');
  // Una línea por jefa: el peor semáforo de su equipo hoy y el resumen de la jefa (o "N corrieron")
  const peso: Record<string, number> = { '🟢': 0, '🟡': 1, '🔴': 2 };
  for (const [j, { emoji, equipo }] of Object.entries(JEFAS)) {
    const corrieron = equipo.filter((a) => ultima.has(a));
    const propia = ultima.get(j);
    if (!corrieron.length && !propia) { if (dow >= 1 && dow <= 5) salud.push(`⏳ ${emoji} ${j} aún no corre`); continue; }
    const sems = [...corrieron.map((a) => ultima.get(a)!.semaforo), propia?.semaforo].filter(Boolean) as string[];
    const peor = sems.sort((a, b) => (peso[b] ?? 0) - (peso[a] ?? 0))[0] ?? '🟢';
    const res = propia?.resumen && j !== 'Oli' ? propia.resumen : `${corrieron.length} de su equipo corrieron hoy`;
    salud.push(`${peor} ${emoji} ${j}: ${res.slice(0, 60)}`);
  }

  const urg = items.filter((i) => i.prioridad === 'urgente').length;
  for (const [a] of ultima) if (a === '__brief__') ultima.delete(a);
  const sem = urg || salud.some((s) => s.startsWith('🔴')) ? '🔴' : items.length ? '🟡' : '🟢';
  const titulo = items.length ? `${sem} BizOps · ${fechaCorta(hoy)} · ${items.length} para ti` : `${sem} BizOps · ${fechaCorta(hoy)} · nada para ti hoy`;
  const blocks: SlackBlock[] = [{ type: 'header', text: { type: 'plain_text', text: titulo } } as SlackBlock];
  const MAX = 12;
  for (const it of items.slice(0, MAX)) blocks.push(...itemBlocks(it, hoy));
  if (items.length > MAX) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `+${items.length - MAX} más: aparecen mañana o en los borradores de Gmail.` }] } as SlackBlock);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${salud.join('\n') || 'Sin corridas hoy todavía'}\n🤖 Los agentes no envían ni pagan. ✅ Hecho = ya lo resolviste · ⏭️ Mañana = vuelve a salir · ✖ No aplica = el agente aprende` }] } as SlackBlock);
  const text = `${titulo}\n${items.slice(0, MAX).map((i) => `${i.emoji ?? '•'} ${i.texto} (${jefaDe(i.agente)})`).join('\n')}`;
  return { message: { text: text.slice(0, 2900), blocks }, pendientes: items.length };
}

export async function publicar(message: SlackMessage, canal = BRIEF_CHANNEL()) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: 'SLACK_BOT_TOKEN missing' };
  return postChatMessage(token, canal, message);
}

/** Pendiente del mismo día que no puede esperar al brief de mañana (VOBO de pagos o de nómina). */
export function mensajeInmediato(agente: string, semaforo: Semaforo, resumen: string, items: Item[], hoy = todayMx()): SlackMessage {
  const titulo = `${semaforo} ${jefaDe(agente)} · ${resumen}`.slice(0, 150);
  const blocks: SlackBlock[] = [{ type: 'header', text: { type: 'plain_text', text: titulo } } as SlackBlock];
  for (const it of items.filter((i) => i.estado === 'pendiente').slice(0, 8)) blocks.push(...itemBlocks(it, hoy));
  return { text: titulo, blocks };
}

/** Reemplaza los botones de un pendiente por quién y qué decidió (vía response_url de Slack). */
export function marcarDecidido(blocks: SlackBlock[], id: number, etiqueta: string): SlackBlock[] {
  return blocks.map((b) => ((b as { block_id?: string }).block_id === `bz_${id}`
    ? ({ type: 'context', block_id: `bz_${id}`, elements: [{ type: 'mrkdwn', text: etiqueta }] } as SlackBlock)
    : b));
}

/** Guarda el ts del brief de hoy para que los agentes que corren tarde contesten en su hilo. */
export async function guardarTsBrief(ts: string, hoy = todayMx()) {
  const sb = createServerClient();
  await sb.from('bizops_runs').insert({ agente: '__brief__', fecha: hoy, semaforo: '🟢', resumen: ts });
}

/**
 * Si el brief de hoy ya salió, el agente que corre después (Mac dormida) lo pone al día:
 * el mensaje de las 9:15 se vuelve a armar (⏳ pasa a 🟢/🟡 y entran sus pendientes) y,
 * si trae algo para Pepis, además contesta en el hilo para que llegue la notificación.
 */
export async function responderEnHiloSiTarde(agente: string, semaforo: Semaforo, resumen: string, items: Item[], hoy = todayMx()) {
  if (CANAL_POR_AGENTE[agente]) return null;
  const sb = createServerClient();
  const { data } = await sb.from('bizops_runs').select('resumen').eq('agente', '__brief__').eq('fecha', hoy).order('created_at', { ascending: false }).limit(1);
  const ts = (data?.[0] as { resumen?: string } | undefined)?.resumen;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!ts || !token) return null;
  const { message } = await armarBrief(hoy);
  await updateChatMessage(token, BRIEF_CHANNEL(), ts, message);
  const pend = items.filter((i) => i.estado === 'pendiente' && !esRH(i));
  if (!pend.length && semaforo === '🟢') return { ok: true, ts };
  const titulo = `${semaforo} ${jefaDe(agente)} · ${resumen}`.slice(0, 150);
  const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: `*${titulo}*` } } as SlackBlock];
  for (const it of pend.slice(0, 8)) blocks.push(...itemBlocks(it, hoy));
  return postChatMessage(token, BRIEF_CHANNEL(), { text: titulo, blocks }, ts);
}

/** Propuesta de un pendiente (para prellenar "✏️ Otra carpeta"). */
export async function propuestaDe(id: number) {
  const sb = createServerClient();
  const { data } = await sb.from('bizops_items').select('propuesta, texto').eq('id', id).single();
  return (data ?? {}) as { propuesta?: string | null; texto?: string };
}
