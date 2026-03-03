const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnvFile(fp) {
  try {
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
  } catch (e) {}
}
loadEnvFile(path.join(__dirname, '..', '.env.local'));

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function debug() {
  // Check a sample of Jan 2025 transactions
  const { data: sample } = await supabase
    .from('transactions')
    .select('external_id, source, sku, plan_type, amount_gross, amount_net, original_amount, original_currency, transaction_date')
    .gte('transaction_date', '2025-01-01')
    .lt('transaction_date', '2025-02-01')
    .order('amount_gross', { ascending: false })
    .limit(20);

  console.log('Top 20 Jan 2025 transactions by amount_gross:');
  for (const t of sample) {
    console.log(`  $${Number(t.amount_gross).toFixed(2)} gross | $${Number(t.original_amount).toFixed(2)} ${t.original_currency} | ${t.source} | ${t.sku} | ${t.plan_type}`);
  }

  // Check distribution of amounts
  const { data: allJan } = await supabase
    .from('transactions')
    .select('amount_gross, source, plan_type')
    .gte('transaction_date', '2025-01-01')
    .lt('transaction_date', '2025-02-01');

  console.log('\nJan 2025 total transactions:', allJan.length);

  // Count by amount range
  const ranges = { zero: 0, under1: 0, under10: 0, under50: 0, under100: 0, over100: 0 };
  let totalGross = 0;
  for (const t of allJan) {
    const amt = Number(t.amount_gross);
    totalGross += amt;
    if (amt === 0) ranges.zero++;
    else if (amt < 1) ranges.under1++;
    else if (amt < 10) ranges.under10++;
    else if (amt < 50) ranges.under50++;
    else if (amt < 100) ranges.under100++;
    else ranges.over100++;
  }

  console.log('Total gross:', totalGross.toFixed(2));
  console.log('Expected (Kinedu DB):', 326144);
  console.log('Ratio:', (totalGross / 326144 * 100).toFixed(1) + '%');
  console.log('\nAmount distribution:');
  console.log('  $0:', ranges.zero);
  console.log('  $0-$1:', ranges.under1);
  console.log('  $1-$10:', ranges.under10);
  console.log('  $10-$50:', ranges.under50);
  console.log('  $50-$100:', ranges.under100);
  console.log('  $100+:', ranges.over100);

  // Now check the CSV directly
  console.log('\n\nChecking CSV directly:');
  const csvPath = '/Users/pepisavalos/Desktop/query_result.csv';
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n');

  // Count Jan 2025 in CSV
  let csvJanCount = 0;
  let csvJanGross = 0;
  let sampleLines = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('2025-01-')) {
      csvJanCount++;
      // Parse usd_amount (column 6, 0-indexed 5)
      const parts = lines[i].split(',');
      const usdAmt = parseFloat(parts[5]);
      csvJanGross += usdAmt;
      if (sampleLines.length < 5) sampleLines.push(lines[i]);
    }
  }
  console.log('CSV Jan 2025 rows:', csvJanCount);
  console.log('CSV Jan 2025 gross:', csvJanGross.toFixed(2));
  console.log('Sample CSV lines:');
  for (const l of sampleLines) console.log('  ', l.substring(0, 120));
}

debug();
