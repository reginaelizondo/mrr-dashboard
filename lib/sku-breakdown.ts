import { createServerClient } from '@/lib/supabase/server';
import { unstable_cache } from 'next/cache';

/**
 * SKU-level breakdown of MRR, on the SAME accrual basis as the daily snapshots
 * (lib/sync/snapshots.ts) so the per-month totals reconcile EXACTLY with
 * `mrr_gross` / `active_subscriptions` in `mrr_daily_snapshots`.
 *
 * Methodology (must match computeMonthlySnapshot):
 *  - Each charge contributes amount_gross / period_months to every month it is
 *    "active" (from its sale month through sale month + ceil(period) - 1).
 *  - Same data-quality filters: drop test plans, stripe non-subscription
 *    charges, and plan_type='other'.
 *  - Revenue is split new vs recurring by the charge's is_new_subscription flag.
 *  - Volume = count of active charges (each active charge = 1 active sub),
 *    which sums to active_subscriptions.
 *
 * Validated 2026-06-16: per-month total matches mrr_gross within ~$12 (0.00%),
 * the residual being pre-lookback lifetime charges (negligible).
 */

const PLAN_PERIOD_MONTHS: Record<string, number> = {
  monthly: 1,
  yearly: 12,
  semesterly: 6,
  quarterly: 3,
  weekly: 0.25,
  lifetime: 60,
  other: 1,
};

export type SkuMeta = {
  sku: string;
  planType: string;
  totalRev: number; // summed across all months in range (for sorting / default selection)
  totalVol: number;
};

export type SkuSeries = {
  newRev: number[];
  recRev: number[];
  vol: number[];
};

export type SkuBreakdown = {
  months: string[]; // 'YYYY-MM-01'
  skus: SkuMeta[]; // sorted desc by totalRev
  series: Record<string, SkuSeries>;
  totals: { rev: number[]; vol: number[] }; // per-month grand totals (== mrr_gross / active_subscriptions)
};

// Month math on 'YYYY-MM' strings — TIMEZONE-SAFE (no Date objects, which would
// shift across UTC/local boundaries and silently drop a month from the range).
function addMonthsStr(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

function monthList(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

async function compute(startMonth: string, endMonth: string): Promise<SkuBreakdown> {
  const supabase = createServerClient();

  // Lookback: 13 months before the first displayed month captures every yearly
  // sub still spreading into it. Lifetime (60mo) is negligible (~$12/mo total).
  const lookbackFrom = addMonthsStr(startMonth, -13);
  // Exclusive upper bound = first day of the month AFTER endMonth (avoids
  // building invalid dates like "2026-06-31").
  const fetchToExclusive = addMonthsStr(endMonth, 1);

  type Row = {
    id: number;
    sku: string | null;
    plan_type: string | null;
    plan_name: string | null;
    source: string | null;
    amount_gross: number | null;
    transaction_date: string;
    is_new_subscription: boolean | null;
  };

  const rows: Row[] = [];
  let lastId = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id,sku,plan_type,plan_name,source,amount_gross,transaction_date,is_new_subscription')
      .eq('transaction_type', 'charge')
      .gte('transaction_date', lookbackFrom)
      .lt('transaction_date', fetchToExclusive)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(1000);
    if (error) {
      console.error('[sku-breakdown] query error:', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    lastId = Number(data[data.length - 1].id);
    if (data.length < 1000) break;
  }
  console.log(`[sku-breakdown] fetched ${rows.length} charges (${lookbackFrom} → <${fetchToExclusive})`);

  const months = monthList(startMonth, endMonth);
  const mIdx: Record<string, number> = {};
  months.forEach((m, i) => (mIdx[m.slice(0, 7)] = i));

  const series: Record<string, SkuSeries> = {};
  const planBySku: Record<string, string> = {};
  const totalsRev = months.map(() => 0);
  const totalsVol = months.map(() => 0);

  for (const t of rows) {
    const planName = (t.plan_name || '').toLowerCase();
    if (planName.includes('test')) continue;
    if (t.source === 'stripe') {
      if (planName.endsWith(' charge')) continue;
      if (planName === 'payment for invoice') continue;
      if (planName === 'none') continue;
    }
    // Match the snapshot exactly: drop ONLY literal plan_type='other'. Charges
    // with a null plan_type are KEPT (treated as monthly, pm=1) — the snapshot
    // counts them too, so dropping them would understate the total.
    if (t.plan_type === 'other') continue;
    const planType = t.plan_type || 'other';

    const pm = PLAN_PERIOD_MONTHS[planType] || 1;
    const d = new Date(t.transaction_date + 'T00:00:00Z');
    const ty = d.getUTCFullYear();
    const tm = d.getUTCMonth();
    const contrib = (Number(t.amount_gross) || 0) / pm;
    const nCov = pm < 1 ? 1 : Math.ceil(pm);
    const sku = t.sku || '(sin SKU)';

    for (let k = 0; k < nCov; k++) {
      const cy = ty + Math.floor((tm + k) / 12);
      const cm = (tm + k) % 12;
      const key = `${cy}-${String(cm + 1).padStart(2, '0')}`;
      const i = mIdx[key];
      if (i === undefined) continue;

      if (!series[sku]) {
        series[sku] = { newRev: months.map(() => 0), recRev: months.map(() => 0), vol: months.map(() => 0) };
        planBySku[sku] = planType;
      }
      if (t.is_new_subscription) series[sku].newRev[i] += contrib;
      else series[sku].recRev[i] += contrib;
      series[sku].vol[i] += 1;
      totalsRev[i] += contrib;
      totalsVol[i] += 1;
    }
  }

  const skus: SkuMeta[] = Object.keys(series)
    .map((sku) => {
      const s = series[sku];
      return {
        sku,
        planType: planBySku[sku],
        totalRev: s.newRev.reduce((a, b) => a + b, 0) + s.recRev.reduce((a, b) => a + b, 0),
        totalVol: s.vol.reduce((a, b) => a + b, 0),
      };
    })
    .sort((a, b) => b.totalRev - a.totalRev);

  console.log(`[sku-breakdown] last month ${months[months.length - 1]} total=$${Math.round(totalsRev[totalsRev.length - 1]).toLocaleString()} skus=${skus.length}`);

  return {
    months,
    skus,
    series,
    totals: { rev: totalsRev.map((v) => Math.round(v)), vol: totalsVol },
  };
}

const cached = unstable_cache(compute, ['sku-breakdown', 'v3'], { revalidate: 3600, tags: ['snapshots'] });

/** start/end are 'YYYY-MM' month strings. */
export function getSkuBreakdown(startMonth: string, endMonth: string): Promise<SkuBreakdown> {
  return cached(startMonth, endMonth);
}
