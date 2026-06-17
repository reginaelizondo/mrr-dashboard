import { NextRequest, NextResponse } from 'next/server';
import { format, subDays, subMonths } from 'date-fns';
import { syncKineduDB } from '@/lib/sync/kinedu-db';
import { computeMonthlySnapshot } from '@/lib/sync/snapshots';
import { syncAppleEventsRange } from '@/lib/sync/apple-events';
import { syncAppleSalesRecent } from '@/lib/sync/apple-sales';
import { syncAppleReviewsRecent, syncAppleRatingsSummary } from '@/lib/sync/apple-reviews';
import { purgeOldBotBookmarks } from '@/lib/mixpanel/insights';
import { createServerClient } from '@/lib/supabase/server';
import { countSyncedRecords } from '@/lib/sync/sync-log';
import { repriceAppleIntroSkus } from '@/lib/sync/reprice-intro';

export const maxDuration = 300;

/**
 * Consolidated daily cron — replaces the 5 individual daily crons so we stay
 * within Vercel Hobby's 2-cron limit (the other slot is the weekly KPI report).
 *
 * Tasks run in parallel; failure of one does not abort the others.
 * Schedule: 0 7 * * * (07:00 UTC)
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerClient();
  const now = new Date();
  const today = format(now, 'yyyy-MM-dd');

  const { data: syncLog } = await supabase
    .from('sync_log')
    .insert({ source: 'all', sync_type: 'daily', status: 'running' })
    .select()
    .single();

  const results: Record<string, unknown> = {};

  await Promise.allSettled([
    // 1. Kinedu DB transactions + monthly snapshots
    (async () => {
      try {
        const fromDate = format(subDays(now, 3), 'yyyy-MM-dd');
        const result = await syncKineduDB(fromDate, today);
        // Correct intro-priced SKUs (recorded at list price) to Apple's actual
        // charged amount, so the daily sync can't re-inflate them. Must run
        // before snapshots so they reflect the corrected amounts.
        const rep = await repriceAppleIntroSkus(fromDate, today);
        const months = [
          today,
          format(subMonths(now, 1), 'yyyy-MM-01'),
          format(subMonths(now, 2), 'yyyy-MM-01'),
        ];
        for (const m of months) await computeMonthlySnapshot(m);
        results.kineduDb = { status: 'success', synced: result.synced, repriced: rep.repriced, snapshots: months };
      } catch (err) {
        results.kineduDb = { status: 'error', error: (err as Error).message };
      }
    })(),

    // 2. Apple subscription events
    (async () => {
      try {
        const start = format(subDays(now, 3), 'yyyy-MM-dd');
        const end = format(subDays(now, 1), 'yyyy-MM-dd');
        const result = await syncAppleEventsRange(start, end);
        // MV refresh is handled by pg_cron at 07:30 UTC — calling it via
        // PostgREST always times out (~8s gateway limit vs ~60s refresh cost).
        results.appleEvents = { status: 'success', ...result };
      } catch (err) {
        results.appleEvents = { status: 'error', error: (err as Error).message };
      }
    })(),

    // 3. Apple sales (DAILY report — powers the refunds weekly chart)
    (async () => {
      try {
        const result = await syncAppleSalesRecent(5);
        results.appleSales = { status: 'success', ...result };
      } catch (err) {
        results.appleSales = { status: 'error', error: (err as Error).message };
      }
    })(),

    // 4. Apple reviews + ratings
    (async () => {
      try {
        const [reviews, ratings] = await Promise.all([
          syncAppleReviewsRecent(14),
          syncAppleRatingsSummary(),
        ]);
        results.appleReviews = { status: 'success', reviews, ratings };
      } catch (err) {
        results.appleReviews = { status: 'error', error: (err as Error).message };
      }
    })(),

    // 5. Mixpanel bot bookmark cleanup
    (async () => {
      try {
        const result = await purgeOldBotBookmarks(30);
        results.mixpanelPurge = { status: 'success', ...result };
      } catch (err) {
        results.mixpanelPurge = { status: 'error', error: (err as Error).message };
      }
    })(),
  ]);

  const hasError = Object.values(results).some(
    (r) => (r as { status: string }).status === 'error'
  );

  if (syncLog) {
    await supabase
      .from('sync_log')
      .update({
        status: hasError ? 'partial' : 'success',
        completed_at: new Date().toISOString(),
        records_synced: countSyncedRecords(results),
        details: results,
      })
      .eq('id', syncLog.id);
  }

  if (hasError && process.env.SLACK_WEBHOOK_URL) {
    const failed = Object.entries(results as Record<string, { status: string; error?: string }>)
      .filter(([, v]) => v.status === 'error')
      .map(([k, v]) => `• *${k}*: ${v.error || 'error desconocido'}`)
      .join('\n');
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `⚠️ *MRR Dashboard — sync diario con errores* (${new Date().toISOString().slice(0, 10)})\n${failed}\nUsa el botón *Sync manual* en el dashboard si los datos se ven desactualizados.`,
      }),
    }).catch(() => {});
  }

  return NextResponse.json({ success: true, hasError, results });
}
