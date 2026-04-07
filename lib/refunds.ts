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

  // The events table only retains ~365 days, so cap the lookback there.
  const today = new Date();
  const monthsCapped = Math.min(months, 13);
  const start = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (monthsCapped - 1), 1)
  );
  const startStr = start.toISOString().slice(0, 10);

  // ---- 1) Pull events (units, classification) ----
  interface EvRow {
    event_date: string;
    event: string;
    quantity: number | null;
  }
  const events: EvRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('apple_subscription_events')
      .select('event_date, event, quantity')
      .gte('event_date', startStr)
      .range(from, from + pageSize - 1);
    if (error) {
      console.error('[refunds] apple events query error:', error);
      break;
    }
    if (!data || data.length === 0) break;
    events.push(...(data as EvRow[]));
    if (data.length < pageSize) break;
  }

  // ---- 2) Pull charge $ from transactions (Finance Report) for the same range ----
  interface TxRowApple {
    transaction_date: string;
    transaction_type: string;
    amount_gross: number | null;
  }
  const txs: TxRowApple[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('transactions')
      .select('transaction_date, transaction_type, amount_gross')
      .eq('source', 'apple')
      .in('transaction_type', ['charge', 'refund'])
      .gte('transaction_date', startStr)
      .range(from, from + pageSize - 1);
    if (error) {
      console.error('[refunds] apple tx query error:', error);
      break;
    }
    if (!data || data.length === 0) break;
    txs.push(...(data as TxRowApple[]));
    if (data.length < pageSize) break;
  }

  // ---- 3) Aggregate per month ----
  const byMonth = new Map<string, RefundMonthlyRow>();
  function ensure(month: string): RefundMonthlyRow {
    let r = byMonth.get(month);
    if (!r) {
      r = {
        month,
        charge_units: 0,
        refund_units: 0,
        charge_gross: 0,
        refund_gross: 0,
        refund_rate_units: 0,
        refund_rate_amount: 0,
      };
      byMonth.set(month, r);
    }
    return r;
  }

  for (const e of events) {
    const month = (e.event_date || '').slice(0, 7);
    if (!month) continue;
    const qty = Math.abs(Number(e.quantity || 0));
    const ev = e.event || '';
    if (ev.startsWith('Refund')) {
      ensure(month).refund_units += qty;
    } else if (
      ev !== 'Cancel' &&
      ev !== 'Canceled from Billing Retry' &&
      ev !== 'Start Introductory Offer' &&
      !ev.startsWith('Billing Retry')
    ) {
      ensure(month).charge_units += qty;
    }
  }

  for (const t of txs) {
    const month = (t.transaction_date || '').slice(0, 7);
    if (!month) continue;
    const gross = Math.abs(Number(t.amount_gross || 0));
    const r = ensure(month);
    if (t.transaction_type === 'charge') r.charge_gross += gross;
    else if (t.transaction_type === 'refund') r.refund_gross += gross;
  }

  // ---- 4) Compute rates. Refund $ is approximated when missing. ----
  const out = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
  for (const r of out) {
    r.refund_rate_units = r.charge_units > 0 ? r.refund_units / r.charge_units : 0;
    // If refund $ is missing or implausibly low (e.g. only 1 month had Finance refund rows),
    // approximate it from units rate × charge $.
    if (r.refund_gross === 0 && r.charge_gross > 0 && r.refund_units > 0) {
      r.refund_gross = r.charge_gross * r.refund_rate_units;
    }
    // Fallback: if Finance Report charges aren't synced yet for this month
    // (e.g. current month before Apple publishes), mirror the units rate so
    // the chart line stays continuous instead of dropping to zero.
    if (r.charge_gross > 0) {
      r.refund_rate_amount = r.refund_gross / r.charge_gross;
    } else {
      r.refund_rate_amount = r.refund_rate_units;
    }
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

interface EventRow {
  event: string;
  event_date: string;
  consecutive_paid_periods: number | null;
  days_before_canceling: number | null;
  original_start_date: string | null;
  subscription_name: string | null;
  country: string | null;
  standard_subscription_duration: string | null;
  subscription_offer_type: string | null;
  quantity: number;
}

async function fetchAppleEvents(days: number): Promise<EventRow[]> {
  const supabase = createServerClient();
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - days);
  const startStr = start.toISOString().slice(0, 10);

  const pageSize = 1000;
  const rows: EventRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('apple_subscription_events')
      .select(
        'event, event_date, consecutive_paid_periods, days_before_canceling, original_start_date, subscription_name, country, standard_subscription_duration, subscription_offer_type, quantity'
      )
      .gte('event_date', startStr)
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('[refunds] apple events query error:', error);
      break;
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as EventRow[]));
    if (data.length < pageSize) break;
  }

  return rows;
}

