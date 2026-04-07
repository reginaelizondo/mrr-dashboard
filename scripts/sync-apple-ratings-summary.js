// Pull per-country rating totals from the public iTunes Lookup API and
// snapshot them into apple_ratings_summary.
//
// This gives us the "real" total rating counts (including star-taps without
// text). The ASC Customer Reviews API only exposes WRITTEN reviews, which is
// a small biased subset — angry/happy users only.
//
// Usage: node scripts/sync-apple-ratings-summary.js

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

for (const l of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf-8').split('\n')) {
  const t = l.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
}

const APP_ID = process.env.APPLE_APP_ID || '741277284';

// Broad list of storefronts where Kinedu typically has presence
const COUNTRIES = [
  'US', 'MX', 'ES', 'AR', 'CO', 'CL', 'PE', 'BR', 'VE', 'EC', 'UY', 'BO',
  'GT', 'CR', 'PA', 'DO', 'PY', 'HN', 'SV', 'NI',
  'CA', 'GB', 'FR', 'DE', 'IT', 'PT', 'NL', 'BE', 'IE', 'AT', 'CH',
  'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'HU', 'RO', 'GR',
  'AU', 'NZ', 'IN', 'JP', 'KR', 'CN', 'HK', 'TW', 'SG', 'PH', 'ID', 'MY', 'TH', 'VN',
  'ZA', 'TR', 'SA', 'AE', 'EG', 'IL', 'RU', 'UA',
];

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  let totalRatings = 0;
  let weightedSum = 0;

  console.log(`Pulling iTunes Lookup for ${COUNTRIES.length} countries...\n`);

  for (const c of COUNTRIES) {
    const url = `https://itunes.apple.com/lookup?id=${APP_ID}&country=${c}`;
    const r = await fetch(url);
    if (!r.ok) { console.warn(`  ${c}: HTTP ${r.status}`); continue; }
    const j = await r.json();
    const res = j.results?.[0];
    if (!res || !res.userRatingCount) continue;

    const count = res.userRatingCount;
    const avg = res.averageUserRating;
    rows.push({
      snapshot_date: today,
      app_id: APP_ID,
      country_code: c,
      rating_count: count,
      avg_rating: Number(avg.toFixed(3)),
    });
    totalRatings += count;
    weightedSum += count * avg;
    console.log(`  ${c}: ${count.toLocaleString().padStart(6)} ratings · ${avg.toFixed(2)}⭐`);
    await new Promise((res) => setTimeout(res, 120)); // polite throttle
  }

  console.log(`\nAGGREGATE: ${totalRatings.toLocaleString()} ratings · ${(weightedSum / totalRatings).toFixed(2)}⭐ avg across ${rows.length} countries`);

  // Upsert (unique on snapshot_date+app_id+country_code so re-runs same day update)
  const { error } = await sb
    .from('apple_ratings_summary')
    .upsert(rows, { onConflict: 'snapshot_date,app_id,country_code' });
  if (error) throw error;
  console.log(`\n✅ Saved ${rows.length} rows to apple_ratings_summary (snapshot ${today}).`);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
