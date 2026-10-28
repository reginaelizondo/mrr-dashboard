import { createServerClient } from '@/lib/supabase/server';
import { unstable_cache } from 'next/cache';

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

async function loadViaRpc(fromIncl: string, toExcl: string): Promise<MixCell[] | null> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc('sku_mix_by_store_monthly', { p_from: fromIncl, p_to: toExcl });
  if (error) {
    const msg = `${error.code || ''} ${error.message || ''}`;
    if (/PGRST202|42883|Could not find the function|does not exist/i.test(msg)) {
      console.warn('[sku-mix] RPC sku_mix_by_store_monthly missing (run migration 044) — using legacy fetch');
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
        .select('id,source,sku,plan_type,plan_name,amount_gross,transaction_date,is_new_subscription')
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

async function loadLegacy(months: string[]): Promise<MixCell[]> {
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
  for (const t of rows) {
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
  return [...cells.values()];
}

async function compute(startMonth: string, endMonth: string): Promise<SkuMix> {
  const months = monthList(startMonth, endMonth);
  const fromIncl = months[0];
  const toExcl = addMonthsStr(endMonth, 1);
  const cells = (await loadViaRpc(fromIncl, toExcl)) ?? (await loadLegacy(months));
  return { months, cells };
}

const cached = unstable_cache(compute, ['sku-mix', 'v1'], { revalidate: 3600, tags: ['snapshots'] });

/** start/end are 'YYYY-MM' month strings. */
export function getSkuMix(startMonth: string, endMonth: string): Promise<SkuMix> {
  return cached(startMonth, endMonth);
}
