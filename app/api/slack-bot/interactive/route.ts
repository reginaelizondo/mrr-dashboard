import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '@/lib/slack/verify';
import { postChatMessage } from '@/lib/slack/post';
import { runKpiGuard, formatGuardRun } from '@/lib/audit/kpi-guard';
import { runKpiFix, formatFixResult, fixInProgress } from '@/lib/audit/kpi-fix';
import { setProposalStatus } from '@/lib/estela/estela';
import { decidir, marcarDecidido, propuestaDe } from '@/lib/bizops/brief';

// Correcciones largas (re-sincronizar réplica + tiendas ≈ 2–4 min) corren en waitUntil después de responder a Slack.
export const maxDuration = 300;

/**
 * Botones de las alertas de la Guardia (Slack → Interactivity). Configuración en la app de Slack:
 * Interactivity & Shortcuts → On → Request URL = https://<dominio>/api/slack-bot/interactive
 *   kpi_fix      corre las correcciones que tocan y responde en el hilo con el antes y el después
 *   kpi_recheck  vuelve a correr la Guardia y responde en el hilo
 *   estela_accept / estela_reject / estela_close  Pepis decide o cierra una propuesta de Estela (value = id en estela_proposals)
 *   bizops_hecho / bizops_manana / bizops_no      Pepis decide un pendiente del Brief BizOps (value = id en bizops_items);
 *                                                 los botones se reemplazan por la decisión en el mismo mensaje
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const ok = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
    timestamp: request.headers.get('x-slack-request-timestamp'),
    signature: request.headers.get('x-slack-signature'),
    rawBody,
  });
  if (!ok) return new NextResponse('Invalid signature', { status: 401 });

  const payload = JSON.parse(new URLSearchParams(rawBody).get('payload') ?? '{}');
  // "✏️ Otra carpeta": Pepis escribe dónde guardar; el agente lo lee en su siguiente corrida (estado hecho + respuesta)
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'bizops_otra') {
    const meta = JSON.parse(payload.view.private_metadata || '{}') as { id?: number; channel?: string; ts?: string };
    const ruta = String(payload.view.state?.values?.ruta?.valor?.value ?? '').trim();
    const quien = payload.user?.username ? `@${payload.user.username}` : undefined;
    const tok = process.env.SLACK_BOT_TOKEN;
    waitUntil((async () => {
      if (!meta.id || !ruta) return;
      const r = await decidir(meta.id, 'hecho', quien, ruta);
      if (tok && meta.channel) await postChatMessage(tok, meta.channel, { text: `✏️ ${r.ok ? `${r.agente} guardará en: ${ruta}` : 'No pude guardar la carpeta'}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: r.ok ? `✏️ *${r.texto}*\n${r.agente} guardará en: \`${ruta}\`${quien ? ` · ${quien}` : ''}` : `⚠️ No pude guardar: ${r.error}` } }] }, meta.ts);
    })());
    return new NextResponse('', { status: 200 });
  }
  const action = payload.actions?.[0]?.action_id as string | undefined;
  const channel: string | undefined = payload.channel?.id;
  const threadTs: string | undefined = payload.message?.thread_ts ?? payload.message?.ts ?? payload.container?.message_ts;
  const who = payload.user?.username ? `@${payload.user.username}` : payload.user?.name ? `@${payload.user.name}` : undefined;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!action || action === 'kpi_open_dashboard' || !channel || !token) return new NextResponse('', { status: 200 });

  const reply = (text: string) => postChatMessage(token, channel, { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }, threadTs);

  if (action === 'bizops_otra') {
    const id = Number(payload.actions?.[0]?.value);
    const p = Number.isFinite(id) ? await propuestaDe(id) : {};
    await fetch('https://slack.com/api/views.open', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ trigger_id: payload.trigger_id, view: {
        type: 'modal', callback_id: 'bizops_otra', private_metadata: JSON.stringify({ id, channel, ts: threadTs }),
        title: { type: 'plain_text', text: 'Otra carpeta' }, submit: { type: 'plain_text', text: 'Guardar ahí' }, close: { type: 'plain_text', text: 'Cancelar' },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${(p.texto ?? '').slice(0, 140)}*\nEscribe la carpeta (o una nota de dónde va mejor).` } },
          { type: 'input', block_id: 'ruta', label: { type: 'plain_text', text: 'Carpeta' },
            element: { type: 'plain_text_input', action_id: 'valor', multiline: true, ...(p.propuesta ? { initial_value: p.propuesta } : {}) } },
        ] } }),
    });
    return new NextResponse('', { status: 200 });
  }

  waitUntil((async () => {
    try {
      if (action === 'bizops_hecho' || action === 'bizops_manana' || action === 'bizops_no') {
        const id = Number(payload.actions?.[0]?.value);
        const estado = action === 'bizops_hecho' ? 'hecho' : action === 'bizops_manana' ? 'manana' : 'no';
        const r = Number.isFinite(id) ? await decidir(id, estado, who) : { ok: false as const, error: 'id inválido' };
        const etiqueta = !r.ok ? `⚠️ No pude guardar: ${r.error}`
          : estado === 'hecho' ? `✅ Hecho${who ? ` · ${who}` : ''}` : estado === 'manana' ? `⏭️ Mañana vuelve a salir${who ? ` · ${who}` : ''}` : `✖ No aplica${who ? ` · ${who}` : ''} · ${r.agente} lo anota para aprender`;
        const responseUrl: string | undefined = payload.response_url;
        const blocks = payload.message?.blocks;
        if (responseUrl && Array.isArray(blocks)) {
          await fetch(responseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ replace_original: true, text: payload.message?.text ?? 'Brief BizOps', blocks: marcarDecidido(blocks, id, etiqueta) }) });
        } else {
          await reply(etiqueta);
        }
      } else if (action === 'estela_accept' || action === 'estela_reject' || action === 'estela_close') {
        const id = Number(payload.actions?.[0]?.value);
        const estado = action === 'estela_accept' ? 'aceptada' : action === 'estela_reject' ? 'rechazada' : 'cerrada';
        const r = Number.isFinite(id)
          ? await setProposalStatus(id, estado, who, estado === 'cerrada' ? `cerrada por ${who ?? 'Pepis'}` : undefined)
          : { ok: false, error: 'id inválido' };
        const icon = estado === 'aceptada' ? '✅' : estado === 'cerrada' ? '✔' : '✖';
        const tail = estado === 'aceptada' ? 'Estela le da seguimiento cada lunes hasta que la cierres.' : estado === 'cerrada' ? 'Estela ya no le da seguimiento.' : 'No vuelve a aparecer.';
        await reply(r.ok
          ? `${icon} Propuesta #${id} "${r.titulo}" marcada como *${estado}*${who ? ` por ${who}` : ''}. ${tail}`
          : `No pude registrar la decisión: ${r.error}`);
      } else if (action === 'kpi_recheck') {
        await reply(formatGuardRun(await runKpiGuard()));
      } else if (action === 'kpi_fix') {
        if (await fixInProgress()) { await reply('⏳ Ya hay una corrección o un sync de la réplica corriendo; en unos minutos vuelve a revisar con 🔄.'); return; }
        await reply(`🔧 Corrigiendo${who ? ` (pedido por ${who})` : ''}… respondo aquí en 2–4 min.`);
        await reply(formatFixResult(await runKpiFix({ triggeredBy: who }), who));
      }
    } catch (e) {
      await reply(`❌ La corrección falló: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
    }
  })());

  return new NextResponse('', { status: 200 });
}
