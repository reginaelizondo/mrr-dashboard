import { createServerClient } from '@/lib/supabase/server';

/**
 * Homologa el neto del DASHBOARD PRINCIPAL a la tasa neta REAL de las tiendas.
 *
 * `transactions` guarda Apple/Google con comisión NOMINAL (kinedu-db.ts: 30% / 15%),
 * pero la tasa real (comisión + impuestos locales) vive en `mv_store_net_rate_monthly`
 * — la misma MV que consume Cohortes (migraciones 026/027/028/029):
 *   · apple  ← apple_sales_daily (developer_proceeds / customer_price, en USD)
 *   · google ← google_net_rate_monthly (cash neto de earnings; IVA-MX fecha-consciente)
 *   · stripe ← transactions (fee modelado; YA real, no se toca aquí)
 *
 * Este paso reescribe amount_net / commission_amount de los cargos Apple/Google en
 * [fromDate, toDate] con el neto real = gross × tasa_blended(store, mes) de la MV, para
 * que el dashboard principal (snapshots ← transactions.amount_net) muestre lo mismo que
 * Cohortes. Donde la MV no tiene dato (mes sin cobertura, o mes corriente antes de que
 * lleguen los earnings), la fila se deja como está (nominal). commission_amount se
 * recalcula SIEMPRE como gross − net (también corrige el bug histórico de reprice-intro,
 * que movía net pero no commission).
 *
 * La MV la refresca el propio daily cron ANTES de llamar a esto. Stripe queda intacto.
 */
export async function applyRealNetFromMV(
  fromDate: string,
  toDate: string
): Promise<{ updated: number }> {
  const supabase = createServerClient();

  // ── Tasa blended (ponderada por ingreso) por store|mes desde la MV interna ──
  const rate: Record<string, number> = {};
  {
    const acc: Record<string, { g: number; n: number }> = {};
    let from = 0;
    const PAGE = 1000;
    for (;;) {
      const { data, error } = await supabase
        .from('mv_store_net_rate_monthly')
        .select('store,year_month,gross_usd,net_usd')
        .in('store', ['apple', 'google'])
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const r of data) {
        const k = `${r.store}|${r.year_month}`;
        (acc[k] ||= { g: 0, n: 0 }).g += Number(r.gross_usd) || 0;
        acc[k].n += Number(r.net_usd) || 0;
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
    for (const [k, d] of Object.entries(acc)) if (d.g > 0) rate[k] = d.n / d.g;
  }

  const round2 = (x: number) => Math.round(x * 100) / 100;
  const updates: { id: number; amount_net: number; commission_amount: number }[] = [];

  for (const source of ['apple', 'google'] as const) {
    let lastId = 0;
    for (;;) {
      const { data, error } = await supabase
        .from('transactions')
        .select('id,transaction_date,amount_gross,amount_net,commission_amount')
        .eq('source', source)
        .eq('transaction_type', 'charge')
        .gte('transaction_date', fromDate)
        .lte('transaction_date', toDate)
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(1000);
      if (error || !data || data.length === 0) break;
      for (const t of data) {
        const g = Number(t.amount_gross) || 0;
        const ym = String(t.transaction_date).slice(0, 7);
        const r = rate[`${source}|${ym}`];
        const net = r != null ? round2(g * r) : Number(t.amount_net) || 0;
        const comm = round2(g - net);
        if (
          Math.abs(net - (Number(t.amount_net) || 0)) > 0.005 ||
          Math.abs(comm - (Number(t.commission_amount) || 0)) > 0.005
        ) {
          updates.push({ id: Number(t.id), amount_net: net, commission_amount: comm });
        }
      }
      lastId = Number(data[data.length - 1].id);
    }
  }

  const BATCH = 200;
  for (let i = 0; i < updates.length; i += BATCH) {
    await Promise.all(
      updates.slice(i, i + BATCH).map((u) =>
        supabase
          .from('transactions')
          .update({ amount_net: u.amount_net, commission_amount: u.commission_amount })
          .eq('id', u.id)
      )
    );
  }

  return { updated: updates.length };
}