// Apple events that represent a paid transaction (charge to the customer).
// Based on actual SUBSCRIPTION_EVENT report data.
// Excludes: Start Introductory Offer (free trial start), Cancel, Billing Retry (= retry started, not succeeded).
const PAID_EVENT_PATTERNS = [
  'Subscribe',                              // initial paid
  'Subscribe with Contingent Price',
  'Paid Subscription from Introductory Offer', // first paid charge after trial
  'Renew',                                  // paid renewal
  'Renewal from Billing Retry',             // recovered renewal
  'Reactivate',                             // and all 'Reactivate ...' variants
  'Upgrade',                                // and all 'Upgrade ...' variants
  'Downgrade',                              // and all 'Downgrade ...' variants
  'Crossgrade',                             // and all 'Crossgrade ...' variants
];

function isPaidEvent(e: string): boolean {
  // Exclude refunds and explicit non-paid events
  if (isRefundEvent(e)) return false;
  if (e === 'Cancel') return false;
  if (e === 'Canceled from Billing Retry') return false;
  if (e.startsWith('Billing Retry')) return false; // retry STARTED (not yet succeeded)
  if (e === 'Start Introductory Offer') return false; // trial start (no charge)

  // Treat upgrade/downgrade/crossgrade FROM Introductory Offer as paid (they convert)
  for (const p of PAID_EVENT_PATTERNS) {
    if (e === p || e.startsWith(p + ' ') || e.startsWith(p + ' from')) return true;
  }
  return false;
}

function isRefundEvent(e: string): boolean {
  return e === 'Refund' || e.startsWith('Refund');
}

function bucketDaysBeforeCanceling(d: number | null): string {
  if (d == null) return 'Unknown';
  if (d <= 1) return '0–1 days';
  if (d <= 7) return '2–7 days';
  if (d <= 30) return '8–30 days';
  if (d <= 90) return '31–90 days';
  return '90+ days';
}

/**
 * For Refund events Apple leaves "Days Before Canceling" empty.
 * Compute it as event_date − original_start_date when both are present.
 * NOTE: original_start_date is the FIRST EVER subscription start, so for
 * CPP=2+ this measures total time as a subscriber, not time since the
 * refunded charge specifically. Most useful for CPP=1 refunds.
 */
function effectiveDaysBeforeCanceling(ev: EventRow): number | null {
  if (ev.days_before_canceling != null) return ev.days_before_canceling;
  if (!ev.event_date || !ev.original_start_date) return null;
  const start = Date.parse(ev.original_start_date + 'T00:00:00Z');
  const end = Date.parse(ev.event_date + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / (24 * 3600 * 1000));
}

