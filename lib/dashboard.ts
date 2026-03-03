import { createServerClient } from '@/lib/supabase/server';
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
 * Fetch snapshots between start and end dates.
 * If no dates provided, defaults to last 12 months.
 */
export async function getSnapshots(
  start?: string,
  end?: string
): Promise<MrrDailySnapshot[]> {
  const supabase = createServerClient();

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

  console.log(`[Dashboard] getSnapshots: start=${startDate}, end=${endDate}, found=${data?.length || 0}`);
  return data || [];
}

export async function getLastSync(): Promise<SyncLog | null> {
  const supabase = createServerClient();

  const { data } = await supabase
    .from('sync_log')
    .select('*')
    .eq('status', 'success')
    .order('completed_at', { ascending: false })
    .limit(1)
    .single();

  return data;
}
