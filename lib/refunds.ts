import { createServerClient } from '@/lib/supabase/server';
import type { Source } from '@/types';

export interface RefundMonthlyRow {
  month: string; // YYYY-MM
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
  months: number
): Promise<RefundMonthlyRow[]> {
  const supabase = createServerClient();

  // Build date range: first day of (months - 1) months ago to today
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1));
  const startStr = start.toISOString().slice(0, 10);

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
    r.refund_rate_units = r.charge_units > 0 ? r.refund_units / r.charge_units : 0;
    r.refund_rate_amount = r.charge_gross > 0 ? r.refund_gross / r.charge_gross : 0;
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
async function getAppleRefundsByMonth(months: number): Promise<RefundMonthlyRow[]> {
  const supabase = createServerClient();

  // Pull pre-aggregated rows from the v_apple_refund_monthly view (~13 rows)
  // and the v_apple_charge_gross_monthly view (~24 rows) — both backed by
  // Postgres GROUP BY, so this is two ~30ms queries instead of paginating
  // hundreds of thousands of raw rows.
  const monthsCapped = Math.min(months, 13);
  const today = new Date();
  const start = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (monthsCapped - 1), 1)
  );
  const startMonth = start.toISOString().slice(0, 7);

  const [unitsRes, grossRes] = await Promise.all([
    supabase
      .from('v_apple_refund_monthly')
      .select('month, charge_units, refund_units')
      .gte('month', startMonth)
      .order('month', { ascending: true }),
    supabase
      .from('v_apple_charge_gross_monthly')
      .select('month, charge_gross, refund_gross')
      .gte('month', startMonth)
      .order('month', { ascending: true }),
  ]);

  if (unitsRes.error) console.error('[refunds] apple units view error:', unitsRes.error);
  if (grossRes.error) console.error('[refunds] apple gross view error:', grossRes.error);

  const grossByMonth = new Map<string, { charge_gross: number; refund_gross: number }>();
  for (const r of grossRes.data || []) {
    grossByMonth.set(r.month, {
      charge_gross: Math.abs(Number(r.charge_gross || 0)),
      refund_gross: Math.abs(Number(r.refund_gross || 0)),
    });
  }

  const out: RefundMonthlyRow[] = [];
  for (const u of unitsRes.data || []) {
    const charge_units = Number(u.charge_units || 0);
    const refund_units = Number(u.refund_units || 0);
    const refund_rate_units = charge_units > 0 ? refund_units / charge_units : 0;

    const g = grossByMonth.get(u.month) || { charge_gross: 0, refund_gross: 0 };
    let { charge_gross, refund_gross } = g;
    // If refund $ is missing (Finance Report didn't have refund rows for this
    // month historically), approximate it from units rate × charge $.
    if (refund_gross === 0 && charge_gross > 0 && refund_units > 0) {
      refund_gross = charge_gross * refund_rate_units;
    }
    // Fallback: if Finance Report charges aren't synced yet for this month
    // (e.g. current month before Apple publishes), mirror the units rate so
    // the chart line stays continuous instead of dropping to zero.
    const refund_rate_amount = charge_gross > 0 ? refund_gross / charge_gross : refund_rate_units;

    out.push({
      month: u.month,
      charge_units,
      refund_units,
      charge_gross,
      refund_gross,
      refund_rate_units,
      refund_rate_amount,
    });
  }
  return out;
}

/**
 * Fetch monthly refund metrics for a given source over the last `months` months.
 * Computes refund rate as refund_units / charge_units (Apple-style) and
 * refund_gross / charge_gross (dollar-weighted).
 *
 * Apple is a special case: the `transactions` table is populated from the
 * Apple Finance Report (which only carries refunds for the months actively
 * synced — historical CSV imports never had refund rows). The
 * `apple_subscription_events` table comes from the SUBSCRIPTION_EVENT report
 * and is the source of truth that matches App Store Connect → Trends.
 * For Apple we read from there and join $ context from `transactions`.
 */
export async function getRefundsByMonth(
  source: Source,
  months = 24
): Promise<RefundMonthlyRow[]> {
  if (source === 'apple') {
    return getAppleRefundsByMonth(months);
  }
  return getGenericRefundsByMonth(source, months);
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
  lookbackDays: number;
}

/**
 * Compute Apple-specific refund breakdowns from the SUBSCRIPTION_EVENT table
 * via Postgres functions (apple_refunds_by_*) so we never pull raw rows
 * client-side. ~6 small RPC calls in parallel.
 */
export async function getAppleRefundBreakdowns(days = 90): Promise<AppleRefundBreakdowns> {
  const supabase = createServerClient();

  type RpcRow = { bucket: string; refunds: number; paid_events: number };
  type DaysRpcRow = { bucket: string; refunds: number };

  const [cppRes, daysRes, planRes, offerRes, countryRes, skuRes] = await Promise.all([
    supabase.rpc('apple_refunds_by_cpp', { days }),
    supabase.rpc('apple_refunds_by_days_to_refund', { days }),
    supabase.rpc('apple_refunds_by_dimension', { dim: 'duration', days, top_n: 20 }),
    supabase.rpc('apple_refunds_by_dimension', { dim: 'offer', days, top_n: 20 }),
    supabase.rpc('apple_refunds_by_dimension', { dim: 'country', days, top_n: 15 }),
    supabase.rpc('apple_refunds_by_dimension', { dim: 'sku', days, top_n: 15 }),
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
    lookbackDays: days,
  };

  function toRows(rows: RpcRow[] | null | undefined): BreakdownRow[] {
    return (rows || []).map((r) => ({
      bucket: r.bucket,
      refunds: Number(r.refunds || 0),
      paid_events: Number(r.paid_events || 0),
      refund_rate: Number(r.paid_events || 0) > 0
        ? Number(r.refunds || 0) / Number(r.paid_events || 0)
        : 0,
    }));
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
    overallRate: totalPaid > 0 ? totalRefunds / totalPaid : 0,
    hasData: true,
    lookbackDays: days,
  };
}
