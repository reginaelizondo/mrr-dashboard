/**
 * backfill-google-rates.js — calcula la tasa NETA REAL de Google por país/mes
 * desde los earnings CSV de Google Play (PlayApps_YYYYMM.csv) y hace upsert a
 * la tabla `google_net_rate_monthly` en Supabase. La vista v_store_net_rate
 * (migración 028) la lee y le aplica la capa de IVA-consumidor.
 *
 * Guarda el NET DE CAJA (lo que Google efectivamente paga a Kinedu):
 *   gross      = SUM(Charge)                          [Merchant Currency = MXN]
 *   cash_net   = SUM(Charge + Google fee + Tax)       [fees y taxes son negativos]
 *   → captura fee (15%), IVA-sobre-fee (Mexico VAT ~2.4%) y las retenciones
 *     reales de Brasil (CIDE/IRRF) que viven en filas Tax. Reproduce el ~0.826
 *     de caja para US/MX y el ~0.50-0.60 volátil de Brasil.
 * EXCLUYE refunds (Charge/Google fee/Tax refund) — la deducción es sobre el cargo;
 * los refunds son ajuste de LTV aparte (igual que Apple).
 *
 * El IVA del consumidor (que Google paga a Kinedu y Kinedu remite) NO está en el
 * CSV → se resta en la VISTA (migración 028), no aquí. Aquí solo va el dato de caja.
 *
 * FX: la tasa es invariante a la moneda (net/gross en MXN == en USD), así que la
 * conversión a USD solo afecta los montos absolutos (que la vista NO expone).
 *
 * Uso:
 *   node scripts/backfill-google-rates.js            # DRY RUN (imprime, no escribe)
 *   node scripts/backfill-google-rates.js apply      # escribe a Supabase
 *   GOOGLE_EARNINGS_DIR=/ruta node scripts/backfill-google-rates.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
// carga .env.local si existe (para el modo apply)
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !process.env[t.slice(0, i)]) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
  }
} catch {}

const APPLY = process.argv[2] === 'apply';
const DIR = process.env.GOOGLE_EARNINGS_DIR ||
  path.join(ROOT, '..', 'google-earnings-extracted');

// FX MXN/USD (mismo mapa que lib/sync/google.ts). Solo afecta montos absolutos;
// la tasa es FX-invariante.
const MXN_USD = {
  '2024-01':17.05,'2024-02':17.00,'2024-03':16.70,'2024-04':16.95,'2024-05':16.85,
  '2024-06':18.05,'2024-07':17.80,'2024-08':18.75,'2024-09':19.20,'2024-10':19.65,
  '2024-11':20.15,'2024-12':20.05,'2025-01':20.35,'2025-02':20.25,'2025-03':20.15,
  '2025-04':19.95,'2025-05':19.40,'2025-06':19.55,'2025-07':19.75,'2025-08':19.60,
  '2025-09':19.45,'2025-10':20.00,'2025-11':20.20,'2025-12':20.35,'2026-01':20.40,'2026-02':20.30,
};
const toUsd = (mxn, ym) => mxn / (MXN_USD[ym] || 20.0);

// parser CSV robusto a comillas (Product Title puede traer comas)
function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function parseCsv(text) {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const v = parseLine(lines[i]);
    const r = {};
    headers.forEach((h, j) => (r[h] = (v[j] || '').trim()));
    rows.push(r);
  }
  return rows;
}
function ym(dateStr) {
  // Google: "YYYY-MM-DD" o "Mon DD, YYYY"
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr.slice(0, 7);
  const d = new Date(dateStr);
  if (!isNaN(d)) return d.toISOString().slice(0, 7);
  return null;
}
const num = (x) => {
  const n = parseFloat(String(x || '').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
};

// agrega por (country, month)
const agg = new Map(); // key `${cc}|${ym}` -> {grossMxn, netMxn, units}
function bump(cc, m, field, val) {
  const k = `${cc}|${m}`;
  if (!agg.has(k)) agg.set(k, { cc, ym: m, grossMxn: 0, netMxn: 0, units: 0 });
  agg.get(k)[field] += val;
}

const files = fs.readdirSync(DIR).filter((f) => /^PlayApps_\d{6}\.csv$/i.test(f)).sort();
if (!files.length) { console.error(`No hay PlayApps_*.csv en ${DIR}`); process.exit(1); }
let totalRows = 0;
for (const f of files) {
  const rows = parseCsv(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const r of rows) {
    totalRows++;
    const tt = r['Transaction Type'];
    // solo cargo y sus deducciones; refunds fuera
    if (!['Charge', 'Google fee', 'Tax'].includes(tt)) continue;
    const cc = (r['Buyer Country'] || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) continue;
    const m = ym(r['Transaction Date']);
    if (!m) continue;
    const amt = num(r['Amount (Merchant Currency)']); // MXN; fees/taxes negativos
    if (tt === 'Charge') { bump(cc, m, 'grossMxn', amt); bump(cc, m, 'netMxn', amt); bump(cc, m, 'units', 1); }
    else bump(cc, m, 'netMxn', amt); // Google fee + Tax (negativos) restan del net
  }
}

const recs = [...agg.values()]
  .filter((a) => a.grossMxn > 0)
  .map((a) => ({
    country_code: a.cc,
    year_month: a.ym,
    gross_usd: Math.round(toUsd(a.grossMxn, a.ym) * 100) / 100,
    cash_net_usd: Math.round(toUsd(a.netMxn, a.ym) * 100) / 100,
    charge_units: a.units,
    _cashRate: a.netMxn / a.grossMxn,
  }));

console.log(`Filas CSV leídas: ${totalRows} | celdas (país×mes): ${recs.length}\n`);

// ---- VALIDACIÓN: promedio ponderado por país vs benchmarks ----
const IVA_MX = 0.16 / 1.16; // IVA-consumidor que Kinedu remite (solo MX confirmado)
const byC = new Map();
for (const r of recs) {
  if (!byC.has(r.country_code)) byC.set(r.country_code, { g: 0, n: 0, u: 0 });
  const o = byC.get(r.country_code); o.g += r.gross_usd; o.n += r.cash_net_usd; o.u += r.charge_units;
}
const bench = { US: 0.826, MX: 0.688, BR: 0.50, ES: 0.85, GB: 0.85, CO: 0.826, AR: 0.826, CL: 0.826 };
console.log('país  cash_rate  apple_consist(MX resta IVA)  cohortes_const  units');
for (const cc of ['US', 'MX', 'BR', 'CO', 'AR', 'CL', 'ES', 'GB']) {
  const o = byC.get(cc); if (!o) continue;
  const cash = o.n / o.g;
  const apple = cc === 'MX' ? cash - IVA_MX : cash; // solo MX resta IVA-consumidor
  const b = bench[cc] != null ? bench[cc].toFixed(3) : '  —';
  console.log(`${cc}    ${cash.toFixed(4)}     ${apple.toFixed(4)}                    ${b}          ${o.u}`);
}
// Brasil mes a mes (para ver la volatilidad real)
console.log('\nBrasil por mes (cash_rate — debe MOVERSE):');
recs.filter((r) => r.country_code === 'BR').sort((a, b) => a.year_month.localeCompare(b.year_month))
  .forEach((r) => console.log(`  ${r.year_month}  ${(r._cashRate).toFixed(4)}  (${r.charge_units} charges)`));

if (!APPLY) { console.log('\n(DRY RUN — no se escribió nada. Corre con "apply" para hacer upsert a Supabase.)'); process.exit(0); }

// ---- APPLY: upsert a Supabase (necesita SUPABASE_SERVICE_ROLE_KEY) ----
(async () => {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  const sb = createClient(url, key);
  const payload = recs.map(({ _cashRate, ...r }) => r);
  const B = 500; let done = 0;
  for (let i = 0; i < payload.length; i += B) {
    const { error } = await sb.from('google_net_rate_monthly').upsert(payload.slice(i, i + B), { onConflict: 'country_code,year_month' });
    if (error) { console.error('upsert error:', error.message); process.exit(1); }
    done += Math.min(B, payload.length - i);
    process.stdout.write(`\r  upsert ${done}/${payload.length}`);
  }
  console.log(`\nDONE: ${payload.length} celdas google_net_rate_monthly`);
})();
