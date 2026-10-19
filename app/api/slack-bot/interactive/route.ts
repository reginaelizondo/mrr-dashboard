import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '@/lib/slack/verify';
import { postChatMessage } from '@/lib/slack/post';
import { runKpiGuard, formatGuardRun } from '@/lib/audit/kpi-guard';
import { runKpiFix, formatFixResult, fixInProgress } from '@/lib/audit/kpi-fix';
import { setProposalStatus } from '@/lib/estela/estela';

// Correcciones largas (re-sincronizar réplica + tiendas ≈ 2–4 min) corren en waitUntil después de responder a Slack.
export const maxDuration = 300;

/**
 * Botones de las alertas de la Guardia (Slack → Interactivity). Configuración en la app de Slack:
 * Interactivity & Shortcuts → On → Request URL = https://<dominio>/api/slack-bot/interactive
 *   kpi_fix      corre las correcciones que tocan y responde en el hilo con el antes y el después
 *   kpi_recheck  vuelve a correr la Guardia y responde en el hilo
 *   estela_accept / estela_reject  Pepis decide sobre una propuesta de Estela (value = id en estela_proposals)
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
  const action = payload.actions?.[0]?.action_id as string | undefined;
  const channel: string | undefined = payload.channel?.id;
  const threadTs: string | undefined = payload.message?.thread_ts ?? payload.message?.ts ?? payload.container?.message_ts;
  const who = payload.user?.username ? `@${payload.user.username}` : payload.user?.name ? `@${payload.user.name}` : undefined;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!action || action === 'kpi_open_dashboard' || !channel || !token) return new NextResponse('', { status: 200 });

  const reply = (text: string) => postChatMessage(token, channel, { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }, threadTs);

  waitUntil((async () => {
    try {
      if (action === 'estela_accept' || action === 'estela_reject') {
        const id = Number(payload.actions?.[0]?.value);
        const estado = action === 'estela_accept' ? 'aceptada' : 'rechazada';
        const r = Number.isFinite(id) ? await setProposalStatus(id, estado, who) : { ok: false, error: 'id inválido' };
        await reply(r.ok
          ? `${estado === 'aceptada' ? '✅' : '✖'} Propuesta #${id} "${r.titulo}" marcada como *${estado}*${who ? ` por ${who}` : ''}. Estela le da seguimiento el próximo lunes.`
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
