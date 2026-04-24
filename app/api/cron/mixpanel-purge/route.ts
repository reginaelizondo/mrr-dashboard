import { NextRequest, NextResponse } from 'next/server';
import { purgeOldBotBookmarks } from '@/lib/mixpanel/insights';

/**
 * Daily cron: detach bot-generated Mixpanel bookmarks older than 30 days
 * from the bot's dashboard. We cannot truly DELETE via the service-account
 * API (returns 500) — PATCHing `dashboard_id: null` orphans them so the bot
 * dashboard stays clean.
 */

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await purgeOldBotBookmarks(30);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron mixpanel-purge] failed:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
