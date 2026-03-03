import { NextRequest, NextResponse } from 'next/server';
import { format, eachDayOfInterval, parseISO } from 'date-fns';
import { syncApple } from '@/lib/sync/apple';
import { syncStripe } from '@/lib/sync/stripe';
import { syncGoogle } from '@/lib/sync/google';
import { computeMonthlySnapshot } from '@/lib/sync/snapshots';
import { createServerClient } from '@/lib/supabase/server';

export const maxDuration = 300; // 5 minutes for backfill

export async function POST(request: NextRequest) {
  const { startDate, endDate, source, chunkSize = 31 } = await request.json();

  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: 'startDate and endDate are required (YYYY-MM-DD)' },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  // Create sync log
  const { data: syncLog } = await supabase
    .from('sync_log')
    .insert({
      source: source || 'all',
      sync_type: 'backfill',
      status: 'running',
      date_range_start: startDate,
      date_range_end: endDate,
    })
    .select()
    .single();

  try {
    const allDays = eachDayOfInterval({
      start: parseISO(startDate),
      end: parseISO(endDate),
    });

    // Process only chunkSize days at a time to avoid timeout
    const daysToProcess = allDays.slice(0, chunkSize);
    const remainingDays = allDays.length - daysToProcess.length;
    const nextStartDate = remainingDays > 0
      ? format(allDays[chunkSize], 'yyyy-MM-dd')
      : null;

    let totalRecords = 0;
    const errors: string[] = [];

    // STEP 1: Apple & Google monthly syncs FIRST (so data exists before snapshot computation)
    const uniqueAppleMonths = new Set<string>();
    const uniqueGoogleMonths = new Set<string>();
    for (const day of daysToProcess) {
      uniqueAppleMonths.add(format(day, 'yyyy-MM'));
      uniqueGoogleMonths.add(format(day, 'yyyyMM'));
    }

    if (!source || source === 'apple') {
      for (const ym of uniqueAppleMonths) {
        try {
          const count = await syncApple(ym);
          totalRecords += count;
        } catch (err) {
          errors.push(`Apple ${ym}: ${(err as Error).message}`);
        }
      }
    }

    if (!source || source === 'google') {
      for (const ym of uniqueGoogleMonths) {
        try {
          const count = await syncGoogle(ym);
          totalRecords += count;
        } catch (err) {
          errors.push(`Google ${ym}: ${(err as Error).message}`);
        }
      }
    }

    // STEP 2: Stripe daily sync for each day in the chunk
    if (!source || source === 'stripe') {
      for (const day of daysToProcess) {
        const dateStr = format(day, 'yyyy-MM-dd');
        try {
          const count = await syncStripe(dateStr);
          totalRecords += count;
        } catch (err) {
          errors.push(`Stripe ${dateStr}: ${(err as Error).message}`);
        }
      }
    }

    // STEP 3: Compute ONE monthly snapshot per unique month in the range
    // (MRR is a monthly concept — one row per month stored as YYYY-MM-01)
    const uniqueSnapshotMonths = new Set<string>();
    for (const day of daysToProcess) {
      uniqueSnapshotMonths.add(format(day, 'yyyy-MM-01'));
    }

    for (const monthDate of uniqueSnapshotMonths) {
      try {
        await computeMonthlySnapshot(monthDate);
      } catch (err) {
        errors.push(`Snapshot ${monthDate}: ${(err as Error).message}`);
      }
    }

    // Update sync log
    if (syncLog) {
      await supabase
        .from('sync_log')
        .update({
          status: errors.length > 0 ? 'error' : 'success',
          completed_at: new Date().toISOString(),
          records_synced: totalRecords,
          error_message: errors.length > 0 ? errors.join('; ') : null,
          details: { errors, days_processed: daysToProcess.length, remaining_days: remainingDays },
        })
        .eq('id', syncLog.id);
    }

    return NextResponse.json({
      success: true,
      records: totalRecords,
      days_processed: daysToProcess.length,
      remaining_days: remainingDays,
      next_start_date: nextStartDate,
      errors: errors.length > 0 ? errors : undefined,
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