function bucketCpp(n: number | null): string {
  if (n == null || n <= 0) return 'Unknown';
  if (n === 1) return '1 — Initial purchase';
  if (n === 2) return '2 — 1st renewal';
  if (n === 3) return '3 — 2nd renewal';
  if (n === 4) return '4 — 3rd renewal';
  return '5+ renewals';
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
 * Compute Apple-specific refund breakdowns from the SUBSCRIPTION_EVENT table.
 * Each breakdown returns refund count, paid event count (denominator), and rate.
 */
export async function getAppleRefundBreakdowns(days = 90): Promise<AppleRefundBreakdowns> {
  const events = await fetchAppleEvents(days);

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

  if (events.length === 0) return empty;

  type Agg = { refunds: number; paid: number };
  const mk = () => new Map<string, Agg>();
  const cppMap = mk();
  const daysMap = mk();
  const planMap = mk();
  const offerMap = mk();
  const countryMap = mk();
  const skuMap = mk();

  let totalRefunds = 0;
  let totalPaid = 0;

  function bump(map: Map<string, Agg>, key: string, isRefund: boolean, qty: number) {
    let v = map.get(key);
    if (!v) {
      v = { refunds: 0, paid: 0 };
      map.set(key, v);
    }
    if (isRefund) v.refunds += qty;
    else v.paid += qty;
  }

  for (const ev of events) {
    const isRefund = isRefundEvent(ev.event);
    const isPaid = isPaidEvent(ev.event);
    if (!isRefund && !isPaid) continue;

    const qty = Math.max(0, Number(ev.quantity || 0));
    if (qty === 0) continue;

    if (isRefund) totalRefunds += qty;
    if (isPaid) totalPaid += qty;

    bump(cppMap, bucketCpp(ev.consecutive_paid_periods), isRefund, qty);
    // For days-before-canceling we only care about refunds (denominator = total refunds)
    if (isRefund) {
      bump(daysMap, bucketDaysBeforeCanceling(effectiveDaysBeforeCanceling(ev)), true, qty);
    }
    bump(planMap, ev.standard_subscription_duration || 'Unknown', isRefund, qty);
    bump(offerMap, ev.subscription_offer_type || 'Standard', isRefund, qty);
    bump(countryMap, ev.country || 'Unknown', isRefund, qty);
    bump(skuMap, ev.subscription_name || 'Unknown', isRefund, qty);
  }

  function toRows(map: Map<string, Agg>, sort: 'key' | 'refunds' = 'refunds'): BreakdownRow[] {
    const rows = Array.from(map.entries()).map(([bucket, v]) => ({
      bucket,
      refunds: v.refunds,
      paid_events: v.paid,
      refund_rate: v.paid > 0 ? v.refunds / v.paid : 0,
    }));
    if (sort === 'refunds') {
      rows.sort((a, b) => b.refunds - a.refunds || b.paid_events - a.paid_events);
    } else {
      rows.sort((a, b) => a.bucket.localeCompare(b.bucket));
    }
    return rows;
  }

  // For the days-before-canceling breakdown there is no natural denominator
  // (we can't compute "refunds per paid event at day X"). Instead, treat the
  // rate as "share of total refunds in this bucket".
  function toDaysRows(map: Map<string, Agg>): BreakdownRow[] {
    const total = Array.from(map.values()).reduce((a, v) => a + v.refunds, 0);
    const order = ['0–1 days', '2–7 days', '8–30 days', '31–90 days', '90+ days', 'Unknown'];
    return Array.from(map.entries())
      .map(([bucket, v]) => ({
        bucket,
        refunds: v.refunds,
        paid_events: total, // total refunds as the denominator for the share
        refund_rate: total > 0 ? v.refunds / total : 0,
      }))
      .sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
  }

  return {
    byConsecutivePaidPeriod: toRows(cppMap, 'key'),
    byDaysBeforeCanceling: toDaysRows(daysMap),
    byPlanDuration: toRows(planMap),
    byOfferType: toRows(offerMap),
    byCountry: toRows(countryMap).slice(0, 15),
    bySku: toRows(skuMap).slice(0, 15),
    totalRefunds,
    totalPaid,
    overallRate: totalPaid > 0 ? totalRefunds / totalPaid : 0,
    hasData: true,
    lookbackDays: days,
  };
}
