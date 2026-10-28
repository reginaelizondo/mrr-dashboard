import { createServerClient } from '@/lib/supabase/server';
import { unstable_cache } from 'next/cache';
import { hasSkuFilters, type SkuDims, type SkuFilters } from '@/lib/sku-filters';

/**
 * Yearly vs monthly mix by store — CASH basis (charges dated in the month, not
 * accrual), split new vs renewal. Feeds the "Mezcla anual vs mensual por
 * tienda" section of the SKU Breakdown tab.
 *
 * Family is classified by SKU NAME, not plan_type: Apple's intro month ($3.99)
 * of annual SKUs (kinedu_learn_12_ht_c, _mt_c, _ht_d…) is stored with
 * plan_type = 'monthly' (reprice-intro), so by plan_type Apple would look ~30%
 * monthly when it is really ~2%. Rule: '_12' in the SKU = anual, '_1' =
 * mensual; anything else falls back to plan_type.
 *
 * Primary path: RPC `sku_mix_by_store_monthly` (migration 044). Fallback until
 * it is applied: pull the charges month-by-month in parallel and aggregate here.
 */

export type MixFamily = 'anual' | 'mensual' | 'otro';
export type MixKind = 'new' | 'ren';
export type MixStore = 'apple' | 'google' | 'stripe';

export type MixCell = {
  month: string; // 'YYYY-MM-01'
  source: string;
  family: MixFamily;
  kind: MixKind;
  n: number;
  gross: number;
};

export type SkuMix = {
  months: string[]; // 'YYYY-MM-01', same window as the SKU breakdown
  cells: MixCell[];
  /** Region / country values seen in the window — only on the legacy path (the
   *  RPC path gets them from transactions_dim_values instead). */
  dims?: SkuDims;
};

export const MIX_STORES: MixStore[] = ['apple', 'google', 'stripe'];

export function familyOfSku(sku: string | null, planType: string | null): MixFamily {
  const s = (sku || '').toLowerCase();
  if (/_12(_|$)/.test(s)) return 'anual';
  if (/_1(_|$)/.test(s)) return 'mensual';
  if (planType === 'yearly') return 'anual';
  if (planType === 'monthly') return 'mensual';
  return 'otro';
}

function addMonthsStr(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

function monthList(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = `${start}-01`;
  const last = `${end}-01`;
  while (cur <= last) {
    out.push(cur);
    cur = addMonthsStr(cur.slice(0, 7), 1);
  }
  return out;
}

async function loadViaRpc(fromIncl: string, toExcl: string, filters: SkuFilters): Promise<MixCell[] | null> {
  const supabase = createServerClient();
  // Filter params exist since migration 045; an older signature → PGRST202 → legacy path.
  const { data, error } = await supabase.rpc('sku_mix_by_store_monthly', {
    p_from: fromIncl,
    p_to: toExcl,
    p_sources: filters.sources.length ? filters.sources : null,
    p_regions: filters.regions.length ? filters.regions : null,
    p_countries: filters.countries.length ? filters.countries : null,
  });
  if (error) {
    const msg = `${error.code || ''} ${error.message || ''}`;
    if (/PGRST202|PGRST203|42883|Could not find the function|does not exist|best candidate/i.test(msg)) {
      console.warn('[sku-mix] RPC sku_mix_by_store_monthly missing or old signature (run migration 045) — using legacy fetch');
      return null;
    }
    throw new Error(`[sku-mix] RPC error: ${error.message}`);
  }
  const rows = (data || []) as MixCell[];
  console.log(`[sku-mix] RPC returned ${rows.length} cells (${fromIncl} → <${toExcl})`);
  return rows.map((r) => ({ ...r, n: Number(r.n) || 0, gross: Number(r.gross) || 0 }));
}

type Row = {
  id: number;
  source: string | null;
  sku: string | null;
  plan_type: string | null;
  plan_name: string | null;
  region: string | null;
  country_code: string | null;
  amount_gross: number | null;
  transaction_date: string;
  is_new_subscription: boolean | null;
};

async function fetchMonth(fromIncl: string, toExcl: string): Promise<Row[]> {
  const supabase = createServerClient();
  const rows: Row[] = [];
  let lastId = 0;
  for (;;) {
    let page: Row[] | null = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { data, error } = await supabase
        .from('transactions')
        .select('id,source,sku,plan_type,plan_name,region,country_code,amount_gross,transaction_date,is_new_subscription')
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
    if (page === null) throw new Error(`[sku-mix] transactions query failed (${fromIncl}): ${lastErr}`);
    if (page.length === 0) break;
    rows.push(...page);
    lastId = Number(page[page.length - 1].id);
    if (page.length < 1000) break;
  }
  return rows;
}

async function loadLegacy(months: string[], filters: SkuFilters): Promise<{ cells: MixCell[]; dims: SkuDims }> {
  const rows: Row[] = [];
  const queue = [...months];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const m = queue.shift();
        if (!m) return;
        rows.push(...(await fetchMonth(m, addMonthsStr(m.slice(0, 7), 1))));
      }
    })
  );
  console.log(`[sku-mix] legacy fetched ${rows.length} charges`);
  const cells = new Map<string, MixCell>();
  const regionN: Record<string, number> = {};
  const countryN: Record<string, number> = {};
  for (const t of rows) {
    if (t.region) regionN[t.region] = (regionN[t.region] || 0) + 1;
    if (t.country_code) countryN[t.country_code] = (countryN[t.country_code] || 0) + 1;
    if (filters.sources.length && !filters.sources.includes(t.source || '')) continue;
    if (filters.regions.length && !filters.regions.includes(t.region || '')) continue;
    if (filters.countries.length && !filters.countries.includes(t.country_code || '')) continue;
    const planName = (t.plan_name || '').toLowerCase();
    if (planName.includes('test')) continue;
    if (t.source === 'stripe') {
      if (planName.endsWith(' charge') || planName === 'payment for invoice' || planName === 'none') continue;
    }
    if (t.plan_type === 'other') continue;
    const month = `${t.transaction_date.slice(0, 7)}-01`;
    const source = t.source || 'other';
    const family = familyOfSku(t.sku, t.plan_type);
    const kind: MixKind = t.is_new_subscription ? 'new' : 'ren';
    const key = `${month}|${source}|${family}|${kind}`;
    let c = cells.get(key);
    if (!c) {
      c = { month, source, family, kind, n: 0, gross: 0 };
      cells.set(key, c);
    }
    c.n += 1;
    c.gross += Number(t.amount_gross) || 0;
  }
  const toList = (o: Record<string, number>) => Object.entries(o).map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n);
  return { cells: [...cells.values()], dims: { regions: toList(regionN), countries: toList(countryN) } };
}

