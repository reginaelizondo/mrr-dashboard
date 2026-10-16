import Stripe from 'stripe';
import { createServerClient } from '@/lib/supabase/server';
import { addDays } from '@/lib/kpi/period';
import { gcs, downloadCsvFromZip, fetchAppleFx, fetchGoogleFx } from '@/lib/audit/store-audit';
import { monthChunks } from '@/lib/sync/kpi-daily';

/**
 * store_daily — lo que cada tienda reporta por día y país, en USD al tipo de cambio de la propia tienda
 * (migración 037). Es la base del "Corregido" calibrado del dashboard Operativo.
 *
 *   paid_usd   lo que pagó el cliente, con impuesto (misma base que Total Sales del Looker)
 *   net_usd    lo que deposita la tienda: sin impuesto y sin comisión (base de Net Sales)
 *   refunds_*  reembolsos del día, por fecha de reembolso
 *
 * Fuentes y exactitud:
 *   Apple   apple_sales_daily (reporte diario de App Store Connect, desde 2025-04-07). Customer Price ×
 *           unidades y Developer Proceeds × unidades, a USD con apple_fx_rates. status 'final'.
 *   Google  cobros: tabla `transactions` del sync del MRR (une las cuentas SAPI-MXN e INC-USD de la migración
 *           ene–feb 2026; desde 2022). Reembolsos: earnings_YYYYMM (exacto) o reporte de ventas del mes en
 *           curso (estimado). 'final' hasta el último mes con earnings, 'estimado' después.
 *   Stripe  API balance transactions: monto y neto (después de comisión) ya en USD → 'final'.
 *           Día = día de México (UTC−6), igual que la auditoría.
 */

export type Store = 'apple' | 'google' | 'stripe';
export interface StoreCell {
  date: string; store: Store; country: string;
  paid_usd: number; net_usd: number; refunds_paid_usd: number; refunds_net_usd: number;
  charges: number; refunds_n: number; status: 'final' | 'estimado'; source: string;
}

const key = (d: string, c: string) => `${d}|${c}`;
function cellMap(store: Store, source: string, status: 'final' | 'estimado') {
  const m = new Map<string, StoreCell>();
  const get = (date: string, country: string) => {
    const k = key(date, country || 'null');
    let c = m.get(k);
    if (!c) { c = { date, store, country: country || 'null', paid_usd: 0, net_usd: 0, refunds_paid_usd: 0, refunds_net_usd: 0, charges: 0, refunds_n: 0, status, source }; m.set(k, c); }
    return c;
  };
  return { m, get };
}

