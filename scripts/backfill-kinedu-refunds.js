#!/usr/bin/env node
/**
 * One-off backfill: loads the ENTIRE kinedu backend `refunds` table
 * (sale_id → refund_date) from BigQuery into Supabase `kinedu_refunds`.
 *
 * Prereq: migration 018_refund_cohorts.sql applied in Supabase.
 * Usage:   node scripts/backfill-kinedu-refunds.js
 *
 * After this, the daily cron keeps the last 45 days fresh automatically.
 */
require('dotenv').config({ path: '.env.local' });
const { BigQuery } = require('@google-cloud/bigquery');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const bq = new BigQuery({
    projectId: process.env.BIGQUERY_PROJECT_ID || 'celtic-music-240111',
    keyFilename: process.env.BIGQUERY_KEY_FILE || './bigquery-service-account.json',
  });
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  console.log('Fetching all refunds from BigQuery…');
  const [rows] = await bq.query({
    query: `
      SELECT sale_id, refund_date
      FROM \`celtic-music-240111.aws_kinedu_app_import.refunds\`
      WHERE sale_id IS NOT NULL
        AND refund_date IS NOT NULL
        AND COALESCE(__hevo__marked_deleted, FALSE) = FALSE
    `,
  });
  console.log(`Fetched ${rows.length} refund rows`);

  // Dedup by sale_id keeping earliest refund_date
  const bySale = new Map();
  for (const r of rows) {
    const d = typeof r.refund_date === 'object' ? r.refund_date.value : String(r.refund_date);
    const id = Number(r.sale_id);
    const prev = bySale.get(id);
    if (!prev || d < prev) bySale.set(id, d);
  }
  const deduped = Array.from(bySale, ([sale_id, refund_date]) => ({ sale_id, refund_date }));
  console.log(`${deduped.length} unique sale_ids after dedup`);

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

  // Sanity: count linked charges on a recent month
  const { data, error } = await supabase.rpc('refund_cohorts_monthly', {
    src: 'all', start_month: '2026-01', end_month: '2026-01',
  });
  if (error) console.error('Sanity RPC error (did you apply migration 018?):', error.message);
  else console.log('Sanity check 2026-01:', JSON.stringify(data));
}

main().catch((e) => { console.error(e); process.exit(1); });
