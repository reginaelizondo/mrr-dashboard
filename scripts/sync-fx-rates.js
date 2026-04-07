/**
 * Fetch real historical FX rates from fawazahmed0/currency-api (free, ECB data)
 * for the months we have Apple Sales data (Apr 2025 → Apr 2026) and the
 * currencies that actually appear in our data.
 *
 * Upserts into apple_fx_rates so v_apple_sales_monthly returns USD values
 * that match Apple's published reports much more closely.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf-8');
for (const line of env.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.substring(0, eq).trim();
  const v = t.substring(eq + 1).trim();
  if (!process.env[k]) process.env[k] = v;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CURRENCIES = [
  'eur','gbp','cad','aud','jpy','chf','mxn','brl','clp','cop','pen',
  'cny','hkd','krw','inr','idr','myr','php','sgd','thb','twd','vnd','kzt','pkr',
  'aed','sar','qar','ils','ngn','tzs','zar','egp',
  'sek','nok','dkk','pln','czk','huf','ron','try','rub','nzd','bgn',
];

// Use mid-month date (15th) as a reasonable monthly average proxy.
function midOfMonth(year, month0) {
  const d = new Date(Date.UTC(year, month0, 15));
  return d.toISOString().slice(0, 10);
}

async function fetchRatesForDate(date) {
  // Fawazahmed0 currency-api on jsDelivr CDN, ECB-backed (and others), no rate limit.
  // Format: returns { date, usd: { eur: 0.92, ... } }
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.json`,
    `https://${date}.currency-api.pages.dev/v1/currencies/usd.json`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      if (json && json.usd) return json.usd;
    } catch {
      // try next mirror
    }
  }
  throw new Error(`No FX data for ${date}`);
}

async function main() {
  const months = [];
  // Apr 2025 → Apr 2026 inclusive
  for (let y = 2025; y <= 2026; y++) {
    const m0 = y === 2025 ? 3 : 0;
    const mE = y === 2025 ? 11 : 3;
    for (let m = m0; m <= mE; m++) months.push({ year: y, month0: m });
  }

  console.log(`Fetching FX for ${months.length} months × ${CURRENCIES.length} currencies`);

  const upsertRows = [];
  for (const { year, month0 } of months) {
    const ym = `${year}-${String(month0 + 1).padStart(2, '0')}`;
    const date = midOfMonth(year, month0);
    process.stdout.write(`  ${ym} (${date}) ... `);
    try {
      const rates = await fetchRatesForDate(date);
      let added = 0;
      for (const cur of CURRENCIES) {
        const rate = rates[cur];
        if (typeof rate === 'number' && rate > 0) {
          upsertRows.push({ year_month: ym, currency: cur.toUpperCase(), rate });
          added++;
        }
      }
      console.log(`${added} rates`);
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
  }

  console.log(`\nUpserting ${upsertRows.length} rows...`);
  // Batch upsert
  for (let i = 0; i < upsertRows.length; i += 200) {
    const batch = upsertRows.slice(i, i + 200);
    const { error } = await supabase
      .from('apple_fx_rates')
      .upsert(batch, { onConflict: 'year_month,currency' });
    if (error) {
      console.error('upsert error:', error);
      process.exit(1);
    }
  }
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
