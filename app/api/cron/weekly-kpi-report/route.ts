import { NextRequest, NextResponse } from 'next/server';
import { buildWeeklyReport } from '@/lib/kpi/weekly-report';
import { postToSlack } from '@/lib/slack/post';

export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const message = await buildWeeklyReport();
    await postToSlack(message);
    return NextResponse.json({ ok: true, posted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await postToSlack({
        text: `⚠️ KPI Bot — Error generando reporte semanal\n\`\`\`${msg}\`\`\``,
      });
    } catch { /* swallow */ }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
