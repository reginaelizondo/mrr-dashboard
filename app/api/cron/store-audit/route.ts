import { NextRequest, NextResponse } from 'next/server';
import { runStoreAudit } from '@/lib/audit/store-audit';
import { postToSlack } from '@/lib/slack/post';

export const maxDuration = 300;

/**
 * Daily store audit → Slack (#datastudiobot). Scheduled 16:00 UTC (10:00 MX):
 * after the 07:00 UTC Apple sales sync and the ~09:01 MX dbt rebuild.
 *   dry=1  → build only, return JSON
 *   today=YYYY-MM-DD → pretend it's another day (MX)
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const dry = sp.get('dry') === '1';
  try {
    const result = await runStoreAudit({ today: sp.get('today') ?? undefined });
    if (!dry) await postToSlack(result.message);
    return NextResponse.json({ ok: true, posted: !dry, status: result.status, checks: result.checks, text: result.text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[store-audit] failed:', msg);
    if (!dry) { try { await postToSlack({ text: `⚠️ Auditoría tiendas vs Looker — no pude correrla hoy\n\`\`\`${msg.slice(0, 800)}\`\`\`` }); } catch { /* swallow */ } }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
