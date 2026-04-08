import { NextRequest, NextResponse } from 'next/server';
import { syncAppleReviewsRecent, syncAppleRatingsSummary } from '@/lib/sync/apple-reviews';
import { createServerClient } from '@/lib/supabase/server';

export const maxDuration = 300;

/**
 * Daily cron: pulls the last 14 days of Apple Customer Reviews (written
 * reviews with title/body) and refreshes the per-country rating totals
 * snapshot from the public iTunes Lookup API.
 *
 * Idempotent:
 *   - apple_reviews uses upsert on review_id
 *   - apple_ratings_summary uses upsert on (snapshot_date, app_id, country_code)
 *
 * Guarded by CRON_SECRET (same pattern as the other /api/cron routes).
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data: syncLog } = await supabase
    .from('sync_log')
    .insert({
      source: 'apple',
      sync_type: 'daily',
      status: 'running',
    })
    .select()
    .single();

  try {
    const [reviews, ratings] = await Promise.all([
      syncAppleReviewsRecent(14),
      syncAppleRatingsSummary(),
    ]);

    if (syncLog) {
      await supabase
        .from('sync_log')
        .update({
          status: 'success',
          completed_at: new Date().toISOString(),
          records_synced: reviews.upserted + ratings.countries,
          details: {
            source: 'apple-reviews',
            reviews,
            ratings,
          },
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json({ success: true, reviews, ratings });
  } catch (err) {
    if (syncLog) {
      await supabase
        .from('sync_log')
        .update({
          status: 'error',
          completed_at: new Date().toISOString(),
          error_message: (err as Error).message,
        })
        .eq('id', syncLog.id);
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
