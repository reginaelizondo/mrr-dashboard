import { createServerClient } from '@/lib/supabase/server';
import { unstable_cache } from 'next/cache';
import { hasSkuFilters, type SkuFilters } from '@/lib/sku-filters';

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
 *
 * 2026-10-27: the aggregation moved to Postgres (RPC `sku_breakdown_monthly`,
 * migration 043). Pulling every charge of the window into Node (272K rows in
 * 272 sequential pages) was dropping the connection mid-way on Vercel
 * ("fetch failed") and the tab would not open. Until the migration is applied
 * the legacy path still runs, now fetching months in parallel with retries and
 * FAILING LOUDLY instead of silently rendering partial (understated) numbers.
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

/** One aggregated cell: a SKU's contribution to one month (what the RPC returns). */
type AggRow = {
  sku: string;
  plan_type: string;
  month: string; // 'YYYY-MM-DD' (first of month)
  new_rev: number;
  rec_rev: number;
  vol: number;
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

// ─── Primary path: Postgres does the spreading (migration 043) ───────────────

async function loadAggViaRpc(startMonth: string, endMonth: string, filters: SkuFilters): Promise<AggRow[] | null> {
  const supabase = createServerClient();
  // Filter params exist since migration 045; with the 043 signature this call
  // fails with PGRST202 and we fall back to the legacy path (which filters in Node).
  const { data, error } = await supabase.rpc('sku_breakdown_monthly', {
    p_start_month: `${startMonth}-01`,
    p_end_month: `${endMonth}-01`,
    p_sources: filters.sources.length ? filters.sources : null,
    p_regions: filters.regions.length ? filters.regions : null,
    p_countries: filters.countries.length ? filters.countries : null,
  });
  if (error) {
    // Function not created yet (migration 043 pending) → legacy path. Anything
    // else is a real failure and must surface.
    const msg = `${error.code || ''} ${error.message || ''}`;
    if (/PGRST202|PGRST203|42883|Could not find the function|does not exist|best candidate/i.test(msg)) {
      console.warn('[sku-breakdown] RPC sku_breakdown_monthly missing or old signature (run migration 045) — using legacy fetch');
      return null;
    }
    throw new Error(`[sku-breakdown] RPC error: ${error.message}`);
  }
  const rows = (data || []) as AggRow[];
  console.log(`[sku-breakdown] RPC returned ${rows.length} sku×month cells (${startMonth} → ${endMonth})`);
  return rows;
}

// ─── Legacy path: pull charges and spread in Node (parallel by month, retries) ─

type Row = {
  id: number;
  sku: string | null;
  plan_type: string | null;
  plan_name: string | null;
  source: string | null;
  region: string | null;
  country_code: string | null;
  amount_gross: number | null;
  transaction_date: string;
  is_new_subscription: boolean | null;
};

function rowPassesFilters(t: { source: string | null; region: string | null; country_code: string | null }, f: SkuFilters): boolean {
  if (f.sources.length && !f.sources.includes(t.source || '')) return false;
  if (f.regions.length && !f.regions.includes(t.region || '')) return false;
  if (f.countries.length && !f.countries.includes(t.country_code || '')) return false;
  return true;
}

async function fetchChargesForMonth(fromIncl: string, toExcl: string): Promise<Row[]> {
  const supabase = createServerClient();
  const rows: Row[] = [];
  let lastId = 0;
  for (;;) {
    let page: Row[] | null = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { data, error } = await supabase
        .from('transactions')
        .select('id,sku,plan_type,plan_name,source,region,country_code,amount_gross,transaction_date,is_new_subscription')
        .eq('transaction_type', 'charge')
        .gte('transaction_date', fromIncl)
        .lt('transaction_date', toExcl)
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(1000);
      if (!error) {
        page = (data || []) as Row[];
        break;
      }
      lastErr = error.message;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
    if (page === null) throw new Error(`[sku-breakdown] transactions query failed (${fromIncl}): ${lastErr}`);
    if (page.length === 0) break;
    rows.push(...page);
    lastId = Number(page[page.length - 1].id);
    if (page.length < 1000) break;
  }
  return rows;
}

async function loadAggLegacy(startMonth: string, endMonth: string, filters: SkuFilters): Promise<AggRow[]> {
  // Lookback: 13 months before the first displayed month captures every yearly
  // sub still spreading into it. Lifetime (60mo) is negligible (~$12/mo total).
  const lookbackFrom = addMonthsStr(startMonth, -13);
  // Exclusive upper bound = first day of the month AFTER endMonth.
  const fetchToExclusive = addMonthsStr(endMonth, 1);

  // One paginated fetch per calendar month, 6 at a time.
  const fetchMonths = monthList(lookbackFrom.slice(0, 7), addMonthsStr(fetchToExclusive.slice(0, 7), -1).slice(0, 7));
  const rows: Row[] = [];
  const queue = [...fetchMonths];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const m = queue.shift();
        if (!m) return;
        const got = await fetchChargesForMonth(m, addMonthsStr(m.slice(0, 7), 1));
        rows.push(...got);
      }
    })
  );
  console.log(`[sku-breakdown] legacy fetched ${rows.length} charges (${lookbackFrom} → <${fetchToExclusive})`);

  const months = monthList(startMonth, endMonth);
  const wanted = new Set(months.map((m) => m.slice(0, 7)));
  const cells = new Map<string, AggRow>();

  for (const t of rows) {
    if (!rowPassesFilters(t, filters)) continue;
    const planName = (t.plan_name || '').toLowerCase();
    if (planName.includes('test')) continue;
    if (t.source === 'stripe') {
      if (planName.endsWith(' charge')) continue;
      if (planName === 'payment for invoice') continue;
      if (planName === 'none') continue;
    }
    // Match the snapshot exactly: drop ONLY literal plan_type='other'. Charges
    // with a null plan_type are KEPT (treated as monthly, pm=1).
    if (t.plan_type === 'other') continue;
    const planType = t.plan_type || 'other';

    const pm = PLAN_PERIOD_MONTHS[planType] || 1;
    const [ty, tm1] = t.transaction_date.split('-').map(Number);
    const tm = tm1 - 1;
    const contrib = (Number(t.amount_gross) || 0) / pm;
    const nCov = pm < 1 ? 1 : Math.ceil(pm);
    const sku = t.sku || '(sin SKU)';

    for (let k = 0; k < nCov; k++) {
      const cy = ty + Math.floor((tm + k) / 12);
      const cm = (tm + k) % 12;
      const key = `${cy}-${String(cm + 1).padStart(2, '0')}`;
      if (!wanted.has(key)) continue;
      const cellKey = `${sku}\u0000${planType}\u0000${key}`;
      let cell = cells.get(cellKey);
      if (!cell) {
        cell = { sku, plan_type: planType, month: `${key}-01`, new_rev: 0, rec_rev: 0, vol: 0 };
        cells.set(cellKey, cell);
      }
      if (t.is_new_subscription) cell.new_rev += contrib;
      else cell.rec_rev += contrib;
      cell.vol += 1;
    }
  }
  return [...cells.values()];
}

