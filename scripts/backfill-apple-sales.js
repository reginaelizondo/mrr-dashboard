/**
 * Backfill Apple SALES report (DAILY) into apple_sales_daily.
 * Apple retains daily reports for 365 days.
 *
 * Usage:
 *   node scripts/backfill-apple-sales.js                  # last 365 days
 *   node scripts/backfill-apple-sales.js 2025-04-06 2026-04-05
 */

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const zlib = require('zlib');
const { createClient } = require('@supabase/supabase-js');

// Load .env.local
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

function generateAppleJWT() {
  const privateKey = Buffer.from(process.env.APPLE_PRIVATE_KEY_B64, 'base64').toString('utf-8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: process.env.APPLE_ISSUER_ID, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: process.env.APPLE_KEY_ID, typ: 'JWT' } }
  );
}

const COLS = [
  'Provider', 'Provider Country', 'SKU', 'Developer', 'Title', 'Version',
  'Product Type Identifier', 'Units', 'Developer Proceeds', 'Begin Date', 'End Date',
  'Customer Currency', 'Country Code', 'Currency of Proceeds', 'Apple Identifier',
  'Customer Price', 'Promo Code', 'Parent Identifier', 'Subscription', 'Period',
  'Category', 'CMB', 'Device', 'Supported Platforms', 'Proceeds Reason',
  'Preserved Pricing', 'Client', 'Order Type',
];

function parseAppleDate(s) {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function parseTSV(tsv) {
  const lines = tsv.replace(/\r/g, '').trim().split('\n');
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t').map((c) => c.trim());
    if (cols.length < COLS.length) continue;
    const beginDate = parseAppleDate(cols[9]);
    const endDate = parseAppleDate(cols[10]);
    if (!beginDate || !endDate) continue;
    const raw = {};
    for (let j = 0; j < COLS.length; j++) raw[COLS[j]] = cols[j];
    out.push({
      begin_date: beginDate,
      end_date: endDate,
      sku: cols[2] || null,
      title: cols[4] || null,
      product_type_identifier: cols[6] || null,
      apple_identifier: cols[14] || null,
      parent_identifier: cols[17] || null,
      subscription: cols[18] || null,
      period: cols[19] || null,
      units: parseInt(cols[7]) || 0,
      developer_proceeds: parseFloat(cols[8]) || 0,
      customer_price: parseFloat(cols[15]) || 0,
      customer_currency: cols[11] || null,
      currency_of_proceeds: cols[13] || null,
      country_code: cols[12] || null,
      promo_code: cols[16] || null,
      category: cols[20] || null,
      device: cols[22] || null,
      client: cols[26] || null,
      order_type: cols[27] || null,
      proceeds_reason: cols[24] || null,
      raw_data: raw,
    });
  }
  return out;
}

async function fetchDay(token, date) {
  const url = new URL('https://api.appstoreconnect.apple.com/v1/salesReports');
  url.searchParams.set('filter[reportType]', 'SALES');
  url.searchParams.set('filter[reportSubType]', 'SUMMARY');
  url.searchParams.set('filter[frequency]', 'DAILY');
  url.searchParams.set('filter[reportDate]', date);
  url.searchParams.set('filter[vendorNumber]', process.env.APPLE_VENDOR_NUMBER);
  url.searchParams.set('filter[version]', '1_0');
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 404) return null;
    process.stdout.write(`\n  [${date}] HTTP ${res.status}\n`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  let tsv;
  try { tsv = zlib.gunzipSync(buf).toString('utf-8'); }
  catch { tsv = buf.toString('utf-8'); }
  return parseTSV(tsv);
}

async function syncDay(token, date) {
  const rows = await fetchDay(token, date);
  if (rows === null) return { rows: 0, skipped: true };
  if (rows.length === 0) return { rows: 0, skipped: false };

  const { error: delErr } = await supabase
    .from('apple_sales_daily')
    .delete()
    .eq('begin_date', date);
  if (delErr) throw new Error(`delete: ${delErr.message}`);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('apple_sales_daily').insert(batch);
    if (error) throw new Error(`insert: ${error.message}`);
    inserted += batch.length;
  }
  return { rows: inserted, skipped: false };
}

function fmt(d) { return d.toISOString().slice(0, 10); }

async function main() {
  let startDate, endDate;
  if (process.argv[2] && process.argv[3]) {
    startDate = process.argv[2];
    endDate = process.argv[3];
  } else {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(today.getUTCDate() - 365);
    const end = new Date(today);
    end.setUTCDate(today.getUTCDate() - 1);
    startDate = fmt(start);
    endDate = fmt(end);
  }

  console.log(`Apple SALES backfill: ${startDate} → ${endDate}`);

  let token = generateAppleJWT();
  let tokenIssuedAt = Date.now();
  const TOKEN_TTL_MS = 15 * 60 * 1000;

  let totalRows = 0, days = 0, skipped = 0, errored = 0;
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = fmt(d);
    if (Date.now() - tokenIssuedAt > TOKEN_TTL_MS) {
      token = generateAppleJWT();
      tokenIssuedAt = Date.now();
    }
    try {
      const r = await syncDay(token, dateStr);
      if (r.skipped) {
        skipped++;
        process.stdout.write('.');
      } else {
        totalRows += r.rows;
        days++;
        process.stdout.write('#');
      }
    } catch (e) {
      errored++;
      process.stdout.write('!');
      process.stdout.write(`\n  [${dateStr}] ${e.message}\n`);
    }
    if ((days + skipped + errored) % 50 === 0) process.stdout.write(`  ${days + skipped + errored}\n`);
  }
  console.log(`\n\nDone.`);
  console.log(`  Days processed:  ${days + skipped + errored}`);
  console.log(`  Days with data:  ${days}`);
  console.log(`  Days skipped:    ${skipped} (no data / out of retention)`);
  console.log(`  Days errored:    ${errored}`);
  console.log(`  Rows inserted:   ${totalRows.toLocaleString()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
