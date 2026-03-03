import { NextRequest, NextResponse } from 'next/server';
import { format, subDays } from 'date-fns';
import { syncApple } from '@/lib/sync/apple';
import { syncGoogle } from '@/lib/sync/google';
import { syncStripe } from '@/lib/sync/stripe';
import { computeMonthlySnapshot } from '@/lib/sync/snapshots';
import { createServerClient } from '@/lib/supabase/server';

export const maxDuration = 60; // Vercel Pro: 60s max

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerClient();
  const today = format(new Date(), 'yyyy-MM-dd');
  const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd');
  const currentMonth = format(new Date(), 'yyyy-MM');
  const currentYearMonth = format(new Date(), 'yyyyMM');

  // Create sync log entry
  const { data: syncLog } = await supabase
    .from('sync_log')
    .insert({
      source: 'all',
      sync_type: 'daily',
      status: 'running',
      date_range_start: yesterday,
      date_range_end: today,
    })
    .select()
    .single();

  try {
    let totalRecords = 0;
    const details: Record<string, unknown> = {};

    // Sync Apple (current month — idempotent via upsert)
    try {
      const appleCount = await syncApple(currentMonth);
      totalRecords += appleCount;
      details.apple = { records: appleCount, month: currentMonth, status: 'success' };
    } catch (err) {
      details.apple = { status: 'error', error: (err as Error).message };
      console.error('Apple sync error:', err);
    }

    // Sync Google (current month)
    try {
      const googleCount = await syncGoogle(currentYearMonth);
      totalRecords += googleCount;
      details.google = { records: googleCount, month: currentYearMonth, status: 'success' };
    } catch (err) {
      details.google = { status: 'error', error: (err as Error).message };
      console.error('Google sync error:', err);
    }

    // Sync Stripe — today + yesterday (to catch late-arriving data)
    try {
      const stripeTodayCount = await syncStripe(today);
      const stripeYesterdayCount = await syncStripe(yesterday);
      const totalStripe = stripeTodayCount + stripeYesterdayCount;
      totalRecords += totalStripe;
      details.stripe = { records: totalStripe, today: stripeTodayCount, yesterday: stripeYesterdayCount, status: 'success' };
    } catch (err) {
      details.stripe = { status: 'error', error: (err as Error).message };
      console.error('Stripe sync error:', err);
    }

    // Compute monthly MRR snapshot for the current month
    // (stored as YYYY-MM-01 — computeMonthlySnapshot normalizes any date to 1st of month)
    await computeMonthlySnapshot(today);

    // Also recompute previous month if we're in the first few days (late-arriving data)
    const todayDate = new Date(today);
    if (todayDate.getDate() <= 3) {
      await computeMonthlySnapshot(yesterday);
    }

    // Update sync log
    if (syncLog) {
      await supabase
        .from('sync_log')
        .update({
          status: 'success',
          completed_at: new Date().toISOString(),
          records_synced: totalRecords,
          details,
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json({
      success: true,
      dates: { today, yesterday },
      records: totalRecords,
      details,
    });
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

    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
