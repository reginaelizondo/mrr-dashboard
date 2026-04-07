import { createServerClient } from '@/lib/supabase/server';
import type { Source } from '@/types';

export type Granularity = 'monthly' | 'weekly';

export interface RefundMonthlyRow {
  /** YYYY-MM for monthly, YYYY-MM-DD (week start) for weekly */
  month: string;
  /** YYYY-MM-DD week end (only set for weekly granularity) */
  week_end?: string;
  charge_units: number;
  refund_units: number;
  charge_gross: number;
  refund_gross: number;
  refund_rate_units: number; // 0..1
  refund_rate_amount: number; // 0..1
}

interface TxRow {
  transaction_date: string;
  transaction_type: string;
  units: number | null;
  amount_gross: number | null;
}

async function getGenericRefundsByMonth(
  source: Source,
  startMonth: string,
  endMonth: string
): Promise<RefundMonthlyRow[]> {
  const supabase = createServerClient();

  const startStr = `${startMonth}-01`;
  // End is the LAST day of endMonth — compute by going to the first day of
  // the next month and subtracting one.
  const [ey, em] = endMonth.split('-').map(Number);
  const endDate = new Date(Date.UTC(ey, em, 0));
  const endStr = endDate.toISOString().slice(0, 10);

  // Page through results to avoid Supabase 1000-row cap
  const pageSize = 1000;
  const rows: TxRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('transactions')
      .select('transaction_date, transaction_type, units, amount_gross')
      .eq('source', source)
      .in('transaction_type', ['charge', 'refund'])
      .gte('transaction_date', startStr)
      .lte('transaction_date', endStr)
      .order('transaction_date', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('[refunds] query error:', error);
      break;
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as TxRow[]));
    if (data.length < pageSize) break;
  }

  // Aggregate by month
  const byMonth = new Map<string, RefundMonthlyRow>();
  for (const r of rows) {
    const month = (r.transaction_date || '').slice(0, 7);
    if (!month) continue;
    let row = byMonth.get(month);
    if (!row) {
      row = {
        month,
        charge_units: 0,
        refund_units: 0,
        charge_gross: 0,
        refund_gross: 0,
        refund_rate_units: 0,
        refund_rate_amount: 0,
      };
      byMonth.set(month, row);
    }
    const units = Math.abs(Number(r.units || 0));
    const gross = Math.abs(Number(r.amount_gross || 0));
    if (r.transaction_type === 'charge') {
      row.charge_units += units;
      row.charge_gross += gross;
    } else if (r.transaction_type === 'refund') {
      row.refund_units += units;
      row.refund_gross += gross;
    }
  }

  const out = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
  for (const r of out) {
    // Net-basis rate (refunds / (charges - refunds)) — same definition Apple
    // App Store Connect uses, so the chart is consistent across sources.
    const net_units = r.charge_units - r.refund_units;
    const net_gross = r.charge_gross - r.refund_gross;
    r.refund_rate_units = net_units > 0 ? r.refund_units / net_units : 0;
    r.refund_rate_amount = net_gross > 0 ? r.refund_gross / net_gross : 0;
  }
  return out;
}

/**
 * Apple-specific monthly refund metrics, sourced from `apple_subscription_events`
 * (the SUBSCRIPTION_EVENT report — same data App Store Connect → Trends shows).
 * Joins charge $ from `transactions` (Finance Report) for the dollar-based
 * refund rate. Refund $ is approximated as charge_gross × (refund_units / charge_units)
 * because the SUBSCRIPTION_EVENT report does not carry $ amounts and the Finance
 * Report has incomplete refund history.
 */
async function getAppleRefundsByMonth(
  startMonth: string,
  endMonth: string
): Promise<RefundMonthlyRow[]> {
  const supabase = createServerClient();

  // Source of truth = v_apple_sales_monthly (Apple SALES report, calendar
  // months, USD-converted via per-month FX rates). This view returns the
  // SAME numbers App Store Connect → Trends → Ventas displays.
  const { data, error } = await supabase
    .from('v_apple_sales_monthly')
    .select('month, charge_units, refund_units, charge_gross_usd, refund_gross_usd')
    .gte('month', startMonth)
    .lte('month', endMonth)
    .order('month', { ascending: true });

  if (error) console.error('[refunds] apple sales view error:', error);

  return (data || []).map((r) => {
    const charge_units = Number(r.charge_units || 0);
    const refund_units = Number(r.refund_units || 0);
    const charge_gross = Number(r.charge_gross_usd || 0);
    const refund_gross = Number(r.refund_gross_usd || 0);
    // Apple's refund rate is computed against NET sales (refunds / (charges - refunds))
    // — see App Store Connect → Trends → Ventas. Match that exactly.
    const net_units = charge_units - refund_units;
    const net_gross = charge_gross - refund_gross;
    return {
      month: r.month,
      charge_units,
      refund_units,
      charge_gross,
      refund_gross,
      refund_rate_units: net_units > 0 ? refund_units / net_units : 0,
      refund_rate_amount: net_gross > 0 ? refund_gross / net_gross : 0,
    };
  });
}