// ---- Apple ------------------------------------------------------------------------------
export async function fetchAppleCells(start: string, end: string): Promise<StoreCell[]> {
  const sb = createServerClient();
  const fx = await fetchAppleFx();
  const { m, get } = cellMap('apple', 'apple_sales_daily', 'final');
  let last = 0;
  for (;;) {
    const { data, error } = await sb.from('apple_sales_daily')
      .select('id,begin_date,units,customer_price,customer_currency,developer_proceeds,currency_of_proceeds,country_code')
      .gte('begin_date', start).lte('begin_date', end).gt('id', last).order('id').limit(1000);
    if (error) throw new Error(`apple_sales_daily: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) {
      last = r.id;
      const units = Number(r.units) || 0; const price = Math.abs(Number(r.customer_price) || 0); const proceeds = Math.abs(Number(r.developer_proceeds) || 0);
      if (!units || (!price && !proceeds)) continue;
      const d = String(r.begin_date); const ym = d.slice(0, 7);
      const paid = (price * Math.abs(units)) / fx(String(r.customer_currency), ym);
      const net = (proceeds * Math.abs(units)) / fx(String(r.currency_of_proceeds || r.customer_currency), ym);
      const c = get(d, String(r.country_code || 'null'));
      if (units > 0) { c.paid_usd += paid; c.net_usd += net; c.charges += units; }
      else { c.refunds_paid_usd += paid; c.refunds_net_usd += net; c.refunds_n += Math.abs(units); }
    }
    if (data.length < 1000) break;
  }
  return [...m.values()];
}

// ---- Google -----------------------------------------------------------------------------
const MON: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const earningsDate = (s: string) => { const m = s.trim().match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/); return m ? `${m[3]}-${MON[m[1]]}-${m[2].padStart(2, '0')}` : null; };

async function googleFiles(prefix: string, re: RegExp): Promise<Record<string, string>> {
  const [files] = await gcs().getFiles({ prefix });
  const out: Record<string, string> = {};
  for (const f of files) { const m = f.name.match(re); if (m) out[m[1]] = f.name; }
  return out;
}

/** Exacto, desde el earnings mensual: cobro, comisión e impuesto por orden, ya en USD. */
async function googleEarningsCells(file: string, start: string, end: string): Promise<{ cells: StoreCell[]; netRatio: Record<string, number> }> {
  const rows = await downloadCsvFromZip(file);
  const h = rows[0]; const col = (name: string) => h.findIndex((x) => x.trim() === name);
  const iDate = col('Transaction Date'), iType = col('Transaction Type'), iCountry = col('Buyer Country'), iUsd = col('Amount (Merchant Currency)'), iMc = col('Merchant Currency');
  const { m, get } = cellMap('google', file.split('/').pop()!, 'final');
  const byCountry: Record<string, { paid: number; net: number }> = {};
  for (const r of rows.slice(1)) {
    const d = earningsDate(r[iDate] || ''); if (!d) continue;
    if ((r[iMc] || 'USD') !== 'USD') continue;
    const amt = parseFloat(r[iUsd]) || 0; const type = (r[iType] || '').trim(); const country = r[iCountry] || 'null';
    const bc = (byCountry[country] ??= { paid: 0, net: 0 });
    if (type === 'Charge') { bc.paid += amt; bc.net += amt; } else if (!/refund/i.test(type)) bc.net += amt;
    if (d < start || d > end) continue;
    const c = get(d, country);
    if (type === 'Charge') { c.paid_usd += amt; c.net_usd += amt; c.charges++; }
    else if (type === 'Charge refund') { c.refunds_paid_usd += -amt; c.refunds_net_usd += -amt; c.refunds_n++; }
    else if (/refund/i.test(type)) c.refunds_net_usd += -amt;   // devolución de comisión/impuesto: reduce el neto reembolsado
    else c.net_usd += amt;                                       // Google fee, Tax, retenciones (negativos)
  }
  const netRatio: Record<string, number> = {};
  let tp = 0, tn = 0;
  for (const [c, v] of Object.entries(byCountry)) { if (v.paid > 0) netRatio[c] = v.net / v.paid; tp += v.paid; tn += v.net; }
  netRatio['*'] = tp ? tn / tp : 0.85;
  return { cells: [...m.values()], netRatio };
}

/** Estimado, desde el reporte de ventas del mes (aún sin earnings): FX y neto/cobrado del último earnings. */
async function googleSalesCells(file: string, start: string, end: string, fxUsd: Record<string, number>, netRatio: Record<string, number>, appleFx: (cur: string, ym: string) => number): Promise<StoreCell[]> {
  const rows = await downloadCsvFromZip(file);
  const h = rows[0]; const col = (re: RegExp) => h.findIndex((x) => re.test(x));
  const iDate = col(/charged date/i), iStatus = col(/financial status/i), iCur = col(/currency of sale/i), iCharged = col(/charged amount/i), iCountry = col(/country of buyer/i);
  const { m, get } = cellMap('google', file.split('/').pop()!, 'estimado');
  for (const r of rows.slice(1)) {
    const d = (r[iDate] || '').slice(0, 10); if (!d || d < start || d > end) continue;
    // FX de Google (último earnings); moneda que no aparece ahí → FX de Apple del mes, como la auditoría.
    const cur = r[iCur] || 'USD'; const rate = cur === 'USD' ? 1 : fxUsd[cur] ?? 1 / appleFx(cur, d.slice(0, 7));
    const amt = Math.abs(parseFloat(r[iCharged]) || 0) * rate; const country = r[iCountry] || 'null';
    const ratio = netRatio[country] ?? netRatio['*'];
    const st = (r[iStatus] || '').toLowerCase(); const c = get(d, country);
    if (st.startsWith('charged')) { c.paid_usd += amt; c.net_usd += amt * ratio; c.charges++; }
    else if (st.startsWith('refund')) { c.refunds_paid_usd += amt; c.refunds_net_usd += amt * ratio; c.refunds_n++; }
  }
  return [...m.values()];
}

/**
 * Google. Cobros desde la tabla `transactions` del MRR (sync de Google: une la cuenta vieja de SAPI, que
 * liquidaba en MXN, y la nueva de INC en USD desde la migración de ene–feb 2026; bruto, comisión y neto por
 * cobro en USD, desde 2022). El bucket GCS solo tiene la cuenta nueva: enero 2026 salía con $3K en vez de
 * $46K. Reembolsos desde el earnings (exacto) o, en el mes en curso, del reporte de ventas (estimado).
 * Estado: 'final' hasta el último mes con earnings, 'estimado' después.
 */
export async function fetchGoogleCells(start: string, end: string): Promise<StoreCell[]> {
  const sb = createServerClient();
  const earnings = await googleFiles('earnings/', /earnings_(\d{6})/);
  const sales = await googleFiles('sales/', /salesreport_(\d{6})/);
  const latest = Object.keys(earnings).sort().pop() ?? '000000';
  const statusOf = (d: string) => (d.slice(0, 7).replace('-', '') <= latest ? 'final' : 'estimado') as 'final' | 'estimado';
  const m = new Map<string, StoreCell>();
  const get = (date: string, country: string) => {
    const k = key(date, country || 'null');
    let c = m.get(k);
    if (!c) { c = { date, store: 'google', country: country || 'null', paid_usd: 0, net_usd: 0, refunds_paid_usd: 0, refunds_net_usd: 0, charges: 0, refunds_n: 0, status: statusOf(date), source: 'transactions' }; m.set(k, c); }
    return c;
  };
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('transactions').select('transaction_date,country_code,transaction_type,amount_gross,amount_net')
      .eq('source', 'google').gte('transaction_date', start).lte('transaction_date', end).order('id').range(from, from + 999);
    if (error) throw new Error(`transactions google: ${error.message}`);
    for (const r of data ?? []) {
      const c = get(String(r.transaction_date).slice(0, 10), String(r.country_code || 'null'));
      if (r.transaction_type === 'charge') { c.paid_usd += Number(r.amount_gross) || 0; c.net_usd += Number(r.amount_net) || 0; c.charges++; }
      else { c.refunds_paid_usd += Math.abs(Number(r.amount_gross) || 0); c.refunds_net_usd += Math.abs(Number(r.amount_net) || 0); c.refunds_n++; }
    }
    if (!data || data.length < 1000) break;
  }
  // Reembolsos: la tabla de transacciones solo trae cobros.
  const fxUsd = await fetchGoogleFx();
  const appleFx = await fetchAppleFx();
  let lastRatio: Record<string, number> = { '*': 0.85 };
  if (earnings[latest]) lastRatio = (await googleEarningsCells(earnings[latest], '9999-01-01', '9999-01-01')).netRatio;
  for (const ch of monthChunks(start, end)) {
    const ym = ch.start.slice(0, 7).replace('-', '');
    const src = earnings[ym] ? (await googleEarningsCells(earnings[ym], ch.start, ch.end)).cells
      : sales[ym] ? await googleSalesCells(sales[ym], ch.start, ch.end, fxUsd, lastRatio, appleFx) : [];
    for (const r of src) {
      if (!r.refunds_n && !r.refunds_paid_usd) continue;
      const c = get(r.date, r.country);
      c.refunds_paid_usd += r.refunds_paid_usd; c.refunds_net_usd += r.refunds_net_usd; c.refunds_n += r.refunds_n;
    }
  }
  return [...m.values()];
}

// ---- Stripe -----------------------------------------------------------------------------
export async function fetchStripeCells(start: string, end: string): Promise<StoreCell[]> {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const gte = Math.floor(Date.parse(`${start}T06:00:00Z`) / 1000);
  const lt = Math.floor(Date.parse(`${end}T06:00:00Z`) / 1000) + 86400;
  const mxDay = (ts: number) => new Date((ts - 6 * 3600) * 1000).toISOString().slice(0, 10);
  const { m, get } = cellMap('stripe', 'stripe_api', 'final');
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.balanceTransactions.list({ created: { gte, lt }, limit: 100, expand: ['data.source'], ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const bt of page.data) {
      if (bt.currency !== 'usd') continue;
      const d = mxDay(bt.created);
      const src = (typeof bt.source === 'object' && bt.source ? bt.source : null) as unknown as { billing_details?: { address?: { country?: string | null } }; payment_method_details?: { card?: { country?: string | null } } } | null;
      if (bt.type === 'charge' || bt.type === 'payment') {
        const country = src?.billing_details?.address?.country || src?.payment_method_details?.card?.country || 'null';
        const c = get(d, country); c.paid_usd += bt.amount / 100; c.net_usd += bt.net / 100; c.charges++;
      } else if (bt.type === 'refund' || bt.type === 'payment_refund') {
        // El reembolso no trae el país del cobro sin otra llamada: va al nivel procesador (país '__').
        const c = get(d, '__'); c.refunds_paid_usd += -bt.amount / 100; c.refunds_net_usd += -bt.net / 100; c.refunds_n++;
      }
    }
    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return [...m.values()];
}

// ---- Escritura + recalibración ---------------------------------------------------------
const FETCH: Record<Store, (s: string, e: string) => Promise<StoreCell[]>> = { apple: fetchAppleCells, google: fetchGoogleCells, stripe: fetchStripeCells };
const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Reemplaza store_daily de [start, end] para las tiendas indicadas y recalcula factores + rollup. */
export async function syncStoreDaily(start: string, end: string, stores: Store[] = ['apple', 'google', 'stripe']) {
  const sb = createServerClient();
  const result: Record<string, { cells: number; paid: number; net: number; estimado: number }> = {};
  for (const store of stores) {
    const cells = await FETCH[store](start, end);
    const { error: delErr } = await sb.from('store_daily').delete().eq('store', store).gte('date', start).lte('date', end);
    if (delErr) throw new Error(`store_daily delete ${store}: ${delErr.message}`);
    const rows = cells.map((c) => ({ ...c, paid_usd: round(c.paid_usd), net_usd: round(c.net_usd), refunds_paid_usd: round(c.refunds_paid_usd), refunds_net_usd: round(c.refunds_net_usd), synced_at: new Date().toISOString() }));
    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await sb.from('store_daily').insert(rows.slice(i, i + 1000));
      if (error) throw new Error(`store_daily insert ${store}: ${error.message}`);
    }
    result[store] = { cells: rows.length, paid: Math.round(cells.reduce((s, c) => s + c.paid_usd, 0)), net: Math.round(cells.reduce((s, c) => s + c.net_usd, 0)), estimado: cells.filter((c) => c.status === 'estimado').length };
  }
  for (const c of monthChunks(start, end)) {
    const { error } = await sb.rpc('refresh_store_calibration', { p_start: c.start, p_end: c.end });
    if (error) throw new Error(`refresh_store_calibration ${c.start}→${c.end}: ${error.message}`);
  }
  return { start, end, stores: result };
}

/** Ventana estándar: Apple publica con 1–2 días, Google cierra el mes con el earnings (~día 5). */
export async function runStoreDailySync(today: string, days: number) {
  return syncStoreDaily(addDays(today, -days), today);
}
