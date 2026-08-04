#!/usr/bin/env node
/**
 * One-off backfill: loads the ENTIRE kinedu backend `refunds` table into
 * Supabase `kinedu_refunds`, INCLUDING the original charge info (date, USD
 * amount, store) from `sales` — refunded charges flip payment_status
 * 'paid'→'canceled' and get dropped from `transactions` on re-sync, so the
 * cohort view needs the charge data carried here.
 *
 * Prereq: migration 019_refund_cohorts_v2.sql applied in Supabase.
 * Usage:   node scripts/backfill-kinedu-refunds.js
 */
require('dotenv').config({ path: '.env.local' });
const { BigQuery } = require('@google-cloud/bigquery');
const { createClient } = require('@supabase/supabase-js');

function mapStore(store) {
  if (!store) return 'stripe';
  const s = String(store).toLowerCase();
  if (s === 'apple') return 'apple';
  if (s === 'google') return 'google';
  return 'stripe'; // webapp, stripe, webapp-partners
}

async function main() {
  const bq = new BigQuery({
    projectId: process.env.BIGQUERY_PROJECT_ID || 'celtic-music-240111',
    keyFilename: process.env.BIGQUERY_KEY_FILE || './bigquery-service-account.json',
  });
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  console.log('Fetching all refunds (+ original charge info) from BigQuery…');
  const [rows] = await bq.query({
    query: `
      SELECT r.sale_id,
             MIN(r.refund_date) AS refund_date,
             DATE(s.created_at) AS charge_date,
             CAST(s.usd_amount AS FLOAT64) AS usd_amount,
             s.store
      FROM \`celtic-music-240111.aws_kinedu_app_import.refunds\` r
      JOIN \`celtic-music-240111.aws_kinedu_app_import.sales\` s ON s.id = r.sale_id
      WHERE r.sale_id IS NOT NULL
        AND r.refund_date IS NOT NULL
        AND COALESCE(r.__hevo__marked_deleted, FALSE) = FALSE
        AND s.fraud = 0 AND s.livemode = 1
      GROUP BY r.sale_id, charge_date, usd_amount, s.store
    `,
  });
  console.log(`Fetched ${rows.length} unique refunded sales`);

  const asDate = (v) => (typeof v === 'object' && v !== null ? v.value : String(v));
  const deduped = rows.map((r) => ({
    sale_id: Number(r.sale_id),
    refund_date: asDate(r.refund_date),
    charge_date: asDate(r.charge_date),
    usd_amount: Number(r.usd_amount) || 0,
    source: mapStore(r.store),
  }));

  const BATCH = 500;
  let ok = 0;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH);
    const { error } = await supabase.from('kinedu_refunds').upsert(batch, { onConflict: 'sale_id' });
    if (error) {
      console.error(`Batch ${i}: ${error.message}`);
      process.exitCode = 1;
    } else {
      ok += batch.length;
      if ((i / BATCH) % 20 === 0) console.log(`  upserted ${ok}/${deduped.length}…`);
    }
  }
  console.log(`Done: ${ok}/${deduped.length} refunds in kinedu_refunds`);

  // Sanity: Jan-2026 should show ~1,098 refunded charges (validated in BigQuery)
  const { data, error } = await supabase.rpc('refund_cohorts_monthly', {
    src: 'all', start_month: '2026-01', end_month: '2026-01',
  });
  if (error) console.error('Sanity RPC error (did you apply migration 019?):', error.message);
  else console.log('Sanity check 2026-01 (expect ~1,098 refunded):', JSON.stringify(data));
}

main().catch((e) => { console.error(e); process.exit(1); });
