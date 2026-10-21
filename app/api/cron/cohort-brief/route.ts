import { NextRequest, NextResponse } from 'next/server';
import { buildCohortBrief } from '@/lib/kpi/cohort-brief';
import { postWithThread, postChatMessage, postToSlack } from '@/lib/slack/post';

export const maxDuration = 300; // BigQuery + Supabase + gráfica + subida de imagen

/**
 * Brief de cohortes → su propio canal de Slack (SLACK_COHORT_CHANNEL). Programado 15:35 UTC (09:35 MX),
 * después del brief diario calendar (15:30 UTC, SLACK_BRIEF_CHANNEL). Nunca cae al webhook del canal
 * calendar: si falta el canal, no publica y lo dice en la respuesta.
 *
 * Query params (opcionales):
 *   dry=1             arma el mensaje sin publicar; devuelve el texto y los datos
 *   today=YYYY-MM-DD  como si fuera otro día (MX)
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const dry = sp.get('dry') === '1';
  const today = sp.get('today') ?? undefined;
  const channel = process.env.SLACK_COHORT_CHANNEL;

  if (!dry && !channel) {
    console.error('[cohort-brief] SLACK_COHORT_CHANNEL no está configurado; no se publica.');
    return NextResponse.json({ ok: false, posted: false, skipped: 'SLACK_COHORT_CHANNEL not set' });
  }

  try {
    const result = await buildCohortBrief({ today });
    if (dry) {
      return NextResponse.json({
        ok: true, posted: false, text: result.text, facts: result.facts,
        message: { ...result.message, files: result.message.files?.map((f) => ({ filename: f.filename, title: f.title, bytes: f.data.byteLength })) },
        thread: result.thread,
      });
    }
    const via = await postWithThread({ main: result.message, thread: result.thread }, { channel, webhookFallback: false });
    return NextResponse.json({ ok: true, posted: true, via: via.via });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cohort-brief] failed:', msg);
    if (!dry) {
      const text = `⚠️ KPI Bot — no pude generar el brief de cohortes\n\`\`\`${msg.slice(0, 800)}\`\`\``;
      const token = process.env.SLACK_BOT_TOKEN;
      const r = token && channel ? await postChatMessage(token, channel, { text }) : { ok: false };
      if (!r.ok) { try { await postToSlack({ text }); } catch { /* swallow */ } }
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