/**
 * Fetch monthly refund metrics for a given source between [startMonth, endMonth]
 * (inclusive, both YYYY-MM). Computes refund rate as refunds / (charges - refunds)
 * to match App Store Connect's "Reembolso vs Total" methodology.
 *
 * Apple is a special case: we read from `v_apple_sales_monthly` which is
 * built from the Apple SALES (DAILY) report — the same calendar-aligned
 * data App Store Connect → Trends → Ventas shows. The `transactions` table
 * for Apple is sourced from the Finance Report which uses Apple's fiscal
 * calendar and would not match App Store Connect month-to-month.
 */
export async function getRefundsByMonth(
  source: Source,
  startMonth: string,
  endMonth: string
): Promise<RefundMonthlyRow[]> {
  if (source === 'apple') {
    return getAppleRefundsByMonth(startMonth, endMonth);
  }
  return getGenericRefundsByMonth(source, startMonth, endMonth);
}

/**
 * Apple weekly aggregation (ISO weeks, Mon→Sun) over an arbitrary date range.
 * Backed by v_apple_sales_weekly. Same shape as getAppleRefundsByMonth so the
 * dashboard can reuse the chart and detail-table components.
 */
export async function getAppleRefundsByWeek(
  startDate: string,
  endDate: string
): Promise<RefundMonthlyRow[]> {
  const supabase = createServerClient();

  const { data, error } = await supabase
    .from('v_apple_sales_weekly')
    .select('week_start, week_end, charge_units, refund_units, charge_gross_usd, refund_gross_usd')
    .gte('week_end', startDate) // include weeks that overlap the range
    .lte('week_start', endDate)
    .order('week_start', { ascending: true });

  if (error) console.error('[refunds] apple weekly view error:', error);

  return (data || []).map((r) => {
    const charge_units = Number(r.charge_units || 0);
    const refund_units = Number(r.refund_units || 0);
    const charge_gross = Number(r.charge_gross_usd || 0);
    const refund_gross = Number(r.refund_gross_usd || 0);
    const net_units = charge_units - refund_units;
    const net_gross = charge_gross - refund_gross;
    return {
      month: r.week_start,
      week_end: r.week_end,
      charge_units,
      refund_units,
      charge_gross,
      refund_gross,
      refund_rate_units: net_units > 0 ? refund_units / net_units : 0,
      refund_rate_amount: net_gross > 0 ? refund_gross / net_gross : 0,
    };
  });
}

/**
 * Returns the most recent Apple Sales sync timestamp.
 * Tries sync_log first (populated by the daily cron), falls back to the
 * latest synced_at on `apple_sales_daily` (covers manual backfills).
 */
export async function getLastAppleSalesSync(): Promise<{
  completedAt: string | null;
  records: number;
  status: string | null;
  latestDataDate: string | null;
}> {
  const supabase = createServerClient();

  // 1) Try sync_log
  const { data: logs } = await supabase
    .from('sync_log')
    .select('completed_at, records_synced, status, details')
    .eq('source', 'apple')
    .order('started_at', { ascending: false })
    .limit(20);

  const sale = (logs || []).find(
    (r) => (r.details as { source?: string } | null)?.source === 'apple-sales'
  );

  // 2) Fallback: latest synced_at on apple_sales_daily, plus the latest
  //    begin_date so the user can see how recent the actual data is.
  const { data: latestSync } = await supabase
    .from('apple_sales_daily')
    .select('synced_at')
    .order('synced_at', { ascending: false })
    .limit(1)
    .single();

  const { data: latestData } = await supabase
    .from('apple_sales_daily')
    .select('begin_date')
    .order('begin_date', { ascending: false })
    .limit(1)
    .single();

  return {
    completedAt: sale?.completed_at || latestSync?.synced_at || null,
    records: sale ? Number(sale.records_synced || 0) : 0,
    status: sale?.status || (latestSync ? 'success' : null),
    latestDataDate: latestData?.begin_date || null,
  };
}

// ============================================================================
// Apple SUBSCRIPTION_EVENT report-based breakdowns
// (requires apple_subscription_events table populated by /api/cron/apple-events)
// ============================================================================

export interface BreakdownRow {
  bucket: string;
  refunds: number;
  paid_events: number; // Subscribe + Renew + Reactivate at the same dimension
  refund_rate: number; // refunds / paid_events (0..1)
}