// ─── Assemble the series the chart consumes ──────────────────────────────────

async function compute(startMonth: string, endMonth: string, filtersJson: string): Promise<SkuBreakdown> {
  const filters = JSON.parse(filtersJson) as SkuFilters;
  const agg = (await loadAggViaRpc(startMonth, endMonth, filters)) ?? (await loadAggLegacy(startMonth, endMonth, filters));

  const months = monthList(startMonth, endMonth);
  const mIdx: Record<string, number> = {};
  months.forEach((m, i) => (mIdx[m.slice(0, 7)] = i));

  const series: Record<string, SkuSeries> = {};
  // A SKU can carry more than one plan_type in the data; label it with the one
  // that brings the most revenue.
  const revByPlan: Record<string, Record<string, number>> = {};
  const totalsRev = months.map(() => 0);
  const totalsVol = months.map(() => 0);

  for (const r of agg) {
    const i = mIdx[String(r.month).slice(0, 7)];
    if (i === undefined) continue;
    const newRev = Number(r.new_rev) || 0;
    const recRev = Number(r.rec_rev) || 0;
    const vol = Number(r.vol) || 0;
    if (!series[r.sku]) {
      series[r.sku] = { newRev: months.map(() => 0), recRev: months.map(() => 0), vol: months.map(() => 0) };
      revByPlan[r.sku] = {};
    }
    series[r.sku].newRev[i] += newRev;
    series[r.sku].recRev[i] += recRev;
    series[r.sku].vol[i] += vol;
    revByPlan[r.sku][r.plan_type] = (revByPlan[r.sku][r.plan_type] || 0) + newRev + recRev;
    totalsRev[i] += newRev + recRev;
    totalsVol[i] += vol;
  }

  const skus: SkuMeta[] = Object.keys(series)
    .map((sku) => {
      const s = series[sku];
      const planType = Object.entries(revByPlan[sku]).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
      return {
        sku,
        planType,
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

const cached = unstable_cache(compute, ['sku-breakdown', 'v5'], { revalidate: 3600, tags: ['snapshots'] });

const NO_FILTERS: SkuFilters = { sources: [], regions: [], countries: [] };

/** start/end are 'YYYY-MM' month strings. Filters (store / region / country) are optional. */
export function getSkuBreakdown(startMonth: string, endMonth: string, filters: SkuFilters = NO_FILTERS): Promise<SkuBreakdown> {
  // Serialized so the cache key is stable and the args stay JSON-serializable.
  const f: SkuFilters = hasSkuFilters(filters)
    ? { sources: [...filters.sources].sort(), regions: [...filters.regions].sort(), countries: [...filters.countries].sort() }
    : NO_FILTERS;
  return cached(startMonth, endMonth, JSON.stringify(f));
}
