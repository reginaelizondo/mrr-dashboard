import { NextRequest, NextResponse } from 'next/server';
import { format, subDays, subMonths } from 'date-fns';
import { syncKineduDB } from '@/lib/sync/kinedu-db';
import { computeMonthlySnapshot } from '@/lib/sync/snapshots';
import { syncAppleEventsRange } from '@/lib/sync/apple-events';
import { syncAppleSalesRecent } from '@/lib/sync/apple-sales';
import { syncAppleReviewsRecent, syncAppleRatingsSummary } from '@/lib/sync/apple-reviews';
import { purgeOldBotBookmarks } from '@/lib/mixpanel/insights';
import { createServerClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';
import { countSyncedRecords } from '@/lib/sync/sync-log';
import { repriceAppleIntroSkus } from '@/lib/sync/reprice-intro';

export const maxDuration = 300;

export async function POST(_req: NextRequest) {
  const session = await getSession();
  if (!session.isAuthenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerClient();
  const now = new Date();
  const today = format(now, 'yyyy-MM-dd');

  const { data: syncLog } = await supabase
    .from('sync_log')
    .insert({ source: 'all', sync_type: 'manual', status: 'running' })
    .select()
    .single();

  const results: Record<string, unknown> = {};

  await Promise.allSettled([
    (async () => {
      try {
        const fromDate = format(subDays(now, 3), 'yyyy-MM-dd');
        const result = await syncKineduDB(fromDate, today);
        const rep = await repriceAppleIntroSkus(fromDate, today);
        const months = [today, format(subMonths(now, 1), 'yyyy-MM-01'), format(subMonths(now, 2), 'yyyy-MM-01')];
        for (const m of months) await computeMonthlySnapshot(m);
        results.kineduDb = { status: 'success', synced: result.synced, repriced: rep.repriced };
      } catch (err) {
        results.kineduDb = { status: 'error', error: (err as Error).message };
      }
    })(),

    (async () => {
      try {
        const start = format(subDays(now, 3), 'yyyy-MM-dd');
        const end = format(subDays(now, 1), 'yyyy-MM-dd');
        const result = await syncAppleEventsRange(start, end);
        results.appleEvents = { status: 'success', ...result };
      } catch (err) {
        results.appleEvents = { status: 'error', error: (err as Error).message };
      }
    })(),

    (async () => {
      try {
        const result = await syncAppleSalesRecent(5);
        results.appleSales = { status: 'success', ...result };
      } catch (err) {
        results.appleSales = { status: 'error', error: (err as Error).message };
      }
    })(),

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

  return NextResponse.json({ success: true, hasError, results });
}