async function compute(startMonth: string, endMonth: string, filtersJson: string): Promise<SkuMix> {
  const filters = JSON.parse(filtersJson) as SkuFilters;
  const months = monthList(startMonth, endMonth);
  const fromIncl = months[0];
  const toExcl = addMonthsStr(endMonth, 1);
  const viaRpc = await loadViaRpc(fromIncl, toExcl, filters);
  if (viaRpc) return { months, cells: viaRpc };
  const legacy = await loadLegacy(months, filters);
  return { months, cells: legacy.cells, dims: legacy.dims };
}

const cached = unstable_cache(compute, ['sku-mix', 'v2'], { revalidate: 3600, tags: ['snapshots'] });

const NO_FILTERS: SkuFilters = { sources: [], regions: [], countries: [] };

/** start/end are 'YYYY-MM' month strings. Filters (store / region / country) are optional. */
export function getSkuMix(startMonth: string, endMonth: string, filters: SkuFilters = NO_FILTERS): Promise<SkuMix> {
  const f: SkuFilters = hasSkuFilters(filters)
    ? { sources: [...filters.sources].sort(), regions: [...filters.regions].sort(), countries: [...filters.countries].sort() }
    : NO_FILTERS;
  return cached(startMonth, endMonth, JSON.stringify(f));
}

// ─── Dimension values for the filter dropdowns ───────────────────────────────

class DimsMissing extends Error {}

async function computeDims(): Promise<SkuDims> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc('transactions_dim_values');
  if (error) {
    const msg = `${error.code || ''} ${error.message || ''}`;
    // Thrown (not returned as null) so unstable_cache does NOT store the miss:
    // a cached null would hide the dropdowns for 24h after the migration lands.
    if (/PGRST202|42883|Could not find the function|does not exist/i.test(msg)) throw new DimsMissing('run migration 045');
    throw new Error(`[sku-mix] transactions_dim_values error: ${error.message}`);
  }
  const d = (data || {}) as { regions?: { value: string; n: number }[]; countries?: { value: string; n: number }[] };
  return {
    regions: (d.regions || []).map((r) => ({ value: String(r.value), n: Number(r.n) || 0 })),
    countries: (d.countries || []).map((r) => ({ value: String(r.value), n: Number(r.n) || 0 })),
  };
}

const cachedDims = unstable_cache(computeDims, ['sku-dims', 'v2'], { revalidate: 86400, tags: ['snapshots'] });

/** Region / country values for the filter bar; null until migration 045 is applied. */
export async function getSkuDims(): Promise<SkuDims | null> {
  try {
    return await cachedDims();
  } catch (err) {
    if (err instanceof DimsMissing || /run migration 045/.test((err as Error).message)) {
      console.warn('[sku-mix] RPC transactions_dim_values missing (run migration 045)');
      return null;
    }
    throw err;
  }
}
