#!/usr/bin/env node
/**
 * Import Kinedu DB sales from CSV → Supabase
 *
 * 1. Export sales from Sequel Pro as CSV
 * 2. Place CSV in scripts/ folder
 * 3. Run: node scripts/import-csv.js scripts/sales-export.csv
 *
 * This replaces the SSH tunnel approach with a simple manual export/import.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Load .env.local manually (no dotenv dependency needed)
function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}
loadEnvFile(path.join(__dirname, '..', '.env.local'));

// ─── Configuration ───────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://plxhpxjsysjbhzcwamyy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

// ─── SKU → Plan Type mapping ─────────────────────────────────────────────────

function getPlanTypeFromSku(sku) {
  if (!sku) return 'other';
  const s = sku.toLowerCase();
  if (s.includes('lifetime') || s.includes('_lifetime_')) return 'lifetime';
  if (s.includes('_12_') || s.endsWith('_12')) return 'yearly';
  if (s.includes('_6_') || s.endsWith('_6')) return 'semesterly';
  if (s.includes('_3_') || s.endsWith('_3')) return 'quarterly';
  if (s.includes('_1_') || s.endsWith('_1')) return 'monthly';
  return 'other';
}

function getPlanNameFromSku(sku) {
  if (!sku) return 'Unknown';
  const parts = sku.split('_');
  if (parts.length < 3) return sku;

  const product = parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : '';
  const periodMap = { '12': 'Yearly', '6': 'Semesterly', '3': 'Quarterly', '1': 'Monthly' };
  const period = periodMap[parts[2]] || parts[2];
  const rest = parts.slice(3).map(p => p.toUpperCase()).join(' ');

  return `Kinedu ${product} - ${period} ${rest}`.trim();
}

// ─── Region mapping ──────────────────────────────────────────────────────────

function getRegion(countryCode) {
  if (!countryCode) return 'rest_of_world';
  const code = countryCode.toUpperCase();
  if (code === 'US' || code === 'CA') return 'us_canada';
  if (code === 'MX') return 'mexico';
  if (code === 'BR') return 'brazil';
  return 'rest_of_world';
}

// ─── Source mapping ──────────────────────────────────────────────────────────

function mapStore(store) {
  if (!store) return 'stripe';
  const s = store.toLowerCase();
  if (s === 'apple') return 'apple';
  if (s === 'google') return 'google';
  if (s === 'webapp' || s === 'stripe' || s === 'webapp-partners') return 'stripe';
  return 'stripe';
}

// ─── Country from currency ───────────────────────────────────────────────────

function getCountryFromCurrency(currencyCode) {
  if (!currencyCode) return null;
  const map = {
    'MXN': 'MX', 'BRL': 'BR', 'USD': 'US', 'CAD': 'CA',
    'GBP': 'GB', 'EUR': 'EU', 'COP': 'CO', 'AED': 'AE', 'AUD': 'AU',
  };
  return map[currencyCode.toUpperCase()] || null;
}

// ─── CSV Parser (handles quoted fields) ──────────────────────────────────────

function parseCSV(content) {
  const lines = content.split('\n');
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const val = values[j] || '';
      row[headers[j].trim()] = val === 'NULL' || val === '' ? null : val;
    }
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// ─── Transform row to transaction ────────────────────────────────────────────

function transformRow(row) {
  const source = mapStore(row.store);
  const planType = getPlanTypeFromSku(row.sku);
  const planName = getPlanNameFromSku(row.sku);
  const usdAmount = Number(row.usd_amount) || 0;

  // Skip rows with 0 USD amount
  if (usdAmount <= 0) return null;

  // Commission rates:
  // Apple/Google: 30% for new subscriptions (year 1), 15% for renewals (year 2+)
  // Stripe: ~2.9% flat
  const isRenewal = String(row.renewed_automatically) === '1';
  let commissionRate = 0;
  if (source === 'apple') commissionRate = isRenewal ? 0.15 : 0.30;
  else if (source === 'google') commissionRate = isRenewal ? 0.15 : 0.30;
  else commissionRate = 0.029;

  const commission = usdAmount * commissionRate;
  const netAmount = usdAmount - commission;

  // Parse date — handle various formats
  let transactionDate;
  try {
    const d = new Date(row.created_at);
    if (isNaN(d.getTime())) return null;
    transactionDate = d.toISOString().split('T')[0];
  } catch {
    return null;
  }

  const countryCode = getCountryFromCurrency(row.currency_code);

  return {
    source,
    transaction_date: transactionDate,
    order_id: `kinedu_sale_${row.id}`,
    external_id: `kinedu_sale_${row.id}`,
    sku: row.sku,
    plan_type: planType,
    plan_name: planName,
    transaction_type: 'charge',
    is_new_subscription: String(row.renewed_automatically) === '0',
    is_renewal: String(row.renewed_automatically) === '1',
    is_trial_conversion: false,
    subscription_period: null,
    amount_gross: usdAmount,
    amount_net: netAmount,
    commission_amount: commission,
    tax_amount: 0,
    original_amount: Number(row.amount) || 0,
    original_currency: row.currency_code,
    country_code: countryCode,
    region: getRegion(countryCode),
    units: 1,
    raw_data: { kinedu_sale_id: row.id, store: row.store },
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node scripts/import-csv.js <path-to-csv>');
    console.error('');
    console.error('Steps:');
    console.error('  1. Open Sequel Pro → Run the sales query');
    console.error('  2. File → Export → CSV (or click the export icon)');
    console.error('  3. Save as scripts/sales-export.csv');
    console.error('  4. node scripts/import-csv.js scripts/sales-export.csv');
    process.exit(1);
  }

  const fullPath = path.resolve(csvPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`❌ File not found: ${fullPath}`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  Kinedu CSV → Supabase Import');
  console.log('═══════════════════════════════════════════════');
  console.log(`  File: ${path.basename(fullPath)}`);

  // 1. Read and parse CSV
  console.log('\n📄 Reading CSV...');
  const content = fs.readFileSync(fullPath, 'utf-8');
  const rows = parseCSV(content);
  console.log(`  Found ${rows.length} rows`);

  if (rows.length === 0) {
    console.error('❌ No data rows found. Check CSV format.');
    process.exit(1);
  }

  // Show sample
  console.log('  Sample row:', JSON.stringify(rows[0]).substring(0, 200));

  // 2. Transform to transactions
  console.log('\n🔄 Transforming to transactions...');
  const transactions = [];
  let skipped = 0;

  for (const row of rows) {
    const tx = transformRow(row);
    if (tx) {
      transactions.push(tx);
    } else {
      skipped++;
    }
  }

  console.log(`  ✅ ${transactions.length} transactions ready`);
  if (skipped > 0) console.log(`  ⚠️  ${skipped} rows skipped (0 amount or invalid date)`);

  // Find date range
  const dates = transactions.map(t => t.transaction_date).sort();
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];
  console.log(`  📅 Date range: ${fromDate} → ${toDate}`);

  // Show breakdown by source
  const bySource = {};
  for (const tx of transactions) {
    bySource[tx.source] = (bySource[tx.source] || 0) + 1;
  }
  console.log('  📊 By source:', bySource);

  // Show breakdown by month (first & last few)
  const byMonth = {};
  for (const tx of transactions) {
    const month = tx.transaction_date.substring(0, 7);
    if (!byMonth[month]) byMonth[month] = { count: 0, gross: 0 };
    byMonth[month].count++;
    byMonth[month].gross += tx.amount_gross;
  }
  const months = Object.keys(byMonth).sort();
  console.log('\n  Monthly summary:');
  for (const m of months) {
    console.log(`    ${m}: ${byMonth[m].count} sales, $${byMonth[m].gross.toFixed(0)} gross`);
  }

  // 3. Connect to Supabase and upsert
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Delete ALL charge transactions in this date range
  // (kinedu-sourced, Apple API, Google API, and Stripe API — all replaced by Kinedu DB data)
  console.log(`\n🗑️  Cleaning up ALL charge transactions from ${fromDate} to ${toDate}...`);

  for (const src of ['apple', 'google', 'stripe']) {
    const { error: delSrc, count: delCount } = await supabase
      .from('transactions')
      .delete()
      .gte('transaction_date', fromDate)
      .lte('transaction_date', toDate)
      .eq('transaction_type', 'charge')
      .eq('source', src);

    if (delSrc) console.warn(`  ⚠️  Error deleting ${src} txs:`, delSrc.message);
    else console.log(`  ✅ ${src} transactions deleted`);
  }

  // Also delete any kinedu-prefixed that might not match source filter
  const { error: delKinedu } = await supabase
    .from('transactions')
    .delete()
    .gte('transaction_date', fromDate)
    .lte('transaction_date', toDate)
    .eq('transaction_type', 'charge');

  if (delKinedu) console.warn('  ⚠️  Error on final cleanup:', delKinedu.message);
  else console.log('  ✅ All charges in range cleaned up');

  // 4. Batch upsert
  console.log('\n📤 Uploading to Supabase...');
  const BATCH_SIZE = 500;
  let totalSynced = 0;
  let errors = 0;

  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await supabase
      .from('transactions')
      .insert(batch);

    if (insertError) {
      console.error(`\n  ❌ Batch error (offset ${i}):`, insertError.message);
      // Try one by one
      let singles = 0;
      for (const tx of batch) {
        const { error: singleError } = await supabase
          .from('transactions')
          .insert(tx);
        if (!singleError) singles++;
        else errors++;
      }
      totalSynced += singles;
    } else {
      totalSynced += batch.length;
    }

    process.stdout.write(`\r  Progress: ${totalSynced}/${transactions.length} (${Math.round(totalSynced/transactions.length*100)}%)`);
  }
  console.log('');

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  ✅ Import complete!`);
  console.log(`  📊 ${totalSynced} transactions synced`);
  if (errors > 0) console.log(`  ⚠️  ${errors} errors`);
  console.log(`  📅 Range: ${fromDate} → ${toDate}`);
  console.log('═══════════════════════════════════════════════');
  console.log('\nNext step: Run snapshot recomputation:');
  console.log('  node -e "require(\'./lib/sync/snapshots\').recomputeAllSnapshots()"');
}

main().catch(err => {
  console.error('\n❌ Import failed:', err.message || err);
  process.exit(1);
});
