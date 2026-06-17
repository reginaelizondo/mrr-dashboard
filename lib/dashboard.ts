import { createServerClient } from '@/lib/supabase/server';
import { unstable_cache } from 'next/cache';
import { format, subMonths } from 'date-fns';
import type { MrrDailySnapshot, SyncLog } from '@/types';

// Re-export client-safe functions so existing imports keep working
export { computeTotals, getPresetDates } from '@/lib/filters';

async function getLatestSnapshotDate(): Promise<string | null> {
  const supabase = createServerClient();

  const { data } = await supabase
    .from('mrr_daily_snapshots')
    .select('snapshot_date')
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .single();

  return data?.snapshot_date || null;
}

/**
 * Cached snapshot fetch. Snapshots only change once a day (the cron recomputes
 * the last 3 months), so a short revalidate window makes repeat loads instant
 * without ever showing meaningfully stale data. The manual-sync endpoint busts
 * the 'snapshots' tag so a forced sync reflects immediately.
 */
const fetchSnapshots = unstable_cache(
  async (startDate: string, endDate: string): Promise<MrrDailySnapshot[]> => {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('mrr_daily_snapshots')
      .select('*')
      .gte('snapshot_date', startDate)
      .lte('snapshot_date', endDate)
      .order('snapshot_date', { ascending: true });

    if (error) {
      console.error('Error fetching snapshots:', error);
      return [];
    }
    return data || [];
  },
  ['mrr-snapshots'],
  { revalidate: 60, tags: ['snapshots'] }
);

/**
 * Fetch snapshots between start and end dates.
 * If no dates provided, defaults to last 12 months.
 */
export async function getSnapshots(
  start?: string,
  end?: string
): Promise<MrrDailySnapshot[]> {
  // If no explicit end date, use the latest snapshot date
  let endDate = end;
  if (!endDate) {
    const latest = await getLatestSnapshotDate();
    endDate = latest || format(new Date(), 'yyyy-MM-dd');
  }

  // If no start date, default to 12 months back from end
  let startDate = start;
  if (!startDate) {
    startDate = format(subMonths(new Date(endDate), 12), 'yyyy-MM-dd');
  }

  return fetchSnapshots(startDate, endDate);
}

export const getLastSync = unstable_cache(
  async (): Promise<SyncLog | null> => {
    const supabase = createServerClient();
    const { data } = await supabase
      .from('sync_log')
      .select('*')
      .eq('status', 'success')
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();
    return data;
  },
  ['last-sync'],
  { revalidate: 60, tags: ['sync'] }
);