export interface AppleRefundBreakdowns {
  byConsecutivePaidPeriod: BreakdownRow[];
  byDaysBeforeCanceling: BreakdownRow[];
  byPlanDuration: BreakdownRow[];
  byOfferType: BreakdownRow[];
  byCountry: BreakdownRow[];
  bySku: BreakdownRow[];
  totalRefunds: number;
  totalPaid: number;
  overallRate: number;
  hasData: boolean;
  startDate: string;
  endDate: string;
}

/**
 * Compute Apple-specific refund breakdowns from the SUBSCRIPTION_EVENT table
 * via Postgres functions (apple_refunds_by_*_range) for an arbitrary
 * [startDate, endDate] window. Returns 6 breakdowns in parallel via RPC.
 */
export async function getAppleRefundBreakdowns(
  startDate: string,
  endDate: string
): Promise<AppleRefundBreakdowns> {
  const supabase = createServerClient();

  type RpcRow = { bucket: string; refunds: number; paid_events: number };
  type DaysRpcRow = { bucket: string; refunds: number };

  const args = { start_date: startDate, end_date: endDate };
  const [cppRes, daysRes, planRes, offerRes, countryRes, skuRes] = await Promise.all([
    supabase.rpc('apple_refunds_by_cpp_range', args),
    supabase.rpc('apple_refunds_by_days_to_refund_range', args),
    supabase.rpc('apple_refunds_by_dimension_range', { dim: 'duration', ...args, top_n: 20 }),
    supabase.rpc('apple_refunds_by_dimension_range', { dim: 'offer', ...args, top_n: 20 }),
    supabase.rpc('apple_refunds_by_dimension_range', { dim: 'country', ...args, top_n: 15 }),
    supabase.rpc('apple_refunds_by_dimension_range', { dim: 'sku', ...args, top_n: 15 }),
  ]);

  for (const [name, res] of [
    ['cpp', cppRes],
    ['days', daysRes],
    ['plan', planRes],
    ['offer', offerRes],
    ['country', countryRes],
    ['sku', skuRes],
  ] as const) {
    if (res.error) console.error(`[refunds] apple breakdown rpc ${name} error:`, res.error);
  }

  const empty: AppleRefundBreakdowns = {
    byConsecutivePaidPeriod: [],
    byDaysBeforeCanceling: [],
    byPlanDuration: [],
    byOfferType: [],
    byCountry: [],
    bySku: [],
    totalRefunds: 0,
    totalPaid: 0,
    overallRate: 0,
    hasData: false,
    startDate,
    endDate,
  };

  function toRows(rows: RpcRow[] | null | undefined): BreakdownRow[] {
    return (rows || []).map((r) => {
      const refunds = Number(r.refunds || 0);
      const paid = Number(r.paid_events || 0);
      // Net-basis rate to match Apple App Store Connect methodology
      // (refunds / (paid - refunds)). When paid <= refunds the bucket is
      // pathological and we fall back to gross basis.
      const net = paid - refunds;
      return {
        bucket: r.bucket,
        refunds,
        paid_events: paid,
        refund_rate: net > 0 ? refunds / net : (paid > 0 ? refunds / paid : 0),
      };
    });
  }

  // Days-to-refund: there's no natural "paid" denominator. Treat rate as
  // share of total refunds in each bucket.
  function toDaysRows(rows: DaysRpcRow[] | null | undefined): BreakdownRow[] {
    const list = rows || [];
    const total = list.reduce((a, r) => a + Number(r.refunds || 0), 0);
    return list.map((r) => ({
      bucket: r.bucket,
      refunds: Number(r.refunds || 0),
      paid_events: total,
      refund_rate: total > 0 ? Number(r.refunds || 0) / total : 0,
    }));
  }

  const cpp = toRows(cppRes.data as RpcRow[] | null);
  if (cpp.length === 0) return empty;

  const totalRefunds = cpp.reduce((a, r) => a + r.refunds, 0);
  const totalPaid = cpp.reduce((a, r) => a + r.paid_events, 0);

  return {
    byConsecutivePaidPeriod: cpp,
    byDaysBeforeCanceling: toDaysRows(daysRes.data as DaysRpcRow[] | null),
    byPlanDuration: toRows(planRes.data as RpcRow[] | null),
    byOfferType: toRows(offerRes.data as RpcRow[] | null),
    byCountry: toRows(countryRes.data as RpcRow[] | null),
    bySku: toRows(skuRes.data as RpcRow[] | null),
    totalRefunds,
    totalPaid,
    overallRate: totalPaid > totalRefunds ? totalRefunds / (totalPaid - totalRefunds) : 0,
    hasData: true,
    startDate,
    endDate,
  };
}
