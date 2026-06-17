import { createServerClient } from '@/lib/supabase/server';

/**
 * Auto-reprice Apple intro-offer SKUs against Apple's ACTUAL charged price.
 *
 * Problem this solves: the Kinedu `sales` source records intro-priced annual
 * subscriptions (e.g. "$3.99 first month then $79.99/yr") at their LIST price
 * (~$80), so the dashboard over-states MRR/cash for those charges. Apple's real
 * sales report (`apple_sales_daily`) has the actual charged amount.
 *
 * This runs after each kinedu-db sync. It is DATA-DRIVEN (no hard-coded SKU
 * list): for every Apple NEW-subscription charge in the window, if Apple's
 * actual average "New" price for that (sku, currency, month) is materially
 * LOWER than what was recorded, it reprices the charge to Apple's actual amount
 * and marks it monthly (intro charges bill monthly). This automatically catches
 * current and future intro SKUs without maintenance.
 *
 * Safe by construction: only lowers amounts (never inflates), only acts on
 * Apple new-sub charges, requires enough Apple volume to trust the price, and
 * preserves the original amount in raw_data for full reversibility.
 */
export async function repriceAppleIntroSkus(
  fromDate: string,
  toDate: string
): Promise<{ repriced: number; scanned: number }> {
  const supabase = createServerClient();

  // ── FX rates (apple_fx_rates) to convert Apple local prices → USD ──────────
  const { data: fxRows } = await supabase
    .from('apple_fx_rates')
    .select('year_month,currency,rate');
  const FX: Record<string, number> = {};
  for (const r of fxRows || []) {
    FX[`${r.year_month}|${String(r.currency).toUpperCase()}`] = Number(r.rate);
  }
  const toUsd = (amountLocal: number, currency: string | null, ym: string): number | null => {
    const c = (currency || 'USD').toUpperCase();
    if (c === 'USD') return amountLocal;
    const r = FX[`${ym}|${c}`] ?? FX[`default|${c}`];
    if (!r || r === 0) return null;
    return amountLocal / r;
  };

  // ── Apple's actual "New" (intro) avg price per (sku, currency, ym) ─────────
  // Fetch apple_sales_daily New rows from the first day of fromDate's month.
  const monthStart = `${fromDate.slice(0, 7)}-01`;
  const ref: Record<string, { sum: number; units: number }> = {};
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from('apple_sales_daily')
      .select('sku,customer_price,customer_currency,units,begin_date')
      .eq('subscription', 'New')
      .gte('begin_date', monthStart)
      .lte('begin_date', toDate)
      .gt('units', 0)
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data) {
      if (!(Number(r.customer_price) > 0)) continue;
      const ym = String(r.begin_date).slice(0, 7);
      const key = `${r.sku}|${String(r.customer_currency || 'USD').toUpperCase()}|${ym}`;
      const a = (ref[key] = ref[key] || { sum: 0, units: 0 });
      a.sum += Number(r.customer_price) * Number(r.units);
      a.units += Number(r.units);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // ── Reprice Apple new-sub charges in [fromDate, toDate] ────────────────────
  const updates: { id: number; amount_gross: number; amount_net: number; original_amount: number; raw_data: Record<string, unknown> }[] = [];
  let scanned = 0;
  let lastId = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id,sku,transaction_date,amount_gross,original_currency,raw_data')
      .eq('source', 'apple')
      .eq('transaction_type', 'charge')
      .eq('is_new_subscription', true)
      .gte('transaction_date', fromDate)
      .lte('transaction_date', toDate)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (error || !data || data.length === 0) break;
    for (const t of data) {
      scanned++;
      const ym = String(t.transaction_date).slice(0, 7);
      const cur = String(t.original_currency || 'USD').toUpperCase();
      const r = ref[`${t.sku}|${cur}|${ym}`];
      if (!r || r.units < 5) continue; // need enough Apple volume to trust the price
      const appleLocal = r.sum / r.units;
      const appleUsd = toUsd(appleLocal, cur, ym);
      if (appleUsd == null) continue;
      const recorded = Number(t.amount_gross) || 0;
      // only correct downward (intro): require Apple price < 90% of recorded
      if (appleUsd >= recorded * 0.9) continue;
      const oldGross =
        t.raw_data && (t.raw_data as Record<string, unknown>).old_amount_gross != null
          ? Number((t.raw_data as Record<string, unknown>).old_amount_gross)
          : recorded;
      updates.push({
        id: Number(t.id),
        amount_gross: appleUsd,
        amount_net: appleUsd * 0.7,
        original_amount: appleLocal,
        raw_data: { ...(t.raw_data as object), intro_repriced: true, old_amount_gross: oldGross },
      });
    }
    if (data.length < PAGE) break;
    lastId = Number(data[data.length - 1].id);
  }

  // ── Apply updates (also flip plan_type → monthly: intro charges bill monthly)
  let repriced = 0;
  const BATCH = 200;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    await Promise.all(
      batch.map((u) =>
        supabase
          .from('transactions')
          .update({
            amount_gross: u.amount_gross,
            amount_net: u.amount_net,
            original_amount: u.original_amount,
            plan_type: 'monthly',
            raw_data: u.raw_data,
          })
          .eq('id', u.id)
      )
    );
    repriced += batch.length;
  }

  console.log(`[reprice-intro] scanned ${scanned} apple new-subs, repriced ${repriced} (${fromDate}→${toDate})`);
  return { repriced, scanned };
}
