/**
 * Standalone backfill for Apple SUBSCRIPTION_EVENT daily reports.
 *
 * Hits Apple's /v1/salesReports endpoint directly and writes rows to the
 * apple_subscription_events table in Supabase. Does NOT need the Next dev
 * server running.
 *
 * Usage:
 *   node scripts/backfill-apple-events.js                       # last 365 days
 *   node scripts/backfill-apple-events.js 2025-04-07 2026-04-05 # custom range
 */

const fs = require('fs');
const path = require('path');
const { gunzipSync } = require('zlib');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// ── env loader ───────────────────────────────────────────────────────────────
function loadEnvFile(fp) {
  if (!fs.existsSync(fp)) return;
  const c = fs.readFileSync(fp, 'utf-8');
  for (const l of c.split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.substring(0, eq).trim();
    const v = t.substring(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvFile(path.join(__dirname, '..', '.env.local'));

const REQUIRED = [
  'APPLE_PRIVATE_KEY_B64',
  'APPLE_ISSUER_ID',
  'APPLE_KEY_ID',
  'APPLE_VENDOR_NUMBER',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Apple JWT ────────────────────────────────────────────────────────────────
function generateAppleJWT() {
  const privateKey = Buffer.from(process.env.APPLE_PRIVATE_KEY_B64, 'base64').toString('utf-8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: process.env.APPLE_ISSUER_ID,
      iat: now,
      exp: now + 20 * 60,
      aud: 'appstoreconnect-v1',
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: process.env.APPLE_KEY_ID, typ: 'JWT' },
    }
  );
}

// ── fetch + parse ────────────────────────────────────────────────────────────
async function fetchSubscriptionEventReport(token, date) {
  const url = new URL('https://api.appstoreconnect.apple.com/v1/salesReports');
  url.searchParams.set('filter[reportType]', 'SUBSCRIPTION_EVENT');
  url.searchParams.set('filter[reportSubType]', 'SUMMARY');
  url.searchParams.set('filter[frequency]', 'DAILY');
  url.searchParams.set('filter[reportDate]', date);
  url.searchParams.set('filter[vendorNumber]', process.env.APPLE_VENDOR_NUMBER);
  url.searchParams.set('filter[version]', '1_4');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    if (res.status === 404 || res.status === 410) return null;
    const text = await res.text().catch(() => '');
    console.warn(`  [${date}] HTTP ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return gunzipSync(buf).toString('utf-8');
  } catch {
    return buf.toString('utf-8');
  }
}

function nullIfEmpty(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}
function toIntOrNull(s) {
  if (s == null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
function parseAppleDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

function parseTSV(tsv) {
  const lines = tsv.replace(/\r/g, '').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map((h) => h.trim());
  const idx = (n) => headers.indexOf(n);

  const C = {
    eventDate: idx('Event Date'),
    event: idx('Event'),
    appId: idx('App Apple ID'),
    subName: idx('Subscription Name'),
    subId: idx('Subscription Apple ID'),
    groupId: idx('Subscription Group ID'),
    stdDur: idx('Standard Subscription Duration'),
    promoName: idx('Promotional Offer Name'),
    promoId: idx('Promotional Offer ID'),
    offerType: idx('Subscription Offer Type'),
    offerDur: idx('Subscription Offer Duration'),
    mktOptIn: idx('Marketing Opt-In'),
    preserved: idx('Preserved Pricing'),
    proceeds: idx('Proceeds Reason'),
    cpp: idx('Consecutive Paid Periods'),
    origStart: idx('Original Start Date'),
    client: idx('Client'),
    device: idx('Device'),
    state: idx('State'),
    country: idx('Country'),
    prevSubName: idx('Previous Subscription Name'),
    prevSubId: idx('Previous Subscription Apple ID'),
    daysBefore: idx('Days Before Canceling'),
    cancelReason: idx('Cancellation Reason'),
    daysCanceled: idx('Days Canceled'),
    qty: idx('Quantity'),
  };

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 5) continue;
    const raw = {};
    headers.forEach((h, k) => (raw[h] = cols[k] || ''));

    const eventDate = parseAppleDate(cols[C.eventDate]);
    const event = nullIfEmpty(cols[C.event]);
    if (!eventDate || !event) continue;

    out.push({
      event_date: eventDate,
      event,
      app_apple_id: nullIfEmpty(cols[C.appId]),
      subscription_name: nullIfEmpty(cols[C.subName]),
      subscription_apple_id: nullIfEmpty(cols[C.subId]),
      subscription_group_id: nullIfEmpty(cols[C.groupId]),
      standard_subscription_duration: nullIfEmpty(cols[C.stdDur]),
      promotional_offer_name: nullIfEmpty(cols[C.promoName]),
      promotional_offer_id: nullIfEmpty(cols[C.promoId]),
      subscription_offer_type: nullIfEmpty(cols[C.offerType]),
      subscription_offer_duration: nullIfEmpty(cols[C.offerDur]),
      marketing_opt_in: nullIfEmpty(cols[C.mktOptIn]),
      preserved_pricing: nullIfEmpty(cols[C.preserved]),
      proceeds_reason: nullIfEmpty(cols[C.proceeds]),
      consecutive_paid_periods: toIntOrNull(cols[C.cpp]),
      original_start_date: parseAppleDate(cols[C.origStart]),
      client: nullIfEmpty(cols[C.client]),
      device: nullIfEmpty(cols[C.device]),
      state: nullIfEmpty(cols[C.state]),
      country: (nullIfEmpty(cols[C.country]) || '').slice(0, 2) || null,
      previous_subscription_name: nullIfEmpty(cols[C.prevSubName]),
      previous_subscription_apple_id: nullIfEmpty(cols[C.prevSubId]),
      days_before_canceling: toIntOrNull(cols[C.daysBefore]),
      cancellation_reason: nullIfEmpty(cols[C.cancelReason]),
      days_canceled: toIntOrNull(cols[C.daysCanceled]),
      quantity: toIntOrNull(cols[C.qty]) ?? 0,
      raw_data: raw,
    });
  }
  return out;
}

async function syncDay(token, date) {
  const tsv = await fetchSubscriptionEventReport(token, date);
  if (!tsv) return { rows: 0, skipped: true };
  const rows = parseTSV(tsv);
  if (rows.length === 0) return { rows: 0, skipped: false };

  // Replace any existing rows for this date
  const { error: delErr } = await supabase
    .from('apple_subscription_events')
    .delete()
    .eq('event_date', date);
  if (delErr) throw new Error(`delete error ${date}: ${delErr.message}`);

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('apple_subscription_events').insert(batch);
    if (error) throw new Error(`insert error ${date}: ${error.message}`);
  }
  return { rows: rows.length, skipped: false };
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const args = process.argv.slice(2);
  let startDate, endDate;
  const today = new Date();

  if (args.length === 2) {
    startDate = args[0];
    endDate = args[1];
  } else {
    const e = new Date(today);
    e.setUTCDate(e.getUTCDate() - 1); // yesterday (today's report not yet available)
    const s = new Date(e);
    s.setUTCDate(s.getUTCDate() - 364); // 365 day window total
    startDate = fmt(s);
    endDate = fmt(e);
  }

  console.log(`Apple events backfill: ${startDate} → ${endDate}`);

  // Check that the table exists before doing anything expensive
  const { error: probeErr } = await supabase
    .from('apple_subscription_events')
    .select('id', { head: true, count: 'exact' })
    .limit(1);
  if (probeErr) {
    console.error('\n❌ Table apple_subscription_events not found.');
    console.error('   Apply migration 005 first (paste SQL in Supabase SQL Editor).');
    console.error('   Error:', probeErr.message);
    process.exit(1);
  }

  let token = generateAppleJWT();
  let tokenIssuedAt = Date.now();
  const TOKEN_TTL_MS = 15 * 60 * 1000; // refresh every 15 min (Apple JWT lasts 20)

  let totalRows = 0;
  let totalDays = 0;
  let skippedDays = 0;
  let errorDays = 0;

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
      totalDays++;
      totalRows += r.rows;
      if (r.skipped) {
        skippedDays++;
        process.stdout.write('.');
      } else {
        process.stdout.write(r.rows > 0 ? '#' : 'o');
      }
    } catch (e) {
      errorDays++;
      console.error(`\n  [${dateStr}] error: ${e.message}`);
    }
    if (totalDays % 50 === 0) process.stdout.write(`  ${totalDays}\n`);
  }

  console.log(`\n\nDone.`);
  console.log(`  Days processed:  ${totalDays}`);
  console.log(`  Days with data:  ${totalDays - skippedDays - errorDays}`);
  console.log(`  Days skipped:    ${skippedDays} (no data / out of retention window)`);
  console.log(`  Days errored:    ${errorDays}`);
  console.log(`  Rows inserted:   ${totalRows.toLocaleString()}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
