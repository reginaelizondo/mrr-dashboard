import { NextRequest, NextResponse } from 'next/server';
import { buildDailyBrief } from '@/lib/kpi/daily-brief';
import { postWithThread, postToSlack } from '@/lib/slack/post';

export const maxDuration = 300; // BigQuery + gráficas + ~8 mensajes y subida de imágenes

/**
 * Daily KPI brief → Slack. Scheduled 15:30 UTC (09:30 MX), after the 09:01 MX
 * dbt rebuild of an_operational_dash. Mondays include the weekly section, which
 * replaces the old weekly-kpi-report cron (that route stays for manual use).
 *
 * Query params (all optional):
 *   dry=1        build but don't post; return the rendered text + facts
 *   weekly=1|0   force the weekly section on/off
 *   today=YYYY-MM-DD  pretend it's another day (MX)
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const dry = sp.get('dry') === '1';
  const weeklyParam = sp.get('weekly');
  const today = sp.get('today') ?? undefined;

  try {
    const result = await buildDailyBrief({
      today,
      weekly: weeklyParam === null ? undefined : weeklyParam === '1',
    });
    if (dry) {
      return NextResponse.json({
        ok: true, posted: false, narrativeSource: result.narrativeSource,
        text: result.text, facts: result.facts, message: result.message,
        // Las imágenes no van en el JSON: solo nombre y tamaño.
        thread: result.thread.map(({ files, ...m }) => ({ ...m, files: files?.map((f) => ({ filename: f.filename, title: f.title, bytes: f.data.byteLength })) })),
      });
    }
    const via = await postWithThread({ main: result.message, thread: result.thread });
    return NextResponse.json({ ok: true, posted: true, via: via.via, narrativeSource: result.narrativeSource });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[daily-brief] failed:', msg);
    if (!dry) {
      try {
        await postToSlack({ text: `⚠️ KPI Bot — no pude generar el brief diario\n\`\`\`${msg.slice(0, 800)}\`\`\`` });
      } catch { /* swallow */ }
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
